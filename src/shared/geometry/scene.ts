// The scene: where every visible node is drawn, given the model, which nodes are expanded in place and which
// subgraph is focused. Pure and deterministic, shared by the canvas, the SVG exporter and the HTML viewer.
//
// - Each level (the children of one parent) sits on its own hex grid; a node without saved coordinates takes the next
//   free cell of a spiral around the level's centre.
// - An expanded node becomes a container hexagon big enough for its own children (recursively); a separation pass
//   then pushes overlapping containers and nodes on its level apart along the line between their centres until they
//   clear. That offset is view-only: saved coordinates never change.
// - Overview detail folds the canvas level's satellites (shared/model/satellites.ts) into their owner and draws
//   every node collapsed: an at-a-glance map. Also view-only.
// - In focus mode the focused node's children fill the canvas and outside nodes they talk to appear as faded
//   "context ghosts" on a ring around them.
// - Connectors are lifted to the nearest visible ancestor of each end (shared/model/queries.ts).
import { ancestorsOf, liftedEdges } from '../model/queries.ts'
import { satellitesOf } from '../model/satellites.ts'
import type { LiftedEdge } from '../model/queries.ts'
import type { HexCoord, HxNode, Model } from '../model/schema.ts'
import {
  CELL_R,
  ISO_SQUASH,
  NODE_R,
  axialToPixel,
  coordKey,
  hexCorners,
  hexRadiusForInnerCircle,
  hexSpiral,
} from './hex.ts'
import type { HexStyle, Point } from './hex.ts'

export interface SceneNode {
  id: string
  /** The rendered container this node sits in (null: the canvas). */
  containerId: string | null
  center: Point
  /** Circumradius of the drawn hexagon. */
  r: number
  expanded: boolean
  /** Faded stand-in for an outside node in focus mode. */
  ghost: boolean
  /** Nesting depth in the scene (0: canvas level). */
  depth: number
  /** The grid cell the node occupies on its level (saved or auto-assigned). */
  cell: HexCoord
  /** True when `cell` was assigned here (no saved coordinates yet). */
  autoPlaced: boolean
  /** Absolute pixel position of cell (0,0) of this node's level (drops convert back to cells from here). */
  gridOrigin: Point
  /** Expanded containers: absolute position of cell (0,0) of their inner grid. */
  innerOrigin: Point | null
  /** Overview: the satellites folded into this node (drawn as a "+N inside" badge). */
  folded: string[]
}

export interface SceneBoundary {
  id: string
  points: Point[]
  /** Where to draw the label (top-left-ish corner of the hull). */
  labelAt: Point
}

export interface Scene {
  nodes: Map<string, SceneNode>
  /** Containers before their contents (render order). */
  order: string[]
  edges: LiftedEdge[]
  boundaries: SceneBoundary[]
  focusId: string | null
  style: HexStyle
  /** Absolute position of cell (0,0) of the canvas level. */
  rootOrigin: Point
  detail: SceneDetail
  /** Overview: folded satellite → the node it is drawn as. */
  folded: ReadonlyMap<string, string>
}

/** Full: everything as saved and expanded. Overview: satellites folded into their owners, containers collapsed. */
export type SceneDetail = 'overview' | 'full'

export interface SceneOptions {
  expanded: ReadonlySet<string>
  focusId: string | null
  style: HexStyle
  /** Default full. */
  detail?: SceneDetail
}

const CONTAINER_PAD = 46
const CONTAINER_MIN_R = NODE_R * 2.2
const PUSH_MARGIN = 30

interface Placed {
  id: string
  rel: Point
  r: number
  expanded: boolean
  cell: HexCoord
  autoPlaced: boolean
  children: Placed[]
  /** How far the children's level was shifted to centre it in this container. */
  childShift: Point
}

function childMap(m: Model): Map<string | null, HxNode[]> {
  const map = new Map<string | null, HxNode[]>()
  for (const n of Object.values(m.nodes)) {
    const list = map.get(n.parentId)
    if (list === undefined) map.set(n.parentId, [n])
    else list.push(n)
  }
  for (const list of map.values()) list.sort((a, b) => (a.id < b.id ? -1 : 1))
  return map
}

