// Text exports: lossless Harpoon JSON, the LLM interchange shape from the spec (plus its JSON Schema), Mermaid
// (flowchart and one sequence diagram per flow), PlantUML C4. Pure functions over the model.
import { z } from 'zod'
import { childrenOf } from '../../shared/model/queries.ts'
import { ProjectFileZ, layoutFileOf, projectFileOf } from '../../shared/model/schema.ts'
import { flowSequence } from '../../shared/model/sequence.ts'
import type { HxConnector, HxNode, Model } from '../../shared/model/schema.ts'

export function harpoonJson(m: Model): string {
  return `${JSON.stringify({ ...projectFileOf(m), layout: layoutFileOf(m).nodes }, null, 2)}\n`
}

/** The spec's "Unified JSON Schema Interface": flat nodes with features, duplex connectors, boundaries. */
export function interchangeJson(m: Model): string {
  const out = {
    system: m.meta.name,
    description: m.meta.description,
    nodes: Object.values(m.nodes).map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      boundary: n.boundary,
      ...(n.role !== null ? { role: n.role } : {}),
      ...(n.techStack !== null ? { techStack: n.techStack } : {}),
      ...(n.vendor !== null ? { vendor: n.vendor } : {}),
      ...(n.hosting !== null ? { hosting: n.hosting } : {}),
      ...(n.provider !== null ? { provider: n.provider } : {}),
      ...(n.region !== null ? { region: n.region } : {}),
      ...(n.parentId !== null ? { subsystem: n.parentId } : {}),
      ...(n.team !== null ? { team: n.team } : {}),
      ...(n.owner !== null ? { owner: n.owner } : {}),
      ...(n.sensitivity !== null ? { sensitivity: n.sensitivity } : {}),
      ...(n.dataClasses.length > 0 ? { dataClasses: n.dataClasses } : {}),
      ...(n.phase !== null ? { phase: n.phase } : {}),
      ...(n.notes !== '' ? { notes: n.notes } : {}),
      status: n.status,
      description: n.description,
      features: n.features.map((f) => ({ name: f.name, category: f.category, ...(f.protocol !== null ? { protocol: f.protocol } : {}), ...(f.endpoint !== null ? { endpoint: f.endpoint } : {}) })),
    })),
    connectors: Object.values(m.connectors).map((c) => ({
      id: c.id,
      source: c.source,
      target: c.target,
      isDuplex: c.duplex,
      sync: c.sync,
      channelA: strip(c.channelA),
      ...(c.channelB !== null ? { channelB: strip(c.channelB) } : {}),
      ...(c.team !== null ? { team: c.team } : {}),
      ...(c.phase !== null ? { phase: c.phase } : {}),
      ...(c.notes !== '' ? { notes: c.notes } : {}),
    })),
    boundaries: Object.values(m.boundaries).map((b) => ({ id: b.id, name: b.name, type: b.type, nodeIds: b.nodeIds, ...(b.dataClasses.length > 0 ? { approvedData: b.dataClasses } : {}) })),
    ...(m.meta.teams.length > 0 ? { teams: m.meta.teams } : {}),
    ...(m.meta.phases.length > 0 ? { phases: m.meta.phases } : {}),
    ...(m.meta.dataClasses.length > 0 ? { dataClasses: m.meta.dataClasses } : {}),
    flows: Object.values(m.flows).map((f) => ({ id: f.id, name: f.name, steps: f.steps })),
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

function strip<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))) as Partial<T>
}

/** JSON Schema of the native project file (generated from the same zod schema that validates it). */
export function projectJsonSchema(): string {
  return `${JSON.stringify(z.toJSONSchema(ProjectFileZ, { io: 'input', unrepresentable: 'any' }), null, 2)}\n`
}

// ---- Mermaid ------------------------------------------------------------------------------------------------------

