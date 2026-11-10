// The traffic simulator: a deterministic, discrete-time model of load through the architecture. Modelled, not
// measured: it shows how load, latency and failures propagate given each node's capacity and each connector's
// fan-out and policies, so "what if Redis slows down?" can be asked of the diagram.
//
// Per tick:
//  1. Entry load: nodes with `entryRps` (clients, schedulers) times the load profile and multiplier.
//  2. Propagation along routes (paths.ts) in dependency order: connectors carry calls = handled × fan-out (retries
//     amplify calls by the callee's error rate; open circuit breakers and partitions stop calls), and the hierarchy
//     carries the rest (into a container's receiving parts, up from a part with no calls to its service's calls).
//     Handled is what the caller's unit had capacity for: nothing while it is down, and its served share as of the
//     last tick when it is overloaded (the same feedback delay as error rates), so a bottleneck shields what is
//     behind it.
//  3. Each service unit (a node with capacity, or the nearest ancestor that has one, else kind defaults) gets
//     utilization, queueing latency (base / (1 − ρ), capped) and drops when overloaded. A fault on a node hits the
//     unit that serves it and every unit inside it.
//  4. Errors flow back up synchronous links (a caller fails when a dependency it waits on fails or times out).
//  5. Async links into a slower consumer pile up as backlog on the broker, one backlog per consumer.
import { ancestorsOf } from '../model/queries.ts'
import { resilienceOf } from '../model/resilience.ts'
import type { HxNode, Model, NodeKind } from '../model/schema.ts'
import { entryNodes, routes } from './paths.ts'
import type { Route } from './paths.ts'

export const TICK_SEC = 0.25

export type FaultType = 'down' | 'latency' | 'partition' | 'ratelimit' | 'errors' | 'instance' | 'zone' | 'region'

export interface Fault {
  id: string
  type: FaultType
  /** Node id (down, latency, ratelimit, errors, instance), connector id (partition), or a zone / region name. */
  target: string
  /** latency: multiplier; ratelimit: rps cap; errors: error rate 0..1. */
  value: number
  /** Simulated seconds. */
  from: number
  until: number | null
}

export type LoadProfile = 'constant' | 'ramp' | 'spike' | 'diurnal'

export interface Scenario {
  multiplier: number
  profile: LoadProfile
  faults: Fault[]
}

export const DEFAULT_SCENARIO: Scenario = { multiplier: 1, profile: 'constant', faults: [] }

export type Health = 'ok' | 'warn' | 'bad'

export interface NodeFrame {
  /** Requests per second arriving. */
  rps: number
  util: number
  latencyMs: number
  errorRate: number
  backlog: number
  health: Health
}

export interface EdgeFrame {
  rps: number
  errorRate: number
  breakerOpen: boolean
  health: Health
}

export interface Frame {
  t: number
  nodes: Record<string, NodeFrame>
  edges: Record<string, EdgeFrame>
  /** Successful requests per second leaving entry points. */
  throughput: number
  /** Request-weighted mean latency at entry points. */
  latencyMs: number
  errorRate: number
}

interface UnitParams {
  capacity: number
  latencyMs: number
  errorRate: number
}

const KIND_DEFAULTS: Record<NodeKind, UnitParams> = {
  system: { capacity: 5000, latencyMs: 5, errorRate: 0 },
  service: { capacity: 1000, latencyMs: 20, errorRate: 0.001 },
  gateway: { capacity: 5000, latencyMs: 3, errorRate: 0.0005 },
  database: { capacity: 2000, latencyMs: 5, errorRate: 0.0005 },
  cache: { capacity: 20000, latencyMs: 1, errorRate: 0.0001 },
  queue: { capacity: 8000, latencyMs: 2, errorRate: 0.0001 },
  stream: { capacity: 10000, latencyMs: 2, errorRate: 0.0001 },
  worker: { capacity: 500, latencyMs: 30, errorRate: 0.001 },
  function: { capacity: 1000, latencyMs: 40, errorRate: 0.001 },
  storage: { capacity: 3000, latencyMs: 15, errorRate: 0.0005 },
  cdn: { capacity: 50000, latencyMs: 10, errorRate: 0.0001 },
  client: { capacity: 1e9, latencyMs: 0, errorRate: 0 },
  identity: { capacity: 2000, latencyMs: 60, errorRate: 0.001 },
  saas: { capacity: 2000, latencyMs: 150, errorRate: 0.002 },
  scheduler: { capacity: 1e9, latencyMs: 0, errorRate: 0 },
  observability: { capacity: 10000, latencyMs: 5, errorRate: 0 },
  process: { capacity: 1000, latencyMs: 10, errorRate: 0.0005 },
  module: { capacity: 1000, latencyMs: 10, errorRate: 0.0005 },
  frontend: { capacity: 1e9, latencyMs: 0, errorRate: 0 },
  mobile: { capacity: 1e9, latencyMs: 0, errorRate: 0 },
  desktop: { capacity: 1e9, latencyMs: 0, errorRate: 0 },
  device: { capacity: 1e9, latencyMs: 0, errorRate: 0 },
  search: { capacity: 3000, latencyMs: 15, errorRate: 0.0005 },
  ml: { capacity: 200, latencyMs: 250, errorRate: 0.002 },
  warehouse: { capacity: 500, latencyMs: 400, errorRate: 0.001 },
  pipeline: { capacity: 2000, latencyMs: 50, errorRate: 0.001 },
  network: { capacity: 20000, latencyMs: 1, errorRate: 0.0001 },
  legacy: { capacity: 300, latencyMs: 120, errorRate: 0.003 },
}

