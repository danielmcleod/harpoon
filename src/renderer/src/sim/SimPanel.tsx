// The simulator's side panel (mockup 2): headline numbers, throughput / latency / error charts, what is failing and
// why (root causes first, each with an AI fix and a way to force it healthy), the selected node's or link's live state
// and causes, load controls, fault injection (crash, slow down, partition, rate limit, error burst) and flow tracing.
import { Activity, Cable, ChevronRight, OctagonX, Pause, ShieldCheck, Sparkles, Play, Plus, Route, SkipBack, SkipForward, Trash2, X, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { FaultType, LoadProfile } from '@shared/sim/engine.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { kindIcon, nodeColor } from '../lib/icons.tsx'
import { useStore } from '../state/store.ts'
import { addFault, currentFrame, endFault, removeFault, setScenario, simTime, toggleHealthy, useSim } from './simStore.ts'
import type { Frame, Health } from '@shared/sim/engine.ts'
import { describeEdgeCause, describeNodeCause, failureReport, linkName } from '@shared/sim/explain.ts'
import type { Reason } from '@shared/sim/explain.ts'
import { Sparkline } from './Sparkline.tsx'
import { ScenarioBar } from './ScenarioBar.tsx'
import { clock } from './Timeline.tsx'
import { fixFailures, investigateTraffic, reviewFlows } from './investigate.ts'
import { lintModel } from '@shared/model/lint.ts'
import { useTrafficBreaks } from './useTrafficBreaks.ts'
import { select } from '../state/actions.ts'

const FAULT_LABEL: Record<FaultType, string> = {
  down: 'Crash (node down)',
  latency: 'Slow down (latency ×)',
  partition: 'Network partition (cut a link)',
  ratelimit: 'Rate limit (cap rps)',
  errors: 'Error burst (error rate)',
  instance: 'Lose an instance (of a node)',
  zone: 'Zone outage (every node in it)',
  region: 'Region outage',
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
  const mode = useStore((s) => s.ui.mode)
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
  const selConnId = selection?.kind === 'connector' ? selection.ids[0] : undefined
  const healthy = scenario.healthy ?? []
  const sel = selId !== undefined ? model.nodes[selId] : undefined
  const nf = sel !== undefined ? frame?.nodes[sel.id] : undefined
  const Icon = sel !== undefined ? kindIcon(sel.kind) : Activity
  const nodes = Object.values(model.nodes).sort((a, b) => a.name.localeCompare(b.name))
  const conns = Object.values(model.connectors)
  // Zones and regions as recorded on nodes (resilience zones; the region field).
  const zones = [...new Set(Object.values(model.nodes).flatMap((n) => n.resilience?.zones ?? []))].sort()
  const regions = [...new Set(Object.values(model.nodes).flatMap((n) => (n.region !== null ? [n.region] : [])))].sort()
  const now = simTime()
  const flow = trace !== null ? model.flows[trace.flowId] : undefined
  const step = flow !== undefined && trace !== null ? flow.steps[trace.step] : undefined
  const stepConn = step !== undefined ? model.connectors[step.connectorId] : undefined
  const editor = mode !== 'docs'

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

      {frame !== null && frame.t > 0 && <Failing frame={frame} />}

      <TrafficStops />

      <section className="border-b p-3">
        <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Selected</h3>
        {sel === undefined && selConnId !== undefined && model.connectors[selConnId] !== undefined ? (
          <SelectedLink id={selConnId} frame={frame} />
        ) : sel === undefined ? (
          <p className="text-xs text-muted-foreground">Click a node or a link to see its live load and why it fails.</p>
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
            {nf?.forced === true ? (
              <p className="mt-2 text-[11px] text-hx-cyan">Forced healthy: it serves everything and passes no failure on.</p>
            ) : (
              nf?.causes !== undefined &&
              nf.health !== 'ok' && (
                <div className="mt-2">
                  <h4 className="text-[11px] font-medium text-muted-foreground">Why</h4>
                  <Reasons reasons={nf.causes.map((c) => describeNodeCause(model, sel.id, c, frame ?? undefined))} />
                </div>
              )
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              <Button size="sm" variant="outline" icon={<Zap />} onClick={() => addFault({ type: 'down', target: sel.id, value: 0, until: null })}>
                Crash it
              </Button>
              <Button size="sm" variant="outline" onClick={() => addFault({ type: 'latency', target: sel.id, value: 5, until: null })}>
                Slow ×5
              </Button>
              <ForceButton id={sel.id} />
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
              <option value="">{faultType === 'partition' ? 'Pick a connector…' : faultType === 'zone' ? (zones.length > 0 ? 'Pick a zone…' : 'No zones recorded') : faultType === 'region' ? (regions.length > 0 ? 'Pick a region…' : 'No regions recorded') : 'Pick a node…'}</option>
              {faultType === 'zone' || faultType === 'region'
                ? (faultType === 'zone' ? zones : regions).map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))
                : faultType === 'partition'
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
            const target = f.type === 'zone' || f.type === 'region' ? f.target : f.type === 'partition' ? `${model.nodes[model.connectors[f.target]?.source ?? '']?.name ?? '?'} → ${model.nodes[model.connectors[f.target]?.target ?? '']?.name ?? '?'}` : (model.nodes[f.target]?.name ?? f.target)
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
        {healthy.length > 0 && (
          <div className="mt-2">
            <h4 className="mb-1 text-[11px] font-medium text-muted-foreground">Forced healthy</h4>
            <ul className="flex flex-col gap-1">
              {healthy.map((id) => (
                <li key={id} className="flex items-center gap-2 rounded-md border border-hx-cyan/40 bg-hx-cyan/10 px-2 py-1 text-[11px]">
                  <ShieldCheck className="size-3 text-hx-cyan" />
                  <span className="min-w-0 flex-1 truncate">{model.nodes[id]?.name ?? (model.connectors[id] !== undefined ? linkName(model, id) : id)}</span>
                  <button type="button" title="Stop forcing it healthy" aria-label="Stop forcing healthy" onClick={() => toggleHealthy(id)} className="text-muted-foreground hover:text-foreground">
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="p-3">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="flex-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Trace a flow</h3>
          {editor && (
            <Button size="sm" variant="ghost" icon={<Sparkles />} onClick={() => reviewFlows(null)} title="The AI checks the flows against the code, fixes broken ones and adds missing journeys">
              Review flows with AI
            </Button>
          )}
        </div>
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
            <FlowProblems flowId={flow.id} />
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

/** Where traffic stops or never gets to, and why; each with a way to investigate it with AI. */
function TrafficStops(): React.JSX.Element | null {
  const breaks = useTrafficBreaks()
  const model = useStore((s) => s.project?.model)
  const editor = useStore((s) => s.ui.mode !== 'docs')
  if (breaks.length === 0 || model === undefined) return null
  return (
    <section className="border-b p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Where traffic stops ({breaks.length})</h3>
        {editor && (
          <Button size="sm" variant="ghost" icon={<Sparkles />} onClick={() => investigateTraffic(null)} title="The AI reads the code and infrastructure to find the real path, and proposes fixes">
            Investigate all
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-1.5">
        {breaks.map((b) => (
          <li key={`${b.kind}:${b.nodeId}:${b.connectorId ?? ''}`} className="rounded-md border p-2 text-xs">
            <button type="button" className="flex w-full items-start gap-1.5 text-left" onClick={() => select({ kind: 'node', ids: [b.nodeId] })}>
              <OctagonX className={cn('mt-0.5 size-3.5 shrink-0', b.kind === 'dead-end' ? 'text-destructive' : 'text-warning')} />
              <span>
                <span className="block">{b.message}</span>
                <span className="mt-0.5 block text-muted-foreground">{b.hint}</span>
              </span>
            </button>
            {editor && (
              <button type="button" className="mt-1 ml-5 text-[11px] text-primary hover:underline" onClick={() => investigateTraffic(b.nodeId)}>
                Investigate with AI
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** A traced flow's problems (steps that do not link up or run the wrong way), with an AI fix. */
function FlowProblems({ flowId }: { flowId: string }): React.JSX.Element | null {
  const model = useStore((s) => s.project?.model)
  const editor = useStore((s) => s.ui.mode !== 'docs')
  const problems = useMemo(() => (model === undefined ? [] : lintModel(model).filter((p) => p.code.startsWith('flow-') && p.flowId === flowId)), [model, flowId])
  if (problems.length === 0) return null
  return (
    <div className="mt-1.5 rounded border border-warning/40 bg-warning/10 p-1.5 text-[11px]">
      {problems.map((p, i) => (
        <p key={i}>{p.message}</p>
      ))}
      {editor && (
        <button type="button" className="mt-1 text-primary hover:underline" onClick={() => reviewFlows(flowId)}>
          Fix this flow with AI
        </button>
      )}
    </div>
  )
}

const HEALTH_TEXT: Record<Health, string> = { ok: 'text-success', warn: 'text-warning', bad: 'text-destructive' }

/** Reasons in words; the ones that point at another node or link select it. */
function Reasons({ reasons }: { reasons: Reason[] }): React.JSX.Element {
  return (
    <ul className="mt-0.5 flex flex-col gap-0.5 text-[11px]">
      {reasons.map((r, i) => {
        const ref = r.ref
        return (
          <li key={i} className="flex items-start gap-1">
            <ChevronRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
            {ref === undefined ? (
              <span>{r.text}</span>
            ) : (
              <button type="button" className="text-left hover:underline" onClick={() => select({ kind: ref.kind, ids: [ref.id] })} title="Select it">
                {r.text}
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Force a node or link healthy in this scenario (as if it never failed), or stop forcing it. */
function ForceButton({ id }: { id: string }): React.JSX.Element {
  const on = useSim((s) => (s.scenario.healthy ?? []).includes(id))
  return (
    <Button size="sm" variant={on ? 'secondary' : 'outline'} icon={<ShieldCheck />} onClick={() => toggleHealthy(id)} title={on ? 'Let it fail again' : 'What if this never failed? It serves everything and passes no failure on'}>
      {on ? 'Forced healthy' : 'Force healthy'}
    </Button>
  )
}

/** What is strained or failing right now: root causes first (with an AI fix and force healthy), then knock-ons. */
function Failing({ frame }: { frame: Frame }): React.JSX.Element | null {
  const model = useStore((s) => s.project?.model)
  const editor = useStore((s) => s.ui.mode !== 'docs')
  const report = useMemo(() => (model === undefined ? null : failureReport(model, frame)), [model, frame])
  if (report === null || model === undefined || report.roots.length === 0) return null
  const names = new Map(report.roots.map((r) => [r.key, r.name]))
  return (
    <section className="border-b p-3" aria-label="What is failing">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">What&apos;s failing ({report.roots.length})</h3>
        {editor && (
          <Button size="sm" variant="ghost" icon={<Sparkles />} onClick={() => fixFailures(null)} title="The AI reproduces this scenario, proposes changes that survive it and checks them in the simulator">
            Fix all with AI
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-1.5">
        {report.roots.map((r) => (
          <li key={r.key} className="rounded-md border p-2 text-xs">
            <button type="button" className="flex w-full items-center gap-1.5 text-left" onClick={() => select({ kind: r.ref.kind, ids: [r.ref.id] })}>
              {r.ref.kind === 'connector' ? <Cable className={cn('size-3.5 shrink-0', HEALTH_TEXT[r.health])} /> : <OctagonX className={cn('size-3.5 shrink-0', HEALTH_TEXT[r.health])} />}
              <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
              {r.affects.length > 0 && <span className="shrink-0 text-[10px] text-muted-foreground">+{r.affects.length} knock-on</span>}
            </button>
            <div className="ml-5">
              <Reasons reasons={r.reasons} />
              <div className="mt-1 flex gap-3 text-[11px]">
                {editor && (
                  <button type="button" className="text-primary hover:underline" onClick={() => fixFailures(r.key)}>
                    Fix with AI
                  </button>
                )}
                <button type="button" className="text-hx-cyan hover:underline" onClick={() => toggleHealthy(r.ref.id)} title="What if this never failed? It serves everything and passes no failure on">
                  Force healthy
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {report.knockOn.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">{report.knockOn.length} knock-on failures</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {report.knockOn.map((k) => (
              <li key={k.nodeId}>
                <button type="button" className="flex w-full items-start gap-1.5 text-left hover:underline" onClick={() => select({ kind: 'node', ids: [k.nodeId] })}>
                  <span className={cn('mt-1 size-1.5 shrink-0 rounded-full', k.health === 'bad' ? 'bg-destructive' : 'bg-warning')} />
                  <span>
                    {k.name} <span className="text-muted-foreground">← {k.roots.map((x) => names.get(x) ?? x).join(', ')}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

/** The selected link's live state and why it fails. */
function SelectedLink({ id, frame }: { id: string; frame: Frame | null }): React.JSX.Element | null {
  const model = useStore((s) => s.project?.model)
  if (model === undefined) return null
  const ef = frame?.edges[id]
  return (
    <div>
      <div className="flex items-center gap-2">
        <Cable className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{linkName(model, id)}</span>
        {ef !== undefined && (
          <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', ef.health === 'ok' ? 'bg-success/15 text-success' : ef.health === 'warn' ? 'bg-warning/15 text-warning' : 'bg-destructive/15 text-destructive')}>
            {ef.health === 'ok' ? 'Healthy' : ef.health === 'warn' ? 'Strained' : 'Failing'}
          </span>
        )}
      </div>
      {ef !== undefined && (
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Calls</dt>
          <dd className="text-right font-mono tabular-nums">{fmtRps(ef.rps)}</dd>
          <dt className="text-muted-foreground">Error rate</dt>
          <dd className="text-right font-mono tabular-nums">{fmtPct(ef.errorRate)}</dd>
          <dt className="text-muted-foreground">Circuit breaker</dt>
          <dd className="text-right">{ef.breakerOpen ? 'Open' : model.connectors[id]?.policies.circuitBreaker === true ? 'Closed' : 'None'}</dd>
        </dl>
      )}
      {ef?.forced === true ? (
        <p className="mt-2 text-[11px] text-hx-cyan">Forced healthy: never cut, never refused, never times out.</p>
      ) : (
        ef?.causes !== undefined && (
          <div className="mt-2">
            <h4 className="text-[11px] font-medium text-muted-foreground">Why</h4>
            <Reasons reasons={ef.causes.map((c) => ({ text: describeEdgeCause(model, c) }))} />
          </div>
        )
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        <Button size="sm" variant="outline" icon={<Zap />} onClick={() => addFault({ type: 'partition', target: id, value: 0, until: null })}>
          Cut it
        </Button>
        <ForceButton id={id} />
      </div>
    </div>
  )
}