const mid = (id: string): string => `n_${id.replace(/[^A-Za-z0-9_]/g, '_')}`
const mlabel = (s: string): string => s.replace(/"/g, "'").replace(/[\r\n]+/g, ' ')

export function mermaidFlowchart(m: Model): string {
  const lines = ['flowchart LR']
  const shape = (n: HxNode): string => {
    const label = `"${mlabel(n.name)}${n.techStack !== null ? `<br/><small>${mlabel(n.techStack)}</small>` : ''}"`
    switch (n.kind) {
      case 'database':
      case 'storage':
        return `${mid(n.id)}[(${label})]`
      case 'queue':
      case 'stream':
        return `${mid(n.id)}>${label}]`
      case 'client':
        return `${mid(n.id)}([${label}])`
      default:
        return `${mid(n.id)}{{${label}}}`
    }
  }
  const emit = (parentId: string | null, indent: string): void => {
    for (const n of childrenOf(m, parentId).sort((a, b) => a.name.localeCompare(b.name))) {
      const kids = childrenOf(m, n.id)
      if (kids.length > 0) {
        lines.push(`${indent}subgraph ${mid(n.id)}_g["${mlabel(n.name)}"]`)
        lines.push(`${indent}  ${shape(n)}`)
        emit(n.id, `${indent}  `)
        lines.push(`${indent}end`)
      } else lines.push(`${indent}${shape(n)}`)
    }
  }
  emit(null, '  ')
  for (const c of Object.values(m.connectors)) {
    const proto = mlabel(c.label ?? c.channelA.protocol)
    lines.push(`  ${mid(c.source)} ${c.sync === 'async' ? '-.->' : '-->'}|"${proto}${c.channelA.auth !== null ? ` · ${mlabel(c.channelA.auth)}` : ''}"| ${mid(c.target)}`)
    if (c.duplex && c.channelB !== null) lines.push(`  ${mid(c.target)} -.->|"${mlabel(c.channelB.protocol)}"| ${mid(c.source)}`)
  }
  const ext = Object.values(m.nodes).filter((n) => n.boundary === 'external').map((n) => mid(n.id))
  const planned = Object.values(m.nodes).filter((n) => n.status === 'planned').map((n) => mid(n.id))
  lines.push('  classDef external stroke-dasharray: 5 4,stroke:#d9a441')
  lines.push('  classDef planned stroke-dasharray: 2 4,opacity:0.7')
  if (ext.length > 0) lines.push(`  class ${ext.join(',')} external`)
  if (planned.length > 0) lines.push(`  class ${planned.join(',')} planned`)
  return `${lines.join('\n')}\n`
}

export function mermaidSequences(m: Model): string {
  const out: string[] = []
  for (const f of Object.values(m.flows)) {
    const seq = flowSequence(m, f)
    const arrow = { sync: '->>', async: '-)', reply: '-->>' } as const
    out.push(
      [
        `%% ${f.name}`,
        'sequenceDiagram',
        ...seq.participants.map((p) => `  participant ${mid(p.id)} as ${mlabel(p.name)}`),
        ...seq.messages.map((s) => `  ${mid(s.from)}${arrow[s.kind]}${mid(s.to)}: ${mlabel(s.label)}`),
      ].join('\n'),
    )
  }
  return out.length === 0 ? '' : `${out.join('\n\n')}\n`
}

// ---- PlantUML C4 ------------------------------------------------------------------------------------------------

const pid = (id: string): string => id.replace(/[^A-Za-z0-9_]/g, '_')
const pq = (s: string): string => `"${s.replace(/"/g, "'").replace(/[\r\n]+/g, ' ')}"`

export function plantUml(m: Model): string {
  const lines = ['@startuml', '!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml', '', `title ${m.meta.name}`, '']
  const inBoundary = new Set(Object.values(m.boundaries).flatMap((b) => b.nodeIds))
  const element = (n: HxNode, indent: string): string => {
    const desc = pq(n.description.split('\n')[0]?.slice(0, 120) ?? '')
    const tech = pq(n.techStack ?? n.vendor ?? '')
    if (n.kind === 'client') return `${indent}Person_Ext(${pid(n.id)}, ${pq(n.name)}, ${desc})`
    if (n.boundary === 'external') return `${indent}System_Ext(${pid(n.id)}, ${pq(n.name)}, ${desc})`
    if (n.kind === 'database' || n.kind === 'cache' || n.kind === 'storage') return `${indent}ContainerDb(${pid(n.id)}, ${pq(n.name)}, ${tech}, ${desc})`
    if (n.kind === 'queue' || n.kind === 'stream') return `${indent}ContainerQueue(${pid(n.id)}, ${pq(n.name)}, ${tech}, ${desc})`
    return `${indent}Container(${pid(n.id)}, ${pq(n.name)}, ${tech}, ${desc})`
  }
  const emitNode = (n: HxNode, indent: string): void => {
    const kids = childrenOf(m, n.id)
    if (kids.length === 0) {
      lines.push(element(n, indent))
      return
    }
    lines.push(`${indent}Container_Boundary(${pid(n.id)}_b, ${pq(n.name)}) {`)
    lines.push(element(n, `${indent}  `))
    for (const k of kids) emitNode(k, `${indent}  `)
    lines.push(`${indent}}`)
  }
  for (const b of Object.values(m.boundaries)) {
    lines.push(`${b.type === 'third-party' ? 'Enterprise_Boundary' : 'System_Boundary'}(${pid(b.id)}, ${pq(b.name)}) {`)
    for (const id of b.nodeIds) {
      const n = m.nodes[id]
      if (n !== undefined && n.parentId === b.parentId) emitNode(n, '  ')
    }
    lines.push('}')
  }
  for (const n of childrenOf(m, null)) if (!inBoundary.has(n.id)) emitNode(n, '')
  lines.push('')
  const rel = (c: HxConnector): string => `Rel(${pid(c.source)}, ${pid(c.target)}, ${pq(c.label ?? c.channelA.protocol)}, ${pq([c.channelA.protocol, c.channelA.auth, c.sync === 'async' ? 'async' : null].filter((x) => x !== null).join(' / '))})`
  for (const c of Object.values(m.connectors)) lines.push(rel(c))
  lines.push('@enduml')
  return `${lines.join('\n')}\n`
}
