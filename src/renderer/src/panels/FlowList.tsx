// Flows (user journeys / request paths): ordered connector steps through the architecture. Selecting one
// emphasizes its path on the canvas; the simulator and presentations use them too. Any flow opens as a sequence diagram.
import { ArrowDown, ArrowUp, ChartNoAxesGantt, Plus, Route, Sparkles, Trash2 } from 'lucide-react'
import { reviewFlows } from '../sim/investigate.ts'
import { useState } from 'react'
import { uniqueId } from '@shared/model/ids.ts'
import { FlowZ } from '@shared/model/schema.ts'
import type { FlowStep, HxFlow } from '@shared/model/schema.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { edit } from '../state/actions.ts'
import { setUi, useStore } from '../state/store.ts'
import { useModel } from '../canvas/useScene.ts'
import { FlowSequence } from './FlowSequence.tsx'
import { TextInput } from './inspector/fields.tsx'

export function FlowList({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const model = useModel()
  const flowId = useStore((s) => s.ui.flowId)
  const selection = useStore((s) => s.ui.selection)
  const flows = Object.values(model.flows).sort((a, b) => a.name.localeCompare(b.name))
  const active = flowId !== null ? model.flows[flowId] : undefined
  const [sequence, setSequence] = useState(false)

  const add = (): void => {
    const id = uniqueId('new-flow', (x) => model.flows[x] !== undefined)
    if (edit([{ op: 'addFlow', flow: FlowZ.parse({ id, name: 'New flow' }) }], { label: 'add flow' })) setUi({ flowId: id })
  }
  const setSteps = (f: HxFlow, steps: FlowStep[]): void => {
    edit([{ op: 'updateFlow', id: f.id, patch: { steps } }], { label: 'edit flow' })
  }
  const selectedConnector = selection?.kind === 'connector' && selection.ids.length === 1 ? selection.ids[0] : undefined

  return (
    <div>
      <ul className="flex flex-col gap-1">
        {flows.map((f) => (
          <li key={f.id}>
            <button
              type="button"
              onClick={() => setUi({ flowId: flowId === f.id ? null : f.id })}
              className={cn('flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs', flowId === f.id ? 'border-primary/60 bg-primary/10' : 'hover:bg-accent/50')}
            >
              <Route className="size-3.5 text-hx-cyan" />
              <span className="flex-1 truncate font-medium">{f.name}</span>
              <span className="text-[10px] text-muted-foreground">{f.steps.length} steps</span>
            </button>
          </li>
        ))}
      </ul>
      {flows.length === 0 && <p className="text-xs text-muted-foreground">No flows yet. A flow traces a request (login, checkout) hop by hop.</p>}
      {!readOnly && (
        <div className="mt-1 flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" icon={<Plus />} onClick={add}>
            New flow
          </Button>
          <Button size="sm" variant="ghost" icon={<Sparkles />} onClick={() => reviewFlows(active?.id ?? null)} title="The AI checks flows against the code, fixes broken steps, completes partial flows and adds missing journeys">
            {active !== undefined ? 'Review this flow with AI' : 'Review flows with AI'}
          </Button>
        </div>
      )}

      {active !== undefined && (
        <div className="mt-2 rounded-md border bg-background p-2">
          <TextInput value={active.name} readOnly={readOnly} onChange={(v) => v.trim() !== '' && edit([{ op: 'updateFlow', id: active.id, patch: { name: v } }], { coalesceKey: `flow:${active.id}:name` })} className="font-medium" />
          <ol className="mt-2 flex flex-col gap-0.5">
            {active.steps.map((st, i) => {
              const c = model.connectors[st.connectorId]
              const from = c === undefined ? '?' : model.nodes[st.direction === 'A' ? c.source : c.target]?.name
              const to = c === undefined ? '?' : model.nodes[st.direction === 'A' ? c.target : c.source]?.name
              return (
                <li key={`${st.connectorId}-${i}`} className="group flex items-center gap-1.5 text-[11px]">
                  <span className="w-4 text-right text-muted-foreground tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {from} → {to}
                    <span className="ml-1 font-mono text-muted-foreground">{st.direction === 'A' ? c?.channelA.protocol : (c?.channelB?.protocol ?? 'reply')}</span>
                  </span>
                  {!readOnly && (
                    <span className="hidden gap-0.5 group-hover:flex">
                      <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => setSteps(active, swap(active.steps, i, i - 1))} className="text-muted-foreground hover:text-foreground disabled:opacity-30">
                        <ArrowUp className="size-3" />
                      </button>
                      <button type="button" aria-label="Move down" disabled={i === active.steps.length - 1} onClick={() => setSteps(active, swap(active.steps, i, i + 1))} className="text-muted-foreground hover:text-foreground disabled:opacity-30">
                        <ArrowDown className="size-3" />
                      </button>
                      <button type="button" aria-label="Remove step" onClick={() => setSteps(active, active.steps.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive">
                        <Trash2 className="size-3" />
                      </button>
                    </span>
                  )}
                </li>
              )
            })}
          </ol>
          <Button size="sm" variant="ghost" className="mt-1" icon={<ChartNoAxesGantt />} disabled={active.steps.length === 0} onClick={() => setSequence(true)}>
            Sequence diagram
          </Button>
          {sequence && <FlowSequence flow={active} onClose={() => setSequence(false)} />}
          {!readOnly && (
            <div className="mt-2 flex flex-wrap gap-1">
              <Button size="sm" variant="outline" disabled={selectedConnector === undefined} title="Select a connector on the canvas first" onClick={() => selectedConnector !== undefined && setSteps(active, [...active.steps, { connectorId: selectedConnector, direction: 'A', note: null }])}>
                + request step
              </Button>
              <Button size="sm" variant="outline" disabled={selectedConnector === undefined} onClick={() => selectedConnector !== undefined && setSteps(active, [...active.steps, { connectorId: selectedConnector, direction: 'B', note: null }])}>
                + reply step
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => {
                edit([{ op: 'removeFlow', id: active.id }], { label: 'delete flow' })
                setUi({ flowId: null })
              }}>
                Delete
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function swap<T>(xs: readonly T[], i: number, j: number): T[] {
  const out = [...xs]
  const a = out[i]
  const b = out[j]
  if (a === undefined || b === undefined) return out
  out[i] = b
  out[j] = a
  return out
}
