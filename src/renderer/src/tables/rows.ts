// The rows behind each table: pure functions of the model, so the tables, CSV export and tests agree.
import { channelEncrypted, connectorDataClasses, dataClassLabel, dataScope, effectiveTeam, phasesInOrder } from '@shared/model/governance.ts'
import { KIND_INFO, protocolFamily } from '@shared/model/kinds.ts'
import type { ProtocolFamily } from '@shared/model/kinds.ts'
import { lintModel } from '@shared/model/lint.ts'
import type { Problem } from '@shared/model/lint.ts'
import { ancestorsOf, childrenOf, pathLabel } from '@shared/model/queries.ts'
import type { HxNode, Model, Status } from '@shared/model/schema.ts'

const teamName = (m: Model, id: string | null): string => (id === null ? '' : (m.meta.teams.find((t) => t.id === id)?.name ?? id))
const phaseName = (m: Model, id: string | null): string => (id === null ? '' : (m.meta.phases.find((p) => p.id === id)?.name ?? id))

export interface ServiceRow {
  id: string
  name: string
  path: string
  kind: string
  kindLabel: string
  status: Status
  boundary: string
  team: string
  teamId: string | null
  teamInherited: boolean
  owner: string
  hosting: string
  provider: string
  region: string
  tech: string
  data: string
  dataIds: string[]
  sensitivity: string
  phase: string
  phaseId: string | null
  features: number
  inbound: number
  outbound: number
  problems: number
  notes: string
  subRows?: ServiceRow[]
}

export function serviceRows(m: Model, problems: readonly Problem[] = lintModel(m)): ServiceRow[] {
  const scope = dataScope(m)
  const inbound = new Map<string, number>()
  const outbound = new Map<string, number>()
  for (const c of Object.values(m.connectors)) {
    outbound.set(c.source, (outbound.get(c.source) ?? 0) + 1)
    inbound.set(c.target, (inbound.get(c.target) ?? 0) + 1)
  }
  const probs = new Map<string, number>()
  for (const p of problems) if (p.nodeId !== undefined) probs.set(p.nodeId, (probs.get(p.nodeId) ?? 0) + 1)
  const row = (n: HxNode): ServiceRow => {
    const t = effectiveTeam(m, n.id)
    const dataIds = [...(scope.get(n.id)?.keys() ?? [])]
    const kids = childrenOf(m, n.id).sort((a, b) => a.name.localeCompare(b.name))
    return {
      id: n.id,
      name: n.name,
      path: pathLabel(m, n.id),
      kind: n.kind,
      kindLabel: KIND_INFO[n.kind].label,
      status: n.status,
      boundary: n.boundary,
      team: teamName(m, t?.team ?? null),
      teamId: n.team,
      teamInherited: t?.inherited === true,
      owner: n.owner ?? '',
      hosting: n.hosting ?? '',
      provider: n.provider ?? '',
      region: n.region ?? '',
      tech: n.techStack ?? '',
      data: dataIds.map((d) => dataClassLabel(m.meta, d)).join(', '),
      dataIds,
      sensitivity: n.sensitivity ?? '',
      phase: phaseName(m, n.phase),
      phaseId: n.phase,
      features: n.features.length,
      inbound: inbound.get(n.id) ?? 0,
      outbound: outbound.get(n.id) ?? 0,
      problems: probs.get(n.id) ?? 0,
      notes: n.notes,
      ...(kids.length > 0 ? { subRows: kids.map(row) } : {}),
    }
  }
  return childrenOf(m, null)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(row)
}

export interface ConnectorRow {
  id: string
  source: string
  target: string
  sourceId: string
  targetId: string
  protocol: string
  returnProtocol: string
  sync: string
  auth: string
  encrypted: string
  data: string
  status: Status
  team: string
  teamId: string | null
  phase: string
  phaseId: string | null
  notes: string
}

export function connectorRows(m: Model): ConnectorRow[] {
  return Object.values(m.connectors)
    .map((c) => ({
      id: c.id,
      source: pathLabel(m, c.source),
      target: pathLabel(m, c.target),
      sourceId: c.source,
      targetId: c.target,
      protocol: c.channelA.protocol,
      returnProtocol: c.channelB?.protocol ?? '',
      sync: c.sync,
      auth: c.channelA.auth ?? '',
      encrypted: channelEncrypted(c.channelA) && (c.channelB === null || channelEncrypted(c.channelB)) ? 'yes' : 'no',
      data: connectorDataClasses(c)
        .map((d) => dataClassLabel(m.meta, d))
        .join(', '),
      status: c.status,
      team: teamName(m, c.team),
      teamId: c.team,
      phase: phaseName(m, c.phase),
      phaseId: c.phase,
      notes: c.notes,
    }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
}

export interface EndpointRow {
  id: string
  nodeId: string
  featureId: string
  service: string
  name: string
  category: string
  protocol: string
  endpoint: string
  status: Status
  phase: string
  phaseId: string | null
  sla: string
  contract: string
}

export function endpointRows(m: Model): EndpointRow[] {
  const out: EndpointRow[] = []
  for (const n of Object.values(m.nodes)) {
    for (const f of n.features) {
      const sla = f.sla === null ? '' : [f.sla.p50Ms !== null ? `p50 ${f.sla.p50Ms}ms` : '', f.sla.p99Ms !== null ? `p99 ${f.sla.p99Ms}ms` : '', f.sla.maxRps !== null ? `${f.sla.maxRps} rps` : ''].filter(Boolean).join(', ')
      out.push({
        id: `${n.id}/${f.id}`,
        nodeId: n.id,
        featureId: f.id,
        service: pathLabel(m, n.id),
        name: f.name,
        category: f.category,
        protocol: f.protocol ?? '',
        endpoint: f.endpoint ?? '',
        status: f.status,
        phase: phaseName(m, f.phase),
        phaseId: f.phase,
        sla,
        contract: f.contract === null ? '' : f.contract.kind,
      })
    }
  }
  return out.sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name))
}

