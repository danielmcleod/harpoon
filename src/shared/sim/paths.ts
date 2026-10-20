// Where a request goes next, for the simulator, the "where traffic stops" checks, flow checks and the AI's
// check_traffic tool. Connectors point from the side that starts a request to the side that answers it. The
// hierarchy counts too: a request handled by an inner part that makes no calls of its own goes on through its
// service's connectors, and a request that reaches a container goes in at the inner parts that receive traffic.
import { ancestorsOf, childrenOf, descendantIds } from '../model/queries.ts'
import type { HxConnector, HxNode, Model, NodeKind } from '../model/schema.ts'

/** Kinds that start traffic (with no explicit entry load anywhere, these generate some). */
export const ENTRY_KINDS: ReadonlySet<NodeKind> = new Set(['client', 'frontend', 'mobile', 'desktop', 'device', 'scheduler'])

/** Kinds where a request naturally ends: stores and outside services answer without calling on. */
export const SINK_KINDS: ReadonlySet<NodeKind> = new Set(['database', 'cache', 'storage', 'saas', 'observability', 'search', 'warehouse', 'identity', 'cdn'])

/** Network hops between hosting worlds (on-prem ↔ cloud). */
const HOP_KINDS: ReadonlySet<NodeKind> = new Set(['gateway', 'network', 'cdn'])

/**
 * One way traffic moves on: a connector (`conn`), into a container's receiving inner parts (`into`, the load split
 * across them), or from an inner part with no calls of its own up to its service's calls (`up`).
 */
export interface Route {
  kind: 'conn' | 'into' | 'up'
  from: string
  to: string
  /** `conn` only. */
  connector?: HxConnector
  /** Share of the load at `from` that takes this route (`into` splits; others carry it all). */
  share: number
}

const live = (c: HxConnector): boolean => c.status !== 'removed'
const liveNode = (n: HxNode | undefined): n is HxNode => n !== undefined && n.status !== 'removed'

/** Every route, in no particular order. */
export function routes(m: Model): Route[] {
  const out = new Map<string, HxConnector[]>()
  const conns = Object.values(m.connectors).filter((c) => live(c) && liveNode(m.nodes[c.source]) && liveNode(m.nodes[c.target]))
  for (const c of conns) {
    const list = out.get(c.source)
    if (list === undefined) out.set(c.source, [c])
    else list.push(c)
  }
  const res: Route[] = conns.map((c) => ({ kind: 'conn', from: c.source, to: c.target, connector: c, share: 1 }))
  for (const n of Object.values(m.nodes)) {
    if (!liveNode(n) || (out.get(n.id)?.length ?? 0) > 0) continue
    const kids = childrenOf(m, n.id).filter(liveNode)
    if (kids.length > 0) {
      // In at the inner parts nothing inside the container calls (the ones that receive outside traffic).
      const inside = new Set([n.id, ...descendantIds(m, n.id)])
      const called = new Set(conns.filter((c) => inside.has(c.source) && inside.has(c.target)).map((c) => c.target))
      const receivers = kids.filter((k) => !called.has(k.id))
      const targets = receivers.length > 0 ? receivers : kids
      for (const k of targets) res.push({ kind: 'into', from: n.id, to: k.id, share: 1 / targets.length })
      continue
    }
    if (SINK_KINDS.has(n.kind)) continue
    const up = ancestorsOf(m, n.id).find((a) => (out.get(a.id)?.length ?? 0) > 0)
    if (up !== undefined) res.push({ kind: 'up', from: n.id, to: up.id, share: 1 })
  }
  return res
}

/**
 * Where traffic starts: nodes with entry load, plus every client-like node (client, web or mobile app, device,
 * scheduler) whose load is not set (they default to some), so a second group of users is never silently idle. An
 * entry load of 0 switches a node off.
 */
export function entryNodes(m: Model): string[] {
  return Object.values(m.nodes)
    .filter((n) => liveNode(n) && ((n.sim?.entryRps ?? 0) > 0 || (ENTRY_KINDS.has(n.kind) && (n.sim?.entryRps ?? null) === null)))
    .map((n) => n.id)
}

export interface Reach {
  nodes: Set<string>
  connectors: Set<string>
}

/** Everything traffic from `sources` gets to. */
export function reach(m: Model, sources: readonly string[], rs: readonly Route[] = routes(m)): Reach {
  const from = new Map<string, Route[]>()
  for (const r of rs) {
    const list = from.get(r.from)
    if (list === undefined) from.set(r.from, [r])
    else list.push(r)
  }
  const nodes = new Set<string>()
  const connectors = new Set<string>()
  const queue = sources.filter((s) => m.nodes[s] !== undefined)
  for (const s of queue) nodes.add(s)
  while (queue.length > 0) {
    const cur = queue.shift()
    if (cur === undefined) break
    for (const r of from.get(cur) ?? []) {
      if (r.connector !== undefined) connectors.add(r.connector.id)
      if (nodes.has(r.to)) continue
      nodes.add(r.to)
      queue.push(r.to)
    }
  }
  return { nodes, connectors }
}

export type BreakKind = 'dead-end' | 'reversed' | 'never-reached' | 'missing-hop'