/** Grid cells for a level: saved ones, then free spiral cells for the rest (stable: sorted by id). */
export function levelCells(m: Model, kids: readonly HxNode[]): Map<string, { cell: HexCoord; auto: boolean }> {
  const out = new Map<string, { cell: HexCoord; auto: boolean }>()
  const taken = new Set<string>()
  for (const n of kids) {
    const c = m.layout[n.id]
    if (c !== undefined && !taken.has(coordKey(c))) {
      out.set(n.id, { cell: c, auto: false })
      taken.add(coordKey(c))
    }
  }
  const spiral = hexSpiral()
  for (const n of kids) {
    if (out.has(n.id)) continue
    for (;;) {
      const c = spiral.next().value as HexCoord
      if (!taken.has(coordKey(c))) {
        taken.add(coordKey(c))
        out.set(n.id, { cell: c, auto: true })
        break
      }
    }
  }
  return out
}

function layoutLevel(
  m: Model,
  kids: readonly HxNode[],
  children: Map<string | null, HxNode[]>,
  expanded: ReadonlySet<string>,
  center: boolean,
  guard: Set<string>,
): { items: Placed[]; radius: number; shift: Point } {
  const cells = levelCells(m, kids)
  const items: Placed[] = kids.map((n) => {
    const { cell, auto } = cells.get(n.id) ?? { cell: { q: 0, r: 0 }, auto: true }
    const sub = children.get(n.id) ?? []
    // An expanded node with no children yet is an empty container (drop inner parts into it).
    const isOpen = expanded.has(n.id) && !guard.has(n.id)
    let r = NODE_R
    let inner: Placed[] = []
    let childShift = { x: 0, y: 0 }
    if (isOpen) {
      guard.add(n.id)
      const lvl = layoutLevel(m, sub, children, expanded, true, guard)
      guard.delete(n.id)
      inner = lvl.items
      childShift = lvl.shift
      r = Math.max(CONTAINER_MIN_R, hexRadiusForInnerCircle(lvl.radius + CONTAINER_PAD))
    }
    return { id: n.id, rel: axialToPixel(cell), r, expanded: isOpen, cell, autoPlaced: auto, children: inner, childShift }
  })

  // Expanded nodes are bigger than a cell: push overlapping neighbours apart.
  separate(items)

  let shift = { x: 0, y: 0 }
  if (center && items.length > 0) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const it of items) {
      minX = Math.min(minX, it.rel.x - it.r)
      maxX = Math.max(maxX, it.rel.x + it.r)
      minY = Math.min(minY, it.rel.y - it.r)
      maxY = Math.max(maxY, it.rel.y + it.r)
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    shift = { x: cx, y: cy }
    for (const it of items) it.rel = { x: it.rel.x - cx, y: it.rel.y - cy }
  }
  let radius = 0
  for (const it of items) radius = Math.max(radius, Math.hypot(it.rel.x, it.rel.y) + it.r)
  return { items, radius, shift }
}

/**
 * Push overlapping hexagons apart, in place: every pair closer than their radii plus a margin moves apart along the
 * line between their centres, the smaller one further, until no pair overlaps. Plain nodes on distinct cells never
 * overlap, so a level without containers is left alone.
 */
export function separate(items: { rel: Point; r: number }[], margin = PUSH_MARGIN): void {
  if (!items.some((it) => it.r > NODE_R)) return
  for (let iter = 0; iter < 300; iter++) {
    let worst = 0
    for (let i = 0; i < items.length; i++) {
      const a = items[i] as { rel: Point; r: number }
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j] as { rel: Point; r: number }
        let dx = b.rel.x - a.rel.x
        let dy = b.rel.y - a.rel.y
        let d = Math.hypot(dx, dy)
        const need = a.r + b.r + margin
        if (d >= need - 0.5) continue
        if (d < 1e-6) {
          // Same spot: pick a direction that differs per pair, so a stack fans out.
          const t = (i * 7 + j * 13) * 2.399963
          dx = Math.cos(t)
          dy = Math.sin(t)
          d = 1
        } else {
          dx /= d
          dy /= d
        }
        const overlap = need - Math.max(d, 0)
        worst = Math.max(worst, overlap)
        const wa = b.r / (a.r + b.r)
        const wb = a.r / (a.r + b.r)
        a.rel = { x: a.rel.x - dx * overlap * wa, y: a.rel.y - dy * overlap * wa }
        b.rel = { x: b.rel.x + dx * overlap * wb, y: b.rel.y + dy * overlap * wb }
      }
    }
    if (worst < 0.5) return
  }
}

