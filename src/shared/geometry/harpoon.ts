// Harpoon connector geometry. A connector is a straight segment from a docking port of one hexagon (the edge facing
// the other node) to a docking port of the other. A duplex connector is two anti-parallel lines offset either side
// of that segment: channel A runs source → target, channel B target → source. Each line ends in a single barb (a
// half arrowhead) on its outer side, which gives the ⇌ look. The canvas, the particle overlay and the SVG exporter
// all draw from this one function so they always line up.
import type { Port } from '../model/schema.ts'
import { PORT_ANGLE, PORT_ORDER, inradius } from './hex.ts'
import type { Point } from './hex.ts'

export interface HexShape {
  center: Point
  /** Circumradius of the docking footprint. */
  r: number
  /** Vertical squash of the footprint (isometric top face); 1 for flat. */
  squash: number
}

export interface HarpoonLine {
  from: Point
  to: Point
  /** The barb's free end (the tip is `to`). */
  barb: Point
  length: number
}

export interface HarpoonGeometry {
  sourcePort: Port
  targetPort: Port
  /** Channel A (source → target). */
  a: HarpoonLine
  /** Channel B (target → source) when duplex. */
  b: HarpoonLine | null
  /** Badge anchor: the midpoint between the lines. */
  mid: Point
  /** Segment angle in radians (for upright text, flip when |angle| > 90°). */
  angle: number
}

export interface HarpoonOptions {
  duplex: boolean
  /** Distance between the two lines of a duplex connector. */
  gap?: number
  /** Space left between a line end and the hexagon edge. */
  inset?: number
  barbLength?: number
  /** Barb angle from the line, radians. */
  barbAngle?: number
  sourcePort?: Port | null
  targetPort?: Port | null
  /**
   * Shift the whole connector this far to the left of its direction of travel. Two drawn edges on one pair (A→B and
   * B→A) both shift left of their own direction, so they end up side by side instead of on the same pixels.
   */
  offset?: number
}

/** The sideways shift for a drawn edge whose pair also has an edge the other way (clears a duplex pair's lines). */
export const RECIPROCAL_OFFSET = 11

/** The port of a hexagon whose edge faces the direction `angle` (radians, y down). */
export function portFacing(angle: number): Port {
  // Ports are 60° apart starting at -90° (N). Normalise to [0, 2π) from N.
  const t = (angle + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI)
  const i = Math.round(t / (Math.PI / 3)) % 6
  return PORT_ORDER[i] ?? 'n'
}

/** Midpoint of a port's edge on a (possibly squashed) hexagon. */
export function portPoint(s: HexShape, port: Port): Point {
  const a = PORT_ANGLE[port]
  const h = inradius(s.r)
  return { x: s.center.x + h * Math.cos(a), y: s.center.y + h * Math.sin(a) * s.squash }
}

/**
 * Where the line from the hexagon's centre toward `toward` leaves it. Lines aimed centre to centre stay straight
 * and symmetric whatever the angle; for grid neighbours this is exactly the facing port's midpoint.
 */
export function boundaryPoint(s: HexShape, toward: Point): Point {
  const dx = toward.x - s.center.x
  const dy = (toward.y - s.center.y) / s.squash
  const phi = Math.atan2(dy, dx)
  const h = inradius(s.r)
  // Distance to the boundary of a flat-top hexagon: h / cos(angle to the nearest edge normal).
  const normal = PORT_ANGLE[portFacing(phi)]
  const t = h / Math.cos(phi - normal)
  return { x: s.center.x + t * Math.cos(phi), y: s.center.y + t * Math.sin(phi) * s.squash }
}

export function choosePorts(a: HexShape, b: HexShape): { source: Port; target: Port } {
  const dx = b.center.x - a.center.x
  const dy = (b.center.y - a.center.y) / Math.max(0.0001, (a.squash + b.squash) / 2)
  const angle = Math.atan2(dy, dx)
  return { source: portFacing(angle), target: portFacing(angle + Math.PI) }
}

const sub = (p: Point, q: Point): Point => ({ x: p.x - q.x, y: p.y - q.y })
const add = (p: Point, q: Point): Point => ({ x: p.x + q.x, y: p.y + q.y })
const mul = (p: Point, k: number): Point => ({ x: p.x * k, y: p.y * k })
const len = (p: Point): number => Math.hypot(p.x, p.y)

function line(from: Point, to: Point, outward: Point, barbLength: number, barbAngle: number): HarpoonLine {
  const d = sub(to, from)
  const l = len(d)
  const u = l === 0 ? { x: 1, y: 0 } : mul(d, 1 / l)
  const back = mul(u, -barbLength * Math.cos(barbAngle))
  const side = mul(outward, barbLength * Math.sin(barbAngle))
  return { from, to, barb: add(add(to, back), side), length: l }
}

export function harpoonGeometry(source: HexShape, target: HexShape, o: HarpoonOptions): HarpoonGeometry {
  const gap = o.gap ?? 10
  const inset = o.inset ?? 6
  const barbLength = o.barbLength ?? 11
  const barbAngle = o.barbAngle ?? (28 * Math.PI) / 180
  const chosen = choosePorts(source, target)
  const sourcePort = o.sourcePort ?? chosen.source
  const targetPort = o.targetPort ?? chosen.target

  // An explicit port docks on that edge's midpoint; otherwise the line runs centre to centre.
  let p0 = o.sourcePort != null ? portPoint(source, o.sourcePort) : boundaryPoint(source, target.center)
  let p1 = o.targetPort != null ? portPoint(target, o.targetPort) : boundaryPoint(target, source.center)
  const d = sub(p1, p0)
  const l = len(d)
  const u = l === 0 ? { x: 1, y: 0 } : mul(d, 1 / l)
  // Pull both ends in a little, unless the hexagons are so close the line would vanish.
  const pull = Math.min(inset, Math.max(0, (l - 4) / 2))
  p0 = add(p0, mul(u, pull))
  p1 = add(p1, mul(u, -pull))
  // Normal to the left of the direction of travel (screen coordinates, y down).
  const n = { x: u.y, y: -u.x }
  const angle = Math.atan2(u.y, u.x)
  if (o.offset !== undefined && o.offset !== 0) {
    p0 = add(p0, mul(n, o.offset))
    p1 = add(p1, mul(n, o.offset))
  }
  const mid = mul(add(p0, p1), 0.5)

  if (!o.duplex) {
    return { sourcePort, targetPort, a: line(p0, p1, n, barbLength, barbAngle), b: null, mid, angle }
  }
  const off = mul(n, gap / 2)
  // A runs on the left of source→target with its barb on the left (outer) side; B runs back on the right side
  // with its barb on the right: together ⇌.
  const a = line(add(p0, off), add(p1, off), n, barbLength, barbAngle)
  const b = line(sub(p1, off), sub(p0, off), mul(n, -1), barbLength, barbAngle)
  return { sourcePort, targetPort, a, b, mid, angle }
}

/** SVG path data for one harpoon line with its barb. */
export function harpoonPath(l: HarpoonLine): string {
  const f = (n: number): string => (Math.round(n * 10) / 10).toString()
  return `M${f(l.from.x)},${f(l.from.y)}L${f(l.to.x)},${f(l.to.y)}L${f(l.barb.x)},${f(l.barb.y)}`
}

/** A point `t` (0..1) of the way along a line (particles). */
export function pointAlong(l: HarpoonLine, t: number): Point {
  return { x: l.from.x + (l.to.x - l.from.x) * t, y: l.from.y + (l.to.y - l.from.y) * t }
}
