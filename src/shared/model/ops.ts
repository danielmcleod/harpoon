// Ops: the only way the model changes. User edits, undo/redo, AI tool calls, imports and proposals all produce
// ops; `applyOps` applies a batch immutably, checks referential integrity and returns the inverse batch (undo).
//
// Primitive ops keep the model consistent on their own: removing a node takes it out of boundaries and drops its
// layout; removing a connector drops it from flows (the inverse puts all of that back). Removing a node that still has
// children or connectors is refused: use `removeNodeOps` to cascade.
import { z } from 'zod'
import { deepEqual } from './equal.ts'
import { descendantIds, isSelfOrAncestor } from './queries.ts'
import {
  BoundaryPatchZ,
  BoundaryZ,
  ConnectorPatchZ,
  ConnectorZ,
  FlowPatchZ,
  FlowZ,
  HexCoordZ,
  IdZ,
  MetaPatchZ,
  NodePatchZ,
  NodeZ,
} from './schema.ts'
import type {
  BoundaryPatch,
  ConnectorPatch,
  FlowPatch,
  HexCoord,
  HxBoundary,
  HxConnector,
  HxFlow,
  HxNode,
  MetaPatch,
  Model,
  NodePatch,
} from './schema.ts'

export const OpZ = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addNode'), node: NodeZ, at: HexCoordZ.nullable().default(null) }),
  z.object({ op: z.literal('updateNode'), id: IdZ, patch: NodePatchZ }),
  z.object({ op: z.literal('removeNode'), id: IdZ }),
  z.object({ op: z.literal('addConnector'), connector: ConnectorZ }),
  z.object({ op: z.literal('updateConnector'), id: IdZ, patch: ConnectorPatchZ }),
  z.object({ op: z.literal('removeConnector'), id: IdZ }),
  z.object({ op: z.literal('addBoundary'), boundary: BoundaryZ }),
  z.object({ op: z.literal('updateBoundary'), id: IdZ, patch: BoundaryPatchZ }),
  z.object({ op: z.literal('removeBoundary'), id: IdZ }),
  z.object({ op: z.literal('addFlow'), flow: FlowZ }),
  z.object({ op: z.literal('updateFlow'), id: IdZ, patch: FlowPatchZ }),
  z.object({ op: z.literal('removeFlow'), id: IdZ }),
  z.object({ op: z.literal('setLayout'), id: IdZ, at: HexCoordZ.nullable() }),
  z.object({ op: z.literal('updateMeta'), patch: MetaPatchZ }),
])

export type Op =
  | { op: 'addNode'; node: HxNode; at: HexCoord | null }
  | { op: 'updateNode'; id: string; patch: NodePatch }
  | { op: 'removeNode'; id: string }
  | { op: 'addConnector'; connector: HxConnector }
  | { op: 'updateConnector'; id: string; patch: ConnectorPatch }
  | { op: 'removeConnector'; id: string }
  | { op: 'addBoundary'; boundary: HxBoundary }
  | { op: 'updateBoundary'; id: string; patch: BoundaryPatch }
  | { op: 'removeBoundary'; id: string }
  | { op: 'addFlow'; flow: HxFlow }
  | { op: 'updateFlow'; id: string; patch: FlowPatch }
  | { op: 'removeFlow'; id: string }
  | { op: 'setLayout'; id: string; at: HexCoord | null }
  | { op: 'updateMeta'; patch: MetaPatch }

/** Parse untrusted ops (IPC, AI, files). Absent patch keys stay absent; explicit undefined values are dropped. */
export function parseOps(raw: unknown): Op[] {
  return z.array(OpZ).parse(raw).map((o) => ('patch' in o ? { ...o, patch: defined(o.patch) } : o)) as Op[]
}

function defined<T extends object>(patch: T): T {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as T
}

export class OpError extends Error {
  readonly index: number
  constructor(index: number, message: string) {
    super(message)
    this.name = 'OpError'
    this.index = index
  }
}

export interface ApplyResult {
  model: Model
  /** Applying these to `model` gives back the input model. */
  inverse: Op[]
}

/** Values of `obj` for the keys of `patch` (the inverse patch). */
function previous<T extends object, P extends { [K in keyof T]?: T[K] }>(obj: T, patch: P): P {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) out[k] = (obj as Record<string, unknown>)[k]
  return out as P
}

/** `obj` with the patch's defined values. */
function merge<T extends object>(obj: T, patch: { [K in keyof T]?: T[K] }): T {
  return { ...obj, ...defined(patch) }
}