/** The outside node a connector end is represented by in focus mode (null: it is inside the focus). */
export function ghostFor(m: Model, id: string, focusId: string): string | null {
  const chain = [...ancestorsOf(m, id).reverse().map((n) => n.id), id]
  if (chain.includes(focusId)) return null
  const focusChain = new Set([...ancestorsOf(m, focusId).map((n) => n.id), focusId])
  return chain.find((x) => !focusChain.has(x)) ?? null
}

export function computeScene(m: Model, o: SceneOptions): Scene {
  const children = childMap(m)
  const focusId = o.focusId !== null && m.nodes[o.focusId] !== undefined ? o.focusId : null
  const detail = o.detail ?? 'full'
  const folded = detail === 'overview' ? satellitesOf(m, focusId) : new Map<string, string>()
  const foldedInto = new Map<string, string[]>()
  for (const [id, owner] of folded) foldedInto.set(owner, [...(foldedInto.get(owner) ?? []), id])
  const top = (children.get(focusId) ?? []).filter((n) => !folded.has(n.id))
  const expanded = detail === 'overview' ? new Set<string>() : o.expanded
  const lvl = layoutLevel(m, top, children, expanded, focusId !== null, new Set(focusId === null ? [] : [focusId]))

  const nodes = new Map<string, SceneNode>()
  const order: string[] = []
  const place = (items: Placed[], origin: Point, gridOrigin: Point, containerId: string | null, depth: number): void => {
    for (const it of items) {
      const c = { x: origin.x + it.rel.x, y: origin.y + it.rel.y }
      nodes.set(it.id, {
        gridOrigin,
        innerOrigin: it.expanded ? { x: c.x - it.childShift.x, y: c.y - it.childShift.y } : null,
        id: it.id,
        containerId,
        center: c,
        r: it.r,
        expanded: it.expanded,
        ghost: false,
        depth,
        cell: it.cell,
        autoPlaced: it.autoPlaced,
        folded: foldedInto.get(it.id) ?? [],
      })
      order.push(it.id)
      if (it.expanded) {
        place(it.children, c, { x: c.x - it.childShift.x, y: c.y - it.childShift.y }, it.id, depth + 1)
      }
    }
  }
  place(lvl.items, { x: 0, y: 0 }, { x: -lvl.shift.x, y: -lvl.shift.y }, null, 0)

  if (focusId !== null) addGhosts(m, focusId, nodes, order, lvl.radius)

  const edges = liftedEdges(m, (id) => nodes.has(id), folded)
  const boundaries = sceneBoundaries(m, nodes, focusId, o.style)
  return { nodes, order, edges, boundaries, focusId, style: o.style, rootOrigin: { x: -lvl.shift.x, y: -lvl.shift.y }, detail, folded }
}

