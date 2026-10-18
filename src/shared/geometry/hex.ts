// Flat-top hexagon math. Nodes sit on an axial grid (q, r); a flat-top hexagon's six edges face N, NE, SE, S, SW
// and NW, which are the six docking ports, and neighbouring cells lie exactly along those directions, so connectors
// between neighbours are perfectly aligned with the 60° grid.
import type { HexCoord, Port } from '../model/schema.ts'

export interface Point {
  x: number
  y: number
}

export const SQRT3 = Math.sqrt(3)

/** Circumradius of a regular node hexagon (px at zoom 1). */
export const NODE_R = 56
/** Grid cell circumradius: neighbouring node centres are SQRT3 * CELL_R apart, leaving room for connectors. */
export const CELL_R = 112
/** Isometric style: the prism's top face is the hexagon squashed vertically by this factor. */
export const ISO_SQUASH = 0.58
/** Isometric style: prism wall height. */
export const ISO_DEPTH = 16

export type HexStyle = 'flat' | 'iso'

/** Port → the angle (radians, y down) its edge faces. */
export const PORT_ANGLE: Readonly<Record<Port, number>> = {
  n: -Math.PI / 2,
  ne: -Math.PI / 6,
  se: Math.PI / 6,
  s: Math.PI / 2,
  sw: (5 * Math.PI) / 6,
  nw: (7 * Math.PI) / 6,
}
export const PORT_ORDER: readonly Port[] = ['n', 'ne', 'se', 's', 'sw', 'nw']

/** Axial neighbour offsets in port order. */
export const AXIAL_DIRS: Readonly<Record<Port, HexCoord>> = {
  n: { q: 0, r: -1 },
  ne: { q: 1, r: -1 },
  se: { q: 1, r: 0 },
  s: { q: 0, r: 1 },
  sw: { q: -1, r: 1 },
  nw: { q: -1, r: 0 },
}

export function axialToPixel(c: HexCoord, cell = CELL_R): Point {
  return { x: cell * 1.5 * c.q, y: cell * SQRT3 * (c.r + c.q / 2) }
}

/** The nearest grid cell to a pixel position. */
export function pixelToAxial(p: Point, cell = CELL_R): HexCoord {
  const q = ((2 / 3) * p.x) / cell
  const r = ((-1 / 3) * p.x + (SQRT3 / 3) * p.y) / cell
  return axialRound(q, r)
}

export function axialRound(q: number, r: number): HexCoord {
  const s = -q - r
  let rq = Math.round(q)
  let rr = Math.round(r)
  const rs = Math.round(s)
  const dq = Math.abs(rq - q)
  const dr = Math.abs(rr - r)
  const ds = Math.abs(rs - s)
  if (dq > dr && dq > ds) rq = -rr - rs
  else if (dr > ds) rr = -rq - rs
  // Avoid -0 in saved files.
  return { q: rq + 0, r: rr + 0 }
}

export function axialDistance(a: HexCoord, b: HexCoord): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2
}

export const coordKey = (c: HexCoord): string => `${c.q},${c.r}`

const RING_DIRS: readonly HexCoord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]

/** Cells in rings around the origin: centre, then ring 1 (6 cells), ring 2 (12), … */
export function* hexSpiral(origin: HexCoord = { q: 0, r: 0 }): Generator<HexCoord> {
  yield origin
  for (let k = 1; ; k++) {
    let c = { q: origin.q - k, r: origin.r + k }
    for (const d of RING_DIRS) {
      for (let i = 0; i < k; i++) {
        yield c
        c = { q: c.q + d.q, r: c.r + d.r }
      }
    }
  }
}

/** The first free cell nearest to `near` (spiralling out). */
export function nearestFreeCell(near: HexCoord, taken: (c: HexCoord) => boolean, limit = 2000): HexCoord {
  let i = 0
  for (const c of hexSpiral(near)) {
    if (!taken(c)) return c
    if (++i > limit) break
  }
  return near
}

/** Corners of a flat-top hexagon (style iso squashes it vertically). */
export function hexCorners(center: Point, r: number, squash = 1): Point[] {
  const out: Point[] = []
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i
    out.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) * squash })
  }
  return out
}

export function pointsAttr(pts: readonly Point[]): string {
  return pts.map((p) => `${round2(p.x)},${round2(p.y)}`).join(' ')
}

export const round2 = (n: number): number => Math.round(n * 100) / 100

/** Inradius (centre → edge midpoint) of a hexagon with circumradius r. */
export const inradius = (r: number): number => (r * SQRT3) / 2

/** Whether a point lies inside a flat-top hexagon. */
export function insideHex(p: Point, center: Point, r: number, squash = 1): boolean {
  const dx = Math.abs(p.x - center.x)
  const dy = Math.abs(p.y - center.y) / squash
  const h = inradius(r)
  if (dx > r || dy > h) return false
  return h * r - h * dx - (r / 2) * dy >= 0
}

/** The circumradius of a hexagon whose inscribed circle has radius `rho` (a container for content of radius rho). */
export const hexRadiusForInnerCircle = (rho: number): number => (2 * rho) / SQRT3
