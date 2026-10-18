// Model diffs: what changed between two models (for the Diff & Merge overlay, drift checks and proposals) and the
// ops that turn one into the other.
import { deepEqual } from './equal.ts'
import type { Op } from './ops.ts'
import type { HxNode, Model } from './schema.ts'

export type ChangeKind = 'added' | 'modified' | 'removed'

export interface EntityChange {
  id: string
  kind: ChangeKind
  /** Changed top-level fields (modified only). */
  fields: string[]
}

export interface ChangeSummary {
  nodes: EntityChange[]
  connectors: EntityChange[]
  boundaries: EntityChange[]
  flows: EntityChange[]
  /** Nodes whose position changed (not counted as a semantic change). */
  moved: string[]
  meta: string[]
}

function changedKeys(a: object, b: object): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const ar = a as Record<string, unknown>
  const br = b as Record<string, unknown>
  return [...keys].filter((k) => !deepEqual(ar[k], br[k])).sort()
}

function compareRecords<T extends object>(a: Record<string, T>, b: Record<string, T>): EntityChange[] {
  const out: EntityChange[] = []
  for (const [id, av] of Object.entries(a)) {
    const bv = b[id]
    if (bv === undefined) out.push({ id, kind: 'removed', fields: [] })
    else {
      const fields = changedKeys(av, bv)
      if (fields.length > 0) out.push({ id, kind: 'modified', fields })
    }
  }
  for (const id of Object.keys(b)) if (a[id] === undefined) out.push({ id, kind: 'added', fields: [] })
  return out.sort((x, y) => (x.id < y.id ? -1 : 1))
}

export function compareModels(a: Model, b: Model): ChangeSummary {
  const moved: string[] = []
  for (const id of Object.keys(b.nodes)) {
    if (a.nodes[id] === undefined) continue
    if (!deepEqual(a.layout[id] ?? null, b.layout[id] ?? null)) moved.push(id)
  }
  return {
    nodes: compareRecords(a.nodes, b.nodes),
    connectors: compareRecords(a.connectors, b.connectors),
    boundaries: compareRecords(a.boundaries, b.boundaries),
    flows: compareRecords(a.flows, b.flows),
    moved: moved.sort(),
    meta: changedKeys(a.meta, b.meta),
  }
}

export function isEmptySummary(s: ChangeSummary): boolean {
  return (
    s.nodes.length === 0 &&
    s.connectors.length === 0 &&
    s.boundaries.length === 0 &&
    s.flows.length === 0 &&
    s.moved.length === 0 &&
    s.meta.length === 0
  )
}

export function summaryCounts(s: ChangeSummary): Record<ChangeKind, number> {
  const out: Record<ChangeKind, number> = { added: 0, modified: 0, removed: 0 }
  for (const list of [s.nodes, s.connectors, s.boundaries, s.flows]) for (const c of list) out[c.kind]++
  return out
}

function depthIn(m: Model, id: string): number {
  let d = 0
  let cur: string | null = m.nodes[id]?.parentId ?? null
  const seen = new Set<string>()
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur)
    d++
    cur = m.nodes[cur]?.parentId ?? null
  }
  return d
}

function pick<T extends object>(obj: T, keys: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = (obj as Record<string, unknown>)[k]
  return out as Partial<T>
}

/**
 * Ops that turn `a` into `b`. Order: flows/boundaries out, connectors out, nodes in (parents first), node updates
 * (reparenting), nodes out (deepest first), connectors in/updated, boundaries and flows in/updated, layout, meta.
 */
export function diffModels(a: Model, b: Model): Op[] {
  const s = compareModels(a, b)
  const ops: Op[] = []
  const of = (list: typeof s.nodes, kind: 'added' | 'modified' | 'removed') => list.filter((c) => c.kind === kind)

  for (const c of of(s.flows, 'removed')) ops.push({ op: 'removeFlow', id: c.id })
  for (const c of of(s.boundaries, 'removed')) ops.push({ op: 'removeBoundary', id: c.id })
  for (const c of of(s.connectors, 'removed')) ops.push({ op: 'removeConnector', id: c.id })

  const added = of(s.nodes, 'added')
    .map((c) => b.nodes[c.id])
    .filter((n): n is HxNode => n !== undefined)
    .sort((x, y) => depthIn(b, x.id) - depthIn(b, y.id))
  for (const n of added) ops.push({ op: 'addNode', node: n, at: b.layout[n.id] ?? null })

  for (const c of of(s.nodes, 'modified')) {
    const n = b.nodes[c.id]
    if (n !== undefined) ops.push({ op: 'updateNode', id: c.id, patch: pick(n, c.fields) })
  }

  const removed = of(s.nodes, 'removed').sort((x, y) => depthIn(a, y.id) - depthIn(a, x.id))
  for (const c of removed) ops.push({ op: 'removeNode', id: c.id })

  for (const c of of(s.connectors, 'added')) {
    const k = b.connectors[c.id]
    if (k !== undefined) ops.push({ op: 'addConnector', connector: k })
  }
  for (const c of of(s.connectors, 'modified')) {
    const k = b.connectors[c.id]
    if (k !== undefined) ops.push({ op: 'updateConnector', id: c.id, patch: pick(k, c.fields) })
  }
  for (const c of of(s.boundaries, 'added')) {
    const x = b.boundaries[c.id]
    if (x !== undefined) ops.push({ op: 'addBoundary', boundary: x })
  }
  for (const c of of(s.boundaries, 'modified')) {
    const x = b.boundaries[c.id]
    if (x !== undefined) ops.push({ op: 'updateBoundary', id: c.id, patch: pick(x, c.fields) })
  }
  for (const c of of(s.flows, 'added')) {
    const x = b.flows[c.id]
    if (x !== undefined) ops.push({ op: 'addFlow', flow: x })
  }
  for (const c of of(s.flows, 'modified')) {
    const x = b.flows[c.id]
    if (x !== undefined) ops.push({ op: 'updateFlow', id: c.id, patch: pick(x, c.fields) })
  }
  for (const id of s.moved) ops.push({ op: 'setLayout', id, at: b.layout[id] ?? null })
  if (s.meta.length > 0) ops.push({ op: 'updateMeta', patch: pick(b.meta, s.meta.filter((k) => k !== 'id')) })
  return ops
}
