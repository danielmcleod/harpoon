// Draws one frame of the 3D view on a 2D canvas: decks from the lowest up (the camera is always above them), and on
// each deck its plate, its hexagon prisms far to near, its connectors as arcs over the deck, then the light cones up
// to the parents on the deck above. Returns where every node landed, for labels and picking.
import { convexHull } from '@shared/geometry/scene.ts'
import type { StrataDeck, StrataEdge, StrataLayout, StrataNode } from '@shared/geometry/strata.ts'
import { clamp, project } from './camera3d.ts'
import type { Projected, View } from './camera3d.ts'

export interface Pt {
  x: number
  y: number
}

export interface NodeLook {
  color: string
  /** Outside a search, a lens legend pick or the open branch. */
  dim: boolean
  /** Planned or removed. */
  faded: boolean
  dashed: boolean
  selected: boolean
  /** Hovered, or a neighbour of the hovered or selected node. */
  hot: boolean
}

export interface Palette {
  fill: string
  edge: string
  label: string
  ring: string
  primary: string
}

export interface Placed {
  id: string
  deck: number
  /** Centre of the top face. */
  x: number
  y: number
  /** Radius of the hexagon on screen. */
  r: number
  depth: number
  /** Screen y just under the prism (where its name goes). */
  below: number
  alpha: number
  poly: Pt[]
}

export interface Frame {
  ctx: CanvasRenderingContext2D
  view: View
  layout: StrataLayout
  /** How solid each deck is drawn (0..1). */
  deckAlpha: readonly number[]
  focusDeck: number
  look: (n: StrataNode) => NodeLook
  /** Connectors to light up (null: none picked, all drawn evenly). */
  hotEdges: ReadonlySet<string> | null
  palette: Palette
  /** Seconds, for the pulses along lit connectors. */
  time: number
  pulses: boolean
  font: string
  /** A node's name (drawn over its parts on the deck below). */
  title: (id: string) => string
}

const NODE_H = 16
const GROUP_H = 26
const ARC_STEPS = 20
const COS = [0, 1, 2, 3, 4, 5].map((i) => Math.cos((Math.PI / 3) * i))
const SIN = [0, 1, 2, 3, 4, 5].map((i) => Math.sin((Math.PI / 3) * i))

export const prismHeight = (n: StrataNode): number => (n.kind === 'group' ? GROUP_H : NODE_H)

function hexRing(v: View, x: number, y: number, z: number, r: number): Projected[] | null {
  const out: Projected[] = []
  for (let i = 0; i < 6; i++) {
    const p = project(v, x + r * (COS[i] as number), y, z + r * (SIN[i] as number))
    if (p === null) return null
    out.push(p)
  }
  return out
}

function trace(ctx: CanvasRenderingContext2D, pts: readonly Pt[], close = true): void {
  ctx.beginPath()
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  if (close) ctx.closePath()
}

export function drawFrame(f: Frame): Placed[] {
  const { ctx, view, layout } = f
  ctx.clearRect(0, 0, view.w, view.h)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const placed: Placed[] = []
  const edgesByDeck = new Map<number, StrataEdge[]>()
  for (const e of layout.edges) edgesByDeck.set(e.deck, [...(edgesByDeck.get(e.deck) ?? []), e])

  for (let i = layout.decks.length - 1; i >= 0; i--) {
    const deck = layout.decks[i] as StrataDeck
    const alpha = f.deckAlpha[i] ?? 0
    if (alpha < 0.015) continue
    drawPlate(f, deck, alpha)

    const items: { n: StrataNode; depth: number }[] = []
    for (const id of deck.nodeIds) {
      const n = layout.nodes.get(id)
      if (n === undefined) continue
      const c = project(view, n.x, deck.y, n.z)
      if (c !== null) items.push({ n, depth: c.depth })
    }
    items.sort((a, b) => b.depth - a.depth)
    const glow = alpha > 0.9 && items.length <= 160
    for (const it of items) {
      const p = drawPrism(f, it.n, deck, alpha, glow)
      if (p !== null) placed.push(p)
    }
    for (const e of edgesByDeck.get(i) ?? []) drawEdge(f, e)
    if (i > 0) {
      const above = layout.decks[i - 1] as StrataDeck
      for (const id of above.nodeIds) {
        const parent = layout.nodes.get(id)
        if (parent !== undefined && parent.children.length > 0) drawCone(f, parent, above, deck)
      }
    }
  }
  ctx.globalAlpha = 1
  return placed
}

