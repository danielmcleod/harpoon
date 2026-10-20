// The resilience review: where availability is weak (single points of failure, one-zone services, missing backups,
// outside calls without a timeout or breaker), each a click from the node, and an AI run to propose fixes for the
// ones ticked.
import { CircleAlert, Info, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { resilienceFindings } from '@shared/model/resilience.ts'
import type { ResilienceFinding } from '@shared/model/resilience.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { select } from '../state/actions.ts'
import { ask } from '../state/ai.ts'
import { setUi } from '../state/store.ts'
import { useModel } from '../canvas/useScene.ts'
import { reveal } from './ArchitectureTree.tsx'

const ICON = { error: { icon: CircleAlert, cls: 'text-destructive' }, warn: { icon: TriangleAlert, cls: 'text-warning' }, info: { icon: Info, cls: 'text-info' } }
const keyOf = (f: ResilienceFinding): string => `${f.kind}:${f.nodeId ?? ''}:${f.connectorId ?? ''}`

export function useResilienceFindings(): ResilienceFinding[] {
  const model = useModel()
  return useMemo(() => resilienceFindings(model), [model])
}

export function ResilienceReview({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const model = useModel()
  const findings = useResilienceFindings()
  // Ticked for the AI (default: everything but "not documented").
  const [off, setOff] = useState<Set<string>>(new Set())
  const ticked = findings.filter((f) => (f.kind === 'undocumented' ? off.has(`+${keyOf(f)}`) : !off.has(keyOf(f))))
  const toggle = (f: ResilienceFinding): void =>
    setOff((s) => {
      const k = f.kind === 'undocumented' ? `+${keyOf(f)}` : keyOf(f)
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  const isTicked = (f: ResilienceFinding): boolean => ticked.includes(f)

  if (findings.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5 text-success" /> No availability gaps found in what is documented.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="ghost" onClick={() => setUi({ lens: { kind: 'resilience', hidden: [] } })} title="Colour the diagram by resilience and mark single points of failure">
          Show on the diagram
        </Button>
        {!readOnly && (
          <Button
            size="sm"
            variant="outline"
            icon={<Sparkles />}
            disabled={ticked.length === 0}
            onClick={() =>
              void ask(`Propose fixes for these availability gaps:\n${ticked.map((f) => `- ${f.message}${f.nodeId !== null ? ` (node id ${f.nodeId})` : ''}`).join('\n')}`, { fresh: true, mode: 'resilience' })
            }
            title="The AI checks the real deployment in the code and infrastructure, then stages planned fixes for review"
          >
            Propose fixes with AI ({ticked.length})
          </Button>
        )}
      </div>
      <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
        {findings.map((f) => {
          const I = ICON[f.severity]
          return (
            <li key={keyOf(f)} className="flex items-start gap-1.5 rounded-md px-1 py-1 hover:bg-accent/50">
              {!readOnly && <input type="checkbox" className="mt-1" checked={isTicked(f)} onChange={() => toggle(f)} aria-label={`Include in the AI fix: ${f.message}`} />}
              <button
                type="button"
                className="flex flex-1 items-start gap-1.5 text-left text-[11.5px]"
                onClick={() => {
                  if (f.nodeId !== null) reveal(model, f.nodeId)
                  else if (f.connectorId !== null) select({ kind: 'connector', ids: [f.connectorId] })
                }}
              >
                <I.icon className={cn('mt-0.5 size-3.5 shrink-0', I.cls)} />
                <span>
                  {f.message} <span className="text-muted-foreground">{f.fix}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