export interface DataRow {
  id: string
  dataClass: string
  regime: string
  entity: 'node' | 'connector'
  entityId: string
  name: string
  how: string
  encrypted: string
  zone: string
}

/** One row per (data class × node or connector that handles it), with how and where. */
export function dataRows(m: Model): DataRow[] {
  const out: DataRow[] = []
  const scope = dataScope(m)
  const zonesFor = (cls: string, nodeId: string): string[] =>
    Object.values(m.boundaries)
      .filter((b) => b.dataClasses.includes(cls) && (b.nodeIds.includes(nodeId) || b.nodeIds.some((id) => pathIds(m, nodeId).includes(id))))
      .map((b) => b.name)
  const zoned = (cls: string): boolean => Object.values(m.boundaries).some((b) => b.dataClasses.includes(cls))
  const regime = (cls: string): string => m.meta.dataClasses.find((d) => d.id === cls)?.regime ?? builtInRegime(cls)
  for (const [nodeId, byCls] of scope) {
    for (const [cls, why] of byCls) {
      const zones = zonesFor(cls, nodeId)
      out.push({
        id: `${cls}/n/${nodeId}`,
        dataClass: dataClassLabel(m.meta, cls),
        regime: regime(cls),
        entity: 'node',
        entityId: nodeId,
        name: pathLabel(m, nodeId),
        how: why.own ? 'stores / processes' : why.via.length > 0 ? 'sends / receives' : 'inside',
        encrypted: '',
        zone: zones.length > 0 ? zones.join(', ') : zoned(cls) ? 'outside approved zone' : '',
      })
    }
  }
  for (const c of Object.values(m.connectors)) {
    for (const [ch, dir] of [
      [c.channelA, 'request'],
      [c.channelB, 'response'],
    ] as const) {
      if (ch === null) continue
      for (const cls of ch.dataClasses) {
        out.push({
          id: `${cls}/c/${c.id}/${dir}`,
          dataClass: dataClassLabel(m.meta, cls),
          regime: regime(cls),
          entity: 'connector',
          entityId: c.id,
          name: `${pathLabel(m, dir === 'request' ? c.source : c.target)} → ${pathLabel(m, dir === 'request' ? c.target : c.source)}`,
          how: `in transit (${ch.protocol})`,
          encrypted: channelEncrypted(ch) ? 'yes' : 'no',
          zone: '',
        })
      }
    }
  }
  return out.sort((a, b) => a.dataClass.localeCompare(b.dataClass) || a.name.localeCompare(b.name))
}

const pathIds = (m: Model, id: string): string[] => {
  const out: string[] = []
  for (let cur = m.nodes[id]?.parentId ?? null; cur !== null; cur = m.nodes[cur]?.parentId ?? null) out.push(cur)
  return out
}

const BUILT_IN_REGIME: Record<string, string> = { pii: 'GDPR / CCPA', phi: 'HIPAA', pci: 'PCI DSS', cji: 'CJIS', ferpa: 'FERPA', fin: 'SOX / GLBA', special: 'GDPR Art. 9' }
const builtInRegime = (cls: string): string => BUILT_IN_REGIME[cls] ?? ''

export interface ChangeRow {
  id: string
  entity: 'node' | 'connector' | 'feature'
  entityId: string
  nodeId: string | null
  name: string
  what: string
  change: string
  status: Status
  phase: string
  phaseId: string | null
  /** Sort key: the phase's position (unphased last). */
  phaseOrder: number
}

const CHANGE: Record<Status, string> = { planned: 'add', 'in-progress': 'building', deprecated: 'retire', removed: 'removed', existing: '' }