/** Apply a batch. Throws OpError (with the failing op's index) and leaves the input untouched. */
export function applyOps(input: Model, ops: readonly Op[]): ApplyResult {
  const m: Model = {
    meta: input.meta,
    nodes: { ...input.nodes },
    connectors: { ...input.connectors },
    boundaries: { ...input.boundaries },
    flows: { ...input.flows },
    layout: { ...input.layout },
  }
  const inverse: Op[][] = []

  ops.forEach((o, i) => {
    const fail = (msg: string): never => {
      throw new OpError(i, `${o.op}: ${msg}`)
    }
    const inv: Op[] = []
    switch (o.op) {
      case 'addNode': {
        const n = o.node
        if (m.nodes[n.id] !== undefined) fail(`a node "${n.id}" already exists`)
        if (n.parentId !== null && m.nodes[n.parentId] === undefined) fail(`parent "${n.parentId}" not found`)
        m.nodes[n.id] = n
        if (o.at !== null) m.layout[n.id] = o.at
        inv.push({ op: 'removeNode', id: n.id })
        break
      }
      case 'updateNode': {
        const cur = m.nodes[o.id] ?? fail(`node "${o.id}" not found`)
        const parent = o.patch.parentId
        if (parent !== undefined && parent !== cur.parentId && parent !== null) {
          if (m.nodes[parent] === undefined) fail(`parent "${parent}" not found`)
          if (isSelfOrAncestor(m, o.id, parent)) fail(`"${o.id}" cannot move inside itself`)
        }
        m.nodes[o.id] = merge(cur, o.patch)
        inv.push({ op: 'updateNode', id: o.id, patch: previous(cur, o.patch) })
        break
      }
      case 'removeNode': {
        const cur = m.nodes[o.id] ?? fail(`node "${o.id}" not found`)
        if (Object.values(m.nodes).some((n) => n.parentId === o.id)) fail(`"${o.id}" still has children`)
        if (Object.values(m.connectors).some((c) => c.source === o.id || c.target === o.id)) {
          fail(`"${o.id}" still has connectors`)
        }
        // Inverse order matters: the node comes back first, then its boundary memberships.
        inv.push({ op: 'addNode', node: cur, at: m.layout[o.id] ?? null })
        for (const b of Object.values(m.boundaries)) {
          if (!b.nodeIds.includes(o.id)) continue
          m.boundaries[b.id] = { ...b, nodeIds: b.nodeIds.filter((x) => x !== o.id) }
          inv.push({ op: 'updateBoundary', id: b.id, patch: { nodeIds: b.nodeIds } })
        }
        delete m.nodes[o.id]
        delete m.layout[o.id]
        inverse.push(inv)
        return
      }
      case 'addConnector': {
        const c = o.connector
        if (m.connectors[c.id] !== undefined) fail(`a connector "${c.id}" already exists`)
        if (m.nodes[c.source] === undefined) fail(`source "${c.source}" not found`)
        if (m.nodes[c.target] === undefined) fail(`target "${c.target}" not found`)
        if (c.source === c.target) fail('a connector needs two different nodes')
        m.connectors[c.id] = c
        inv.push({ op: 'removeConnector', id: c.id })
        break
      }
      case 'updateConnector': {
        const cur = m.connectors[o.id] ?? fail(`connector "${o.id}" not found`)
        const next = merge(cur, o.patch)
        if (m.nodes[next.source] === undefined) fail(`source "${next.source}" not found`)
        if (m.nodes[next.target] === undefined) fail(`target "${next.target}" not found`)
        if (next.source === next.target) fail('a connector needs two different nodes')
        m.connectors[o.id] = next
        inv.push({ op: 'updateConnector', id: o.id, patch: previous(cur, o.patch) })
        break
      }
      case 'removeConnector': {
        const cur = m.connectors[o.id] ?? fail(`connector "${o.id}" not found`)
        inv.push({ op: 'addConnector', connector: cur })
        for (const f of Object.values(m.flows)) {
          if (!f.steps.some((s) => s.connectorId === o.id)) continue
          m.flows[f.id] = { ...f, steps: f.steps.filter((s) => s.connectorId !== o.id) }
          inv.push({ op: 'updateFlow', id: f.id, patch: { steps: f.steps } })
        }
        delete m.connectors[o.id]
        inverse.push(inv)
        return
      }
      case 'addBoundary': {
        const b = o.boundary
        if (m.boundaries[b.id] !== undefined) fail(`a boundary "${b.id}" already exists`)
        if (b.parentId !== null && m.nodes[b.parentId] === undefined) fail(`parent "${b.parentId}" not found`)
        m.boundaries[b.id] = b
        inv.push({ op: 'removeBoundary', id: b.id })
        break
      }
      case 'updateBoundary': {
        const cur = m.boundaries[o.id] ?? fail(`boundary "${o.id}" not found`)
        m.boundaries[o.id] = merge(cur, o.patch)
        inv.push({ op: 'updateBoundary', id: o.id, patch: previous(cur, o.patch) })
        break
      }
      case 'removeBoundary': {
        const cur = m.boundaries[o.id] ?? fail(`boundary "${o.id}" not found`)
        delete m.boundaries[o.id]
        inv.push({ op: 'addBoundary', boundary: cur })
        break
      }
      case 'addFlow': {
        if (m.flows[o.flow.id] !== undefined) fail(`a flow "${o.flow.id}" already exists`)
        m.flows[o.flow.id] = o.flow
        inv.push({ op: 'removeFlow', id: o.flow.id })
        break
      }
      case 'updateFlow': {
        const cur = m.flows[o.id] ?? fail(`flow "${o.id}" not found`)
        m.flows[o.id] = merge(cur, o.patch)
        inv.push({ op: 'updateFlow', id: o.id, patch: previous(cur, o.patch) })
        break
      }
      case 'removeFlow': {
        const cur = m.flows[o.id] ?? fail(`flow "${o.id}" not found`)
        delete m.flows[o.id]
        inv.push({ op: 'addFlow', flow: cur })
        break
      }
      case 'setLayout': {
        if (m.nodes[o.id] === undefined) fail(`node "${o.id}" not found`)
        const prev = m.layout[o.id] ?? null
        if (o.at === null) delete m.layout[o.id]
        else m.layout[o.id] = o.at
        inv.push({ op: 'setLayout', id: o.id, at: prev })
        break
      }
      case 'updateMeta': {
        const cur = m.meta
        m.meta = merge(cur, o.patch)
        inv.push({ op: 'updateMeta', patch: previous(cur, o.patch) })
        break
      }
    }
    inverse.push(inv)
  })

  return { model: m, inverse: inverse.reverse().flat() }
}

