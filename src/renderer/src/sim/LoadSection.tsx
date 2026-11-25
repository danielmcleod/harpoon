// The simulator panel's Load section: what is being sent right now (in rps, and where that number comes from), the
// overall multiplier, how much the architecture holds before something fails (and what fails, and which flows go
// through it), the pattern over time, and the base load of each entry point (saved with the project).
import { Gauge, RotateCcw, TriangleAlert } from 'lucide-react'
import { DEFAULT_ENTRY_RPS } from '@shared/sim/engine.ts'
import type { LoadProfile } from '@shared/sim/engine.ts'
import { HEADROOM_MAX, PROFILE_PEAK, PROFILE_TEXT, baseLoad } from '@shared/sim/headroom.ts'
import type { Headroom } from '@shared/sim/headroom.ts'
import type { NodeSim } from '@shared/model/schema.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { isViewer } from '../lib/viewer.ts'
import { NumberInput } from '../panels/inspector/fields.tsx'
import { patchNode } from '../panels/inspector/NodeInspector.tsx'
import { select } from '../state/actions.ts'
import { useStore } from '../state/store.ts'
import { ScenarioBar } from './ScenarioBar.tsx'
import { LOAD_MAX, LOAD_MIN, fmtRps, fmtX, setLoad, useHeadroom, useLoad } from './load.ts'
import { setScenario, useSim } from './simStore.ts'

const NO_SIM: NodeSim = { capacityRps: null, latencyMs: null, errorRate: null, entryRps: null }

/** Where a multiplier sits on the slider's log scale (0..1). */
const pos = (x: number): number => (Math.log10(Math.min(LOAD_MAX, Math.max(LOAD_MIN, x))) - Math.log10(LOAD_MIN)) / (Math.log10(LOAD_MAX) - Math.log10(LOAD_MIN))