function addGhosts(m: Model, focusId: string, nodes: Map<string, SceneNode>, order: string[], radius: number): void {
  const inside = (id: string): boolean => ghostFor(m, id, focusId) === null
  const ghosts = new Set<string>()
  for (const c of Object.values(m.connectors)) {
    const si = inside(c.source)
    const ti = inside(c.target)
    if (si === ti) continue
    const outside = si ? c.target : c.source
    const g = ghostFor(m, outside, focusId)
    if (g !== null) ghosts.add(g)
  }
  if (ghosts.size === 0) return
  // Angle of each ghost: where it sits relative to the focused node on their shared level.
  const anchorOf = (id: string): Point => {
    const n = m.nodes[id]
    const c = n === undefined ? undefined : m.layout[id]
    return c === undefined ? { x: 0, y: 0 } : axialToPixel(c)
  }
  const focusChain = [focusId, ...ancestorsOf(m, focusId).map((n) => n.id)]
  const list = [...ghosts].map((g) => {
    const parent = m.nodes[g]?.parentId ?? null
    const sibling = focusChain.find((f) => (m.nodes[f]?.parentId ?? null) === parent) ?? focusId
    const a = anchorOf(g)
    const b = anchorOf(sibling)
    return { id: g, angle: Math.atan2(a.y - b.y, a.x - b.x) }
  })
  list.sort((a, b) => a.angle - b.angle)
  // Keep ghosts at least ~a node apart around the ring.
  const ringR = radius + CELL_R * 1.6
  const minSep = (NODE_R * 2.6) / ringR
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]
    const cur = list[i]
    if (prev !== undefined && cur !== undefined && cur.angle - prev.angle < minSep) cur.angle = prev.angle + minSep
  }
  for (const g of list) {
    const c = { x: Math.cos(g.angle) * ringR, y: Math.sin(g.angle) * ringR }
    nodes.set(g.id, {
      id: g.id,
      containerId: null,
      center: c,
      r: NODE_R,
      expanded: false,
      ghost: true,
      depth: 0,
      cell: { q: 0, r: 0 },
      autoPlaced: true,
      gridOrigin: { x: 0, y: 0 },
      innerOrigin: null,
      folded: [],
    })
    order.push(g.id)
  }
}

/** Convex hull (monotone chain), counter-clockwise. */
export function convexHull(points: readonly Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  if (pts.length <= 2) return pts
  const cross = (o: Point, a: Point, b: Point): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Point[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as Point, lower[lower.length - 1] as Point, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Point[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as Point
    while (upper.length >= 2 && cross(upper[upper.length - 2] as Point, upper[upper.length - 1] as Point, p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  return [...lower, ...upper]
}

function sceneBoundaries(
  m: Model,
  nodes: Map<string, SceneNode>,
  focusId: string | null,
  style: HexStyle,
): SceneBoundary[] {
  const out: SceneBoundary[] = []
  const squash = style === 'iso' ? ISO_SQUASH : 1
  for (const b of Object.values(m.boundaries)) {
    // Drawn where its level is on screen: the canvas level, or inside an expanded container.
    const levelShown =
      b.parentId === focusId || (b.parentId !== null && nodes.get(b.parentId)?.expanded === true)
    if (!levelShown) continue
    const pts: Point[] = []
    for (const id of b.nodeIds) {
      const n = nodes.get(id)
      if (n === undefined || n.ghost) continue
      const pad = 26
      // Expanded containers are drawn flat in either style; only leaf prisms are squashed.
      const sq = n.expanded ? 1 : squash
      const label = style === 'iso' && !n.expanded ? 26 : 0
      for (const p of hexCorners(n.center, n.r + pad, sq)) pts.push(p)
      if (label > 0) pts.push({ x: n.center.x, y: n.center.y + n.r * sq + label + pad })
    }
    if (pts.length === 0) continue
    const hull = convexHull(pts)
    let labelAt = hull[0] ?? { x: 0, y: 0 }
    for (const p of hull) if (p.y < labelAt.y - 0.5 || (Math.abs(p.y - labelAt.y) <= 0.5 && p.x < labelAt.x)) labelAt = p
    out.push({ id: b.id, points: hull, labelAt })
  }
  return out
}

/** Bounding box of a scene (for fit-to-view and exports). */
export function sceneBounds(s: Scene): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of s.nodes.values()) {
    minX = Math.min(minX, n.center.x - n.r)
    maxX = Math.max(maxX, n.center.x + n.r)
    minY = Math.min(minY, n.center.y - n.r)
    maxY = Math.max(maxY, n.center.y + n.r + 30)
  }
  for (const b of s.boundaries) {
    for (const p of b.points) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y - 20)
      maxY = Math.max(maxY, p.y)
    }
  }
  if (!Number.isFinite(minX)) return { minX: -200, minY: -200, maxX: 200, maxY: 200 }
  return { minX, minY, maxX, maxY }
}
