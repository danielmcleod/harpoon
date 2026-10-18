// Architecture lint (shared/model/lint.ts): problems worth a look, each one a click away from what it is about.
import { CircleAlert, Info, TriangleAlert } from 'lucide-react'
import { useMemo } from 'react'
import { lintModel } from '@shared/model/lint.ts'
import type { Severity } from '@shared/model/lint.ts'
import { cn } from '../lib/cn.ts'
import { select, setMode } from '../state/actions.ts'
import { setUi } from '../state/store.ts'
import { useModel } from '../canvas/useScene.ts'
import { reveal } from './ArchitectureTree.tsx'

const ICON: Record<Severity, { icon: typeof Info; cls: string }> = {
  error: { icon: CircleAlert, cls: 'text-destructive' },
  warn: { icon: TriangleAlert, cls: 'text-warning' },
  info: { icon: Info, cls: 'text-info' },
}

export function useProblems(): ReturnType<typeof lintModel> {
  const model = useModel()
  return useMemo(() => lintModel(model), [model])
}

export function Problems(): React.JSX.Element {
  const model = useModel()
  const problems = useProblems()
  if (problems.length === 0) return <p className="text-xs text-muted-foreground">No problems found.</p>
  return (
    <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
      {problems.slice(0, 200).map((p, i) => {
        const I = ICON[p.severity]
        return (
          <li key={i}>
            <button
              type="button"
              className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-[11.5px] hover:bg-accent/50"
              onClick={() => {
                if (p.nodeId !== undefined) reveal(model, p.nodeId)
                else if (p.connectorId !== undefined) select({ kind: 'connector', ids: [p.connectorId] })
                else if (p.boundaryId !== undefined) select({ kind: 'boundary', ids: [p.boundaryId] })
                else if (p.flowId !== undefined) {
                  setMode('edit')
                  setUi({ flowId: p.flowId })
                }
              }}
            >
              <I.icon className={cn('mt-0.5 size-3.5 shrink-0', I.cls)} />
              <span>{p.message}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
