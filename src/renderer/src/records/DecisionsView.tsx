// The Decisions view: open comparisons (problems with proposed solutions) and the decision log (ADRs). Pick one on
// the left to compare its options or edit the record.
import { FileDown, Plus, Scale, ScrollText, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { adrNumber } from '@shared/export/adr.ts'
import { DECISION_STATUSES } from '@shared/ipc.ts'
import type { DecisionStatus, SolutionSet } from '@shared/ipc.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { invoke } from '../ipc/client.ts'
import { toast } from '../state/actions.ts'
import { AI_NOTE_SHORT } from '../ai/AiNote.tsx'
import { startIn } from '../state/ai.ts'
import { useStore } from '../state/store.ts'
import { CompareView } from './CompareView.tsx'
import { DECISION_STATUS_STYLE, DecisionEditor } from './DecisionEditor.tsx'
import { newDecision, openRecord } from './decide.ts'
import { putSet, useRecords } from './recordsStore.ts'

export function DecisionsView(): React.JSX.Element {
  const sets = useRecords((s) => s.sets)
  const decisions = useRecords((s) => s.decisions)
  const open = useStore((s) => s.ui.records)
  const editable = useStore((s) => s.ui.mode === 'edit')
  const proposals = useStore((s) => s.ai.proposals)
  const [filter, setFilter] = useState<DecisionStatus | 'all'>('all')
  const set = open?.kind === 'set' ? sets.find((x) => x.id === open.id) : undefined
  const rec = open?.kind === 'decision' ? decisions.find((x) => x.id === open.id) : undefined
  const looseProposals = Object.values(proposals).filter((p) => p.status === 'pending' && p.option === null)

  const exportAdrs = async (): Promise<void> => {
    const r = await invoke('decision.exportAdrs')
    if (!r.ok) return toast(r.error.message, 'error')
    toast(`Wrote ${r.value.count} decision records to ${r.value.dir}.`)
  }

  /** Compare saved proposals that were made separately (each becomes an option). */
  const compareLoose = async (): Promise<void> => {
    const id = `s-manual-${Date.now().toString(36)}`
    const picked = looseProposals.slice(0, 4)
    const s: SolutionSet = {
      id,
      title: 'Compare proposals',
      problem: picked.map((p) => p.title).join(' vs '),
      constraints: '',
      criteria: [],
      options: picked.map((p) => p.id),
      scores: [],
      recommendation: null,
      status: 'open',
      chosen: null,
      decisionId: null,
      runId: null,
      createdAt: Date.now(),
      source: { kind: 'manual', ref: null, label: null },
    }
    // Loose proposals become options of this set (lettered in order).
    for (const [i, p] of picked.entries()) {
      await invoke('proposal.setOption', { id: p.id, option: { solutionSetId: id, key: String.fromCharCode(65 + i), summary: p.rationale, pros: [], cons: [], effort: null } })
    }
    await putSet(s)
    openRecord('set', id)
  }

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="flex w-80 shrink-0 flex-col border-r bg-popover">
        <div className="flex flex-wrap gap-1.5 border-b p-2">
          {editable && (
            <>
              <Button
                size="sm"
                icon={<Sparkles />}
                title={`Describe what you need; the AI designs alternatives to compare. ${AI_NOTE_SHORT}`}
                onClick={() => {
                  startIn('solutions')
                }}
              >
                Propose solutions
              </Button>
              <Button size="sm" variant="outline" icon={<Plus />} onClick={() => void newDecision()}>
                New decision
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" icon={<FileDown />} title="Write every record to docs/adr/NNNN-title.md in the project folder" onClick={() => void exportAdrs()}>
            docs/adr
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <h3 className="mb-1 px-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Comparisons</h3>
          {sets.length === 0 && <p className="px-1 pb-2 text-xs text-muted-foreground">None yet. Use Propose solutions in the AI panel.</p>}
          {editable && looseProposals.length >= 2 && (
            <button type="button" onClick={() => void compareLoose()} className="mb-1 w-full rounded-md border border-dashed px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/50">
              Compare the {Math.min(4, looseProposals.length)} saved proposals…
            </button>
          )}
          <ul className="mb-3 flex flex-col gap-0.5">
            {sets.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => openRecord('set', s.id)}
                  className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60', open?.kind === 'set' && open.id === s.id && 'bg-accent')}
                >
                  <Scale className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <span className={cn('rounded px-1 text-[10px]', s.status === 'decided' ? 'bg-success/15 text-success' : s.status === 'open' ? 'bg-info/15 text-info' : 'bg-muted text-muted-foreground')}>
                    {s.status === 'open' ? `${s.options.length} options` : s.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mb-1 flex items-center gap-1 px-1">
            <h3 className="flex-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Decision log</h3>
            <select aria-label="Filter decisions" value={filter} onChange={(e) => setFilter(e.target.value as DecisionStatus | 'all')} className="h-6 rounded border bg-background px-0.5 text-[10.5px]">
              <option value="all">all</option>
              {DECISION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          {decisions.length === 0 && <p className="px-1 text-xs text-muted-foreground">No decisions recorded.</p>}
          <ul className="flex flex-col gap-0.5">
            {decisions
              .filter((d) => filter === 'all' || d.status === filter)
              .map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => openRecord('decision', d.id)}
                    className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60', open?.kind === 'decision' && open.id === d.id && 'bg-accent')}
                  >
                    <ScrollText className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-mono text-[10.5px] text-muted-foreground">{adrNumber(d.number).slice(4)}</span>
                    <span className="min-w-0 flex-1 truncate">{d.title}</span>
                    <span className={cn('rounded px-1 text-[10px]', DECISION_STATUS_STYLE[d.status])}>{d.status}</span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        {set !== undefined ? (
          <CompareView set={set} />
        ) : rec !== undefined ? (
          <DecisionEditor rec={rec} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Scale className="size-8" />
            <p className="max-w-md">
              Compare alternative solutions side by side, choose one, and keep the decision on record. Start with <strong>Propose solutions</strong> in the AI panel, or record a decision made elsewhere.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
