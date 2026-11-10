// Levels: the architecture in 3D, one floating deck per level. Core (the few nodes the system turns around) sits
// above the System deck (the top level, as on the diagram), and every node's inner parts hang on the decks under it,
// so opening a level never pushes anything aside. The deck in focus is solid; the ones above and below show through.
// Drag to orbit, scroll to zoom, double-click a node to dive to its parts. Read-only: editing stays on the diagram.
import { Expand, Layers, Play, RotateCcw, Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hangsFrom, strataLayout } from '@shared/geometry/strata.ts'
import type { StrataNode } from '@shared/geometry/strata.ts'
import { dataScope } from '@shared/model/governance.ts'
import { KIND_INFO } from '@shared/model/kinds.ts'
import { DIFF_COLOR, IMPACT_COLOR } from '../canvas/HexNode.tsx'
import { computeLens } from '../canvas/lensMarks.ts'
import { useReview } from '../canvas/useReview.ts'
import { useHighlight, useImpact, useModel } from '../canvas/useScene.ts'
import { EmptyState } from '../components/ui/EmptyState.tsx'
import { cn } from '../lib/cn.ts'
import { kindIcon, nodeColor } from '../lib/icons.tsx'
import { reducedMotion } from '../lib/motion.ts'
import { select } from '../state/actions.ts'
import { useStore } from '../state/store.ts'
import { TimeBar } from '../time/TimeBar.tsx'
import { useProjection } from '../time/timeStore.ts'
import { fitDistance } from './camera3d.ts'
import { StrataEngine } from './engine.ts'
import type { LabelEls, Live } from './engine.ts'
import type { NodeLook } from './render.ts'

const LABEL_FONT = '500 11.5px ui-sans-serif, system-ui, sans-serif'
const TOUR_STEP_MS = 3400

/** What a node is called under its prism: a Core group takes its anchor's name. */
function titleOf(n: StrataNode, name: (id: string) => string): string {
  return n.kind === 'group' ? name(n.members[0] ?? n.id) : name(n.id)
}

