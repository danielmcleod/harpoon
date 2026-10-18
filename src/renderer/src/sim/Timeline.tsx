// The simulator's transport bar (mockup 2): play / pause / step / reset, a scrubber over the recorded frames, the
// simulated clock, and the speed.
import { Panel } from '@xyflow/react'
import { FastForward, Pause, Play, RotateCcw, StepForward } from 'lucide-react'
import { Button } from '../components/ui/Button.tsx'
import { useStore } from '../state/store.ts'
import { TICK_SEC, resetSim, stepSim, useSim } from './simStore.ts'

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
    <Panel position="bottom-center">
      <div className="flex w-[560px] max-w-[70vw] items-center gap-2 rounded-xl border bg-popover/95 px-3 py-2 shadow-lg backdrop-blur" role="toolbar" aria-label="Simulation controls">
        <Button variant="ghost" size="icon" className="size-8" aria-label={playing ? 'Pause' : 'Play'} onClick={() => useSim.setState({ playing: !playing, cursor: null })}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Step" title="Step one tick" onClick={() => model !== undefined && (useSim.setState({ cursor: null }), stepSim(model, 1))}>
          <StepForward />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Restart" title="Restart from zero" onClick={() => resetSim(model ?? null)}>
          <RotateCcw />
        </Button>
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
        <span className="w-28 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
          {clock(t)} / {live ? <span className="text-success">Live</span> : clock((count - 1) * TICK_SEC)}
        </span>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <FastForward className="size-3.5" />
          <select aria-label="Speed" value={speed} onChange={(e) => useSim.setState({ speed: Number(e.target.value) })} className="h-7 rounded-md border bg-background px-1 text-xs text-foreground">
            {SPEEDS.map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
        </label>
      </div>
    </Panel>
  )
}
