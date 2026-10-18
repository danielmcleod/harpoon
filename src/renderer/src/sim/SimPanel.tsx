// The simulator's side panel (mockup 2): headline numbers, throughput / latency / error charts, the selected node's
// live state, load controls, fault injection (crash, slow down, partition, rate limit, error burst) and flow tracing.
import { Activity, Pause, Play, Plus, Route, SkipBack, SkipForward, Trash2, X, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { FaultType, LoadProfile } from '@shared/sim/engine.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { kindIcon, nodeColor } from '../lib/icons.tsx'
import { useStore } from '../state/store.ts'
import { addFault, currentFrame, endFault, removeFault, setScenario, simTime, useSim } from './simStore.ts'
import { Sparkline } from './Sparkline.tsx'
import { ScenarioBar } from './ScenarioBar.tsx'
import { clock } from './Timeline.tsx'

const FAULT_LABEL: Record<FaultType, string> = {
  down: 'Crash (node down)',
  latency: 'Slow down (latency ×)',
  partition: 'Network partition (cut a link)',
  ratelimit: 'Rate limit (cap rps)',
  errors: 'Error burst (error rate)',
}

const fmtRps = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}k rps` : `${Math.round(v)} rps`)
const fmtMs = (v: number): string => `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`
const fmtPct = (v: number): string => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`