/** Everything not simply built: planned, in progress, deprecated, removed. The roadmap as a list. */
export function changeRows(m: Model): ChangeRow[] {
  const order = phasesInOrder(m.meta)
  const rank = (phase: string | null): number => {
    const i = phase === null ? -1 : order.findIndex((p) => p.id === phase)
    return i < 0 ? 999 : i
  }
  const out: ChangeRow[] = []
  for (const n of Object.values(m.nodes)) {
    if (n.status !== 'existing') out.push({ id: `n/${n.id}`, entity: 'node', entityId: n.id, nodeId: n.id, name: pathLabel(m, n.id), what: KIND_INFO[n.kind].label, change: CHANGE[n.status], status: n.status, phase: phaseName(m, n.phase), phaseId: n.phase, phaseOrder: rank(n.phase) })
    for (const f of n.features) {
      if (f.status !== 'existing') out.push({ id: `f/${n.id}/${f.id}`, entity: 'feature', entityId: f.id, nodeId: n.id, name: `${pathLabel(m, n.id)} › ${f.name}`, what: 'Feature', change: CHANGE[f.status], status: f.status, phase: phaseName(m, f.phase), phaseId: f.phase, phaseOrder: rank(f.phase) })
    }
  }
  for (const c of Object.values(m.connectors)) {
    if (c.status !== 'existing') out.push({ id: `c/${c.id}`, entity: 'connector', entityId: c.id, nodeId: null, name: `${pathLabel(m, c.source)} → ${pathLabel(m, c.target)}`, what: `Connector (${c.channelA.protocol})`, change: CHANGE[c.status], status: c.status, phase: phaseName(m, c.phase), phaseId: c.phase, phaseOrder: rank(c.phase) })
  }
  return out.sort((a, b) => a.phaseOrder - b.phaseOrder || a.name.localeCompare(b.name))
}

export interface ProblemRow {
  id: string
  severity: Problem['severity']
  code: string
  message: string
  entity: 'node' | 'connector' | 'boundary' | 'flow' | 'project'
  entityId: string | null
}

export function problemRows(problems: readonly Problem[]): ProblemRow[] {
  return problems.map((p, i) => ({
    id: `${i}-${p.code}`,
    severity: p.severity,
    code: p.code,
    message: p.message,
    entity: p.nodeId !== undefined ? 'node' : p.connectorId !== undefined ? 'connector' : p.boundaryId !== undefined ? 'boundary' : p.flowId !== undefined ? 'flow' : 'project',
    entityId: p.nodeId ?? p.connectorId ?? p.boundaryId ?? p.flowId ?? null,
  }))
}

export interface MatrixCell {
  /** Row → column: the connectors whose source sits in the row and target in the column. */
  connectorIds: string[]
  protocols: string[]
  /** The protocol family they share, or 'mixed'. */
  family: ProtocolFamily | 'mixed'
  families: ProtocolFamily[]
  problems: number
}

export interface DependencyMatrix {
  services: { id: string; name: string; depth: number }[]
  /** Keyed `${rowId}>${colId}`; absent where nothing connects. */
  cells: Record<string, MatrixCell>
}

/** Services × services. Top level by default (connectors lifted to their top-level service); with `inner` every
 * part gets its own row and column, in tree order. */
export function dependencyMatrix(m: Model, problems: readonly Problem[] = lintModel(m), inner = false): DependencyMatrix {
  const services: DependencyMatrix['services'] = []
  const walk = (parentId: string | null, depth: number): void => {
    for (const n of childrenOf(m, parentId).sort((a, b) => a.name.localeCompare(b.name))) {
      services.push({ id: n.id, name: n.name, depth })
      if (inner) walk(n.id, depth + 1)
    }
  }
  walk(null, 0)
  const top = (id: string): string => (inner ? id : (ancestorsOf(m, id).at(-1)?.id ?? id))
  const probs = new Map<string, number>()
  for (const p of problems) if (p.connectorId !== undefined) probs.set(p.connectorId, (probs.get(p.connectorId) ?? 0) + 1)
  const cells: DependencyMatrix['cells'] = {}
  for (const c of Object.values(m.connectors).sort((a, b) => a.id.localeCompare(b.id))) {
    const key = `${top(c.source)}>${top(c.target)}`
    const cell = (cells[key] ??= { connectorIds: [], protocols: [], family: 'other', families: [], problems: 0 })
    cell.connectorIds.push(c.id)
    if (!cell.protocols.includes(c.channelA.protocol)) cell.protocols.push(c.channelA.protocol)
    const fam = protocolFamily(c.channelA.protocol)
    if (!cell.families.includes(fam)) cell.families.push(fam)
    cell.family = cell.families.length === 1 ? fam : 'mixed'
    cell.problems += probs.get(c.id) ?? 0
  }
  return { services, cells }
}

/** A cell value as text (lists joined). */
export function cellText(v: unknown): string {
  if (Array.isArray(v)) return v.map(cellText).join(', ')
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
}

/** Rows as CSV (RFC 4180 quoting), columns in the given order. */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const q = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return `${[header, ...rows].map((r) => r.map(q).join(',')).join('\r\n')}\r\n`
}

/** Rows as a Markdown table. */
export function toMarkdown(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const cell = (v: string): string => v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  return `${[`| ${header.map(cell).join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n')}\n`
}
