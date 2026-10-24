// Canvas edits as ops: where a dropped point lands (which container, which grid cell), new nodes from the palette,
// new connectors with sensible defaults, moves and reparenting.
import { coordKey, insideHex, nearestFreeCell, pixelToAxial } from '@shared/geometry/hex.ts'
import type { Point } from '@shared/geometry/hex.ts'
import type { Scene } from '@shared/geometry/scene.ts'
import { uniqueId } from '@shared/model/ids.ts'
import { KIND_INFO } from '@shared/model/kinds.ts'
import type { Op } from '@shared/model/ops.ts'
import { descendantIds } from '@shared/model/queries.ts'
import { arrangeLevel } from '@shared/geometry/tidy.ts'
import { ChannelZ, ConnectorZ, NodeZ } from '@shared/model/schema.ts'
import type { HexCoord, HxNode, Model, NodeKind } from '@shared/model/schema.ts'

/** The deepest expanded container whose hexagon contains `p` (skipping `exclude`), else the canvas level. */
export function containerAt(scene: Scene, p: Point, exclude: ReadonlySet<string> = new Set()): { parentId: string | null; origin: Point } {
  let best: { id: string; depth: number; origin: Point } | null = null
  for (const n of scene.nodes.values()) {
    if (!n.expanded || n.ghost || exclude.has(n.id) || n.innerOrigin === null) continue
    if (!insideHex(p, n.center, n.r)) continue
    if (best === null || n.depth > best.depth) best = { id: n.id, depth: n.depth, origin: n.innerOrigin }
  }
  return best === null ? { parentId: scene.focusId, origin: scene.rootOrigin } : { parentId: best.id, origin: best.origin }
}

/** Cells already used by `parentId`'s children (except `except`). */
function takenCells(m: Model, scene: Scene, parentId: string | null, except: ReadonlySet<string>): Set<string> {
  const taken = new Set<string>()
  for (const n of Object.values(m.nodes)) {
    if (n.parentId !== parentId || except.has(n.id)) continue
    const c = m.layout[n.id] ?? scene.nodes.get(n.id)?.cell
    if (c !== undefined) taken.add(coordKey(c))
  }
  return taken
}

export function cellAt(m: Model, scene: Scene, p: Point, parentId: string | null, origin: Point, except: ReadonlySet<string> = new Set()): HexCoord {
  const want = pixelToAxial({ x: p.x - origin.x, y: p.y - origin.y })
  const taken = takenCells(m, scene, parentId, except)
  return nearestFreeCell(want, (c) => taken.has(coordKey(c)))
}

/** Ops for nodes dropped at new centres: reparent into whatever container they landed in, then snap to its grid. */
export function moveOps(m: Model, scene: Scene, moves: readonly { id: string; center: Point }[]): Op[] {
  const ops: Op[] = []
  const movedIds = new Set(moves.map((x) => x.id))
  // Nodes that were already placed this batch, so two dropped nodes never take the same cell.
  const claimed = new Map<string | null, Set<string>>()
  for (const mv of moves) {
    const n = m.nodes[mv.id]
    if (n === undefined) continue
    const subtree = new Set([mv.id, ...descendantIds(m, mv.id)])
    const { parentId, origin } = containerAt(scene, mv.center, subtree)
    const want = pixelToAxial({ x: mv.center.x - origin.x, y: mv.center.y - origin.y })
    const taken = takenCells(m, scene, parentId, movedIds)
    for (const k of claimed.get(parentId) ?? []) taken.add(k)
    const cell = nearestFreeCell(want, (c) => taken.has(coordKey(c)))
    const set = claimed.get(parentId) ?? new Set<string>()
    set.add(coordKey(cell))
    claimed.set(parentId, set)
    if (parentId !== n.parentId) ops.push({ op: 'updateNode', id: mv.id, patch: { parentId } })
    ops.push({ op: 'setLayout', id: mv.id, at: cell })
  }
  return ops
}

