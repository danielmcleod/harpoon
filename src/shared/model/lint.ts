// Architecture lint: problems worth a look (the Problems panel and the AI's validate_draft tool share it).
import { arrivalRank, channelEncrypted, dataClassCatalog, dataClassLabel, dataScope, phasesInOrder } from './governance.ts'
import { ancestorsOf, descendantIds, isSelfOrAncestor } from './queries.ts'
import { entryNodes, reach, trafficBreaks } from '../sim/paths.ts'
import { evaluateRules } from './rules.ts'
import { satellitesOf } from './satellites.ts'
import type { Model } from './schema.ts'
import { boundaryProblems } from './boundaries.ts'

export type Severity = 'error' | 'warn' | 'info'

export interface Problem {
  severity: Severity
  code: string
  message: string
  nodeId?: string
  connectorId?: string
  boundaryId?: string
  flowId?: string
}

export function lintModel(m: Model): Problem[] {
  const out: Problem[] = []
  const nodes = Object.values(m.nodes)
  const conns = Object.values(m.connectors)
  const name = (id: string): string => m.nodes[id]?.name ?? id

  // Connectors anywhere in a node's subtree count as its connections.
  const touched = new Set<string>()
  for (const c of conns) {
    touched.add(c.source)
    touched.add(c.target)
  }
  const hasKids = new Set(nodes.map((n) => n.parentId).filter((p): p is string => p !== null))
  for (const n of nodes) {
    // Modules are responsibilities of their service: they need not connect to anything.
    if (n.kind === 'system' || n.kind === 'module' || n.status === 'removed') continue
    const subtree = [n.id, ...(hasKids.has(n.id) ? descendantIds(m, n.id) : [])]
    if (!subtree.some((id) => touched.has(id))) {
      out.push({ severity: 'warn', code: 'orphan', message: `${n.name} has no connections.`, nodeId: n.id })
    }
    if (n.boundary === 'external' && n.vendor === null && n.kind === 'saas') {
      out.push({ severity: 'info', code: 'no-vendor', message: `${n.name} is external but names no vendor.`, nodeId: n.id })
    }
    for (const f of n.features) {
      if (f.category === 'api' && f.endpoint === null) {
        out.push({ severity: 'info', code: 'feature-no-endpoint', message: `${n.name} › ${f.name} has no endpoint or signature.`, nodeId: n.id })
      }
    }
  }

  // Top-level parts that only one service uses belong inside it (imports leave many of them at the top).
  for (const [id, owner] of satellitesOf(m)) {
    out.push({ severity: 'info', code: 'stray-node', message: `${name(id)} is only used by ${name(owner)}; move it inside ${name(owner)}.`, nodeId: id })
  }

  // Duplicate names among siblings.
  const seen = new Map<string, string>()
  for (const n of nodes) {
    const key = `${n.parentId ?? ''}::${n.name.trim().toLowerCase()}`
    const other = seen.get(key)
    if (other !== undefined) out.push({ severity: 'warn', code: 'duplicate-name', message: `Two nodes are called "${n.name}" at the same level.`, nodeId: n.id })
    else seen.set(key, n.id)
  }

  for (const c of conns) {
    const s = m.nodes[c.source]
    const t = m.nodes[c.target]
    if (c.channelA.protocol.trim() === '') {
      out.push({ severity: 'error', code: 'no-protocol', message: `${name(c.source)} → ${name(c.target)} has no protocol.`, connectorId: c.id })
    }
    if (s !== undefined && t !== undefined && s.boundary !== t.boundary && c.channelA.auth === null) {
      out.push({
        severity: 'warn',
        code: 'external-no-auth',
        message: `${s.name} → ${t.name} crosses the system boundary without an auth mechanism.`,
        connectorId: c.id,
      })
    }
    if (c.duplex && c.channelB === null) {
      out.push({ severity: 'info', code: 'duplex-no-return', message: `${name(c.source)} ⇄ ${name(c.target)} is duplex but has no return channel.`, connectorId: c.id })
    }
  }

  for (const b of Object.values(m.boundaries)) {
    for (const id of b.nodeIds) {
      if (m.nodes[id] === undefined) out.push({ severity: 'error', code: 'boundary-missing-node', message: `Boundary ${b.name} lists a node that does not exist (${id}).`, boundaryId: b.id })
    }
  }
  out.push(...boundaryProblems(m))
  // Where traffic stops (shared with the simulator): the AI's validate_draft sees these while it builds.
  const TRAFFIC: Record<string, { code: string; severity: Severity }> = {
    'dead-end': { code: 'traffic-dead-end', severity: 'warn' },
    reversed: { code: 'traffic-reversed', severity: 'warn' },
    'never-reached': { code: 'traffic-unreached', severity: 'info' },
    'missing-hop': { code: 'hybrid-no-hop', severity: 'info' },
  }
  for (const b of trafficBreaks(m)) {
    const t = TRAFFIC[b.kind] ?? { code: `traffic-${b.kind}`, severity: 'info' as const }
    out.push({ severity: t.severity, code: t.code, message: `${b.message} ${b.hint}`, nodeId: b.nodeId, ...(b.connectorId !== null ? { connectorId: b.connectorId } : {}) })
  }

  // Flows: each step must start somewhere the flow has already been (after a call returns, the caller makes the next
  // one; an inner part and its container count as one place), run the way its connector carries traffic, and start
  // somewhere traffic reaches.
  const reached = reach(m, entryNodes(m)).nodes
  const related = (a: string, b: string): boolean => isSelfOrAncestor(m, a, b) || isSelfOrAncestor(m, b, a)
  for (const f of Object.values(m.flows)) {
    const visited: string[] = []
    let prevTo: string | null = null
    f.steps.forEach((st, i) => {
      const c = m.connectors[st.connectorId]
      if (c === undefined) {
        out.push({ severity: 'error', code: 'flow-missing-connector', message: `Flow ${f.name} uses a connector that does not exist (${st.connectorId}).`, flowId: f.id })
        prevTo = null
        return
      }
      const from = st.direction === 'A' ? c.source : c.target
      const to = st.direction === 'A' ? c.target : c.source
      if (st.direction === 'B' && !c.duplex && c.channelB === null) {
        out.push({ severity: 'warn', code: 'flow-reversed', message: `Flow ${f.name}, step ${i + 1}: runs from ${name(c.target)} back to ${name(c.source)}, but that connector only carries ${name(c.source)} → ${name(c.target)}. Reverse the step, or the connector if requests really go that way.`, flowId: f.id, connectorId: c.id })
      }
      if (prevTo !== null && !visited.some((v) => related(v, from))) {
        out.push({ severity: 'warn', code: 'flow-gap', message: `Flow ${f.name}, step ${i + 1}: starts at ${name(from)}, but step ${i} ended at ${name(prevTo)}. Add the missing hop or reorder the steps.`, flowId: f.id })
      }
      if (i === 0 && reached.size > 0 && !reached.has(from)) {
        out.push({ severity: 'info', code: 'flow-unreachable', message: `Flow ${f.name} starts at ${name(from)}, which no entry point's traffic reaches.`, flowId: f.id })
      }
      visited.push(from, to)
      prevTo = to
    })
  }

  // Synchronous call cycles between services (each hop waits on the next: a deadlock or latency trap).
  const adj = new Map<string, string[]>()
  for (const c of conns) {
    if (c.sync !== 'sync') continue
    const l = adj.get(c.source)
    if (l === undefined) adj.set(c.source, [c.target])
    else l.push(c.target)
  }
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const reported = new Set<string>()
  const visit = (id: string): void => {
    state.set(id, 1)
    stack.push(id)
    for (const nx of adj.get(id) ?? []) {
      const st = state.get(nx)
      if (st === 1) {
        const cycle = stack.slice(stack.indexOf(nx))
        const key = [...cycle].sort().join('|')
        if (!reported.has(key)) {
          reported.add(key)
          out.push({ severity: 'warn', code: 'sync-cycle', message: `Synchronous call cycle: ${[...cycle, nx].map(name).join(' → ')}.`, nodeId: nx })
        }
      } else if (st === undefined) visit(nx)
    }
    stack.pop()
    state.set(id, 2)
  }
  for (const id of adj.keys()) if (!state.has(id)) visit(id)

  out.push(...governanceProblems(m))
  // The project's own rules.
  for (const h of evaluateRules(m, m.meta.rules).hits) {
    out.push({ severity: h.rule.severity, code: `rule:${h.rule.id}`, message: h.message, ...(h.entity === 'node' ? { nodeId: h.id } : h.entity === 'connector' ? { connectorId: h.id } : { boundaryId: h.id }) })
  }

  const rank: Record<Severity, number> = { error: 0, warn: 1, info: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}

const PUBLIC_CALLERS = new Set(['client', 'frontend', 'mobile', 'desktop', 'device'])

/** Ownership, data and roadmap checks. */
function governanceProblems(m: Model): Problem[] {
  const out: Problem[] = []
  const name = (id: string): string => m.nodes[id]?.name ?? id
  const known = new Set(dataClassCatalog(m.meta).map((d) => d.id))
  const teams = new Set(m.meta.teams.map((t) => t.id))
  const phases = new Set(m.meta.phases.map((p) => p.id))
  const label = (cls: string): string => dataClassLabel(m.meta, cls)

  const refs: { kind: 'node' | 'connector' | 'boundary'; id: string; what: string; team: string | null; phase: string | null; classes: string[] }[] = [
    ...Object.values(m.nodes).map((n) => ({ kind: 'node' as const, id: n.id, what: n.name, team: n.team, phase: n.phase, classes: n.dataClasses })),
    ...Object.values(m.connectors).map((c) => ({
      kind: 'connector' as const,
      id: c.id,
      what: `${name(c.source)} → ${name(c.target)}`,
      team: c.team,
      phase: c.phase,
      classes: [...c.channelA.dataClasses, ...(c.channelB?.dataClasses ?? [])],
    })),
    ...Object.values(m.boundaries).map((b) => ({ kind: 'boundary' as const, id: b.id, what: b.name, team: b.team, phase: null, classes: b.dataClasses })),
  ]
  const at = (r: (typeof refs)[number]): Partial<Problem> => (r.kind === 'node' ? { nodeId: r.id } : r.kind === 'connector' ? { connectorId: r.id } : { boundaryId: r.id })
  for (const r of refs) {
    if (r.team !== null && !teams.has(r.team)) out.push({ severity: 'warn', code: 'unknown-team', message: `${r.what} belongs to a team that is not in the project (${r.team}).`, ...at(r) })
    if (r.phase !== null && !phases.has(r.phase)) out.push({ severity: 'warn', code: 'unknown-phase', message: `${r.what} is set to a phase that does not exist (${r.phase}).`, ...at(r) })
    for (const cls of new Set(r.classes)) {
      if (!known.has(cls)) out.push({ severity: 'warn', code: 'unknown-data-class', message: `${r.what} is tagged with an unknown data class (${cls}).`, ...at(r) })
    }
  }

  // Regulated data in transit without encryption.
  for (const c of Object.values(m.connectors)) {
    for (const [ch, dir] of [[c.channelA, 'A'], [c.channelB, 'B']] as const) {
      if (ch === null || ch.dataClasses.length === 0 || channelEncrypted(ch)) continue
      out.push({
        severity: 'error',
        code: 'data-unencrypted',
        message: `${dir === 'A' ? `${name(c.source)} → ${name(c.target)}` : `${name(c.target)} → ${name(c.source)}`} carries ${ch.dataClasses.map(label).join(', ')} without encryption.`,
        connectorId: c.id,
      })
    }
  }

  // Data handled outside its zone (only for classes some boundary is approved for), or by an unnamed third party.
  const scope = dataScope(m)
  const zoned = new Map<string, Set<string>>()
  for (const b of Object.values(m.boundaries)) {
    for (const cls of b.dataClasses) {
      let members = zoned.get(cls)
      if (members === undefined) zoned.set(cls, (members = new Set()))
      for (const id of b.nodeIds) {
        members.add(id)
        for (const d of descendantIds(m, id)) members.add(d)
      }
    }
  }
  for (const [nodeId, byCls] of scope) {
    const n = m.nodes[nodeId]
    if (n === undefined || n.status === 'removed') continue
    for (const [cls, why] of byCls) {
      if (why.inner.length > 0 && !why.own && why.via.length === 0) continue // a container: its parts are checked
      const members = zoned.get(cls)
      if (members !== undefined && !members.has(nodeId) && !ancestorsOf(m, nodeId).some((a) => members.has(a.id))) {
        out.push({ severity: 'error', code: 'data-outside-zone', message: `${n.name} handles ${label(cls)} but is outside every zone approved for it.`, nodeId })
      }
      if (n.boundary === 'external' && n.vendor === null) {
        out.push({ severity: 'warn', code: 'data-unnamed-vendor', message: `${label(cls)} reaches ${n.name}, a third party with no vendor named.`, nodeId })
      }
    }
  }

  // Restricted data on a node that clients call directly.
  for (const n of Object.values(m.nodes)) {
    if (n.sensitivity !== 'restricted') continue
    const exposed = Object.values(m.connectors).some((c) => {
      if (c.target !== n.id) return false
      const s = m.nodes[c.source]
      return s !== undefined && (PUBLIC_CALLERS.has(s.kind) || s.boundary === 'external')
    })
    if (exposed) out.push({ severity: 'warn', code: 'restricted-exposed', message: `${n.name} holds restricted data and is called directly from outside or by clients.`, nodeId: n.id })
  }

  // Roadmap: planned work without a phase, and things built before what they depend on.
  if (m.meta.phases.length > 0) {
    const order = phasesInOrder(m.meta)
    for (const n of Object.values(m.nodes)) {
      if ((n.status === 'planned' || n.status === 'in-progress') && n.phase === null) {
        out.push({ severity: 'info', code: 'planned-no-phase', message: `${n.name} is ${n.status === 'planned' ? 'planned' : 'in progress'} but not in a roadmap phase.`, nodeId: n.id })
      }
    }
    const phaseName = (i: number): string => order[i]?.name ?? 'today'
    for (const c of Object.values(m.connectors)) {
      const src = m.nodes[c.source]
      const dst = m.nodes[c.target]
      if (src === undefined || dst === undefined) continue
      // Who depends on whom: the caller on the callee, but a consumer on the queue or stream it reads from (the
      // arrow points at the consumer).
      const consumer = c.sync === 'async' && (src.kind === 'queue' || src.kind === 'stream')
      const s = consumer ? dst : src
      const t = consumer ? src : dst
      const rs = arrivalRank(m, s, order)
      const rt = arrivalRank(m, t, order)
      const rc = arrivalRank(m, c, order)
      if (rs !== null && rt !== null && rt > rs) {
        out.push({ severity: 'error', code: 'phase-order', message: `${s.name} (${phaseName(rs)}) depends on ${t.name}, which only arrives in ${phaseName(rt)}.`, connectorId: c.id })
      } else if (rc !== null && c.phase !== null) {
        const late = [s, t].find((e) => {
          const r = arrivalRank(m, e, order)
          return r !== null && r > rc
        })
        if (late !== undefined) out.push({ severity: 'error', code: 'phase-order', message: `${src.name} → ${dst.name} is planned for ${phaseName(rc)}, before ${late.name} arrives.`, connectorId: c.id })
      }
    }
  }
  return out
}
