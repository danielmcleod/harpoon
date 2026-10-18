// The architecture at the end of a roadmap phase: planned work whose phase has landed is in (and drawn as built),
// work planned for later or never scheduled is out, and what is retired by then is gone. The phase's own arrivals
// and retirements come back as a change summary, so the canvas can mark them like a diff (new in green, going in red).
import type { ChangeSummary, EntityChange } from './diff.ts'
import { phasesInOrder } from './governance.ts'
import type { Feature, HxConnector, HxNode, Model, Status } from './schema.ts'

export interface Projection {
  model: Model
  summary: ChangeSummary
  /** The phase's position (0-based) in the roadmap. */
  index: number
}

type Fate = 'present' | 'arrives' | 'retires' | 'absent'

/** What happens to an entity by the end of phase `i`, given its status and phase rank (null: no/unknown phase). */
function fate(status: Status, rank: number | null, i: number): Fate {
  switch (status) {
    case 'existing':
      return 'present'
    case 'planned':
    case 'in-progress':
      if (rank === null || rank > i) return 'absent'
      return rank === i ? 'arrives' : 'present'
    case 'deprecated':
      if (rank === null || rank > i) return 'present'
      return rank === i ? 'retires' : 'absent'
    case 'removed':
      if (rank === null) return 'absent'
      if (rank > i) return 'present'
      return rank === i ? 'retires' : 'absent'
  }
}

export function modelAsOf(m: Model, phaseId: string): Projection | null {
  const order = phasesInOrder(m.meta)
  const i = order.findIndex((p) => p.id === phaseId)
  if (i < 0) return null
  const rankOf = (phase: string | null): number | null => {
    if (phase === null) return null
    const r = order.findIndex((p) => p.id === phase)
    return r < 0 ? null : r
  }
  const landed = (s: Status): Status => (s === 'planned' || s === 'in-progress' ? 'existing' : s)
  const keepFeature = (f: Feature): Feature | null => {
    const fa = fate(f.status, rankOf(f.phase), i)
    return fa === 'absent' ? null : { ...f, status: fa === 'retires' ? f.status : landed(f.status) }
  }

  const fates = new Map<string, Fate>()
  const fateOfNode = (n: HxNode): Fate => {
    const known = fates.get(n.id)
    if (known !== undefined) return known
    const parent = n.parentId === null ? undefined : m.nodes[n.parentId]
    const pf = parent === undefined ? 'present' : fateOfNode(parent)
    let f = fate(n.status, rankOf(n.phase), i)
    // Inside something that is not there (yet, or any more): not there either.
    if (pf === 'absent') f = 'absent'
    else if (pf === 'retires' && f !== 'absent') f = 'retires'
    fates.set(n.id, f)
    return f
  }

  const nodes: Record<string, HxNode> = {}
  const changes: EntityChange[] = []
  for (const n of Object.values(m.nodes)) {
    const f = fateOfNode(n)
    if (f === 'absent') continue
    nodes[n.id] = {
      ...n,
      status: f === 'retires' ? n.status : landed(n.status),
      features: n.features.map(keepFeature).filter((x): x is Feature => x !== null),
    }
    if (f === 'arrives') changes.push({ id: n.id, kind: 'added', fields: [] })
    if (f === 'retires') changes.push({ id: n.id, kind: 'removed', fields: [] })
  }

  const connectors: Record<string, HxConnector> = {}
  const connChanges: EntityChange[] = []
  for (const c of Object.values(m.connectors)) {
    const s = nodes[c.source]
    const t = nodes[c.target]
    if (s === undefined || t === undefined) continue
    let f = fate(c.status, rankOf(c.phase), i)
    // An unscheduled planned link to something that has landed lands with it.
    if (c.phase === null && (c.status === 'planned' || c.status === 'in-progress')) {
      const ends = [fates.get(c.source), fates.get(c.target)]
      if (ends.includes('arrives')) f = 'arrives'
      else if (ends.every((e) => e === 'present') && [m.nodes[c.source], m.nodes[c.target]].some((e) => e?.status === 'planned' || e?.status === 'in-progress')) f = 'present'
    }
    if (fates.get(c.source) === 'retires' || fates.get(c.target) === 'retires') f = f === 'absent' ? 'absent' : 'retires'
    if (f === 'absent') continue
    connectors[c.id] = { ...c, status: f === 'retires' ? c.status : landed(c.status) }
    if (f === 'arrives') connChanges.push({ id: c.id, kind: 'added', fields: [] })
    if (f === 'retires') connChanges.push({ id: c.id, kind: 'removed', fields: [] })
  }

  const boundaries = Object.fromEntries(Object.entries(m.boundaries).map(([id, b]) => [id, { ...b, nodeIds: b.nodeIds.filter((x) => nodes[x] !== undefined) }]))
  const flows = Object.fromEntries(Object.entries(m.flows).filter(([, f]) => f.steps.every((st) => connectors[st.connectorId] !== undefined)))
  return {
    model: { ...m, nodes, connectors, boundaries, flows },
    summary: { nodes: changes, connectors: connChanges, boundaries: [], flows: [], moved: [], meta: [] },
    index: i,
  }
}
