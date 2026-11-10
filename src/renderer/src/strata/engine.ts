// The 3D view's engine: it owns the canvas, the camera and the frame loop, and moves the HTML labels (icons and
// names) to where their nodes land. It draws only when something changed: the camera gliding, decks fading, pulses
// running along lit connectors. React hands it the current state with setLive and calls the camera methods.
import type { StrataDeck, StrataLayout, StrataNode } from '@shared/geometry/strata.ts'
import { reducedMotion } from '../lib/motion.ts'
import { MAX_DIST, MAX_PITCH, MIN_DIST, MIN_PITCH, approach, clamp, fitDistance, viewOf } from './camera3d.ts'
import type { Cam } from './camera3d.ts'
import { drawFrame, insidePoly } from './render.ts'
import type { NodeLook, Palette, Placed } from './render.ts'

export interface Live {
  layout: StrataLayout
  /** Per node; colours may be CSS variables (resolved here, against the current theme). */
  looks: ReadonlyMap<string, NodeLook>
  hotEdges: ReadonlySet<string> | null
  /** The deck in focus. */
  level: number
  /** Every deck solid at once. */
  explode: boolean
  /** Nodes whose name always shows (hovered, selected). */
  pinned: ReadonlySet<string>
  labelWidth: (id: string) => number
  title: (id: string) => string
  /** Changes when the theme does, so colours are read again. */
  theme: string
}

export interface LabelEls {
  icon: HTMLElement | null
  name: HTMLElement | null
}

const HOME: Cam = { tx: 0, ty: 0, tz: 0, yaw: -0.5, pitch: 0.74, dist: 2400 }
const FALLBACK_LOOK: NodeLook = {
  color: '#888',
  dim: false,
  faded: false,
  dashed: false,
  selected: false,
  hot: false,
}
const LABEL_H = 18

/** How solid a deck is drawn, by its distance from the deck in focus. */
export function deckAlphaTarget(index: number, level: number, explode: boolean): number {
  if (explode) return 1
  const d = index - level
  if (d === 0) return 1
  if (d === 1) return 0.5
  if (d > 1) return 0.2
  return d === -1 ? 0.2 : 0.07
}

export class StrataEngine {
  readonly cam: Cam = { ...HOME }
  readonly goal: Cam = { ...HOME }
  /** Radians per second the camera turns on its own (the tour). */
  spin = 0
  placed: Placed[] = []
  /** The project the camera was last framed for (a new one starts on its home deck). */
  framedFor: string | null = null

  readonly #canvas: HTMLCanvasElement
  readonly #ctx: CanvasRenderingContext2D
  readonly #labels: ReadonlyMap<string, LabelEls>
  #live: Live | null = null
  #looks = new Map<string, NodeLook>()
  #palette: Palette = { fill: '#222', edge: '#888', label: '#eee', ring: '#88f', primary: '#88f' }
  #font = '600 11px sans-serif'
  #stale = true
  #alpha: number[] = []
  #raf = 0
  #last = 0
  #disposed = false
  /** The pitch to go back to after looking at every deck from the side. */
  #pitchBeforeAll: number | null = null

  constructor(canvas: HTMLCanvasElement, labels: ReadonlyMap<string, LabelEls>) {
    this.#canvas = canvas
    this.#labels = labels
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('No 2D canvas context.')
    this.#ctx = ctx
  }

  setLive(live: Live): void {
    this.#live = live
    this.#stale = true
    this.invalidate()
  }