export function StrataView(): React.JSX.Element {
  const storeModel = useModel()
  const review = useReview()
  const roadmap = useProjection()
  // Like the diagram: a change under review, or the architecture as of a commit or the end of a roadmap phase.
  const model = review?.model ?? roadmap?.model ?? storeModel
  const layout = useMemo(() => strataLayout(model), [model])
  const highlight = useHighlight(model)
  const impact = useImpact(model)
  const lensState = useStore((s) => s.ui.lens)
  const lens = useMemo(
    () =>
      lensState === null
        ? null
        : {
            marks: computeLens(model, lensState.kind, dataScope(model)).marks,
            hidden: new Set(lensState.hidden),
          },
    [model, lensState],
  )
  const diff = useMemo(
    () => new Map((review?.summary ?? roadmap?.summary)?.nodes.map((c) => [c.id, c.kind]) ?? []),
    [review, roadmap],
  )
  const selection = useStore((s) => s.ui.selection)
  const theme = useStore((s) => s.theme.resolved)
  const centerReq = useStore((s) => s.ui.centerOn)
  const fitNonce = useStore((s) => s.ui.fitNonce)

  const home = layout.hasCore ? 1 : 0
  const [picked, setPicked] = useState<number | null>(null)
  const level = Math.min(picked ?? home, Math.max(0, layout.decks.length - 1))
  const [explode, setExplode] = useState(false)
  const [hover, setHover] = useState<string | null>(null)
  /** The node dived into: on the decks under it, everything else dims. */
  const [branch, setBranch] = useState<string | null>(null)
  const [touring, setTouring] = useState(false)

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelsRef = useRef(new Map<string, LabelEls>())
  const engineRef = useRef<StrataEngine | null>(null)
  const tourRef = useRef<number | null>(null)
  /** The node this view selected itself (so the selection effect does not fly to it again). */
  const ownPick = useRef<string | null>(null)

  const selected = useMemo(() => new Set(selection?.kind === 'node' ? selection.ids : []), [selection])
  const active = hover ?? (selected.size === 1 ? ([...selected][0] ?? null) : null)

  // What lights up with the hovered or selected node: its connectors on every deck and the nodes at their far ends.
  const hot = useMemo(() => {
    if (active === null) return { nodes: new Set<string>(), edges: null }
    const ids = new Set([active])
    // A top-level node also lights its Core group's connectors, and a group lights its members'.
    const self = layout.nodes.get(active)
    if (self?.kind === 'group') for (const m of self.members) ids.add(m)
    const nodes = new Set<string>(ids)
    const edges = new Set<string>()
    for (const e of layout.edges) {
      if (!ids.has(e.a) && !ids.has(e.b)) continue
      edges.add(e.id)
      nodes.add(e.a)
      nodes.add(e.b)
    }
    return { nodes, edges }
  }, [active, layout])

  // Colour without hover or selection, shared by the canvas and the icons.
  const baseColor = useMemo(() => {
    const out = new Map<string, string>()
    for (const n of layout.nodes.values()) {
      const id = n.kind === 'group' ? (n.members[0] ?? n.id) : n.id
      const m = model.nodes[id]
      if (m === undefined) continue
      const d = n.kind === 'node' ? diff.get(id) : undefined
      const hit = n.kind === 'node' ? impact?.get(id) : undefined
      out.set(
        n.id,
        d !== undefined
          ? DIFF_COLOR[d]
          : hit !== undefined && hit.kind !== 'origin'
            ? IMPACT_COLOR[hit.kind]
            : (lens?.marks.get(id)?.color ?? nodeColor(m)),
      )
    }
    return out
  }, [layout, model, diff, impact, lens])

  const looks = useMemo(() => {
    const out = new Map<string, NodeLook>()
    const branchDeck = branch === null ? null : (layout.nodes.get(branch)?.deck ?? null)
    for (const n of layout.nodes.values()) {
      const ids = n.kind === 'group' ? n.members : [n.id]
      const m = model.nodes[ids[0] ?? '']
      const outOfSearch = highlight !== null && !ids.some((id) => highlight.has(id))
      const outOfLens =
        lens !== null && ids.every((id) => (lens.marks.get(id)?.keys ?? []).every((k) => lens.hidden.has(k)))
      const outOfBranch =
        branch !== null && branchDeck !== null && n.deck > branchDeck && !hangsFrom(layout, n.id, branch)
      out.set(n.id, {
        color: baseColor.get(n.id) ?? 'var(--hx-slate)',
        dim: outOfSearch || outOfLens || outOfBranch,
        faded: n.kind === 'node' && (m?.status === 'planned' || m?.status === 'removed'),
        dashed:
          n.kind === 'node' &&
          (m?.status === 'planned' || m?.status === 'in-progress' || m?.boundary === 'external'),
        selected: selected.has(n.id),
        hot: hot.nodes.has(n.id),
      })
    }
    return out
  }, [layout, model, baseColor, highlight, lens, branch, selected, hot])

  const widths = useMemo(() => {
    const ctx = document.createElement('canvas').getContext('2d')
    if (ctx !== null) ctx.font = LABEL_FONT
    const out = new Map<string, number>()
    for (const n of layout.nodes.values()) {
      const text = titleOf(n, (id) => model.nodes[id]?.name ?? id)
      out.set(
        n.id,
        Math.min(
          168,
          (ctx?.measureText(text).width ?? text.length * 6.5) + (n.children.length > 0 ? 40 : 14),
        ),
      )
    }
    return out
  }, [layout, model])

  const pinned = useMemo(() => new Set([...selected, ...(hover === null ? [] : [hover])]), [selected, hover])
  const live = useMemo<Live>(
    () => ({
      layout,
      looks,
      hotEdges: hot.edges,
      level,
      explode,
      pinned,
      labelWidth: (id) => widths.get(id) ?? 80,
      title: (id) => model.nodes[id]?.name ?? id,
      theme,
    }),
    [layout, looks, hot, level, explode, pinned, widths, model, theme],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const engine = new StrataEngine(canvas, labelsRef.current)
    engineRef.current = engine
    const ro = new ResizeObserver(() => engine.invalidate())
    ro.observe(canvas)
    return () => {
      ro.disconnect()
      engine.dispose()
      engineRef.current = null
    }
  }, [])

  // The first frame of a project looks at the home deck; later model edits leave the camera where it is.
  useEffect(() => {
    const engine = engineRef.current
    if (engine === null) return
    engine.setLive(live)
    if (engine.framedFor !== model.meta.id && layout.decks.length > 0) {
      engine.framedFor = model.meta.id
      engine.frameLevel(live.level, true)
    }
  }, [live, model.meta.id, layout])

  const stopTour = useCallback(() => {
    if (tourRef.current !== null) window.clearTimeout(tourRef.current)
    tourRef.current = null
    if (engineRef.current !== null) engineRef.current.spin = 0
    setTouring(false)
  }, [])
  useEffect(() => stopTour, [stopTour])

  const goLevel = useCallback(
    (index: number) => {
      const i = Math.max(0, Math.min(layout.decks.length - 1, index))
      setBranch(null)
      setExplode(false)
      setPicked(i)
      engineRef.current?.frameLevel(i)
    },
    [layout],
  )

  /** Bring a node into view on its own deck. */
  const reveal = useCallback(
    (id: string) => {
      const n = layout.nodes.get(id)
      const deck = n === undefined ? undefined : layout.decks[n.deck]
      const engine = engineRef.current
      if (n === undefined || deck === undefined || engine === null) return
      setExplode(false)
      setPicked(n.deck)
      const el = canvasRef.current
      engine.flyTo(
        n.x,
        deck.y,
        n.z,
        Math.min(
          engine.goal.dist,
          fitDistance(deck.radius * 0.6, el?.clientWidth ?? 800, el?.clientHeight ?? 600),
        ),
      )
    },
    [layout],
  )

  /** Go down to a node's parts (a Core group's members), dimming the rest of that deck. */
  const dive = useCallback((id: string) => {
    const engine = engineRef.current
    const parts = engine?.partsOf(id) ?? null
    if (engine === null || parts === null) return false
    setBranch(id)
    setExplode(false)
    setPicked(parts.deck.index)
    const el = canvasRef.current
    engine.flyTo(
      parts.x,
      parts.y,
      parts.z,
      fitDistance(parts.radius + 150, el?.clientWidth ?? 800, el?.clientHeight ?? 600),
    )
    return true
  }, [])

  const click = useCallback(
    (id: string | null) => {
      if (id === null) {
        ownPick.current = null
        select(null)
        setBranch(null)
        return
      }
      const n = layout.nodes.get(id)
      if (n === undefined) return
      if (n.kind === 'group') {
        dive(id)
        return
      }
      ownPick.current = id
      select({ kind: 'node', ids: [id] })
      if (n.deck !== level && !explode) reveal(id)
    },
    [layout, level, explode, dive, reveal],
  )

  // Selected elsewhere (the architecture tree, a table, search): go to it.
  const onlySelected = selected.size === 1 ? ([...selected][0] ?? null) : null
  useEffect(() => {
    if (onlySelected === null || onlySelected === ownPick.current) return
    ownPick.current = onlySelected
    reveal(onlySelected)
  }, [onlySelected, reveal])
  useEffect(() => {
    if (centerReq !== null) reveal(centerReq.id)
    // Only when asked again (the nonce), not when the layout changes under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerReq?.nonce])
  const firstFit = useRef(fitNonce)
  useEffect(() => {
    if (firstFit.current === fitNonce) return
    firstFit.current = fitNonce
    engineRef.current?.home()
    engineRef.current?.frameLevel(level)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitNonce])

  const toggleExplode = (): void => {
    stopTour()
    setBranch(null)
    if (explode) engineRef.current?.frameLevel(level)
    else engineRef.current?.frameAll()
    setExplode(!explode)
  }

  const startTour = (): void => {
    const engine = engineRef.current
    if (engine === null) return
    setTouring(true)
    setBranch(null)
    engine.spin = 0.14
    let i = 0
    const step = (): void => {
      if (i < layout.decks.length) {
        setExplode(false)
        setPicked(i)
        engine.frameLevel(i)
        tourRef.current = window.setTimeout(step, TOUR_STEP_MS)
      } else if (i === layout.decks.length) {
        setExplode(true)
        engine.frameAll()
        tourRef.current = window.setTimeout(step, TOUR_STEP_MS * 1.6)
      } else {
        stopTour()
        setExplode(false)
        setPicked(null)
        engine.frameLevel(home)
      }
      i++
    }
    step()
  }

  // ---- pointer, wheel, keys ------------------------------------------------------------------------------------

  const drag = useRef<{ x: number; y: number; pan: boolean; moved: boolean } | null>(null)
  const at = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = canvasRef.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }
  const onPointerDown = (e: React.PointerEvent): void => {
    if (touring) stopTour()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    const engine = engineRef.current
    if (engine === null) return
    if (d === null) {
      const p = at(e)
      const id = engine.pick(p.x, p.y)
      if (id !== hover) setHover(id)
      return
    }
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    d.moved = true
    d.x = e.clientX
    d.y = e.clientY
    if (d.pan) engine.pan(dx, dy)
    else engine.orbit(dx, dy)
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    const d = drag.current
    drag.current = null
    if (d === null || d.moved || e.button !== 0) return
    const p = at(e)
    click(engineRef.current?.pick(p.x, p.y) ?? null)
  }
  const onDoubleClick = (e: React.MouseEvent): void => {
    const p = at(e)
    const id = engineRef.current?.pick(p.x, p.y) ?? null
    if (id !== null && !dive(id)) reveal(id)
  }
  useEffect(() => {
    const el = wrapRef.current
    if (el === null) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      engineRef.current?.zoom(Math.exp(e.deltaY * 0.0012))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const engine = engineRef.current
    if (engine === null || e.ctrlKey || e.metaKey || e.altKey) return
    const acts: Record<string, () => void> = {
      PageDown: () => goLevel(level + 1),
      ']': () => goLevel(level + 1),
      PageUp: () => goLevel(level - 1),
      '[': () => goLevel(level - 1),
      ArrowLeft: () => engine.orbit(60, 0, true),
      ArrowRight: () => engine.orbit(-60, 0, true),
      ArrowUp: () => engine.orbit(0, 40, true),
      ArrowDown: () => engine.orbit(0, -40, true),
      '+': () => engine.zoom(0.8),
      '=': () => engine.zoom(0.8),
      '-': () => engine.zoom(1.25),
      Home: () => {
        engine.home()
        goLevel(home)
      },
    }
    const act = e.key === 'Escape' ? (branch === null ? undefined : () => setBranch(null)) : acts[e.key]
    if (act === undefined) return
    if (touring) stopTour()
    e.preventDefault()
    act()
  }

  // ---- labels and HUD ------------------------------------------------------------------------------------------

  const register = (id: string, part: keyof LabelEls) => (el: HTMLElement | null) => {
    const map = labelsRef.current
    const cur = map.get(id) ?? { icon: null, name: null }
    cur[part] = el
    if (cur.icon === null && cur.name === null) map.delete(id)
    else map.set(id, cur)
  }
  const labels = useMemo(
    () =>
      [...layout.nodes.values()].map((n) => {
        const m = model.nodes[n.kind === 'group' ? (n.members[0] ?? '') : n.id]
        if (m === undefined) return null
        const Icon = n.kind === 'group' ? Layers : kindIcon(m.kind)
        const struck = n.kind === 'node' && (m.status === 'deprecated' || m.status === 'removed')
        // How many more it stands for: a node's inner parts, a Core group's other members.
        const inside = n.kind === 'group' ? n.children.length - 1 : n.children.length
        return (
          <div key={n.id}>
            <span
              ref={register(n.id, 'icon')}
              className="absolute top-0 left-0 will-change-transform"
              style={{ display: 'none', color: baseColor.get(n.id) }}
              aria-hidden
            >
              <Icon className="size-[18px]" />
            </span>
            <button
              ref={register(n.id, 'name')}
              type="button"
              className={cn(
                'absolute top-0 left-0 flex max-w-[168px] items-center gap-1 rounded-full px-1.5 py-px text-[11.5px] leading-tight font-medium whitespace-nowrap text-[var(--hx-label)] outline-none will-change-transform focus-visible:ring-2 focus-visible:ring-ring',
                n.kind === 'group' && 'font-semibold',
              )}
              style={{
                visibility: 'hidden',
                textShadow: '0 0 6px var(--background), 0 0 2px var(--background)',
              }}
              onFocus={() => setHover(n.id)}
              onBlur={() => setHover(null)}
              onClick={() => click(n.id)}
            >
              <span className={cn('truncate', struck && 'line-through')}>{m.name}</span>
              {inside > 0 && (
                <span className="shrink-0 rounded-full border bg-popover px-1 text-[9.5px] font-semibold text-muted-foreground">
                  +{inside}
                </span>
              )}
            </button>
          </div>
        )
      }),
    // `register` and `click` only touch refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, model, baseColor],
  )

  const info = useMemo(() => {
    const n = active === null ? undefined : layout.nodes.get(active)
    if (n === undefined) return null
    const name = (id: string): string => model.nodes[id]?.name ?? id
    if (n.kind === 'group') {
      const rest = n.members.slice(1).map(name)
      return {
        title: name(n.members[0] ?? n.id),
        sub: 'Core',
        body: rest.length === 0 ? 'Stands on its own.' : `With ${rest.join(', ')}.`,
        hint: 'Click to go down to them',
      }
    }
    const m = model.nodes[n.id]
    if (m === undefined) return null
    const links = layout.edges
      .filter((e) => e.deck === n.deck && (e.a === n.id || e.b === n.id))
      .reduce((sum, e) => sum + e.ab + e.ba, 0)
    const bits = [
      m.techStack ?? m.vendor,
      `${links} connector${links === 1 ? '' : 's'} on this level`,
    ].filter((x): x is string => x != null && x !== '')
    return {
      title: m.name,
      sub: KIND_INFO[m.kind].label,
      body: bits.join(' · '),
      hint:
        n.children.length > 0
          ? `Double-click to go down to its ${n.children.length} inner part${n.children.length === 1 ? '' : 's'}`
          : null,
    }
  }, [active, layout, model])

  if (layout.decks.length === 0) {
    return (
      <EmptyState
        className="h-full"
        icon={Layers}
        title="Nothing to show in 3D yet"
        description="Add services on the diagram; they appear here as floating levels."
      />
    )
  }

  const hud =
    'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring'
  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      role="application"
      aria-label="The architecture as floating levels in 3D"
      className={cn(
        'relative h-full w-full touch-none overflow-hidden bg-background outline-none select-none',
        hover !== null ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => drag.current === null && setHover(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div className="pointer-events-none absolute inset-0 overflow-hidden">{labels}</div>

      <div
        className="absolute top-3 left-3 flex w-[150px] flex-col gap-0.5 rounded-lg border bg-popover/90 p-1.5 shadow-lg backdrop-blur"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="px-2 pt-0.5 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          Levels
        </div>
        {layout.decks.map((d) => {
          const on = !explode && d.index === level
          return (
            <button
              key={d.index}
              type="button"
              aria-pressed={on}
              title={
                d.depth === 'core'
                  ? 'The few nodes the system turns around, each with the nodes that mostly serve it'
                  : `Go to the ${d.label} level`
              }
              className={cn(hud, on && 'bg-primary/15 font-medium')}
              onClick={() => goLevel(d.index)}
            >
              <span
                aria-hidden
                className={cn(
                  'size-2 shrink-0 rotate-45 border',
                  on ? 'border-primary bg-primary' : 'border-muted-foreground',
                )}
              />
              <span className="min-w-0 flex-1 truncate">{d.label}</span>
              <span className="text-[10px] text-muted-foreground tabular-nums">{d.nodeIds.length}</span>
            </button>
          )
        })}
        <div className="my-1 h-px bg-border" />
        <button
          type="button"
          aria-pressed={explode}
          title="Every level solid at once"
          className={cn(hud, explode && 'bg-primary/15 font-medium')}
          onClick={toggleExplode}
        >
          <Expand aria-hidden className="size-3.5 shrink-0" />
          All levels
        </button>
        {!reducedMotion() && (
          <button
            type="button"
            title="A slow flight down through every level"
            className={hud}
            onClick={() => (touring ? stopTour() : startTour())}
          >
            {touring ? (
              <Square aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <Play aria-hidden className="size-3.5 shrink-0" />
            )}
            {touring ? 'Stop tour' : 'Tour'}
          </button>
        )}
        <button
          type="button"
          title="Back to the starting angle (Home)"
          className={hud}
          onClick={() => {
            stopTour()
            engineRef.current?.home()
            goLevel(explode ? level : home)
          }}
        >
          <RotateCcw aria-hidden className="size-3.5 shrink-0" />
          Reset view
        </button>
      </div>

      {info !== null && (
        <div className="pointer-events-none absolute top-3 left-1/2 max-w-[70%] -translate-x-1/2 rounded-lg border bg-popover/90 px-3 py-1.5 text-center shadow-lg backdrop-blur">
          <div className="text-sm font-medium">
            {info.title}{' '}
            <span className="ml-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
              {info.sub}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">{info.body}</div>
          {info.hint !== null && <div className="text-[11px] text-primary">{info.hint}</div>}
        </div>
      )}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2">
        <TimeBar />
      </div>
      <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 text-[11px] whitespace-nowrap text-muted-foreground">
        Drag to orbit · Shift-drag to pan · Scroll to zoom · Double-click a node to go down a level
      </div>
    </div>
  )
}
