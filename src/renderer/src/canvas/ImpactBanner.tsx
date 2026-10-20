// Impact analysis, explained where you look: what breaks if the node fails (red, with hops), what it needs to work
// (blue), or both; switch between them and limit the depth.
import { Panel } from '@xyflow/react'
import { Crosshair, X } from 'lucide-react'
import { useMemo } from 'react'
import { impactOf } from '@shared/model/queries.ts'
import { failureImpact } from '@shared/model/resilience.ts'
import type { FailureEffect, FailureScope } from '@shared/model/resilience.ts'
import type { BlastDirection } from '@shared/model/queries.ts'
import { cn } from '../lib/cn.ts'
import { setUi, useStore } from '../state/store.ts'
import { useModel } from './useScene.ts'

export const IMPACT_MODES: { dir: BlastDirection; label: string; hint: string }[] = [
  { dir: 'upstream', label: 'If it fails', hint: 'Everything that calls it, directly or through others, and would break or degrade' },
  { dir: 'downstream', label: 'What it needs', hint: 'Everything it depends on to work' },
  { dir: 'both', label: 'Both', hint: 'Callers and dependencies together' },
]

export function useImpactCounts(id: string | null, dir: BlastDirection, hops: number): { affected: string[]; needed: string[] } {
  const model = useModel()
  return useMemo(() => {
    if (id === null || model.nodes[id] === undefined) return { affected: [], needed: [] }
    const map = impactOf(model, id, dir, hops)
    const affected: string[] = []
    const needed: string[] = []
    for (const [nid, hit] of map) {
      if (hit.kind === 'affected') affected.push(nid)
      else if (hit.kind === 'needed') needed.push(nid)
    }
    return { affected, needed }
  }, [model, id, dir, hops])
}

export function ImpactBanner(): React.JSX.Element | null {
  const model = useModel()
  const blast = useStore((s) => s.ui.blast)
  const counts = useImpactCounts(blast?.id ?? null, blast?.dir ?? 'both', blast?.hops ?? Infinity)
  const fail = useMemo(() => (blast?.failure == null || model.nodes[blast.id] === undefined ? null : failureImpact(model, blast.id, blast.failure)), [model, blast])
  if (blast === null) return null
  const name = model.nodes[blast.id]?.name ?? blast.id
  const failure = blast.failure ?? null
  return (
    <Panel position="top-center">
      <div className="flex flex-col gap-1.5 rounded-xl border border-primary/50 bg-popover/95 px-3 py-2 text-xs whitespace-nowrap shadow-lg">
        <div className="flex items-center gap-2">
          <Crosshair className="size-3.5 text-primary" />
          <span className="font-semibold">Impact of {name}</span>
          <select
            aria-label="What fails"
            title="The call graph, or what one failure really takes down given instances, zones and soft dependencies"
            value={failure ?? 'graph'}
            onChange={(e) => setUi({ blast: { ...blast, failure: e.target.value === 'graph' ? null : (e.target.value as FailureScope) } })}
            className="h-6 rounded border bg-background px-1"
          >
            <option value="graph">Call graph</option>
            <option value="instance">One instance fails</option>
            <option value="zone">Its zone fails</option>
            <option value="down">It goes down</option>
          </select>
          {failure === null && (
          <div role="radiogroup" aria-label="Impact direction" className="ml-1 flex rounded-md border bg-background p-0.5">
            {IMPACT_MODES.map((m) => (
              <button
                key={m.dir}
                type="button"
                role="radio"
                aria-checked={blast.dir === m.dir}
                title={m.hint}
                onClick={() => setUi({ blast: { ...blast, dir: m.dir } })}
                className={cn('rounded px-2 py-0.5', blast.dir === m.dir ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground')}
              >
                {m.label}
              </button>
            ))}
          </div>
          )}
          {failure === null && (
          <select
            aria-label="How far"
            value={Number.isFinite(blast.hops) ? String(blast.hops) : 'all'}
            onChange={(e) => setUi({ blast: { ...blast, hops: e.target.value === 'all' ? Infinity : Number(e.target.value) } })}
            className="h-6 rounded border bg-background px-1"
          >
            <option value="1">direct only</option>
            <option value="2">up to 2 hops</option>
            <option value="all">all the way</option>
          </select>
          )}
          <button type="button" aria-label="Close impact analysis" onClick={() => setUi({ blast: null })} className="rounded p-0.5 text-muted-foreground hover:bg-accent">
            <X className="size-3.5" />
          </button>
        </div>
        {fail !== null && failure !== null && <FailureSummary name={name} origin={blast.id} effects={fail} scope={failure} />}
        <div className={cn('flex items-center gap-3 text-[11px] text-muted-foreground', failure !== null && 'hidden')}>
          {blast.dir !== 'downstream' && (
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-[var(--hx-bad)]" />
              <strong className="text-foreground">{counts.affected.length}</strong> break if it fails
            </span>
          )}
          {blast.dir !== 'upstream' && (
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-[var(--hx-blue)]" />
              <strong className="text-foreground">{counts.needed.length}</strong> it needs to work
            </span>
          )}
          <span>The number on each node is how many hops away it is. Everything else is dimmed.</span>
        </div>
      </div>
    </Panel>
  )
}

/** "Survives losing an instance", or what goes down and what keeps going with less. */
function FailureSummary({ name, origin, effects, scope }: { name: string; origin: string; effects: Map<string, FailureEffect>; scope: FailureScope }): React.JSX.Element {
  const down = [...effects].filter(([id, e]) => e === 'down' && id !== origin).length
  const degraded = [...effects].filter(([id, e]) => e === 'degraded' && id !== origin).length
  const self = effects.get(origin)
  const what = scope === 'instance' ? 'losing an instance' : scope === 'zone' ? 'a zone outage' : 'going down'
  const headline =
    self === 'degraded' && down === 0
      ? `${name} survives ${what}${degraded > 0 ? `; ${degraded} keep${degraded === 1 ? 's' : ''} going with less` : ''}.`
      : `${what === 'going down' ? `If ${name} goes down` : `With ${what} at ${name}`}, ${down + (self === 'down' ? 1 : 0)} go${down + (self === 'down' ? 1 : 0) === 1 ? 'es' : ''} down and ${degraded} degrade.`
  return (
    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
      <span className="text-foreground">{headline}</span>
      <span className="flex items-center gap-1">
        <span className="size-2 rounded-full bg-[var(--hx-bad)]" /> down
      </span>
      <span className="flex items-center gap-1">
        <span className="size-2 rounded-full bg-[var(--hx-warn)]" /> degraded
      </span>
      <span>Based on documented instances, zones and soft dependencies.</span>
    </div>
  )
}
