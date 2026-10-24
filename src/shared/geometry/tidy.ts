// Layout help: (1) badge placement that slides each connector's badge along its line until it overlaps no other badge
// or node; (2) arranging a level (Tidy, a service's first expand, the AI's new nodes): ELK's layered layout snapped
// to the hex grid, then a local search on scene positions that shortens connectors and removes crossings and lines
// that run through other nodes, while keeping every node near where the user put it.
import { ancestorsOf, liftEndpoint } from '../model/queries.ts'
import type { HexCoord, Model } from '../model/schema.ts'
import { elkLayered } from './elk.ts'
import { boundaryPoint } from './harpoon.ts'
import { CELL_R, NODE_R, SQRT3, axialDistance, axialToPixel, coordKey, hexSpiral, nearestFreeCell, pixelToAxial } from './hex.ts'
import type { Point } from './hex.ts'
import { computeScene, levelCells, separate } from './scene.ts'

// ---- segment helpers ---------------------------------------------------------------------------------------------

function segDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

/** Proper intersection of two segments (shared endpoints do not count). */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

// ---- badges ---------------------------------------------------------------------------------------------------------

export interface BadgeInput {
  key: string
  from: Point
  to: Point
  width: number
  height: number
}

export interface Obstacle {
  center: Point
  r: number
}

const BADGE_TS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.27, 0.73, 0.2, 0.8]

/** Where along its line (0..1) each badge goes, so badges do not overlap each other or the nodes. */
export function placeBadges(badges: readonly BadgeInput[], obstacles: readonly Obstacle[]): Map<string, number> {
  const out = new Map<string, number>()
  const placed: { x: number; y: number; w: number; h: number }[] = []
  // Longest lines first: they have the most room to move.
  const order = [...badges].sort((a, b) => Math.hypot(b.to.x - b.from.x, b.to.y - b.from.y) - Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y))
  for (const b of order) {
    let best = 0.5
    let bestScore = Infinity
    for (const t of BADGE_TS) {
      const c = { x: b.from.x + (b.to.x - b.from.x) * t, y: b.from.y + (b.to.y - b.from.y) * t }
      let score = Math.abs(t - 0.5) * 2
      for (const p of placed) {
        const ox = Math.max(0, Math.min(c.x + b.width / 2, p.x + p.w / 2) - Math.max(c.x - b.width / 2, p.x - p.w / 2))
        const oy = Math.max(0, Math.min(c.y + b.height / 2, p.y + p.h / 2) - Math.max(c.y - b.height / 2, p.y - p.h / 2))
        score += (ox * oy) / 10
      }
      for (const o of obstacles) {
        const d = Math.hypot(c.x - o.center.x, c.y - o.center.y)
        if (d < o.r + b.width / 3) score += 50
      }
      if (score < bestScore - 1e-9) {
        bestScore = score
        best = t
      }
      if (score < 0.01) break
    }
    out.set(b.key, best)
    const c = { x: b.from.x + (b.to.x - b.from.x) * best, y: b.from.y + (b.to.y - b.from.y) * best }
    placed.push({ x: c.x, y: c.y, w: b.width, h: b.height })
  }
  return out
}

// ---- tidy layout ------------------------------------------------------------------------------------------------

/** The child of `parentId` that `id` is (or is inside), or null when `id` is not under that level. */
function levelNode(m: Model, id: string, parentId: string | null): string | null {
  if (m.nodes[id]?.parentId === parentId) return id
  for (const a of ancestorsOf(m, id)) if (a.parentId === parentId) return a.id
  return null
}

