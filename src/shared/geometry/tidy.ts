// Layout help: (1) badge placement that slides each connector's badge along its line until it overlaps no other badge
// or node; (2) "Tidy layout": a local search over a level's hex cells that shortens connectors and removes crossings
// and lines that run through other nodes, while keeping every node near where the user put it.
import { ancestorsOf } from '../model/queries.ts'
import type { HexCoord, Model } from '../model/schema.ts'
import { CELL_R, NODE_R, axialDistance, axialToPixel, coordKey, hexSpiral } from './hex.ts'
import type { Point } from './hex.ts'

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

function cost(cells: Map<string, HexCoord>, links: readonly [string, string][], start: Map<string, HexCoord>): number {
  const pos = new Map<string, Point>()
  for (const [id, c] of cells) pos.set(id, axialToPixel(c))
  let total = 0
  const segs: [Point, Point, string, string][] = []
  for (const [a, b] of links) {
    const pa = pos.get(a)
    const pb = pos.get(b)
    if (pa === undefined || pb === undefined) continue
    total += (0.35 * Math.hypot(pa.x - pb.x, pa.y - pb.y)) / CELL_R
    segs.push([pa, pb, a, b])
  }
  // Lines that run through another node.
  for (const [pa, pb, a, b] of segs) {
    for (const [id, p] of pos) {
      if (id === a || id === b) continue
      if (segDistance(p, pa, pb) < NODE_R + 14) total += 6
    }
  }
  // Crossings.
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]
      const t = segs[j]
      if (s === undefined || t === undefined) continue
      if (s[2] === t[2] || s[2] === t[3] || s[3] === t[2] || s[3] === t[3]) continue
      if (segmentsCross(s[0], s[1], t[0], t[1])) total += 3
    }
  }
  // Stay recognisable: moving costs a little.
  for (const [id, c] of cells) {
    const o = start.get(id)
    if (o !== undefined) total += 0.6 * axialDistance(o, c)
  }
  return total
}

/**
 * Better cells for one level's nodes: greedy local search (move to a nearby free cell, or swap two nodes) while the
 * cost drops. Returns only the nodes that moved.
 */
export function tidyLevel(m: Model, parentId: string | null, current: ReadonlyMap<string, HexCoord>, passes = 5): Map<string, HexCoord> {
  const links = levelLinks(m, parentId)
  const start = new Map(current)
  const cells = new Map(current)
  if (cells.size < 3 || links.length === 0) return new Map()
  let best = cost(cells, links, start)
  const ids = [...cells.keys()].sort()
  for (let pass = 0; pass < passes; pass++) {
    let improved = false
    for (const id of ids) {
      const here = cells.get(id)
      if (here === undefined) continue
      const occupied = new Map<string, string>()
      for (const [k, c] of cells) occupied.set(coordKey(c), k)
      let i = 0
      for (const cand of hexSpiral(here)) {
        if (++i > 37) break
        if (cand.q === here.q && cand.r === here.r) continue
        const other = occupied.get(coordKey(cand))
        cells.set(id, cand)
        if (other !== undefined) cells.set(other, here)
        const c = cost(cells, links, start)
        if (c < best - 0.01) {
          best = c
          improved = true
          break
        }
        cells.set(id, here)
        if (other !== undefined) cells.set(other, cand)
      }
    }
    if (!improved) break
  }
  const moved = new Map<string, HexCoord>()
  for (const [id, c] of cells) {
    const o = start.get(id)
    if (o === undefined || o.q !== c.q || o.r !== c.r) moved.set(id, c)
  }
  return moved
}
