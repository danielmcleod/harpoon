// Resilience and high availability: how well each node survives failures (from what is documented, never assumed),
// what is a single point of failure on the paths requests take, and what goes down or degrades when a node, one of
// its instances or its zone fails. Pure; the lens, Show impact, the Problems panel and the AI share it.
import { ancestorsOf } from './queries.ts'
import type { HxConnector, HxNode, Model, Resilience } from './schema.ts'
import { ENTRY_KINDS, entryNodes, routes } from '../sim/paths.ts'
import type { Route } from '../sim/paths.ts'

/** region / zone / instance: survives losing that much; single: one copy; unknown: not documented. */
export type HaLevel = 'region' | 'zone' | 'instance' | 'single' | 'unknown' | 'external' | 'none'

const DATA_KINDS = new Set(['database', 'storage', 'warehouse', 'search'])

/** The node's own resilience, else its nearest documented ancestor's (inner parts run where their service runs). */
export function resilienceOf(m: Model, id: string): Resilience | null {
  const n = m.nodes[id]
  if (n === undefined) return null
  if (n.resilience !== null) return n.resilience
  return ancestorsOf(m, id).find((a) => a.resilience !== null)?.resilience ?? null
}

export function haLevel(m: Model, id: string): HaLevel {
  const n = m.nodes[id]
  if (n === undefined) return 'unknown'
  // Clients and devices are not something the team runs; modules share their service's deployment.
  if (ENTRY_KINDS.has(n.kind)) return 'none'
  const r = resilienceOf(m, id)
  if (r === null) return n.boundary === 'external' || n.kind === 'saas' ? 'external' : 'unknown'
  if (r.deployment === 'multi-region') return 'region'
  if (r.deployment === 'multi-zone' || r.zones.length >= 2) return 'zone'
  if (r.deployment === 'multi-instance' || (r.instances ?? 0) >= 2) return 'instance'
  if (r.deployment === 'single' || r.instances === 1) return 'single'
  return 'unknown'
}

/** A hard dependency on the request path: synchronous, and the caller cannot do without it. */
function hard(r: Route): boolean {
  return r.connector === undefined || (r.connector.sync === 'sync' && r.connector.dependency !== 'soft')
}

/** Nodes requests from the entry points depend on through hard links (what must be up for requests to succeed). */
export function criticalNodes(m: Model): Set<string> {
  const rs = routes(m).filter(hard)
  const out = new Set<string>(entryNodes(m))
  const queue = [...out]
  while (queue.length > 0) {
    const cur = queue.shift()
    if (cur === undefined) break
    for (const r of rs) {
      if (r.from !== cur || out.has(r.to)) continue
      out.add(r.to)
      queue.push(r.to)
    }
  }
  return out
}

export type FindingKind = 'spof' | 'zone-risk' | 'no-backups' | 'unprotected-call' | 'zone-concentration' | 'undocumented'

export interface ResilienceFinding {
  kind: FindingKind
  severity: 'error' | 'warn' | 'info'
  nodeId: string | null
  connectorId: string | null
  message: string
  fix: string
}