export function SimPanel(): React.JSX.Element {
  const model = useStore((s) => s.project?.model)
  const selection = useStore((s) => s.ui.selection)
  const frames = useSim((s) => s.frames)
  const cursor = useSim((s) => s.cursor)
  const scenario = useSim((s) => s.scenario)
  const trace = useSim((s) => s.trace)
  const frame = currentFrame({ ...useSim.getState(), frames, cursor })
  const [faultType, setFaultType] = useState<FaultType>('down')
  const [faultTarget, setFaultTarget] = useState('')
  const [faultValue, setFaultValue] = useState(5)

  // The last 2 simulated minutes for the charts (one point per second).
  const series = useMemo(() => {
    const upto = cursor === null ? frames.length : cursor + 1
    const window = frames.slice(Math.max(0, upto - 480), upto).filter((_, i) => i % 4 === 0)
    return { t: window.map((f) => f.t), tp: window.map((f) => f.throughput), lat: window.map((f) => f.latencyMs), err: window.map((f) => f.errorRate * 100) }
  }, [frames, cursor])

  if (model === undefined) return <aside className="w-[360px] border-l bg-panel" />
  const selId = selection?.kind === 'node' ? selection.ids[0] : undefined
  const sel = selId !== undefined ? model.nodes[selId] : undefined
  const nf = sel !== undefined ? frame?.nodes[sel.id] : undefined
  const Icon = sel !== undefined ? kindIcon(sel.kind) : Activity
  const nodes = Object.values(model.nodes).sort((a, b) => a.name.localeCompare(b.name))
  const conns = Object.values(model.connectors)
  const now = simTime()
  const flow = trace !== null ? model.flows[trace.flowId] : undefined
  const step = flow !== undefined && trace !== null ? flow.steps[trace.step] : undefined
  const stepConn = step !== undefined ? model.connectors[step.connectorId] : undefined

  return (
    <aside className="scroll-region w-[360px] shrink-0 overflow-y-auto border-l bg-panel" aria-label="Simulation">
      <div className="border-b p-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Active simulation</h2>
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground" title="Numbers come from each node's capacity and latency settings, not from production">
            modelled, not measured
          </span>
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
          {(
            [
              ['Throughput', frame === null ? '—' : fmtRps(frame.throughput)],
              ['Latency', frame === null ? '—' : fmtMs(frame.latencyMs)],
              ['Errors', frame === null ? '—' : fmtPct(frame.errorRate)],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="rounded-md border bg-background py-1.5">
              <dd className="font-mono text-sm font-semibold tabular-nums">{v}</dd>
              <dt className="text-[10px] text-muted-foreground uppercase">{k}</dt>
            </div>
          ))}
        </dl>
        {frames.length === 0 && <p className="mt-2 text-xs text-muted-foreground">Press play to send traffic through the architecture.</p>}
      </div>

      <div className="flex flex-col gap-2 border-b p-3">
        <Sparkline label="Throughput" values={series.tp} times={series.t} color="var(--hx-cyan)" format={fmtRps} />
        <Sparkline label="End-to-end latency" values={series.lat} times={series.t} color="var(--hx-violet)" format={fmtMs} />
        <Sparkline label="Error rate" values={series.err} times={series.t} color="var(--hx-rose)" format={(v) => `${v.toFixed(2)}%`} />
      </div>

      <section className="border-b p-3">
        <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Selected</h3>
        {sel === undefined ? (
          <p className="text-xs text-muted-foreground">Click a node to see its live load.</p>
        ) : (
          <div>
            <div className="flex items-center gap-2">
              <Icon className="size-4" style={{ color: nodeColor(sel) }} />
              <span className="text-sm font-medium">{sel.name}</span>
              {nf !== undefined && (
                <span className={cn('ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold', nf.health === 'ok' ? 'bg-success/15 text-success' : nf.health === 'warn' ? 'bg-warning/15 text-warning' : 'bg-destructive/15 text-destructive')}>
                  {nf.health === 'ok' ? 'Healthy' : nf.health === 'warn' ? 'Strained' : 'Failing'}
                </span>
              )}
            </div>
            {nf !== undefined && (
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Incoming</dt>
                <dd className="text-right font-mono tabular-nums">{fmtRps(nf.rps)}</dd>
                <dt className="text-muted-foreground">Utilization</dt>
                <dd className="text-right font-mono tabular-nums">{Number.isFinite(nf.util) ? fmtPct(nf.util) : '∞'}</dd>
                <dt className="text-muted-foreground">Latency</dt>
                <dd className="text-right font-mono tabular-nums">{fmtMs(nf.latencyMs)}</dd>
                <dt className="text-muted-foreground">Error rate</dt>
                <dd className="text-right font-mono tabular-nums">{fmtPct(nf.errorRate)}</dd>
                {nf.backlog > 0 && (
                  <>
                    <dt className="text-muted-foreground">Backlog</dt>
                    <dd className="text-right font-mono tabular-nums">{Math.round(nf.backlog).toLocaleString()} msgs</dd>
                  </>
                )}
              </dl>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              <Button size="sm" variant="outline" icon={<Zap />} onClick={() => addFault({ type: 'down', target: sel.id, value: 0, until: null })}>
                Crash it
              </Button>
              <Button size="sm" variant="outline" onClick={() => addFault({ type: 'latency', target: sel.id, value: 5, until: null })}>
                Slow ×5
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="border-b p-3">
        <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Load</h3>
        <label className="flex items-center gap-2 text-xs">
          <span className="w-16 text-muted-foreground">Traffic</span>
          <input type="range" min={0.1} max={10} step={0.1} value={scenario.multiplier} onChange={(e) => setScenario({ multiplier: Number(e.target.value) })} className="flex-1 accent-[var(--primary)]" aria-label="Traffic multiplier" />
          <span className="w-10 text-right font-mono tabular-nums">{scenario.multiplier.toFixed(1)}×</span>
        </label>
        <label className="mt-2 flex items-center gap-2 text-xs">
          <span className="w-16 text-muted-foreground">Pattern</span>
          <select value={scenario.profile} onChange={(e) => setScenario({ profile: e.target.value as LoadProfile })} className="h-7 flex-1 rounded-md border bg-background px-1 text-xs">
            <option value="constant">Constant</option>
            <option value="ramp">Ramp up</option>
            <option value="spike">Spikes every minute</option>
            <option value="diurnal">Day/night cycle</option>
          </select>
        </label>
        <div className="mt-3">
          <ScenarioBar />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Entry load comes from each node&apos;s “Generates” setting (clients default to 100 rps). Capacity and latency are in the inspector&apos;s Simulation section.</p>
      </section>

      <section className="border-b p-3">
        <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Faults</h3>
        <div className="flex flex-col gap-1.5">
          <select value={faultType} onChange={(e) => setFaultType(e.target.value as FaultType)} className="h-7 rounded-md border bg-background px-1 text-xs" aria-label="Fault type">
            {(Object.keys(FAULT_LABEL) as FaultType[]).map((f) => (
              <option key={f} value={f}>
                {FAULT_LABEL[f]}
              </option>
            ))}
          </select>
          <div className="flex gap-1.5">
            <select value={faultTarget} onChange={(e) => setFaultTarget(e.target.value)} className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1 text-xs" aria-label="Fault target">
              <option value="">{faultType === 'partition' ? 'Pick a connector…' : 'Pick a node…'}</option>
              {faultType === 'partition'
                ? conns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {model.nodes[c.source]?.name} → {model.nodes[c.target]?.name}
                    </option>
                  ))
                : nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
            </select>
            {(faultType === 'latency' || faultType === 'ratelimit' || faultType === 'errors') && (
              <input type="number" value={faultValue} min={0} step={faultType === 'errors' ? 0.05 : 1} onChange={(e) => setFaultValue(Number(e.target.value))} className="h-7 w-16 rounded-md border bg-background px-1 text-xs" aria-label="Fault amount" />
            )}
            <Button size="sm" icon={<Plus />} disabled={faultTarget === ''} onClick={() => addFault({ type: faultType, target: faultTarget, value: faultType === 'errors' ? Math.min(1, faultValue) : faultValue, until: null })}>
              Inject
            </Button>
          </div>
        </div>
        <ul className="mt-2 flex flex-col gap-1">
          {scenario.faults.map((f) => {
            const activeNow = now >= f.from && (f.until === null || now < f.until)
            const target = f.type === 'partition' ? `${model.nodes[model.connectors[f.target]?.source ?? '']?.name ?? '?'} → ${model.nodes[model.connectors[f.target]?.target ?? '']?.name ?? '?'}` : (model.nodes[f.target]?.name ?? f.target)
            return (
              <li key={f.id} className={cn('flex items-center gap-2 rounded-md border px-2 py-1 text-[11px]', activeNow && 'border-destructive/50 bg-destructive/10')}>
                <Zap className={cn('size-3', activeNow ? 'text-destructive' : 'text-muted-foreground')} />
                <span className="min-w-0 flex-1 truncate">
                  {FAULT_LABEL[f.type].split(' (')[0]}: {target}
                  {f.type === 'latency' ? ` ×${f.value}` : f.type === 'ratelimit' ? ` ≤${f.value} rps` : f.type === 'errors' ? ` ${Math.round(f.value * 100)}%` : ''}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {clock(f.from)}
                  {f.until !== null ? `–${clock(f.until)}` : ''}
                </span>
                {activeNow ? (
                  <button type="button" title="End now" aria-label="End fault" onClick={() => endFault(f.id)} className="text-muted-foreground hover:text-foreground">
                    <X className="size-3" />
                  </button>
                ) : (
                  <button type="button" title="Remove" aria-label="Remove fault" onClick={() => removeFault(f.id)} className="text-muted-foreground hover:text-destructive">
                    <Trash2 className="size-3" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <section className="p-3">
        <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Trace a flow</h3>
        <div className="flex flex-wrap gap-1">
          {Object.values(model.flows).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => useSim.setState({ trace: trace?.flowId === f.id ? null : { flowId: f.id, step: 0, playing: true } })}
              className={cn('flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]', trace?.flowId === f.id ? 'border-primary bg-primary/15' : 'hover:bg-accent/50')}
            >
              <Route className="size-3 text-hx-cyan" />
              {f.name}
            </button>
          ))}
          {Object.keys(model.flows).length === 0 && <p className="text-xs text-muted-foreground">Add flows in the editor (project overview) to trace requests hop by hop.</p>}
        </div>
        {flow !== undefined && trace !== null && (
          <div className="mt-2 rounded-md border bg-background p-2">
            <div className="flex items-center gap-1">
              <span className="text-xs font-medium">
                Step {trace.step + 1} / {flow.steps.length}
              </span>
              <span className="ml-auto flex">
                <Button variant="ghost" size="icon" className="size-6" aria-label="Previous step" onClick={() => useSim.setState({ trace: { ...trace, step: Math.max(0, trace.step - 1), playing: false } })}>
                  <SkipBack />
                </Button>
                <Button variant="ghost" size="icon" className="size-6" aria-label={trace.playing ? 'Pause trace' : 'Play trace'} onClick={() => useSim.setState({ trace: { ...trace, playing: !trace.playing, step: !trace.playing && trace.step >= flow.steps.length - 1 ? 0 : trace.step } })}>
                  {trace.playing ? <Pause /> : <Play />}
                </Button>
                <Button variant="ghost" size="icon" className="size-6" aria-label="Next step" onClick={() => useSim.setState({ trace: { ...trace, step: Math.min(flow.steps.length - 1, trace.step + 1), playing: false } })}>
                  <SkipForward />
                </Button>
              </span>
            </div>
            {stepConn !== undefined && step !== undefined && (
              <p className="mt-1 text-xs">
                {model.nodes[step.direction === 'A' ? stepConn.source : stepConn.target]?.name} → {model.nodes[step.direction === 'A' ? stepConn.target : stepConn.source]?.name}{' '}
                <span className="font-mono text-muted-foreground">{step.direction === 'A' ? stepConn.channelA.protocol : (stepConn.channelB?.protocol ?? 'reply')}</span>
                {step.note !== null && <span className="block text-muted-foreground">{step.note}</span>}
              </p>
            )}
          </div>
        )}
      </section>
    </aside>
  )
}