  invalidate(): void {
    if (this.#raf !== 0 || this.#disposed) return
    this.#raf = requestAnimationFrame(this.#frame)
  }

  dispose(): void {
    this.#disposed = true
    if (this.#raf !== 0) cancelAnimationFrame(this.#raf)
    this.#raf = 0
  }

  // ---- camera -------------------------------------------------------------------------------------------------

  /** Look at one deck, from far enough to see all of it (the angle stays). */
  frameLevel(index: number, instant = false): void {
    const deck = this.#live?.layout.decks[index]
    if (deck === undefined) return
    if (this.#pitchBeforeAll !== null) {
      this.goal.pitch = this.#pitchBeforeAll
      this.#pitchBeforeAll = null
    }
    this.flyTo(
      deck.center.x,
      deck.y,
      deck.center.z,
      fitDistance(deck.radius, this.#canvas.clientWidth, this.#canvas.clientHeight),
      instant,
    )
  }

  /** Look at every deck at once. */
  frameAll(instant = false): void {
    const decks = this.#live?.layout.decks ?? []
    const first = decks[0]
    const last = decks[decks.length - 1]
    if (first === undefined || last === undefined) return
    // From the side, so the decks stand apart instead of lying over each other.
    this.#pitchBeforeAll ??= this.goal.pitch
    this.goal.pitch = Math.min(this.goal.pitch, 0.4)
    let radius = (first.y - last.y) * 0.62
    let x = 0
    let z = 0
    for (const d of decks) {
      radius = Math.max(radius, d.radius)
      x += d.center.x / decks.length
      z += d.center.z / decks.length
    }
    this.flyTo(
      x,
      (first.y + last.y) / 2,
      z,
      fitDistance(radius, this.#canvas.clientWidth, this.#canvas.clientHeight),
      instant,
    )
  }

  flyTo(x: number, y: number, z: number, dist?: number, instant = false): void {
    this.goal.tx = x
    this.goal.ty = y
    this.goal.tz = z
    if (dist !== undefined) this.goal.dist = clamp(dist, MIN_DIST, MAX_DIST)
    if (instant) Object.assign(this.cam, this.goal)
    this.invalidate()
  }

  home(): void {
    this.#pitchBeforeAll = null
    this.goal.yaw = HOME.yaw
    this.goal.pitch = HOME.pitch
    this.invalidate()
  }

  /** Turn by a drag of (dx, dy) px; `glide` eases there instead of following the pointer. */
  orbit(dx: number, dy: number, glide = false): void {
    this.goal.yaw -= dx * 0.0055
    this.goal.pitch = clamp(this.goal.pitch + dy * 0.0045, MIN_PITCH, MAX_PITCH)
    if (!glide) {
      this.cam.yaw = this.goal.yaw
      this.cam.pitch = this.goal.pitch
    }
    this.invalidate()
  }

  /** Slide what is under the pointer by (dx, dy) px, along the decks. */
  pan(dx: number, dy: number): void {
    const h = this.#canvas.clientHeight
    const k = this.cam.dist / viewOf(this.cam, this.#canvas.clientWidth, h).f
    const sy = Math.sin(this.cam.yaw)
    const cy = Math.cos(this.cam.yaw)
    const away = (dy * k) / Math.max(0.3, Math.sin(this.cam.pitch))
    const x = -cy * dx * k - sy * away
    const z = sy * dx * k - cy * away
    for (const c of [this.cam, this.goal]) {
      c.tx += x
      c.tz += z
    }
    this.invalidate()
  }

  zoom(factor: number): void {
    this.goal.dist = clamp(this.goal.dist * factor, MIN_DIST, MAX_DIST)
    this.invalidate()
  }

  // ---- picking ------------------------------------------------------------------------------------------------

  /** The node under a point of the canvas: the most solid one, then the nearest. */
  pick(x: number, y: number): string | null {
    let best: Placed | null = null
    for (const p of this.placed) {
      if (p.alpha < 0.1 || !insidePoly({ x, y }, p.poly)) continue
      if (
        best === null ||
        p.alpha > best.alpha + 0.05 ||
        (Math.abs(p.alpha - best.alpha) <= 0.05 && p.depth < best.depth)
      )
        best = p
    }
    return best?.id ?? null
  }

  /** The middle of a node's parts on the deck below and how wide they spread (null: it has none). */
  partsOf(id: string): { x: number; y: number; z: number; radius: number; deck: StrataDeck } | null {
    const layout = this.#live?.layout
    const n = layout?.nodes.get(id)
    if (layout === undefined || n === undefined) return null
    const kids = n.children.map((k) => layout.nodes.get(k)).filter((k): k is StrataNode => k !== undefined)
    const deck = layout.decks[n.deck + 1]
    if (kids.length === 0 || deck === undefined) return null
    let x = 0
    let z = 0
    for (const k of kids) {
      x += k.x / kids.length
      z += k.z / kids.length
    }
    let radius = 0
    for (const k of kids) radius = Math.max(radius, Math.hypot(k.x - x, k.z - z) + k.r)
    return { x, y: deck.y, z, radius, deck }
  }

  // ---- the frame ----------------------------------------------------------------------------------------------

  #frame = (now: number): void => {
    this.#raf = 0
    const live = this.#live
    if (live === null || this.#disposed) return
    const dt = clamp((now - this.#last) / 1000, 0, 0.05)
    this.#last = now
    const still = reducedMotion()
    const k = still ? 1 : 1 - Math.exp(-dt * 6.5)

    if (this.spin !== 0 && !still) {
      this.goal.yaw += this.spin * dt
      this.cam.yaw += this.spin * dt
    }
    const arrived = approach(this.cam, this.goal, k)

    let settled = true
    const decks = live.layout.decks.length
    if (this.#alpha.length !== decks)
      this.#alpha = Array.from({ length: decks }, (_, i) => deckAlphaTarget(i, live.level, live.explode))
    for (let i = 0; i < decks; i++) {
      const target = deckAlphaTarget(i, live.level, live.explode)
      const cur = this.#alpha[i] ?? target
      if (Math.abs(target - cur) < 0.01) this.#alpha[i] = target
      else {
        this.#alpha[i] = cur + (target - cur) * k
        settled = false
      }
    }

    if (this.#stale) this.#readTheme(live)

    const canvas = this.#canvas
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w === 0 || h === 0) return
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    this.#ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const pulses = !still && live.hotEdges !== null && live.hotEdges.size > 0
    this.placed = drawFrame({
      ctx: this.#ctx,
      view: viewOf(this.cam, w, h),
      layout: live.layout,
      deckAlpha: this.#alpha,
      focusDeck: live.explode ? -1 : live.level,
      look: (n) => this.#looks.get(n.id) ?? FALLBACK_LOOK,
      hotEdges: live.hotEdges,
      palette: this.#palette,
      time: now / 1000,
      pulses,
      font: this.#font,
      title: live.title,
    })
    this.#placeLabels(live)
    if (!arrived || !settled || pulses || (this.spin !== 0 && !still)) this.invalidate()
  }

  /** Colours come as CSS variables; a canvas needs their values, which change with the theme. */
  #readTheme(live: Live): void {
    this.#stale = false
    const css = getComputedStyle(this.#canvas)
    const cache = new Map<string, string>()
    const resolve = (c: string): string => {
      if (!c.startsWith('var(')) return c
      const known = cache.get(c)
      if (known !== undefined) return known
      const value = css.getPropertyValue(c.slice(4, -1).trim()).trim()
      const out = value === '' ? '#888' : value
      cache.set(c, out)
      return out
    }
    this.#palette = {
      fill: resolve('var(--hx-fill)'),
      edge: resolve('var(--hx-edge)'),
      label: resolve('var(--hx-label)'),
      ring: resolve('var(--ring)'),
      primary: resolve('var(--primary)'),
    }
    this.#font = `600 11px ${css.fontFamily === '' ? 'sans-serif' : css.fontFamily}`
    this.#looks = new Map([...live.looks].map(([id, l]) => [id, { ...l, color: resolve(l.color) }]))
  }

  /** Icons sit on the top faces; names go under the prisms, nearest first, and one that would cover another hides. */
  #placeLabels(live: Live): void {
    const seen = new Set<string>()
    const wanted: { p: Placed; pinned: boolean; el: HTMLElement }[] = []
    for (const p of this.placed) {
      const els = this.#labels.get(p.id)
      if (els === undefined) continue
      seen.add(p.id)
      if (els.icon !== null) {
        if (p.r > 9 && p.alpha > 0.1) {
          els.icon.style.display = ''
          els.icon.style.opacity = String(Math.min(1, p.alpha * 1.15))
          els.icon.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%) scale(${clamp(p.r / 27, 0.5, 1.5).toFixed(3)})`
        } else els.icon.style.display = 'none'
      }
      if (els.name === null) continue
      const pinned = live.pinned.has(p.id)
      if (pinned || (p.alpha > 0.8 && p.r > 15)) wanted.push({ p, pinned, el: els.name })
      else els.name.style.visibility = 'hidden'
    }
    for (const [id, els] of this.#labels) {
      if (seen.has(id)) continue
      if (els.icon !== null) els.icon.style.display = 'none'
      if (els.name !== null) els.name.style.visibility = 'hidden'
    }
    wanted.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.p.depth - b.p.depth)
    const kept: { x: number; y: number; w: number }[] = []
    for (const { p, pinned, el } of wanted) {
      const w = live.labelWidth(p.id)
      const x = p.x - w / 2
      const y = p.below
      if (
        !pinned &&
        kept.some((r) => x < r.x + r.w + 4 && r.x < x + w + 4 && y < r.y + LABEL_H && r.y < y + LABEL_H)
      ) {
        el.style.visibility = 'hidden'
        continue
      }
      kept.push({ x, y, w })
      el.style.visibility = 'visible'
      el.style.opacity = String(Math.min(1, p.alpha * 1.2))
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.below.toFixed(1)}px) translate(-50%, 0)`
    }
  }
}