/** Where availability is weak, most serious first. */
export function resilienceFindings(m: Model): ResilienceFinding[] {
  const crit = criticalNodes(m)
  const out: ResilienceFinding[] = []
  const live = (n: HxNode): boolean => n.status !== 'removed' && n.status !== 'planned'
  // A service and its inner parts share a deployment: report it once, on the outermost documented node.
  const reported = new Set<string>()
  const owner = (n: HxNode): string => {
    if (n.resilience !== null) return n.id
    return ancestorsOf(m, n.id).find((a) => a.resilience !== null)?.id ?? n.id
  }
  for (const n of Object.values(m.nodes)) {
    if (!live(n) || !crit.has(n.id) || n.kind === 'module' || n.kind === 'system') continue
    const lvl = haLevel(m, n.id)
    const key = owner(n)
    if (reported.has(key)) continue
    const r = resilienceOf(m, n.id)
    if (lvl === 'single' && r?.failover !== 'automatic') {
      reported.add(key)
      out.push({ kind: 'spof', severity: 'error', nodeId: key, connectorId: null, message: `${m.nodes[key]?.name ?? n.name} is a single point of failure: one instance on the request path.`, fix: 'Run at least two instances across zones, or add automatic failover to a standby.' })
    } else if (lvl === 'instance') {
      reported.add(key)
      out.push({ kind: 'zone-risk', severity: 'warn', nodeId: key, connectorId: null, message: `${m.nodes[key]?.name ?? n.name} runs several instances but in one zone: a zone outage takes it down.`, fix: 'Spread its instances across at least two availability zones.' })
    } else if (lvl === 'unknown') {
      reported.add(key)
      out.push({ kind: 'undocumented', severity: 'info', nodeId: key, connectorId: null, message: `${m.nodes[key]?.name ?? n.name} is on the request path, but how it is deployed is not documented.`, fix: 'Record its deployment (instances, zones, failover), or let the AI read it from the infrastructure.' })
    }
  }
  for (const n of Object.values(m.nodes)) {
    if (!live(n) || !DATA_KINDS.has(n.kind) || n.resilience === null || n.resilience.backups === true) continue
    out.push({ kind: 'no-backups', severity: 'warn', nodeId: n.id, connectorId: null, message: `${n.name} has no backups recorded.`, fix: 'Turn on automated backups (and point-in-time recovery) and record the RPO/RTO.' })
  }
  for (const c of Object.values(m.connectors)) {
    if (c.status === 'removed' || c.sync !== 'sync' || c.dependency === 'soft' || !crit.has(c.source)) continue
    const t = m.nodes[c.target]
    if (t === undefined || !(t.boundary === 'external' || t.kind === 'saas')) continue
    if (c.policies.timeoutMs !== null || c.policies.circuitBreaker) continue
    out.push({ kind: 'unprotected-call', severity: 'warn', nodeId: c.source, connectorId: c.id, message: `${m.nodes[c.source]?.name ?? c.source} waits on ${t.name} with no timeout or circuit breaker.`, fix: `Add a timeout and a circuit breaker, and a fallback or queue if ${t.name} can be unavailable.` })
  }
  const zones = new Set<string>()
  let documented = 0
  for (const id of crit) {
    const r = m.nodes[id]?.resilience
    if (r === null || r === undefined || r.zones.length === 0) continue
    documented++
    for (const z of r.zones) zones.add(z)
  }
  if (documented >= 2 && zones.size === 1) {
    out.push({ kind: 'zone-concentration', severity: 'warn', nodeId: null, connectorId: null, message: `Everything on the request path with zones recorded runs in ${[...zones][0] ?? 'one zone'}.`, fix: 'Spread the critical services and data stores across at least two zones.' })
  }
  const rank = { error: 0, warn: 1, info: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}

export type FailureScope = 'instance' | 'zone' | 'down'
export type FailureEffect = 'down' | 'degraded'

/**
 * What a failure does: the origin (down, or degraded when it has spare instances or zones), every other node in the
 * same zone for a zone outage, and then everything that depends on them. A hard synchronous caller of something down
 * goes down; a soft or asynchronous one degrades (fallback, queue), as do callers of something degraded.
 */
export function failureImpact(m: Model, nodeId: string, scope: FailureScope): Map<string, FailureEffect> {
  const out = new Map<string, FailureEffect>()
  const worse = (id: string, e: FailureEffect): boolean => {
    const cur = out.get(id)
    if (cur === 'down' || cur === e) return false
    out.set(id, e)
    return true
  }
  const lvl = haLevel(m, nodeId)
  if (scope === 'down') worse(nodeId, 'down')
  else if (scope === 'instance') worse(nodeId, lvl === 'single' || lvl === 'unknown' ? 'down' : 'degraded')
  else {
    const zone = resilienceOf(m, nodeId)?.zones[0]
    worse(nodeId, lvl === 'zone' || lvl === 'region' ? 'degraded' : 'down')
    if (zone !== undefined) {
      for (const n of Object.values(m.nodes)) {
        const r = resilienceOf(m, n.id)
        if (r === null || !r.zones.includes(zone) || n.id === nodeId) continue
        const l = haLevel(m, n.id)
        worse(n.id, l === 'zone' || l === 'region' ? 'degraded' : 'down')
      }
    }
  }
  // Inner parts fail with their service.
  for (const [id, e] of [...out]) for (const n of Object.values(m.nodes)) if (ancestorsOf(m, n.id).some((a) => a.id === id)) worse(n.id, e)
  const rs = routes(m)
  for (let changed = true; changed; ) {
    changed = false
    for (const r of rs) {
      const e = out.get(r.to)
      if (e === undefined) continue
      const c: HxConnector | undefined = r.connector
      let effect: FailureEffect = 'degraded'
      if (e === 'down') {
        if (c !== undefined) effect = c.sync === 'sync' && c.dependency !== 'soft' ? 'down' : 'degraded'
        else effect = r.kind === 'up' || r.share >= 1 ? 'down' : 'degraded'
      }
      if (worse(r.from, effect)) changed = true
    }
  }
  return out
}
