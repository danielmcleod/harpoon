// Architecture lint (shared/model/lint.ts): problems worth a look, each one a click away from what it is about, with a
// one-click fix where no judgement is needed and an AI run (one, the ones ticked, or all) for the rest.
import { CircleAlert, FolderInput, Info, Sparkles, TriangleAlert, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { lintModel } from '@shared/model/lint.ts'
import type { Problem, Severity } from '@shared/model/lint.ts'
import { moveAllStraysOps, quickFix } from '@shared/model/quickfix.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { edit, select, setMode, toast } from '../state/actions.ts'
import { setUi, useStore } from '../state/store.ts'
import { useModel } from '../canvas/useScene.ts'
import { reveal } from './ArchitectureTree.tsx'
import { problemsAbout, resolveAll, resolveWithAi } from '../ai/resolve.ts'
import { AI_NOTE_SHORT } from '../ai/AiNote.tsx'
import { Section } from './inspector/fields.tsx'

const ICON: Record<Severity, { icon: typeof Info; cls: string }> = {
  error: { icon: CircleAlert, cls: 'text-destructive' },
  warn: { icon: TriangleAlert, cls: 'text-warning' },
  info: { icon: Info, cls: 'text-info' },
}

export function useProblems(): ReturnType<typeof lintModel> {
  const model = useModel()
  return useMemo(() => lintModel(model), [model])
}

/** A stable key for a problem (ticks survive edits that leave it in place). */
export const problemKey = (p: Problem): string => `${p.code}|${p.nodeId ?? ''}|${p.connectorId ?? ''}|${p.boundaryId ?? ''}|${p.flowId ?? ''}|${p.message}`

export function Problems(): React.JSX.Element {
  const model = useModel()
  const problems = useProblems()
  const editable = useStore((s) => s.ui.mode === 'edit')
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  if (problems.length === 0) return <p className="text-xs text-muted-foreground">No problems found.</p>
  const chosen = problems.filter((p) => ticked.has(problemKey(p)))
  const strays = problems.filter((p) => p.code === 'stray-node').length
  const toggle = (p: Problem): void =>
    setTicked((s) => {
      const n = new Set(s)
      const k = problemKey(p)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  return (
    <div className="flex flex-col gap-1.5">
      {editable && (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" icon={<Sparkles />} onClick={() => resolveAll(model)} title={`The AI checks the code for each problem (and availability gap), then proposes fixes. ${AI_NOTE_SHORT}`}>
            Resolve all with AI
          </Button>
          {strays > 1 && (
            <Button
              size="sm"
              variant="outline"
              icon={<FolderInput />}
              title="Move every top-level part that only one service uses inside that service (no AI, undoable)"
              onClick={() => {
                if (edit(moveAllStraysOps(model), { label: 'move strays inside their owners' })) toast(`Moved ${strays} parts inside the services that use them. Undo to put them back.`)
              }}
            >
              Move all strays inside their owners
            </Button>
          )}
          {chosen.length > 0 && (
            <Button size="sm" variant="outline" icon={<Sparkles />} onClick={() => resolveWithAi(chosen)}>
              Resolve selected ({chosen.length})
            </Button>
          )}
        </div>
      )}
      <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
        {problems.slice(0, 200).map((p) => (
          <ProblemItem key={problemKey(p)} problem={p} editable={editable} ticked={ticked.has(problemKey(p))} onTick={() => toggle(p)} />
        ))}
      </ul>
    </div>
  )
}

/** One problem: what it is about (a click away), its one-click fix when it needs no judgement, and its AI fix. */
export function ProblemItem({ problem: p, editable, ticked, onTick }: { problem: Problem; editable: boolean; ticked?: boolean; onTick?: () => void }): React.JSX.Element {
  const model = useModel()
  const I = ICON[p.severity]
  const fix = editable ? quickFix(model, p) : null
  return (
    <li className="group flex items-start gap-1.5 rounded-md px-1 py-1 hover:bg-accent/50">
      {editable && onTick !== undefined && <input type="checkbox" className="mt-1" checked={ticked === true} onChange={onTick} aria-label={`Select: ${p.message}`} />}
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-2 text-left text-[11.5px]"
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
      {editable && (
        <span className="flex shrink-0 gap-0.5 opacity-60 group-focus-within:opacity-100 group-hover:opacity-100">
          {fix !== null && (
            <button type="button" title={`${fix.label} (no AI)`} aria-label={fix.label} onClick={() => edit(fix.ops, { label: fix.label.toLowerCase() })} className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
              <Wrench className="size-3.5" />
            </button>
          )}
          <button type="button" title={`Resolve with AI. ${AI_NOTE_SHORT}`} aria-label={`Resolve with AI: ${p.message}`} onClick={() => resolveWithAi([p])} className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-primary">
            <Sparkles className="size-3.5" />
          </button>
        </span>
      )}
    </li>
  )
}

/** The problems about one node and its inner parts (the inspector). */
export function NodeProblems({ nodeId, name, editable }: { nodeId: string; name: string; editable: boolean }): React.JSX.Element | null {
  const model = useModel()
  const about = useMemo(() => problemsAbout(model, [nodeId]), [model, nodeId])
  if (about.problems.length === 0) return null
  return (
    <Section title={`Problems (${about.problems.length})`} defaultOpen={about.problems.some((p) => p.severity !== 'info')}>
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-0.5">
        {about.problems.map((p) => (
          <ProblemItem key={problemKey(p)} problem={p} editable={editable} />
        ))}
      </ul>
      {editable && about.problems.length > 1 && (
        <Button size="sm" variant="ghost" icon={<Sparkles />} className="self-start" onClick={() => resolveWithAi(about.problems, [], `${name} (and its inner parts)`)}>
          Resolve all {about.problems.length} with AI
        </Button>
      )}
    </div>
    </Section>
  )
}
