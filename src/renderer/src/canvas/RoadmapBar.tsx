// The phase scrubber: Today, then each roadmap phase. Picking a phase shows the architecture as it will be at the
// end of that phase (read-only), with what lands in it marked new and what it retires marked red.
import { Panel } from '@xyflow/react'
import { ChevronLeft, ChevronRight, Milestone } from 'lucide-react'
import { useMemo } from 'react'
import { phasesInOrder } from '@shared/model/governance.ts'
import { modelAsOf } from '@shared/model/roadmap.ts'
import type { Projection } from '@shared/model/roadmap.ts'
import { summaryCounts } from '@shared/model/diff.ts'
import { cn } from '../lib/cn.ts'
import { setUi, useStore } from '../state/store.ts'

/** The projected model while a phase is picked (null: today). */
export function useRoadmap(): Projection | null {
  const model = useStore((s) => s.project?.model)
  const asOf = useStore((s) => s.ui.asOf)
  return useMemo(() => (model === undefined || asOf === null ? null : modelAsOf(model, asOf)), [model, asOf])
}

export function RoadmapBar(): React.JSX.Element | null {
  const model = useStore((s) => s.project?.model)
  const asOf = useStore((s) => s.ui.asOf)
  const projection = useRoadmap()
  if (model === undefined || model.meta.phases.length === 0) return null
  const phases = phasesInOrder(model.meta)
  const steps = [null, ...phases.map((p) => p.id)]
  const at = Math.max(0, steps.indexOf(asOf))
  const go = (i: number): void => {
    const next = steps[Math.max(0, Math.min(steps.length - 1, i))]
    setUi({ asOf: next ?? null, connectFrom: null })
  }
  const counts = projection === null ? null : summaryCounts(projection.summary)
  const phase = phases.find((p) => p.id === asOf)
  return (
    // One row above the bottom-left tools and the bottom-right legend, so a narrow canvas never stacks them.
    <Panel position="bottom-center" style={{ marginBottom: 56 }}>
      <div className="flex flex-col items-center gap-1">
        {phase !== undefined && counts !== null && (
          <div className="rounded-md border bg-popover/95 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm">
            End of <strong className="text-foreground">{phase.name}</strong>
            {phase.target !== null && ` (${phase.target})`}: <span className="text-[var(--hx-add)]">{counts.added} new</span>, <span className="text-[var(--hx-del)]">{counts.removed} retired</span>. Read-only; pick Today to edit.
          </div>
        )}
        <div role="radiogroup" aria-label="Roadmap phase shown" className="flex items-center gap-0.5 rounded-lg border bg-popover/95 p-0.5 text-xs shadow-md backdrop-blur">
          <Milestone className="mx-1 size-3.5 text-muted-foreground" />
          <button type="button" aria-label="Previous phase" disabled={at === 0} onClick={() => go(at - 1)} className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30">
            <ChevronLeft className="size-3.5" />
          </button>
          {steps.map((id, i) => {
            const p = phases.find((x) => x.id === id)
            return (
              <button
                key={id ?? 'today'}
                type="button"
                role="radio"
                aria-checked={i === at}
                title={p === undefined ? 'The architecture as it is (planned work dotted)' : `${p.name}${p.target !== null ? `, target ${p.target}` : ''}: as it will be at the end of this phase`}
                onClick={() => go(i)}
                className={cn('rounded-md px-2 py-0.5 whitespace-nowrap', i === at ? 'bg-primary text-primary-foreground' : i < at ? 'text-foreground hover:bg-accent' : 'text-muted-foreground hover:bg-accent')}
              >
                {p?.name ?? 'Today'}
              </button>
            )
          })}
          <button type="button" aria-label="Next phase" disabled={at === steps.length - 1} onClick={() => go(at + 1)} className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30">
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>
    </Panel>
  )
}
