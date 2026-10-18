// Ownership, data classification and roadmap phases: the catalogs entities point at, and what follows from them
// (inherited teams, data scope carried along connectors, phase order).
import { ancestorsOf } from './queries.ts'
import type { Channel, DataClass, HxConnector, HxNode, Model, Phase, ProjectMeta } from './schema.ts'

/** Common regulated data, always available; projects add their own in `meta.dataClasses`. */
export const BUILTIN_DATA_CLASSES: readonly DataClass[] = [
  { id: 'pii', label: 'PII', regime: 'GDPR / CCPA', description: 'Personal data: names, emails, addresses, identifiers.' },
  { id: 'phi', label: 'PHI', regime: 'HIPAA', description: 'Protected health information.' },
  { id: 'pci', label: 'PCI', regime: 'PCI DSS', description: 'Cardholder data: card numbers, CVV, track data.' },
  { id: 'cji', label: 'CJI', regime: 'CJIS', description: 'Criminal justice information.' },
  { id: 'ferpa', label: 'FERPA', regime: 'FERPA', description: 'Student education records.' },
  { id: 'fin', label: 'Financial', regime: 'SOX / GLBA', description: 'Financial records and reporting data.' },
  { id: 'secrets', label: 'Secrets', regime: null, description: 'Credentials, keys and tokens.' },
  { id: 'special', label: 'Special category', regime: 'GDPR Art. 9', description: 'Health, biometrics, beliefs, orientation, ethnicity.' },
]

/** Built-in classes plus the project's own (a project entry with a built-in id overrides it). */
export function dataClassCatalog(meta: ProjectMeta): DataClass[] {
  const own = new Map(meta.dataClasses.map((d) => [d.id, d]))
  return [...BUILTIN_DATA_CLASSES.map((d) => own.get(d.id) ?? d), ...meta.dataClasses.filter((d) => !BUILTIN_DATA_CLASSES.some((b) => b.id === d.id))]
}

export function dataClassLabel(meta: ProjectMeta, id: string): string {
  return dataClassCatalog(meta).find((d) => d.id === id)?.label ?? id
}

/** The node's team, or the nearest ancestor's (`inherited` says which). */
export function effectiveTeam(m: Model, id: string): { team: string; inherited: boolean } | null {
  const n = m.nodes[id]
  if (n === undefined) return null
  if (n.team !== null) return { team: n.team, inherited: false }
  for (const a of ancestorsOf(m, id).reverse()) if (a.team !== null) return { team: a.team, inherited: true }
  return null
}

export function connectorDataClasses(c: HxConnector): string[] {
  return [...new Set([...c.channelA.dataClasses, ...(c.channelB?.dataClasses ?? [])])]
}

/** Why a node handles a data class: tagged on it, carried by connectors it is on, or held by parts inside it. */
export interface ScopeReason {
  own: boolean
  /** Connectors that carry the class to or from it. */
  via: string[]
  /** Inner nodes that handle it. */
  inner: string[]
}

/**
 * Every node's data scope. A node handles a class when it is tagged with it, when a connector it sends or receives
 * on carries it, or when a node inside it does (containers lift their parts' scope; the top-level system does not).
 */
export function dataScope(m: Model): Map<string, Map<string, ScopeReason>> {
  const out = new Map<string, Map<string, ScopeReason>>()
  const reason = (nodeId: string, cls: string): ScopeReason => {
    let byCls = out.get(nodeId)
    if (byCls === undefined) out.set(nodeId, (byCls = new Map<string, ScopeReason>()))
    let r = byCls.get(cls)
    if (r === undefined) byCls.set(cls, (r = { own: false, via: [], inner: [] }))
    return r
  }
  for (const n of Object.values(m.nodes)) for (const cls of n.dataClasses) reason(n.id, cls).own = true
  for (const c of Object.values(m.connectors)) {
    for (const cls of connectorDataClasses(c)) {
      for (const end of [c.source, c.target]) if (m.nodes[end] !== undefined) reason(end, cls).via.push(c.id)
    }
  }
  // Lift to containers, from the scope gathered so far (direct handlers only, so a parent lists its parts once).
  for (const [nodeId, byCls] of [...out]) {
    for (const a of ancestorsOf(m, nodeId)) {
      if (a.kind === 'system') continue
      for (const cls of byCls.keys()) {
        const r = reason(a.id, cls)
        if (!r.inner.includes(nodeId)) r.inner.push(nodeId)
      }
    }
  }
  return out
}

/** A channel counts as encrypted when it names an encryption, or its protocol or auth (mTLS) implies TLS. */
export function channelEncrypted(ch: Channel): boolean {
  if (ch.encryption !== null && !/^(none|plain|no)$/i.test(ch.encryption.trim())) return true
  return /https|tls|wss|sftp|ssh|ftps|smtps|imaps|ldaps|mtls|amqps|grpcs/i.test(`${ch.protocol} ${ch.transport ?? ''} ${ch.auth ?? ''}`)
}

export function phasesInOrder(meta: ProjectMeta): Phase[] {
  return [...meta.phases].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

/**
 * When an entity exists, on the roadmap: -1 for "today" (built, no phase), the phase's index once its phase lands
 * (planned/in-progress), or null when unknown (planned without a phase, or a phase that does not exist).
 */
export function arrivalRank(m: Model, e: { status: HxNode['status']; phase: string | null }, order = phasesInOrder(m.meta)): number | null {
  if (e.phase === null) return e.status === 'planned' || e.status === 'in-progress' ? null : -1
  const i = order.findIndex((p) => p.id === e.phase)
  if (i < 0) return null
  return e.status === 'planned' || e.status === 'in-progress' ? i : -1
}

/** The model with working notes blanked (shared exports leave them out unless asked). */
export function withoutNotes(m: Model): Model {
  const strip = <T extends { notes: string }>(r: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.notes === '' ? v : { ...v, notes: '' }]))
  return { ...m, nodes: strip(m.nodes), connectors: strip(m.connectors), boundaries: strip(m.boundaries) }
}