/** The links between the nodes of one level (connectors lifted to that level, deduplicated). */
export function levelLinks(m: Model, parentId: string | null): [string, string][] {
  const seen = new Set<string>()
  const out: [string, string][] = []
  for (const c of Object.values(m.connectors)) {
    const a = levelNode(m, c.source, parentId)
    const b = levelNode(m, c.target, parentId)
    if (a === null || b === null || a === b) continue
    const k = a < b ? `${a}|${b}` : `${b}|${a}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push([a, b])
  }
  return out
}


// ---- arrange a level ----------------------------------------------------------------------------------------------

export interface ArrangeOptions {
  /** What is on screen: container sizes and where outside partners sit (default: nothing expanded, no focus). */
  expanded?: ReadonlySet<string>
  focusId?: string | null
  /** Nodes of the level that may move (default: all). The others keep their cells. */
  movable?: ReadonlySet<string>
  /** Current cells of the level (default: saved cells, then spiral cells for the rest). */
  current?: ReadonlyMap<string, HexCoord>
  /** Nodes whose saved cell is only a placeholder (just added): moving them costs nothing. */
  placeholders?: ReadonlySet<string>
  /** Time cap for the refinement, in ms. */
  timeLimitMs?: number
}

/** A level ready to score: its nodes' radii, its links, and outside partners as fixed anchor points. */
interface LevelProblem {
  ids: string[]
  radius: Map<string, number>
  links: [string, string][]
  /** Links to outside partners: the level node and the anchor point on the container edge (level coordinates). */
  anchors: { id: string; key: string; at: Point; outgoing: boolean }[]
  /** Saved cells: moving away from them costs a little (nodes without one are free). */
  start: Map<string, HexCoord>
}

function levelProblem(m: Model, parentId: string | null, o: ArrangeOptions): LevelProblem {
  const ids = Object.values(m.nodes)
    .filter((n) => n.parentId === parentId)
    .map((n) => n.id)
    .sort()
  // Show the level (its container and the ones around it expanded) to learn sizes and where outside partners are.
  const focusId = o.focusId ?? null
  const underFocus = focusId === null || parentId === focusId || (parentId !== null && ancestorsOf(m, parentId).some((a) => a.id === focusId))
  const focus = underFocus ? focusId : null
  const expanded = new Set(o.expanded ?? [])
  if (parentId !== null && parentId !== focus) {
    expanded.add(parentId)
    for (const a of ancestorsOf(m, parentId)) {
      if (a.id === focus) break
      expanded.add(a.id)
    }
  }
  const scene = computeScene(m, { expanded, focusId: focus, style: 'flat' })
  const radius = new Map(ids.map((id) => [id, scene.nodes.get(id)?.r ?? NODE_R]))
  const container = parentId === null ? undefined : scene.nodes.get(parentId)
  const origin = container?.innerOrigin ?? scene.rootOrigin

  const links: [string, string][] = []
  const seen = new Set<string>()
  const anchors: LevelProblem['anchors'] = []
  for (const c of Object.values(m.connectors)) {
    const a = levelNode(m, c.source, parentId)
    const b = levelNode(m, c.target, parentId)
    if (a !== null && b !== null) {
      if (a === b || seen.has(`${a}|${b}`)) continue
      seen.add(`${a}|${b}`)
      links.push([a, b])
      continue
    }
    const inside = a ?? b
    if (inside === null) continue
    const outsideId = liftEndpoint(m, a === null ? c.source : c.target, (id) => scene.nodes.has(id))
    const partner = outsideId === null ? undefined : scene.nodes.get(outsideId)
    if (partner === undefined || outsideId === null || outsideId === parentId) continue
    const key = `${inside}|${outsideId}|${a === null ? 'in' : 'out'}`
    if (seen.has(key)) continue
    seen.add(key)
    // Inside a container: the point of its edge facing the partner. On the canvas level (focus mode): the ghost.
    const abs = container?.expanded === true ? boundaryPoint({ center: container.center, r: container.r, squash: 1 }, partner.center) : partner.center
    anchors.push({ id: inside, key: outsideId, at: { x: abs.x - origin.x, y: abs.y - origin.y }, outgoing: a !== null })
  }
  const start = new Map<string, HexCoord>()
  for (const id of ids) {
    const c = m.layout[id]
    if (c !== undefined && o.placeholders?.has(id) !== true) start.set(id, c)
  }
  return { ids, radius, links, anchors, start }
}

/** Where each node of the level is drawn for these cells: grid positions, then the scene's separation pass. */
function levelPositions(p: LevelProblem, cells: ReadonlyMap<string, HexCoord>): Map<string, Point> {
  const items = p.ids.map((id) => ({ id, rel: axialToPixel(cells.get(id) ?? { q: 0, r: 0 }), r: p.radius.get(id) ?? NODE_R }))
  separate(items)
  return new Map(items.map((it) => [it.id, it.rel]))
}

export interface LevelScore {
  total: number
  crossings: number
  /** Lines that run through a node other than their two ends. */
  through: number
  /** Pairs of hexagons that overlap. */
  overlaps: number
}

/** Cost per cell of the level's reach from its middle (a bigger reach means a bigger container). */
const SPREAD_WEIGHT = 1.2

function scorePositions(p: LevelProblem, pos: ReadonlyMap<string, Point>, cells: ReadonlyMap<string, HexCoord>): LevelScore {
  const r = (id: string): number => p.radius.get(id) ?? NODE_R
  let total = 0
  const segs: [Point, Point, string, string][] = []
  for (const [a, b] of p.links) {
    const pa = pos.get(a)
    const pb = pos.get(b)
    if (pa === undefined || pb === undefined) continue
    // Visible length, edge to edge (for two plain nodes the same as centre to centre).
    total += (0.35 * Math.max(0, Math.hypot(pa.x - pb.x, pa.y - pb.y) - r(a) - r(b) + 2 * NODE_R)) / CELL_R
    segs.push([pa, pb, a, b])
  }
  for (const an of p.anchors) {
    const pa = pos.get(an.id)
    if (pa === undefined) continue
    total += (0.35 * Math.max(0, Math.hypot(pa.x - an.at.x, pa.y - an.at.y) - r(an.id) + NODE_R)) / CELL_R
    segs.push([pa, an.at, an.id, `@${an.key}`])
  }
  let through = 0
  for (const [pa, pb, a, b] of segs) {
    for (const [id, q] of pos) {
      if (id === a || id === b) continue
      if (segDistance(q, pa, pb) < r(id) + 14) through++
    }
  }
  let crossings = 0
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] as [Point, Point, string, string]
    for (let j = i + 1; j < segs.length; j++) {
      const t = segs[j] as [Point, Point, string, string]
      if (s[2] === t[2] || s[2] === t[3] || s[3] === t[2] || s[3] === t[3]) continue
      if (segmentsCross(s[0], s[1], t[0], t[1])) crossings++
    }
  }
  let overlaps = 0
  const list = [...pos]
  for (let i = 0; i < list.length; i++) {
    const [a, pa] = list[i] as [string, Point]
    for (let j = i + 1; j < list.length; j++) {
      const [b, pb] = list[j] as [string, Point]
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y) < r(a) + r(b) - 1) overlaps++
    }
  }
  total += 6 * through + 3 * crossings + 50 * overlaps
  // Keep the level compact: its container grows with the farthest node from the middle.
  let cx = 0
  let cy = 0
  for (const q of pos.values()) {
    cx += q.x / pos.size
    cy += q.y / pos.size
  }
  let reach = 0
  for (const [id, q] of pos) reach = Math.max(reach, Math.hypot(q.x - cx, q.y - cy) + r(id))
  total += (SPREAD_WEIGHT * reach) / CELL_R
  // Stay recognisable: moving away from a saved cell costs a little.
  for (const [id, c] of cells) {
    const o = p.start.get(id)
    if (o !== undefined) total += 0.6 * axialDistance(o, c)
  }
  return { total, crossings, through, overlaps }
}

/** How good a level's layout is, scored on scene positions (container sizes count). */
export function levelScore(m: Model, parentId: string | null, cells: ReadonlyMap<string, HexCoord>, o: ArrangeOptions = {}): LevelScore {
  const p = levelProblem(m, parentId, o)
  return scorePositions(p, levelPositions(p, cells), cells)
}

/** ELK's layered layout of the level, snapped to free hex cells in reading order; mirrored left↔right if asked. */
function elkSeed(p: LevelProblem, around: Point, mirror: boolean): Map<string, HexCoord> {
  const boxes = p.ids.map((id) => {
    const d = 2 * (p.radius.get(id) ?? NODE_R)
    return { id, width: d, height: d }
  })
  const edges: [string, string][] = [...p.links]
  // Outside partners join as small boxes, so the level's callers end up left of it and its callees right.
  const anchorBoxes = new Set<string>()
  for (const an of p.anchors) {
    const box = `@${an.key}`
    anchorBoxes.add(box)
    edges.push(an.outgoing ? [an.id, box] : [box, an.id])
  }
  const pos = elkLayered([...boxes, ...[...anchorBoxes].map((id) => ({ id, width: 40, height: 40 }))], edges, {
    node: SQRT3 * CELL_R - 2 * NODE_R,
    layer: 3 * CELL_R - 2 * NODE_R,
  })
  const placed = p.ids.map((id) => ({ id, at: pos.get(id) ?? { x: 0, y: 0 } }))
  let cx = 0
  let cy = 0
  for (const x of placed) {
    cx += x.at.x / placed.length
    cy += x.at.y / placed.length
  }
  for (const x of placed) x.at = { x: around.x + (mirror ? cx - x.at.x : x.at.x - cx), y: around.y + x.at.y - cy }
  placed.sort((a, b) => a.at.x - b.at.x || a.at.y - b.at.y)
  const taken = new Set<string>()
  const out = new Map<string, HexCoord>()
  for (const x of placed) {
    const c = nearestFreeCell(pixelToAxial(x.at), (k) => taken.has(coordKey(k)))
    taken.add(coordKey(c))
    out.set(x.id, c)
  }
  return out
}

/** Cells each node tries per sweep: itself and four rings around it. */
const NEIGHBOURHOOD = 61

/**
 * Best-improvement local search: each movable node takes the best of the 61 cells around it (swapping with a movable
 * node already there), then any two movable nodes may trade places; sweeps repeat until nothing helps or time is up.
 */
function refine(p: LevelProblem, seed: ReadonlyMap<string, HexCoord>, movable: ReadonlySet<string>, deadline: number): { cells: Map<string, HexCoord>; score: number } {
  const cells = new Map(seed)
  const score = (): number => scorePositions(p, levelPositions(p, cells), cells).total
  let best = score()
  const ids = p.ids.filter((id) => movable.has(id))
  const now = (): number => globalThis.performance.now()
  for (let sweep = 0; sweep < 40 && now() < deadline; sweep++) {
    let improved = false
    for (const id of ids) {
      const here = cells.get(id)
      if (here === undefined) continue
      const occupied = new Map<string, string>()
      for (const [k, c] of cells) occupied.set(coordKey(c), k)
      let bestCell: HexCoord | null = null
      let i = 0
      for (const cand of hexSpiral(here)) {
        if (++i > NEIGHBOURHOOD) break
        if (cand.q === here.q && cand.r === here.r) continue
        const other = occupied.get(coordKey(cand))
        if (other !== undefined && !movable.has(other)) continue
        cells.set(id, cand)
        if (other !== undefined) cells.set(other, here)
        const c = score()
        if (c < best - 0.01) {
          best = c
          bestCell = cand
        }
        cells.set(id, here)
        if (other !== undefined) cells.set(other, cand)
      }
      if (bestCell !== null) {
        const other = occupied.get(coordKey(bestCell))
        cells.set(id, bestCell)
        if (other !== undefined) cells.set(other, here)
        improved = true
      }
      if (now() > deadline) break
    }
    for (let a = 0; a < ids.length && now() < deadline; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const x = ids[a] as string
        const y = ids[b] as string
        const cx = cells.get(x)
        const cy = cells.get(y)
        if (cx === undefined || cy === undefined) continue
        cells.set(x, cy)
        cells.set(y, cx)
        const c = score()
        if (c < best - 0.01) {
          best = c
          improved = true
        } else {
          cells.set(x, cx)
          cells.set(y, cy)
        }
      }
    }
    if (!improved) break
  }
  return { cells, score: best }
}

/**
 * A good layout for one level: ELK's layered layout (callers left, callees right, outside partners as anchors on the
 * container edge facing them) snapped to free hex cells, then refined with a cost on scene positions (line length,
 * lines through nodes, crossings, moving away from saved cells). The current cells are refined as well and the best
 * candidate wins, so a level that is already good barely moves. Returns the cell of every node on the level.
 */
export function arrangeLevel(m: Model, parentId: string | null, o: ArrangeOptions = {}): Map<string, HexCoord> {
  const p = levelProblem(m, parentId, o)
  const current = new Map<string, HexCoord>()
  if (o.current !== undefined) for (const [id, c] of o.current) if (p.radius.has(id)) current.set(id, c)
  const kids = p.ids.map((id) => m.nodes[id]).filter((n) => n !== undefined)
  for (const [id, v] of levelCells(m, kids)) if (!current.has(id)) current.set(id, v.cell)
  const movable = new Set(p.ids.filter((id) => o.movable === undefined || o.movable.has(id)))
  if (movable.size === 0 || p.ids.length < 2) return current
  const deadline = globalThis.performance.now() + (o.timeLimitMs ?? 400)

  const seeds: Map<string, HexCoord>[] = [current]
  if (movable.size === p.ids.length) {
    if (p.links.length + p.anchors.length > 0) {
      // Centre the layered layout where the level is now, so saved positions move as little as possible.
      let x = 0
      let y = 0
      for (const c of current.values()) {
        const px = axialToPixel(c)
        x += px.x / current.size
        y += px.y / current.size
      }
      seeds.push(elkSeed(p, { x, y }, false), elkSeed(p, { x, y }, true))
    }
  } else {
    // New nodes among fixed ones: start each next to what it connects to.
    const seed = new Map(current)
    const taken = new Set([...current].filter(([id]) => !movable.has(id)).map(([, c]) => coordKey(c)))
    for (const id of [...movable].sort()) {
      const near: Point[] = []
      for (const [a, b] of p.links) {
        const other = a === id ? b : b === id ? a : null
        const c = other === null || movable.has(other) ? undefined : current.get(other)
        if (c !== undefined) near.push(axialToPixel(c))
      }
      for (const an of p.anchors) if (an.id === id) near.push(an.at)
      const want =
        near.length === 0
          ? (current.get(id) ?? { q: 0, r: 0 })
          : pixelToAxial({ x: near.reduce((s, q) => s + q.x, 0) / near.length, y: near.reduce((s, q) => s + q.y, 0) / near.length })
      const c = nearestFreeCell(want, (k) => taken.has(coordKey(k)))
      taken.add(coordKey(c))
      seed.set(id, c)
    }
    seeds.push(seed)
  }
  let best: { cells: Map<string, HexCoord>; score: number } | null = null
  for (let i = 0; i < seeds.length; i++) {
    // Share the remaining time between the candidates still to run.
    const left = deadline - globalThis.performance.now()
    const r = refine(p, seeds[i] as Map<string, HexCoord>, movable, globalThis.performance.now() + Math.max(5, left / (seeds.length - i)))
    if (best === null || r.score < best.score - 0.01) best = r
  }
  return best?.cells ?? current
}