/**
 * Tidy layout for what is on screen: the canvas level and every expanded container's inner level, each arranged with
 * the containers at their drawn size and the lines that leave the level counted. Nodes hidden by Overview stay put.
 * Only nodes that move get a setLayout op.
 */
export function tidyOps(m: Model, scene: Scene): Op[] {
  const levels = new Map<string | null, Map<string, HexCoord>>()
  for (const n of scene.nodes.values()) {
    if (n.ghost) continue
    const parent = m.nodes[n.id]?.parentId ?? null
    // A level is shown when it is the canvas level or its container is expanded.
    const shown = parent === scene.focusId || (parent !== null && scene.nodes.get(parent)?.expanded === true)
    if (!shown) continue
    const cells = levels.get(parent) ?? new Map<string, HexCoord>()
    cells.set(n.id, n.cell)
    levels.set(parent, cells)
  }
  const expanded = new Set([...scene.nodes.values()].filter((n) => n.expanded).map((n) => n.id))
  const ops: Op[] = []
  for (const [parent, cells] of levels) {
    const arranged = arrangeLevel(m, parent, { expanded, focusId: scene.focusId, current: cells, movable: new Set(cells.keys()), timeLimitMs: Math.max(80, 700 / levels.size) })
    for (const [id, at] of arranged) {
      const was = cells.get(id) ?? m.layout[id]
      if (was === undefined || was.q !== at.q || was.r !== at.r) ops.push({ op: 'setLayout', id, at })
    }
  }
  return ops
}

export function newNodeOps(m: Model, kind: NodeKind, parentId: string | null, at: HexCoord, name?: string): { ops: Op[]; id: string } {
  const info = KIND_INFO[kind]
  const display = name ?? `New ${info.label.toLowerCase()}`
  const id = uniqueId(display, (x) => m.nodes[x] !== undefined)
  const node: HxNode = NodeZ.parse({
    id,
    name: display,
    kind,
    parentId,
    boundary: info.externalByDefault ? 'external' : 'internal',
    provenance: { source: 'user', runId: null, at: Date.now() },
  })
  return { ops: [{ op: 'addNode', node, at }], id }
}

/** Sensible defaults for a new connector from the kinds at each end. */
export function connectorDefaults(target: HxNode): { protocol: string; duplex: boolean; sync: 'sync' | 'async'; back: string | null } {
  switch (target.kind) {
    case 'database':
      return { protocol: 'SQL', duplex: true, sync: 'sync', back: 'SQL' }
    case 'cache':
      return { protocol: 'Redis', duplex: true, sync: 'sync', back: 'Redis' }
    case 'queue':
      return { protocol: 'AMQP', duplex: false, sync: 'async', back: null }
    case 'stream':
      return { protocol: 'Kafka', duplex: false, sync: 'async', back: null }
    case 'storage':
      return { protocol: 'S3', duplex: true, sync: 'sync', back: 'S3' }
    default:
      return { protocol: target.boundary === 'external' ? 'HTTPS' : 'gRPC', duplex: true, sync: 'sync', back: null }
  }
}

/** A new connector; ports stay automatic (pinned ports are set in the inspector) so lines follow later moves. */
export function newConnectorOps(m: Model, source: string, target: string): { ops: Op[]; id: string } | null {
  const s = m.nodes[source]
  const t = m.nodes[target]
  if (s === undefined || t === undefined || source === target) return null
  const d = connectorDefaults(t)
  const id = uniqueId(`${source}-${target}`, (x) => m.connectors[x] !== undefined)
  const connector = ConnectorZ.parse({
    id,
    source,
    target,
    duplex: d.duplex,
    sync: d.sync,
    channelA: ChannelZ.parse({ protocol: d.protocol }),
    channelB: d.duplex ? ChannelZ.parse({ protocol: d.back ?? d.protocol }) : null,
    provenance: { source: 'user', runId: null, at: Date.now() },
  })
  return { ops: [{ op: 'addConnector', connector }], id }
}
