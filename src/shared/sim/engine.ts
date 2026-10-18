// The traffic simulator: a deterministic, discrete-time model of load through the architecture. Modelled, not
// measured: it shows how load, latency and failures propagate given each node's capacity and each connector's
// fan-out and policies, so "what if Redis slows down?" can be asked of the diagram.
//
// Per tick:
//  1. Entry load: nodes with `entryRps` (clients, schedulers) times the load profile and multiplier.
//  2. Propagation along connectors in dependency order: calls = handled × fan-out; retries amplify calls by the
//     callee's error rate; open circuit breakers and partitions stop calls (fast failures).
//  3. Each service unit (a node with capacity, or the nearest ancestor that has one, else kind defaults) gets
//     utilization, queueing latency (base / (1 − ρ), capped) and drops when overloaded.
//  4. Errors flow back up synchronous links (a caller fails when a dependency it waits on fails or times out).
//  5. Async links into a slower consumer pile up as backlog on the broker.
import { ancestorsOf } from '../model/queries.ts'
import type { HxConnector, HxNode, Model, NodeKind } from '../model/schema.ts'

export const TICK_SEC = 0.25

export type FaultType = 'down' | 'latency' | 'partition' | 'ratelimit' | 'errors'

export interface Fault {
  id: string
  type: FaultType
  /** Node id (down, latency, ratelimit, errors) or connector id (partition). */
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

/** Connectors in dependency order (Kahn's algorithm over nodes; cycles keep their remaining order). */
function orderConnectors(m: Model): HxConnector[] {
  const conns = Object.values(m.connectors)
  const indeg = new Map<string, number>()
  for (const n of Object.keys(m.nodes)) indeg.set(n, 0)
  for (const c of conns) indeg.set(c.target, (indeg.get(c.target) ?? 0) + 1)
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([n]) => n)
  const rank = new Map<string, number>()
  let i = 0
  while (queue.length > 0) {
    const n = queue.shift()
    if (n === undefined) break
    rank.set(n, i++)
    for (const c of conns) {
      if (c.source !== n) continue
      const d = (indeg.get(c.target) ?? 1) - 1
      indeg.set(c.target, d)
      if (d === 0) queue.push(c.target)
    }
  }
  for (const n of Object.keys(m.nodes)) if (!rank.has(n)) rank.set(n, i++)
  return conns.sort((a, b) => (rank.get(a.source) ?? 0) - (rank.get(b.source) ?? 0))
}

export class Simulator {
  readonly #m: Model
  readonly #order: HxConnector[]
  readonly #unit = new Map<string, string>()
  readonly #params = new Map<string, UnitParams>()
  readonly #backlog = new Map<string, number>()
  readonly #breaker = new Map<string, { bad: number; openUntil: number }>()
  #prev: Frame | null = null
  #t = 0