function drawPlate(f: Frame, deck: StrataDeck, alpha: number): void {
  const { ctx, view, palette } = f
  const ring = hexRing(view, deck.center.x, deck.y - 1, deck.center.z, deck.radius)
  if (ring === null) return
  const focused = deck.index === f.focusDeck
  trace(ctx, ring)
  // A deck above the one in focus is glass: it must not veil what is under it.
  ctx.globalAlpha = (f.focusDeck < 0 ? 0.2 : deck.index < f.focusDeck ? 0.12 : 0.5) * alpha
  ctx.fillStyle = palette.fill
  ctx.fill()
  ctx.globalAlpha = (focused ? 0.75 : 0.45) * alpha
  ctx.strokeStyle = palette.primary
  ctx.lineWidth = focused ? 1.6 : 1
  if (focused) {
    ctx.shadowColor = palette.primary
    ctx.shadowBlur = 16
  }
  ctx.stroke()
  ctx.shadowBlur = 0
  // Two inner rings: they give the plate its perspective.
  ctx.lineWidth = 1
  ctx.strokeStyle = palette.edge
  for (const k of [0.66, 0.33]) {
    const inner = hexRing(view, deck.center.x, deck.y - 1, deck.center.z, deck.radius * k)
    if (inner === null) continue
    trace(ctx, inner)
    ctx.globalAlpha = 0.13 * alpha
    ctx.stroke()
  }
  // The deck's name, beside its leftmost corner.
  let corner = ring[0] as Projected
  for (const p of ring) if (p.x < corner.x) corner = p
  ctx.globalAlpha = clamp(0.3 + 0.7 * alpha, 0, 1)
  ctx.fillStyle = focused ? palette.label : palette.edge
  ctx.font = f.font
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  const text = `${deck.label.toUpperCase()} · ${deck.nodeIds.length}`
  // Kept on the canvas when the corner runs off its left edge.
  ctx.fillText(text, Math.max(corner.x - 12, ctx.measureText(text).width + 10), corner.y)
}

