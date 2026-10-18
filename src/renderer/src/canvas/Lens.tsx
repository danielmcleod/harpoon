// The lens: colour every node by status, owning team, data handled or roadmap phase, with a count per legend entry;
// click an entry to show or hide it, "only" to isolate it. Roadmap, ownership and compliance scope at a glance.
import { Panel } from '@xyflow/react'
import { Layers } from 'lucide-react'
import { useMemo } from 'react'
import { dataScope } from '@shared/model/governance.ts'
import { cn } from '../lib/cn.ts'
import { setUi, useStore } from '../state/store.ts'
import { LENS_HINT, LENS_KINDS, LENS_LABEL, computeLens } from './lensMarks.ts'
import type { LensKind } from './lensMarks.ts'
import { useModel } from './useScene.ts'

export function Lens(): React.JSX.Element {
  const model = useModel()
  const lens = useStore((s) => s.ui.lens)
  const legend = useMemo(() => (lens === null ? [] : computeLens(model, lens.kind, dataScope(model)).legend), [model, lens])
  const hidden = new Set(lens?.hidden ?? [])
  const choose = (kind: LensKind): void => setUi({ lens: lens?.kind === kind ? null : { kind, hidden: [] } })

  return (
    <Panel position="top-right">
      <div className="flex flex-col items-end gap-1.5">
        <div role="radiogroup" aria-label="Colour nodes by" className="flex items-center rounded-lg border bg-popover/90 p-0.5 text-xs shadow-sm backdrop-blur">
          <Layers className="mx-1.5 size-3.5 text-muted-foreground" />
          {LENS_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={lens?.kind === k}
              title={LENS_HINT[k]}
              onClick={() => choose(k)}
              className={cn('rounded-md px-2 py-0.5', lens?.kind === k ? 'bg-primary/20 font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
            >
              {LENS_LABEL[k]}
            </button>
          ))}
        </div>
        {lens !== null && (
          <div className="flex max-h-[50vh] min-w-40 flex-col gap-0.5 overflow-y-auto rounded-lg border bg-popover/95 p-1.5 text-xs shadow-md">
            {legend.map((e) => (
              <div key={e.key} className="group flex items-center gap-1">
                <button
                  type="button"
                  aria-pressed={!hidden.has(e.key)}
                  onClick={() => {
                    const next = new Set(hidden)
                    if (next.has(e.key)) next.delete(e.key)
                    else next.add(e.key)
                    setUi({ lens: { kind: lens.kind, hidden: [...next] } })
                  }}
                  className={cn('flex flex-1 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-accent', hidden.has(e.key) && 'opacity-45')}
                >
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: e.color }} />
                  <span className="flex-1 truncate">{e.label}</span>
                  <span className="font-mono text-muted-foreground tabular-nums">{e.count}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setUi({ lens: { kind: lens.kind, hidden: legend.filter((x) => x.key !== e.key).map((x) => x.key) } })}
                  className="invisible rounded px-1 text-[10px] text-muted-foreground group-hover:visible hover:bg-accent hover:text-foreground"
                >
                  only
                </button>
              </div>
            ))}
            {lens.kind === 'data' && legend.length <= 1 && <p className="px-1.5 py-1 text-[11px] text-muted-foreground">Nothing is tagged yet. Tag data on nodes or connectors in the inspector.</p>}
            {lens.kind === 'phase' && model.meta.phases.length === 0 && <p className="px-1.5 py-1 text-[11px] text-muted-foreground">No phases yet. Add them in the project panel.</p>}
            <button type="button" onClick={() => setUi({ lens: { kind: lens.kind, hidden: [] } })} className="mt-0.5 rounded px-1.5 py-0.5 text-left text-[10.5px] text-muted-foreground hover:text-foreground">
              Show all
            </button>
          </div>
        )}
      </div>
    </Panel>
  )
}