  constructor(m: Model) {
    this.#m = m
    this.#order = orderConnectors(m)
    for (const n of Object.values(m.nodes)) {
      const u = unitOf(m, n.id)
      this.#unit.set(n.id, u)
      const un = m.nodes[u]
      if (un !== undefined && !this.#params.has(u)) this.#params.set(u, paramsOf(un))
    }
  }

  get time(): number {
    return this.#t
  }

  step(sc: Scenario): Frame {
    const m = this.#m
    const t = this.#t
    const active = sc.faults.filter((f) => t >= f.from && (f.until === null || t < f.until))
    const fault = (type: FaultType, target: string): Fault | undefined => active.find((f) => f.type === type && f.target === target)

    // Last tick's error rates and latencies drive this tick's retries, timeouts and breakers (feedback delay).
    const prev = this.#prev
    const nodeErr = (id: string): number => prev?.nodes[id]?.errorRate ?? 0
    const nodeLat = (id: string): number => prev?.nodes[id]?.latencyMs ?? 0

    const arrivals = new Map<string, number>()
    // Load a unit serves: entry load plus calls that come from outside it (internal hops are the same request).
    const unitLoad = new Map<string, number>()
    const add = (id: string, rps: number, from: string | null = null): void => {
      arrivals.set(id, (arrivals.get(id) ?? 0) + rps)
      const u = this.#unit.get(id) ?? id
      if (from === null || (this.#unit.get(from) ?? from) !== u) unitLoad.set(u, (unitLoad.get(u) ?? 0) + rps)
    }
    const factor = profileFactor(sc.profile, t) * sc.multiplier
    const entries: string[] = []
    for (const n of Object.values(m.nodes)) {
      const e = n.sim?.entryRps
      if (e != null && e > 0) {
        add(n.id, e * factor)
        entries.push(n.id)
      }
    }
    // Clients without explicit load still generate a little, so a fresh diagram animates.
    if (entries.length === 0) {
      for (const n of Object.values(m.nodes)) {
        if (n.kind === 'client' || n.kind === 'frontend' || n.kind === 'mobile' || n.kind === 'desktop' || n.kind === 'device') {
          add(n.id, 100 * factor)
          entries.push(n.id)
        }
      }
    }

    const edges: Record<string, EdgeFrame> = {}
    for (const c of this.#order) {
      const handled = arrivals.get(c.source) ?? 0
      let rps = handled * (c.sim?.fanout ?? 1)
      const br = this.#breaker.get(c.id) ?? { bad: 0, openUntil: -1 }
      const open = c.policies.circuitBreaker && t < br.openUntil
      const cut = fault('partition', c.id) !== undefined
      const calleeErr = nodeErr(c.target)
      // Retries (synchronous links only) multiply load on a failing callee: the retry storm.
      if (c.sync === 'sync' && (c.policies.retries ?? 0) > 0 && !open) rps *= 1 + (c.policies.retries ?? 0) * Math.min(1, calleeErr)
      const timedOut = c.policies.timeoutMs !== null && nodeLat(c.target) > c.policies.timeoutMs
      let err = cut || open ? 1 : timedOut ? 1 : 0
      // A consumer behind a queue or stream pulls at most its capacity; the rest waits on the broker.
      const src = m.nodes[c.source]
      if (c.sync === 'async' && src !== undefined && (src.kind === 'queue' || src.kind === 'stream') && !cut) {
        const cap = this.#params.get(this.#unit.get(c.target) ?? c.target)?.capacity ?? Infinity
        const queued = this.#backlog.get(c.source) ?? 0
        const demand = rps + queued / TICK_SEC
        const consumed = Math.min(cap, demand)
        this.#backlog.set(c.source, Math.max(0, (demand - consumed) * TICK_SEC))
        rps = consumed
      }
      if (!cut && !open) add(c.target, rps, c.source)
      if (err === 0) err = Math.min(1, calleeErr)
      edges[c.id] = { rps: cut || open ? 0 : rps, errorRate: err, breakerOpen: open, health: open || cut ? 'bad' : 'ok' }
      if (c.policies.circuitBreaker) {
        const bad = err > BREAKER_TRIP ? br.bad + 1 : 0
        this.#breaker.set(c.id, { bad, openUntil: bad >= BREAKER_TICKS ? t + BREAKER_OPEN_SEC : br.openUntil })
      }
    }

    const unitFrame = new Map<string, { util: number; latency: number; err: number }>()
    for (const [u, load] of unitLoad) {
      const p = this.#params.get(u) ?? KIND_DEFAULTS.service
      let capacity = p.capacity
      const rl = fault('ratelimit', u)
      if (rl !== undefined) capacity = Math.min(capacity, rl.value)
      const down = fault('down', u) !== undefined
      const util = capacity <= 0 ? (load > 0 ? Infinity : 0) : load / capacity
      const slow = fault('latency', u)?.value ?? 1
      const latency = Math.min(p.latencyMs * LATENCY_CAP, p.latencyMs / Math.max(1 / LATENCY_CAP, 1 - Math.min(util, 0.999))) * slow
      const drop = util > 1 ? 1 - 1 / util : 0
      const extra = fault('errors', u)?.value ?? 0
      const err = down ? 1 : Math.min(1, 1 - (1 - p.errorRate) * (1 - drop) * (1 - extra))
      unitFrame.set(u, { util: down ? 1.5 : util, latency, err })
    }

    // Errors flow back up synchronous links (reverse dependency order), and async backlog builds on brokers.
    const nodeErrNow = new Map<string, number>()
    for (const id of Object.keys(m.nodes)) nodeErrNow.set(id, unitFrame.get(this.#unit.get(id) ?? id)?.err ?? 0)
    for (const c of [...this.#order].reverse()) {
      const e = edges[c.id]
      if (e === undefined) continue
      if (c.sync === 'sync') {
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
      const backlog = this.#backlog.get(n.id) ?? 0
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

    // Totals at entry points: end-to-end latency is approximated by the slowest synchronous chain from each entry.
    let total = 0
    let ok = 0
    let latSum = 0
    const chain = (id: string, depth: number, seen: Set<string>): number => {
      if (depth > 12 || seen.has(id)) return 0
      seen.add(id)
      const own = nodes[id]?.latencyMs ?? 0
      let worst = 0
      for (const c of Object.values(m.connectors)) if (c.source === id && c.sync === 'sync') worst = Math.max(worst, chain(c.target, depth + 1, seen))
      seen.delete(id)
      return own + worst
    }
    for (const id of entries) {
      const rps = arrivals.get(id) ?? 0
      const e = nodes[id]?.errorRate ?? 0
      total += rps
      ok += rps * (1 - e)
      latSum += rps * chain(id, 0, new Set())
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