export interface TrafficBreak {
  kind: BreakKind
  nodeId: string
  connectorId: string | null
  message: string
  hint: string
}

/** Hosting as set on the node or the nearest ancestor that says. */
function hostingOf(m: Model, n: HxNode): string | null {
  if (n.hosting !== null) return n.hosting
  return ancestorsOf(m, n.id).find((a) => a.hosting !== null)?.hosting ?? null
}

/**
 * Where traffic from `sources` (default: the entry points) stops or cannot get to, and why, each with what to change.
 * Natural end points (stores, outside services) never count as stops.
 */
export function trafficBreaks(m: Model, sources: readonly string[] = entryNodes(m)): TrafficBreak[] {
  const rs = routes(m)
  const r = reach(m, sources, rs)
  const leaves = new Set(rs.map((x) => x.from))
  const name = (id: string): string => m.nodes[id]?.name ?? id
  const conns = Object.values(m.connectors).filter((c) => live(c) && liveNode(m.nodes[c.source]) && liveNode(m.nodes[c.target]))
  const hasIn = new Set(conns.map((c) => c.target))
  const out: TrafficBreak[] = []
  const flagged = new Set<string>()

  for (const id of r.nodes) {
    const n = m.nodes[id]
    if (n === undefined || leaves.has(id) || SINK_KINDS.has(n.kind) || ENTRY_KINDS.has(n.kind)) continue
    if (n.kind === 'queue' || n.kind === 'stream') {
      out.push({ kind: 'dead-end', nodeId: id, connectorId: null, message: `Messages pile up in ${n.name}: nothing consumes them.`, hint: `Connect ${n.name} to its consumers (from the broker to each consumer, asynchronous).` })
    } else {
      const forwards = n.kind === 'gateway' || n.kind === 'network'
      out.push({
        kind: 'dead-end',
        nodeId: id,
        connectorId: null,
        message: `Traffic stops at ${n.name}: nothing leaves it.`,
        hint: forwards
          ? `${n.name} forwards requests: connect it to the services it routes to (from ${n.name} to each target).`
          : `If ${n.name} calls something, add that connector (from it to what it calls). If it is meant to be the end of the line, ignore this.`,
      })
    }
    flagged.add(id)
  }

  // One per node: the link back into a dead end is the likeliest to point the wrong way.
  const reversed = new Map<string, HxConnector>()
  for (const c of conns) {
    if (!r.nodes.has(c.target) || r.nodes.has(c.source)) continue
    const s = m.nodes[c.source]
    if (s === undefined || hasIn.has(s.id) || ENTRY_KINDS.has(s.kind) || SINK_KINDS.has(s.kind) || (s.sim?.entryRps ?? 0) > 0) continue
    const cur = reversed.get(s.id)
    if (cur === undefined || (flagged.has(c.target) && !flagged.has(cur.target))) reversed.set(s.id, c)
  }
  for (const c of reversed.values()) {
    const s = m.nodes[c.source]
    if (s === undefined) continue
    out.push({
      kind: 'reversed',
      nodeId: s.id,
      connectorId: c.id,
      message: `${s.name} never gets traffic: its link points into ${name(c.target)}.`,
      hint: `Connectors point from the caller to the one answering. If ${name(c.target)} sends requests to ${s.name}, reverse this connector; if ${s.name} starts requests itself, give it entry load.`,
    })
    flagged.add(s.id)
  }

  for (const n of Object.values(m.nodes)) {
    if (!liveNode(n) || r.nodes.has(n.id) || flagged.has(n.id) || ENTRY_KINDS.has(n.kind) || n.kind === 'module' || n.kind === 'observability') continue
    // Something is meant to call it but traffic never gets there. A node with only outgoing links starts its own work
    // (a batch job, a replica pulling from its primary); orphans are the Problems panel's own check. A container
    // counts as reached when traffic gets to something inside it.
    if (!hasIn.has(n.id)) continue
    if (descendantIds(m, n.id).some((d) => r.nodes.has(d))) continue
    if (ancestorsOf(m, n.id).some((a) => flagged.has(a.id))) continue
    out.push({ kind: 'never-reached', nodeId: n.id, connectorId: null, message: `No traffic from the entry points reaches ${n.name}.`, hint: `Check that something on the way to ${n.name} connects to it in the direction requests travel, or that what calls it has entry load.` })
  }

  for (const c of conns) {
    const s = m.nodes[c.source]
    const t = m.nodes[c.target]
    if (s === undefined || t === undefined || HOP_KINDS.has(s.kind) || HOP_KINDS.has(t.kind)) continue
    const hs = hostingOf(m, s)
    const ht = hostingOf(m, t)
    const pair = new Set([hs, ht])
    if (!(pair.has('on-prem') && (pair.has('cloud') || pair.has('serverless')))) continue
    out.push({
      kind: 'missing-hop',
      nodeId: s.id,
      connectorId: c.id,
      message: `${s.name} (${hs}) calls ${t.name} (${ht}) directly.`,
      hint: 'Traffic between on-prem and cloud passes a network hop: add the load balancer, API gateway, VPN or Direct Connect / ExpressRoute between them.',
    })
  }
  return out
}
