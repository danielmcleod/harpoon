// The simulator's transport bar (mockup 2): play / pause / step / reset, a scrubber over the recorded frames (marked
// where things went bad), the simulated clock, the traffic load (how much is sent, in rps) and the playback speed
// (how fast simulated time runs; it does not change the load).
import { Panel } from '@xyflow/react'
import { FastForward, Gauge, Minus, Pause, Play, Plus, RotateCcw, StepForward } from 'lucide-react'
import { useMemo } from 'react'
import { failureReport } from '@shared/sim/explain.ts'
import { failureOnsets } from '@shared/sim/onsets.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { useStore } from '../state/store.ts'
import { TICK_SEC, resetSim, stepSim, useSim } from './simStore.ts'
import { LOAD_MAX, LOAD_MIN, fmtRps, fmtX, stepLoad, useHeadroom, useLoad } from './load.ts'

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 10] as const

export function clock(t: number): string {
  const s = Math.floor(t)
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

export function Timeline(): React.JSX.Element {
  const playing = useSim((s) => s.playing)
  const speed = useSim((s) => s.speed)
  const count = useSim((s) => s.frames.length)
  const cursor = useSim((s) => s.cursor)
  const t = useSim((s) => (s.cursor === null ? (s.frames.at(-1)?.t ?? 0) : (s.frames[s.cursor]?.t ?? 0)))
  const model = useStore((s) => s.project?.model)
  const live = cursor === null
  const pos = live ? count - 1 : cursor

  return (
    // Spans the canvas so the bar can shrink to fit it (the scrubber gives way first).
    <Panel position="bottom-center" className="pointer-events-none flex justify-center" style={{ width: 'calc(100% - 30px)' }}>
      <div className="pointer-events-auto flex w-[820px] max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border bg-popover/95 px-3 py-2 shadow-lg backdrop-blur" role="toolbar" aria-label="Simulation controls">
        <Button variant="ghost" size="icon" className="size-8" aria-label={playing ? 'Pause' : 'Play'} onClick={() => useSim.setState({ playing: !playing, cursor: null })}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Step" title="Step one tick" onClick={() => model !== undefined && (useSim.setState({ cursor: null }), stepSim(model, 1))}>
          <StepForward />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Restart" title="Restart from zero" onClick={() => resetSim(model ?? null)}>
          <RotateCcw />
        </Button>
        <div className="relative flex min-w-[140px] flex-1 items-center">
          <FailureMarks />
          <input
            type="range"
            aria-label="Scrub through the recorded simulation"
            min={0}
            max={Math.max(0, count - 1)}
            value={Math.max(0, pos)}
            onChange={(e) => {
              const v = Number(e.target.value)
              useSim.setState({ cursor: v >= count - 1 ? null : v, playing: v >= count - 1 ? playing : false })
            }}
            className="min-w-0 flex-1 accent-[var(--primary)]"
          />
        </div>
        <span className="w-28 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
          {clock(t)} / {live ? <span className="text-success">Live</span> : clock((count - 1) * TICK_SEC)}
        </span>
        <LoadControl />
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title="Playback speed: how fast simulated time runs. It does not change the traffic; use Load for that.">
          <FastForward className="size-3.5" />
          <select aria-label="Playback speed" value={speed} onChange={(e) => useSim.setState({ speed: Number(e.target.value) })} className="h-7 rounded-md border bg-background px-1 text-xs text-foreground">
            {SPEEDS.map((v) => (
              <option key={v} value={v}>
                {v}× speed
              </option>
            ))}
          </select>
        </label>
      </div>
    </Panel>
  )
}

/** Traffic load: − / + step the multiplier; the label says what is being sent right now. Red past what it holds. */
function LoadControl(): React.JSX.Element {
  const model = useStore((s) => s.project?.model)
  const { base, multiplier, pattern, now } = useLoad(model)
  const room = useHeadroom(model)
  const over = room !== null && room.limit !== null && multiplier * pattern > room.limit
  const title = [
    `Sending ${fmtRps(now)}: ${fmtRps(base)} from the entry points × ${fmtX(multiplier)}${pattern !== 1 ? ` × ${pattern.toFixed(2)} from the pattern` : ''}.`,
    room === null ? 'Working out how much it holds…' : room.limit === null ? 'Holds past 20× with nothing failing.' : room.limit === 0 ? 'Something fails even with almost no load.' : `Holds up to ${fmtX(room.limit)} (${fmtRps(base * room.limit)}) before something fails.`,
    'Set the base load per entry point in the Load section of the panel.',
  ].join('\n')
  return (
    <div className="flex items-center gap-0.5 rounded-md border bg-background pl-1.5 text-[11px]" role="group" aria-label="Traffic load" title={title}>
      <Gauge className={cn('size-3.5', over ? 'text-destructive' : 'text-muted-foreground')} />
      <Button variant="ghost" size="icon" className="size-6" aria-label="Less traffic" disabled={multiplier <= LOAD_MIN} onClick={() => stepLoad(-1)}>
        <Minus />
      </Button>
      <span className={cn('min-w-[86px] text-center font-mono tabular-nums', over && 'text-destructive')}>
        {fmtX(multiplier)} · {fmtRps(now)}
      </span>
      <Button variant="ghost" size="icon" className="size-6" aria-label="More traffic" disabled={multiplier >= LOAD_MAX} onClick={() => stepLoad(1)}>
        <Plus />
      </Button>
    </div>
  )
}

/** The thumb's half-width: marks line up with where the thumb sits at that frame. */
const THUMB = 8

/**
 * Marks above the scrubber where things went bad (a node starts failing after a stretch with none): the first one
 * red and labelled, later ones fainter. Hover says what went wrong; a click jumps there.
 */
function FailureMarks(): React.JSX.Element | null {
  const frames = useSim((s) => s.frames)
  const onsets = useMemo(() => failureOnsets(frames), [frames])
  if (frames.length < 2 || onsets.length === 0) return null
  const last = frames.length - 1
  const why = (i: number): string => {
    const f = frames[i]
    const model = useStore.getState().project?.model
    const head = `${i === onsets[0] ? 'First went bad' : 'Went bad again'} at ${clock(f?.t ?? 0)}`
    if (f === undefined || model === undefined) return head
    const roots = failureReport(model, f).roots.filter((r) => r.health === 'bad')
    return [head, ...roots.slice(0, 5).map((r) => `• ${r.name}: ${r.reasons[0]?.text ?? 'failing'}`), ...(roots.length > 5 ? [`…and ${roots.length - 5} more`] : [])].join('\n')
  }
  return (
    <>
      {onsets.map((i, k) => (
        <button
          key={i}
          type="button"
          aria-label={k === 0 ? `First went bad at ${clock(frames[i]?.t ?? 0)}` : `Went bad again at ${clock(frames[i]?.t ?? 0)}`}
          onMouseEnter={(e) => (e.currentTarget.title = why(i))}
          onClick={() => useSim.setState({ cursor: i >= last ? null : i, playing: false })}
          className="pointer-events-none absolute -top-3.5 z-10 flex -translate-x-1/2 flex-col items-center"
          style={{ left: `calc(${THUMB}px + (100% - ${THUMB * 2}px) * ${i / last})` }}
        >
          {k === 0 && <span className="pointer-events-auto mb-0.5 rounded bg-destructive px-1 text-[9px] leading-[13px] font-semibold whitespace-nowrap text-white">First went bad</span>}
          <span className={cn('pointer-events-auto w-0.5 rounded-full', k === 0 ? 'h-3 bg-destructive' : 'h-2.5 bg-destructive/60')} />
        </button>
      ))}
    </>
  )
}