/** The ops that remove a node with everything inside it and every connector touching that subtree. */
export function removeNodeOps(m: Model, id: string): Op[] {
  if (m.nodes[id] === undefined) return []
  const subtree = new Set([id, ...descendantIds(m, id)])
  const ops: Op[] = []
  for (const c of Object.values(m.connectors)) {
    if (subtree.has(c.source) || subtree.has(c.target)) ops.push({ op: 'removeConnector', id: c.id })
  }
  for (const b of Object.values(m.boundaries)) {
    if (b.parentId !== null && subtree.has(b.parentId)) ops.push({ op: 'removeBoundary', id: b.id })
  }
  // Deepest first, so every node is childless when it goes.
  const depth = (n: string): number => {
    let d = 0
    let cur = m.nodes[n]?.parentId ?? null
    while (cur !== null) {
      d++
      cur = m.nodes[cur]?.parentId ?? null
    }
    return d
  }
  for (const n of [...subtree].sort((a, b) => depth(b) - depth(a))) ops.push({ op: 'removeNode', id: n })
  return ops
}

/** A patch with only the keys whose values differ from `cur` (empty: nothing to do). */
export function changedFields<T extends object, P extends { [K in keyof T]?: T[K] }>(cur: T, patch: P): P {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && !deepEqual((cur as Record<string, unknown>)[k], v)) out[k] = v
  }
  return out as P
}

/** Ops touch these entities (for highlighting what a batch changed). */
export function touchedIds(ops: readonly Op[]): { nodes: Set<string>; connectors: Set<string> } {
  const nodes = new Set<string>()
  const connectors = new Set<string>()
  for (const o of ops) {
    switch (o.op) {
      case 'addNode':
        nodes.add(o.node.id)
        break
      case 'updateNode':
      case 'removeNode':
      case 'setLayout':
        nodes.add(o.id)
        break
      case 'addConnector':
        connectors.add(o.connector.id)
        break
      case 'updateConnector':
      case 'removeConnector':
        connectors.add(o.id)
        break
      case 'addBoundary':
      case 'updateBoundary':
      case 'removeBoundary':
      case 'addFlow':
      case 'updateFlow':
      case 'removeFlow':
      case 'updateMeta':
        break
    }
  }
  return { nodes, connectors }
}