const LATENCY_CAP = 30
const BREAKER_TRIP = 0.5
const BREAKER_TICKS = 3
const BREAKER_OPEN_SEC = 10

export function profileFactor(p: LoadProfile, t: number): number {
  switch (p) {
    case 'constant':
      return 1
    case 'ramp':
      return Math.min(3, 0.2 + t / 60)
    case 'spike':
      return t % 60 > 40 && t % 60 < 50 ? 4 : 1
    case 'diurnal':
      return 1 + 0.6 * Math.sin((t / 120) * 2 * Math.PI)
  }
}

export function healthOf(util: number, errorRate: number): Health {
  if (errorRate > 0.08 || util > 1.0) return 'bad'
  if (errorRate > 0.02 || util > 0.8) return 'warn'
  return 'ok'
}

const OWN_UNIT_KINDS: ReadonlySet<NodeKind> = new Set(['database', 'cache', 'queue', 'stream', 'storage', 'saas', 'identity', 'cdn', 'client', 'frontend', 'mobile', 'desktop', 'device', 'search', 'warehouse', 'network', 'legacy', 'ml'])

/**
 * The node whose capacity serves `id`: itself when it has sim params or is a data store / broker / outside service
 * (those scale on their own); otherwise the nearest ancestor with params (a service's processes share its capacity).
 */
function unitOf(m: Model, id: string): string {
  const n = m.nodes[id]
  if (n === undefined || n.sim?.capacityRps != null || OWN_UNIT_KINDS.has(n.kind)) return id
  for (const a of ancestorsOf(m, id)) if (a.sim?.capacityRps != null) return a.id
  return id
}

function paramsOf(n: HxNode): UnitParams {
  const d = KIND_DEFAULTS[n.kind]
  return {
    capacity: n.sim?.capacityRps ?? d.capacity,
    latencyMs: n.sim?.latencyMs ?? d.latencyMs,
    errorRate: n.sim?.errorRate ?? d.errorRate,
  }
}

/** Routes in dependency order (Kahn's algorithm over nodes; cycles keep their remaining order). */
function orderRoutes(m: Model): Route[] {
  const rs = routes(m)
  const indeg = new Map<string, number>()
  for (const n of Object.keys(m.nodes)) indeg.set(n, 0)
  for (const r of rs) indeg.set(r.to, (indeg.get(r.to) ?? 0) + 1)
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([n]) => n)
  const rank = new Map<string, number>()
  let i = 0
  while (queue.length > 0) {
    const n = queue.shift()
    if (n === undefined) break
    rank.set(n, i++)
    for (const r of rs) {
      if (r.from !== n) continue
      const d = (indeg.get(r.to) ?? 1) - 1
      indeg.set(r.to, d)
      if (d === 0) queue.push(r.to)
    }
  }
  for (const n of Object.keys(m.nodes)) if (!rank.has(n)) rank.set(n, i++)
  return rs.sort((a, b) => (rank.get(a.from) ?? 0) - (rank.get(b.from) ?? 0))
}

export class Simulator {
  readonly #m: Model
  readonly #order: Route[]
  readonly #unit = new Map<string, string>()
  readonly #params = new Map<string, UnitParams>()
  /** Messages waiting on a broker for each consumer link (by connector id). */
  readonly #backlog = new Map<string, number>()
  /** `probing`: half-open, letting calls through to see whether the callee is back. */
  readonly #breaker = new Map<string, { bad: number; openUntil: number; probing: boolean }>()
  /** Node ids whose faults hit a unit: the nodes it serves and the containers it sits in. */
  readonly #hits = new Map<string, Set<string>>()
  /** Where a request goes on synchronously from each node (for end-to-end latency). */
  readonly #syncOut = new Map<string, string[]>()
  /** Share of its load each unit had capacity for last tick (absent: all of it). */
  #served = new Map<string, number>()
  #prev: Frame | null = null
  #t = 0