export function LoadSection(): React.JSX.Element | null {
  const model = useStore((s) => s.project?.model)
  const editor = useStore((s) => s.ui.mode !== 'docs') && !isViewer()
  const profile = useSim((s) => s.scenario.profile)
  const { base, multiplier, pattern, now } = useLoad(model)
  const room = useHeadroom(model)
  if (model === undefined) return null
  const { entries } = baseLoad(model)
  const peak = multiplier * PROFILE_PEAK[profile]
  const limit = room?.limit ?? null

  return (
    <section className="border-b p-3" aria-label="Load">
      <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Load</h3>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-lg font-semibold tabular-nums">{fmtRps(now)}</span>
        <span className="text-[11px] text-muted-foreground">
          sent now = {fmtRps(base)} base × {fmtX(multiplier)}
          {pattern !== 1 && ` × ${pattern.toFixed(2)} pattern`}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="w-14 text-muted-foreground">Overall</span>
        <div className="relative flex min-w-0 flex-1 flex-col">
          <input
            type="range"
            min={0}
            max={1}
            step={0.005}
            value={pos(multiplier)}
            onChange={(e) => setLoad(10 ** (Math.log10(LOAD_MIN) + Number(e.target.value) * (Math.log10(LOAD_MAX) - Math.log10(LOAD_MIN))))}
            className="w-full accent-[var(--primary)]"
            aria-label="Traffic multiplier"
            aria-valuetext={`${fmtX(multiplier)}, ${fmtRps(base * multiplier)}`}
          />
          <LimitBar limit={limit} multiplier={multiplier} peak={peak} />
        </div>
        <span className="w-10 text-right font-mono tabular-nums">{fmtX(multiplier)}</span>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Back to 1×" title="Back to 1×" disabled={multiplier === 1} onClick={() => setLoad(1)}>
          <RotateCcw />
        </Button>
      </div>
      <label className="mt-1.5 flex items-center gap-2 text-xs">
        <span className="w-14 text-muted-foreground">Total</span>
        <div className="flex-1">
          <NumberInput value={Math.round(base * multiplier)} min={0} step={50} suffix="rps" onChange={(v) => v !== null && base > 0 && setLoad(v / base)} />
        </div>
      </label>

      <HeadroomNote room={room} base={base} multiplier={multiplier} peak={peak} patterned={profile !== 'constant'} />

      <label className="mt-3 flex items-center gap-2 text-xs">
        <span className="w-14 text-muted-foreground">Pattern</span>
        <select value={profile} onChange={(e) => setScenario({ profile: e.target.value as LoadProfile })} className="h-7 flex-1 rounded-md border bg-background px-1 text-xs" aria-label="Load pattern">
          <option value="constant">Constant</option>
          <option value="ramp">Ramp up</option>
          <option value="spike">Spikes every minute</option>
          <option value="diurnal">Day/night cycle</option>
        </select>
      </label>
      <p className="mt-1 ml-16 text-[11px] text-muted-foreground">{PROFILE_TEXT[profile]}</p>

      <h4 className="mt-3 mb-1 text-[11px] font-medium text-muted-foreground">Where it comes from (base load at 1×)</h4>
      {entries.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">Nothing generates traffic. Give a node a load under “Generates” in the inspector, or add a client.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {entries.map((e) => {
            const n = model.nodes[e.id]
            if (n === undefined) return null
            return (
              <li key={e.id} className="flex items-center gap-2 text-xs">
                <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => select({ kind: 'node', ids: [e.id] })} title={`Select ${n.name}`}>
                  {n.name}
                </button>
                <div className="w-28">
                  <NumberInput
                    value={e.set ? e.rps : null}
                    placeholder={`${DEFAULT_ENTRY_RPS} default`}
                    min={0}
                    step={10}
                    suffix="rps"
                    readOnly={!editor}
                    onChange={(v) => patchNode(e.id, { sim: { ...(n.sim ?? NO_SIM), entryRps: v } }, 'sim.entry')}
                  />
                </div>
                <span className="w-16 text-right font-mono text-[11px] text-muted-foreground tabular-nums" title="Sending now">
                  {fmtRps(e.rps * multiplier * pattern)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">The base load is saved with the project (0 switches an entry point off). Overall and Pattern belong to the scenario: save one to keep them.</p>
      <div className="mt-2">
        <ScenarioBar />
      </div>
    </section>
  )
}

/** Under the slider: green up to what the architecture holds, red past it; a tick where the pattern peaks. */
function LimitBar({ limit, multiplier, peak }: { limit: number | null; multiplier: number; peak: number }): React.JSX.Element {
  const red = limit === null ? null : limit === 0 ? 0 : limit
  return (
    <div className="relative mx-2 mt-0.5 h-1 overflow-hidden rounded-full bg-success/40" aria-hidden>
      {red !== null && red < LOAD_MAX && <div className="absolute inset-y-0 right-0 bg-destructive/60" style={{ left: `${pos(Math.max(red, LOAD_MIN)) * 100}%` }} />}
      {peak > multiplier * 1.01 && <div className="absolute inset-y-0 w-0.5 bg-foreground/60" style={{ left: `${pos(peak) * 100}%` }} title="Where the pattern peaks" />}
    </div>
  )
}

function HeadroomNote({ room, base, multiplier, peak, patterned }: { room: Headroom | null; base: number; multiplier: number; peak: number; patterned: boolean }): React.JSX.Element {
  if (room === null) return <p className="mt-2 text-[11px] text-muted-foreground">Working out how much load it holds…</p>
  const limit = room.limit
  const over = limit !== null && peak > limit
  const close = limit !== null && !over && peak > limit * 0.8
  return (
    <div className={cn('mt-2 rounded-md border p-2 text-[11px]', over ? 'border-destructive/40 bg-destructive/5' : close ? 'border-warning/40 bg-warning/5' : '')} title="Found by running the architecture at steady load with no faults, until something fails">
      <div className="flex items-start gap-1.5">
        {over ? <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" /> : <Gauge className={cn('mt-0.5 size-3.5 shrink-0', close ? 'text-warning' : 'text-success')} />}
        <div className="min-w-0 flex-1">
          {limit === null ? (
            <p>Holds past {fmtX(HEADROOM_MAX)} ({fmtRps(base * HEADROOM_MAX)}) with nothing failing.</p>
          ) : limit === 0 ? (
            <p className="text-destructive">Something fails even with almost no load, so it is not about traffic:</p>
          ) : (
            <p>
              Holds up to <b className="font-mono">{fmtX(limit)}</b> ({fmtRps(base * limit)}) before something fails.{' '}
              {over ? (
                <span className="text-destructive">
                  {patterned && peak !== multiplier ? `This pattern peaks at ${fmtX(peak)}, past that.` : `${fmtX(multiplier)} is past that.`}
                </span>
              ) : close ? (
                <span className="text-warning">{patterned ? `Peaks at ${fmtX(peak)}: close.` : 'Close.'}</span>
              ) : (
                <span className="text-muted-foreground">{Math.round((limit / peak - 1) * 100)}% to spare{patterned ? ' at the pattern’s peak' : ''}.</span>
              )}
            </p>
          )}
          {room.roots.length > 0 && (
            <>
              <p className="mt-1 text-muted-foreground">{limit === 0 ? 'Failing:' : 'First to fail:'}</p>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {room.roots.slice(0, 3).map((r) => (
                  <li key={r.key}>
                    <button type="button" className="text-left hover:underline" onClick={() => select({ kind: r.ref.kind, ids: [r.ref.id] })}>
                      <span className="font-medium">{r.name}</span>
                      {r.reasons[0] !== undefined && <span className="text-muted-foreground">: {r.reasons[0].text}</span>}
                    </button>
                  </li>
                ))}
                {room.roots.length > 3 && <li className="text-muted-foreground">…and {room.roots.length - 3} more</li>}
              </ul>
              {room.flows.length > 0 && <p className="mt-1 text-muted-foreground">Flows through it: {room.flows.join(', ')}</p>}
            </>
          )}
          {limit !== null && limit > 0 && !over && limit * 1.2 <= LOAD_MAX && (
            <button type="button" className="mt-1 text-primary hover:underline" onClick={() => setLoad(limit * 1.2)}>
              Try it just past the limit ({fmtX(limit * 1.2)})
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