function drawPrism(
  f: Frame,
  n: StrataNode,
  deck: StrataDeck,
  deckAlpha: number,
  glow: boolean,
): Placed | null {
  const { ctx, view, palette } = f
  const h = prismHeight(n)
  const top = hexRing(view, n.x, deck.y + h, n.z, n.r - 1.5)
  const bottom = hexRing(view, n.x, deck.y, n.z, n.r - 1.5)
  const centre = project(view, n.x, deck.y + h, n.z)
  if (top === null || bottom === null || centre === null) return null
  const look = f.look(n)
  const alpha = deckAlpha * (look.dim ? 0.2 : 1) * (look.faded ? 0.62 : 1)
  const lw = clamp(centre.scale * 3.2, 0.8, 2.2)
  if (look.dashed) ctx.setLineDash([Math.max(2, centre.scale * 9), Math.max(2.5, centre.scale * 9)])

  // The walls that face the camera.
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * (k + 0.5)
    const nx = Math.cos(a)
    const nz = Math.sin(a)
    const wx = n.x + n.r * (COS[k] as number)
    const wz = n.z + n.r * (SIN[k] as number)
    if ((view.px - wx) * nx + (view.pz - wz) * nz <= 0) continue
    const j = (k + 1) % 6
    trace(ctx, [top[k] as Pt, top[j] as Pt, bottom[j] as Pt, bottom[k] as Pt])
    ctx.globalAlpha = alpha
    ctx.fillStyle = palette.fill
    ctx.fill()
    // Lit from the camera's right.
    ctx.globalAlpha = alpha * (0.13 + 0.2 * Math.max(0, nx * view.rx + nz * view.rz))
    ctx.fillStyle = look.color
    ctx.fill()
    ctx.globalAlpha = alpha
    ctx.strokeStyle = look.color
    ctx.lineWidth = lw * 0.75
    ctx.stroke()
  }

  trace(ctx, top)
  ctx.globalAlpha = alpha
  ctx.fillStyle = palette.fill
  ctx.fill()
  ctx.globalAlpha = alpha * (n.kind === 'group' ? 0.2 : 0.09)
  ctx.fillStyle = look.color
  ctx.fill()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = look.color
  ctx.lineWidth = lw
  if (look.hot || look.selected || glow) {
    ctx.shadowColor = look.color
    ctx.shadowBlur = look.hot || look.selected ? 18 : 7
  }
  ctx.stroke()
  ctx.shadowBlur = 0
  ctx.setLineDash([])

  const r = n.r * centre.scale
  if (r > 16) {
    const inner = hexRing(view, n.x, deck.y + h, n.z, n.r - 10)
    if (inner !== null) {
      trace(ctx, inner)
      ctx.globalAlpha = alpha * 0.24
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }
  if (look.selected) {
    const outer = hexRing(view, n.x, deck.y + h, n.z, n.r + 7)
    if (outer !== null) {
      trace(ctx, outer)
      ctx.globalAlpha = Math.max(alpha, 0.85)
      ctx.strokeStyle = palette.ring
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }
  let below = -Infinity
  for (const p of bottom) below = Math.max(below, p.y)
  return {
    id: n.id,
    deck: n.deck,
    x: centre.x,
    y: centre.y,
    r,
    depth: centre.depth,
    below: below + 4,
    alpha,
    poly: top,
  }
}

/** The cone of light from a node down to its parts on the deck below. */
function drawCone(f: Frame, parent: StrataNode, above: StrataDeck, below: StrataDeck): void {
  const { ctx, view, layout } = f
  let cx = 0
  let cz = 0
  const kids: StrataNode[] = []
  for (const id of parent.children) {
    const k = layout.nodes.get(id)
    if (k === undefined) continue
    kids.push(k)
    cx += k.x
    cz += k.z
  }
  if (kids.length === 0) return
  cx /= kids.length
  cz /= kids.length
  let radius = 0
  for (const k of kids) radius = Math.max(radius, Math.hypot(k.x - cx, k.z - cz) + k.r * 0.9)
  const pts: Pt[] = []
  const from = hexRing(view, parent.x, above.y, parent.z, parent.r * 0.72)
  if (from === null) return
  pts.push(...from)
  const y = below.y + NODE_H
  for (let i = 0; i < 14; i++) {
    const a = (Math.PI * 2 * i) / 14
    const p = project(view, cx + radius * Math.cos(a), y, cz + radius * Math.sin(a))
    if (p === null) return
    pts.push(p)
  }
  const look = f.look(parent)
  const alpha =
    Math.min(1, ((f.deckAlpha[above.index] ?? 0) + (f.deckAlpha[below.index] ?? 0)) / 2) *
    (look.dim ? 0.3 : 1)
  trace(ctx, convexHull(pts))
  ctx.globalAlpha = (look.hot || look.selected ? 0.13 : 0.06) * alpha
  ctx.fillStyle = look.color
  ctx.fill()
  ctx.globalAlpha = (look.hot || look.selected ? 0.5 : 0.2) * alpha
  ctx.strokeStyle = look.color
  ctx.lineWidth = 1
  ctx.stroke()
  // On a solid deck, each group of parts is captioned with what it belongs to.
  const lower = f.deckAlpha[below.index] ?? 0
  if (parent.kind === 'group' || lower < 0.45) return
  let top = pts[6] as Pt
  for (let i = 7; i < pts.length; i++) if ((pts[i] as Pt).y < top.y) top = pts[i] as Pt
  ctx.globalAlpha = 0.8 * lower * (look.dim ? 0.3 : 1)
  ctx.fillStyle = look.color
  ctx.font = f.font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillText(f.title(parent.id).toUpperCase(), top.x, top.y - 5)
}

function drawEdge(f: Frame, e: StrataEdge): void {
  const { ctx, view, layout, palette } = f
  const a = layout.nodes.get(e.a)
  const b = layout.nodes.get(e.b)
  if (a === undefined || b === undefined) return
  const ya = (layout.decks[a.deck]?.y ?? 0) + prismHeight(a)
  const yb = (layout.decks[b.deck]?.y ?? 0) + prismHeight(b)
  let dx = b.x - a.x
  let dz = b.z - a.z
  const len = Math.hypot(dx, dz)
  if (len > 1e-6) {
    dx /= len
    dz /= len
  }
  // From rim to rim, lifted over the deck in between: a connector never runs through a node.
  const trim = len > a.r + b.r ? 0.94 : 0
  const x0 = a.x + dx * a.r * trim
  const z0 = a.z + dz * a.r * trim
  const x1 = b.x - dx * b.r * trim
  const z1 = b.z - dz * b.r * trim
  const lift = e.riser ? 36 : clamp(len * 0.2, 20, 210)
  const mx = (x0 + x1) / 2
  const my = Math.max(ya, yb) + lift
  const mz = (z0 + z1) / 2
  const pts: Projected[] = []
  for (let i = 0; i <= ARC_STEPS; i++) {
    const t = i / ARC_STEPS
    const u = 1 - t
    const p = project(
      view,
      u * u * x0 + 2 * u * t * mx + t * t * x1,
      u * u * ya + 2 * u * t * my + t * t * yb,
      u * u * z0 + 2 * u * t * mz + t * t * z1,
    )
    if (p === null) return
    pts.push(p)
  }
  const la = f.look(a)
  const lb = f.look(b)
  const hot = f.hotEdges?.has(e.id) === true
  const deckAlpha = Math.min(f.deckAlpha[a.deck] ?? 0, f.deckAlpha[b.deck] ?? 0)
  let alpha = hot ? Math.max(0.55, deckAlpha) : 0.55 * deckAlpha
  if (la.dim || lb.dim) alpha *= 0.25
  else if (f.hotEdges !== null && !hot) alpha *= 0.4
  if (alpha < 0.012) return
  const mid = pts[ARC_STEPS / 2] as Projected
  const count = e.ab + e.ba
  const lw = clamp(1.1 + 0.45 * Math.log2(count), 1, 3) * clamp(mid.scale * 2.4, 0.55, 1.25) + (hot ? 0.7 : 0)
  ctx.globalAlpha = alpha
  ctx.strokeStyle = hot ? palette.primary : palette.edge
  ctx.lineWidth = lw
  if (e.async) ctx.setLineDash([6, 5])
  trace(ctx, pts, false)
  ctx.stroke()
  ctx.setLineDash([])

  // One barb per direction (the harpoon): at b for a→b, at a for b→a.
  const barb = clamp(mid.scale * 44, 6, 14)
  const drawBarb = (tip: Pt, back: Pt): void => {
    const ux = back.x - tip.x
    const uy = back.y - tip.y
    const d = Math.hypot(ux, uy)
    if (d < 1e-3) return
    const cos = Math.cos(0.5)
    const sin = Math.sin(0.5)
    ctx.beginPath()
    ctx.moveTo(tip.x, tip.y)
    ctx.lineTo(tip.x + ((ux * cos - uy * sin) / d) * barb, tip.y + ((ux * sin + uy * cos) / d) * barb)
    ctx.stroke()
  }
  if (e.ab > 0) drawBarb(pts[ARC_STEPS] as Pt, pts[ARC_STEPS - 2] as Pt)
  if (e.ba > 0) drawBarb(pts[0] as Pt, pts[2] as Pt)

  if (hot && f.pulses) {
    ctx.fillStyle = palette.primary
    ctx.shadowColor = palette.primary
    ctx.shadowBlur = 8
    const dot = (t: number): void => {
      const at = t * ARC_STEPS
      const i = Math.min(ARC_STEPS - 1, Math.floor(at))
      const p = pts[i] as Projected
      const q = pts[i + 1] as Projected
      const k = at - i
      ctx.beginPath()
      ctx.arc(p.x + (q.x - p.x) * k, p.y + (q.y - p.y) * k, clamp(p.scale * 7, 1.6, 3.4), 0, Math.PI * 2)
      ctx.fill()
    }
    for (let k = 0; k < 3; k++) {
      const t = (f.time * 0.42 + k / 3) % 1
      if (e.ab > 0) dot(t)
      if (e.ba > 0) dot(1 - t)
    }
    ctx.shadowBlur = 0
  }
}

/** Whether a screen point is inside a convex polygon (either winding). */
export function insidePoly(p: Pt, poly: readonly Pt[]): boolean {
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Pt
    const b = poly[(i + 1) % poly.length] as Pt
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (cross === 0) continue
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}