  constructor(m: Model) {
    this.#m = m
    this.#order = orderRoutes(m)
    const hit = (u: string, id: string): void => {
      const set = this.#hits.get(u)
      if (set === undefined) this.#hits.set(u, new Set([id]))
      else set.add(id)
    }
    for (const n of Object.values(m.nodes)) {
      const u = unitOf(m, n.id)
      this.#unit.set(n.id, u)
      hit(u, n.id)
      const un = m.nodes[u]
      if (un !== undefined && !this.#params.has(u)) {
        this.#params.set(u, paramsOf(un))
        for (const a of ancestorsOf(m, u)) hit(u, a.id)
      }
    }
    for (const r of this.#order) {
      if (r.connector !== undefined && r.connector.sync !== 'sync') continue
      const list = this.#syncOut.get(r.from)
      if (list === undefined) this.#syncOut.set(r.from, [r.to])
      else list.push(r.to)
    }
  }

  /** A fault on node `target` hits unit `u`: the unit serves that node, or sits inside it. */
  #hit(u: string, target: string): boolean {
    return target === u || this.#hits.get(u)?.has(target) === true
  }

  /** Share of a unit's capacity left under instance, zone and region faults (resilience as documented). */
  #survives(u: string, active: readonly Fault[]): number {
    const r = resilienceOf(this.#m, u)
    let left = 1
    for (const f of active) {
      if (f.type === 'instance' && this.#hit(u, f.target)) {
        const n = r?.instances ?? (r?.deployment === 'multi-instance' || r?.deployment === 'multi-zone' || r?.deployment === 'multi-region' ? 2 : 1)
        left *= n <= 1 ? 0 : (n - 1) / n
      } else if (f.type === 'zone' && r !== null && r.zones.includes(f.target)) {
        left *= (r.zones.length - 1) / r.zones.length
      } else if (f.type === 'region') {
        const n = this.#m.nodes[u]
        const region = n?.region ?? ancestorsOf(this.#m, u).find((a) => a.region !== null)?.region ?? null
        if (region !== null && region.toLowerCase() === f.target.toLowerCase()) left *= r?.deployment === 'multi-region' ? 0.5 : 0
      }
    }
    return left
  }

  get time(): number {
    return this.#t
  }

  step(sc: Scenario): Frame {
    const m = this.#m
    const t = this.#t
    const active = sc.faults.filter((f) => t >= f.from && (f.until === null || t < f.until))
    const cutOff = (connectorId: string): boolean => active.some((f) => f.type === 'partition' && f.target === connectorId)
    const fault = (type: FaultType, u: string): Fault | undefined => active.find((f) => f.type === type && this.#hit(u, f.target))
    const unit = (id: string): string => this.#unit.get(id) ?? id
    // What each unit can serve this tick: its capacity under a rate limit and what instance, zone and region faults
    // leave of it, and whether it is down.
    const states = new Map<string, { capacity: number; down: boolean }>()
    const stateOf = (u: string): { capacity: number; down: boolean } => {
      let s = states.get(u)
      if (s === undefined) {
        let capacity = (this.#params.get(u) ?? KIND_DEFAULTS.service).capacity
        const rl = fault('ratelimit', u)
        if (rl !== undefined) capacity = Math.min(capacity, rl.value)
        const left = this.#survives(u, active)
        capacity *= left
        states.set(u, (s = { capacity, down: fault('down', u) !== undefined || left <= 0 }))
      }
      return s
    }

    // Last tick's error rates and latencies drive this tick's retries, timeouts and breakers (feedback delay).
    const prev = this.#prev
    const nodeErr = (id: string): number => prev?.nodes[id]?.errorRate ?? 0
    const nodeLat = (id: string): number => prev?.nodes[id]?.latencyMs ?? 0

    const arrivals = new Map<string, number>()
    // Load a unit serves: entry load plus calls that come from outside it (internal hops are the same request).
    const unitLoad = new Map<string, number>()
    const add = (id: string, rps: number, from: string | null = null): void => {
      arrivals.set(id, (arrivals.get(id) ?? 0) + rps)
      const u = unit(id)
      if (from === null || unit(from) !== u) unitLoad.set(u, (unitLoad.get(u) ?? 0) + rps)
    }
    // What goes on from a node: all of it inside one unit (the same request), else only what its unit handled.
    const leaving = (from: string, to: string): number => {
      const u = unit(from)
      const share = u === unit(to) ? 1 : stateOf(u).down ? 0 : (this.#served.get(u) ?? 1)
      return (arrivals.get(from) ?? 0) * share
    }
    const factor = profileFactor(sc.profile, t) * sc.multiplier
    // Entry load; clients without explicit load still generate a little, so a fresh diagram animates.
    const entries = entryNodes(m)
    for (const id of entries) add(id, (m.nodes[id]?.sim?.entryRps ?? 100) * factor)

    const edges: Record<string, EdgeFrame> = {}
    const waiting = new Map<string, number>()
    for (const r of this.#order) {
      const c = r.connector
      if (c === undefined) {
        // The hierarchy: the same request moves into an inner part or up to its service's calls.
        add(r.to, leaving(r.from, r.to) * r.share, r.from)
        continue
      }
      let rps = leaving(c.source, c.target) * (c.sim?.fanout ?? 1)
      const br = this.#breaker.get(c.id) ?? { bad: 0, openUntil: -1, probing: false }
      const open = c.policies.circuitBreaker && t < br.openUntil
      const cut = cutOff(c.id)
      const calleeErr = nodeErr(c.target)
      // Retries (synchronous links only) multiply load on a failing callee: the retry storm.
      if (c.sync === 'sync' && (c.policies.retries ?? 0) > 0 && !open) rps *= 1 + (c.policies.retries ?? 0) * Math.min(1, calleeErr)
      const timedOut = c.policies.timeoutMs !== null && nodeLat(c.target) > c.policies.timeoutMs
      let err = cut || open ? 1 : timedOut ? 1 : 0
      // A consumer behind a queue or stream pulls at most what it can take now (nothing while it is down or cut
      // off, or the broker is down); the rest waits on the broker, each consumer link with its own backlog.
      const src = m.nodes[c.source]
      if (c.sync === 'async' && src !== undefined && (src.kind === 'queue' || src.kind === 'stream')) {
        const consumer = stateOf(unit(c.target))
        const cap = cut || open || consumer.down || stateOf(unit(c.source)).down ? 0 : consumer.capacity
        const demand = rps + (this.#backlog.get(c.id) ?? 0) / TICK_SEC
        const consumed = Math.min(cap, demand)
        const left = Math.max(0, (demand - consumed) * TICK_SEC)
        this.#backlog.set(c.id, left)
        waiting.set(c.source, (waiting.get(c.source) ?? 0) + left)
        rps = consumed
      }
      if (!cut && !open) add(c.target, rps, c.source)
      if (err === 0) err = Math.min(1, calleeErr)
      edges[c.id] = { rps: cut || open ? 0 : rps, errorRate: err, breakerOpen: open, health: open || cut ? 'bad' : 'ok' }
      if (c.policies.circuitBreaker && !open) {
        // An open breaker's own refusals do not count against the callee. Once the wait is over it is half-open:
        // calls go through for a tick, and what comes back (seen a tick later, like every error rate) closes it or
        // opens it again at once.
        if (br.probing) {
          const failed = err > BREAKER_TRIP
          this.#breaker.set(c.id, { bad: failed ? BREAKER_TICKS : 0, openUntil: failed ? t + BREAKER_OPEN_SEC : -1, probing: false })
        } else if (br.openUntil >= 0) this.#breaker.set(c.id, { ...br, probing: true })
        else {
          const bad = err > BREAKER_TRIP ? br.bad + 1 : 0
          this.#breaker.set(c.id, { bad, openUntil: bad >= BREAKER_TICKS ? t + BREAKER_OPEN_SEC : -1, probing: false })
        }
      }
    }

    // A unit that is down shows as down even when nothing reaches it any more.
    if (active.length > 0) for (const u of this.#params.keys()) if (!unitLoad.has(u) && stateOf(u).down) unitLoad.set(u, 0)
    const unitFrame = new Map<string, { util: number; latency: number; err: number }>()
    const served = new Map<string, number>()
    for (const [u, load] of unitLoad) {
      const p = this.#params.get(u) ?? KIND_DEFAULTS.service
      // Losing an instance, a zone or a region: what is left of the unit's capacity (0: down).
      const { capacity, down } = stateOf(u)
      const util = capacity <= 0 ? (load > 0 ? Infinity : 0) : load / capacity
      const slow = fault('latency', u)?.value ?? 1
      const latency = Math.min(p.latencyMs * LATENCY_CAP, p.latencyMs / Math.max(1 / LATENCY_CAP, 1 - Math.min(util, 0.999))) * slow
      const drop = util > 1 ? 1 - 1 / util : 0
      const extra = fault('errors', u)?.value ?? 0
      const err = down ? 1 : Math.min(1, 1 - (1 - p.errorRate) * (1 - drop) * (1 - extra))
      unitFrame.set(u, { util: down ? 1.5 : util, latency, err })
      served.set(u, 1 - drop)
    }
    this.#served = served

    // Errors flow back up synchronous links (reverse dependency order), and async backlog builds on brokers.
    const nodeErrNow = new Map<string, number>()
    for (const id of Object.keys(m.nodes)) nodeErrNow.set(id, unitFrame.get(this.#unit.get(id) ?? id)?.err ?? 0)
    for (const r of [...this.#order].reverse()) {
      const c = r.connector
      if (c === undefined) {
        // An inner part's failure shows on its container (by its share); a service's failing calls on the part.
        const from = nodeErrNow.get(r.from) ?? 0
        const to = (nodeErrNow.get(r.to) ?? 0) * (r.kind === 'into' ? r.share : 1)
        nodeErrNow.set(r.from, Math.min(1, 1 - (1 - from) * (1 - to)))
        continue
      }
      const e = edges[c.id]
      if (e === undefined) continue
      // A soft dependency fails without failing its caller (fallback, cache).
      if (c.sync === 'sync' && c.dependency !== 'soft') {
        const calleeErr = e.breakerOpen || e.rps === 0 ? e.errorRate : Math.max(e.errorRate, nodeErrNow.get(c.target) ?? 0)
        e.errorRate = calleeErr
        const share = Math.min(1, c.sim?.fanout ?? 1)
        nodeErrNow.set(c.source, Math.min(1, 1 - (1 - (nodeErrNow.get(c.source) ?? 0)) * (1 - calleeErr * share)))
      }
      e.health = e.breakerOpen ? 'bad' : healthOf(0, e.errorRate)
    }
    const nodes: Record<string, NodeFrame> = {}
    for (const n of Object.values(m.nodes)) {
      const u = this.#unit.get(n.id) ?? n.id
      const uf = unitFrame.get(u)
      const err = nodeErrNow.get(n.id) ?? 0
      const util = uf?.util ?? 0
      const backlog = waiting.get(n.id) ?? 0
      nodes[n.id] = {
        rps: arrivals.get(n.id) ?? 0,
        util,
        latencyMs: uf?.latency ?? 0,
        errorRate: err,
        backlog,
        health: backlog > 5000 ? 'bad' : backlog > 500 ? 'warn' : healthOf(util, err),
      }
    }
    // Containers show the worst of what is inside them.
    for (const n of Object.values(m.nodes)) {
      for (const a of ancestorsOf(m, n.id)) {
        const af = nodes[a.id]
        const nf = nodes[n.id]
        if (af === undefined || nf === undefined) continue
        const rank = { ok: 0, warn: 1, bad: 2 }
        if (rank[nf.health] > rank[af.health]) af.health = nf.health
      }
    }

    // Totals at entry points: end-to-end latency is approximated by the slowest synchronous chain from each entry,
    // worked out once per node (a call back into the chain being walked adds nothing).
    let total = 0
    let ok = 0
    let latSum = 0
    const slowest = new Map<string, number>()
    const walking = new Set<string>()
    const chain = (id: string): number => {
      const known = slowest.get(id)
      if (known !== undefined) return known
      if (walking.has(id)) return 0
      walking.add(id)
      let worst = 0
      for (const to of this.#syncOut.get(id) ?? []) worst = Math.max(worst, chain(to))
      walking.delete(id)
      const sum = (nodes[id]?.latencyMs ?? 0) + worst
      slowest.set(id, sum)
      return sum
    }
    for (const id of entries) {
      const rps = arrivals.get(id) ?? 0
      const e = nodes[id]?.errorRate ?? 0
      total += rps
      ok += rps * (1 - e)
      latSum += rps * chain(id)
    }

    const frame: Frame = {
      t,
      nodes,
      edges,
      throughput: ok,
      latencyMs: total > 0 ? latSum / total : 0,
      errorRate: total > 0 ? 1 - ok / total : 0,
    }
    this.#prev = frame
    this.#t = Math.round((t + TICK_SEC) * 1000) / 1000
    return frame
  }
}
