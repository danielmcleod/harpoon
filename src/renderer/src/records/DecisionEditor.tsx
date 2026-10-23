// A decision record (ADR): title, status, date, deciders, context, decision, consequences, the options considered,
// what it concerns, its roadmap phase and what it supersedes. Saved as you type; the AI can write or rewrite it.
import { openNote } from '../notes/noteActions.ts'
import { CheckCheck, Copy, FileDown, Hammer, ListChecks, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { DecisionRecord } from '@shared/ipc.ts'
import { DECISION_STATUSES } from '@shared/ipc.ts'
import { adrMarkdown, adrNumber } from '@shared/export/adr.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { toast } from '../state/actions.ts'
import { useStore } from '../state/store.ts'
import { useModel } from '../canvas/useScene.ts'
import { reveal } from '../panels/ArchitectureTree.tsx'
import { NotesEditor, PhasePicker } from '../panels/inspector/governance.tsx'
import { Chip, TextArea, TextInput } from '../panels/inspector/fields.tsx'
import { draftWithAi, markBuilt, openRecord, planImplementation } from './decide.ts'
import { copyText, openImplement, savePlan } from '../state/ai.ts'
import { AI_NOTE_SHORT } from '../ai/AiNote.tsx'
import { deleteRecord, putDecision, useRecords } from './recordsStore.ts'

export const DECISION_STATUS_STYLE: Record<DecisionRecord['status'], string> = {
  proposed: 'bg-info/15 text-info',
  accepted: 'bg-success/15 text-success',
  rejected: 'bg-destructive/15 text-destructive',
  superseded: 'bg-muted text-muted-foreground',
  deprecated: 'bg-warning/15 text-warning',
}

export function DecisionEditor({ rec }: { rec: DecisionRecord }): React.JSX.Element {
  const model = useModel()
  const all = useRecords((s) => s.decisions)
  const selection = useStore((s) => s.ui.selection)
  const editable = useStore((s) => s.ui.mode === 'edit')
  const busy = useStore((s) => Object.values(s.ai.runs).some((r) => r.mode === 'decision' && r.decisionId === rec.id && (r.status === 'running' || r.status === 'starting')))
  const [notes, setNotes] = useState('')
  const [planPath, setPlanPath] = useState<string | null>(null)
  const save = (p: Partial<DecisionRecord>): void => void putDecision({ ...rec, ...p })
  const name = (id: string): string => {
    const n = model.nodes[id]
    if (n !== undefined) return n.name
    const c = model.connectors[id]
    return c === undefined ? `${id} (gone)` : `${model.nodes[c.source]?.name ?? c.source} → ${model.nodes[c.target]?.name ?? c.target}`
  }
  const selectedIds = selection?.kind === 'node' || selection?.kind === 'connector' ? selection.ids.filter((id) => !rec.entityIds.includes(id)) : []

  const supersede = (otherId: string | null): void => {
    const prev = rec.supersedes
    save({ supersedes: otherId })
    // Keep both ends of the link in step: the old record is superseded by this one.
    if (prev !== null && prev !== otherId) {
      const old = all.find((d) => d.id === prev)
      if (old !== undefined && old.supersededBy === rec.id) void putDecision({ ...old, supersededBy: null, status: old.status === 'superseded' ? 'accepted' : old.status })
    }
    if (otherId !== null) {
      const other = all.find((d) => d.id === otherId)
      if (other !== undefined) void putDecision({ ...other, supersededBy: rec.id, status: 'superseded' })
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-5">
      <header className="flex items-start gap-3">
        <span className="mt-1 rounded-md bg-muted px-2 py-1 font-mono text-xs font-semibold">{adrNumber(rec.number)}</span>
        <div className="min-w-0 flex-1">
          <TextInput value={rec.title} readOnly={!editable} onChange={(title) => title.trim() !== '' && save({ title })} className="text-lg font-semibold" />
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
            <select
              aria-label="Status"
              disabled={!editable}
              value={rec.status}
              onChange={(e) => save({ status: e.target.value as DecisionRecord['status'] })}
              className={cn('h-6 rounded-md border-0 px-1.5 text-[11px] font-medium', DECISION_STATUS_STYLE[rec.status])}
            >
              {DECISION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <input type="date" aria-label="Date" disabled={!editable} value={rec.date} onChange={(e) => e.target.value !== '' && save({ date: e.target.value })} className="h-6 rounded-md border bg-background px-1 text-[11px] disabled:border-transparent" />
            <span className="text-muted-foreground">Deciders</span>
            <div className="w-56">
              <TextInput value={rec.deciders.join(', ')} placeholder="Names, comma separated" readOnly={!editable} onChange={(v) => save({ deciders: v.split(',').map((x) => x.trim()).filter(Boolean) })} />
            </div>
            <span className="text-muted-foreground">Phase</span>
            <div className="w-40">
              <PhasePicker value={rec.phase} readOnly={!editable} onChange={(phase) => save({ phase })} compact />
            </div>
          </div>
          {(rec.solutionSetId !== null || rec.source !== null || rec.supersededBy !== null) && (
            <div className="mt-1.5 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              {rec.solutionSetId !== null && (
                <button type="button" className="hover:text-foreground hover:underline" onClick={() => openRecord('set', rec.solutionSetId ?? '')}>
                  From the comparison →
                </button>
              )}
              {rec.supersededBy !== null && (
                <button type="button" className="hover:text-foreground hover:underline" onClick={() => openRecord('decision', rec.supersededBy ?? '')}>
                  Superseded by {rec.supersededBy.toUpperCase()} →
                </button>
              )}
              {rec.source !== null &&
                (rec.source.kind === 'note' && rec.source.ref !== null ? (
                  <button type="button" className="hover:text-foreground hover:underline" onClick={() => openNote(rec.source?.ref?.split('#')[0] ?? '')}>
                    From the note “{rec.source.label}” →
                  </button>
                ) : (
                  <span>Source: {rec.source.label ?? rec.source.kind}</span>
                ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex gap-1.5">
            {editable && (
              <Button size="sm" icon={<Sparkles />} loading={busy} onClick={() => void draftWithAi(rec, notes)} title="Have the AI write this record from the comparison and what is here">
                {rec.decision.trim() === '' ? 'Write with AI' : 'Rewrite with AI'}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              icon={<Copy />}
              onClick={() => void navigator.clipboard.writeText(adrMarkdown(rec, model, all)).then(() => toast('Copied as Markdown.'))}
            >
              Markdown
            </Button>
          </div>
          {editable && (
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes for the AI (optional)"
              aria-label="Notes for the AI"
              className="h-7 w-64 rounded-md border bg-background px-2 text-[11px] outline-none focus:border-ring"
            />
          )}
        </div>
      </header>

      {(
        [
          ['context', 'Context', 'The forces at play: the problem, constraints, why now.'],
          ['decision', 'Decision', 'What we will do, and why this option.'],
          ['consequences', 'Consequences', 'What becomes easier or harder; follow-ups.'],
        ] as const
      ).map(([k, label, hint]) => (
        <section key={k}>
          <h3 className="mb-1 text-sm font-semibold">{label}</h3>
          <p className="mb-1 text-[11px] text-muted-foreground">{hint}</p>
          <NotesEditor value={rec[k]} readOnly={!editable} onChange={(v) => save({ [k]: v })} />
        </section>
      ))}

      <section>
        <div className="mb-1 flex items-center gap-2">
          <h3 className="flex-1 text-sm font-semibold">Implementation plan</h3>
          {editable && (
            <Button
              size="sm"
              variant={rec.implementationPlan.trim() === '' ? 'default' : 'outline'}
              icon={<ListChecks />}
              onClick={() => planImplementation({ decisionId: rec.id })}
              title={`Your CLI’s own plan mode (Claude Code or Codex) reads the code and plans how to build this. ${AI_NOTE_SHORT}`}
            >
              {rec.implementationPlan.trim() === '' ? 'Plan the implementation' : 'Plan again'}
            </Button>
          )}
        </div>
        <p className="mb-1 text-[11px] text-muted-foreground">
          How to build it in the code: steps, files, tests, rollout and risks. Planned by your CLI’s plan mode; follow up in the AI panel, for example to create issues for it.
        </p>
        {rec.implementationPlan.trim() !== '' && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" icon={<FileDown />} onClick={() => void savePlan({ decisionId: rec.id }).then((p) => p !== null && setPlanPath(p))} title="Save it as Markdown in the plans folder (Settings → AI → Implementing)">
              Save plan
            </Button>
            {planPath !== null && (
              <Button size="sm" variant="ghost" icon={<Copy />} onClick={() => void copyText(planPath, 'the path')} title={planPath}>
                Copy path
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<Copy />} onClick={() => void copyText(rec.implementationPlan, 'the plan')}>
              Copy plan
            </Button>
            {editable && rec.entityIds.length > 0 && (
              <Button size="sm" variant="ghost" icon={<CheckCheck />} onClick={() => markBuilt(rec.entityIds)} title="Planned and in-progress parts of this decision become existing (undoable)">
                Mark as built
              </Button>
            )}
            <span className="flex-1" />
            <Button size="sm" icon={<Hammer />} onClick={() => openImplement({ decisionId: rec.id })} title={`Your CLI edits the code to carry out this plan, asking as you choose. ${AI_NOTE_SHORT}`}>
              Implement this plan…
            </Button>
          </div>
        )}
        {rec.implementationPlan.trim() !== '' && <NotesEditor value={rec.implementationPlan} readOnly={!editable} onChange={(v) => save({ implementationPlan: v })} />}
      </section>

      <section>
        <div className="mb-1.5 flex items-center gap-2">
          <h3 className="flex-1 text-sm font-semibold">Options considered</h3>
          {editable && (
            <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => save({ options: [...rec.options, { proposalId: null, title: 'Another option', summary: '', chosen: false, whyNot: '' }] })}>
              Add option
            </Button>
          )}
        </div>
        {rec.options.length === 0 && <p className="text-xs text-muted-foreground">None recorded.</p>}
        <ul className="flex flex-col gap-2">
          {rec.options.map((o, i) => {
            const set = (p: Partial<(typeof rec.options)[number]>): void => save({ options: rec.options.map((x, j) => (j === i ? { ...x, ...p } : x)) })
            return (
              <li key={i} className={cn('rounded-lg border p-2.5', o.chosen && 'border-primary/60 bg-primary/5')}>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-[11px]">
                    <input type="checkbox" disabled={!editable} checked={o.chosen} onChange={(e) => save({ options: rec.options.map((x, j) => ({ ...x, chosen: j === i ? e.target.checked : e.target.checked ? false : x.chosen })) })} />
                    chosen
                  </label>
                  <div className="min-w-0 flex-1">
                    <TextInput value={o.title} readOnly={!editable} onChange={(title) => set({ title })} className="font-medium" />
                  </div>
                  {editable && (
                    <button type="button" aria-label="Remove option" className="text-muted-foreground hover:text-destructive" onClick={() => save({ options: rec.options.filter((_, j) => j !== i) })}>
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
                <div className="mt-1.5 grid gap-2 md:grid-cols-2">
                  <TextArea value={o.summary} rows={2} placeholder="What it is" readOnly={!editable} onChange={(summary) => set({ summary })} />
                  {!o.chosen && <TextArea value={o.whyNot} rows={2} placeholder="Why not" readOnly={!editable} onChange={(whyNot) => set({ whyNot })} />}
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      <section>
        <h3 className="mb-1.5 text-sm font-semibold">Concerns</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {rec.entityIds.map((id) => (
            <Chip key={id} {...(editable ? { onRemove: () => save({ entityIds: rec.entityIds.filter((x) => x !== id) }) } : {})}>
              <button type="button" className="hover:underline" onClick={() => model.nodes[id] !== undefined && reveal(model, id)}>
                {name(id)}
              </button>
            </Chip>
          ))}
          {rec.entityIds.length === 0 && <span className="text-xs text-muted-foreground">Nothing linked.</span>}
          {editable && selectedIds.length > 0 && (
            <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => save({ entityIds: [...rec.entityIds, ...selectedIds] })}>
              Add the selection ({selectedIds.length})
            </Button>
          )}
        </div>
        {editable && selectedIds.length === 0 && <p className="mt-1 text-[11px] text-muted-foreground">Select nodes or connectors (in the tree or a table) to link them here.</p>}
      </section>

      <section className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold">Supersedes</span>
        <select
          aria-label="Supersedes"
          disabled={!editable}
          value={rec.supersedes ?? ''}
          onChange={(e) => supersede(e.target.value === '' ? null : e.target.value)}
          className="h-7 rounded-md border bg-background px-1 text-xs"
        >
          <option value="">nothing</option>
          {all
            .filter((d) => d.id !== rec.id)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {adrNumber(d.number)} {d.title}
              </option>
            ))}
        </select>
        <span className="flex-1" />
        {editable && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            icon={<Trash2 />}
            onClick={() => {
              if (window.confirm(`Delete ${adrNumber(rec.number)}? Decision records are usually kept and marked rejected or superseded instead.`)) void deleteRecord('decisions', rec.id)
            }}
          >
            Delete
          </Button>
        )}
      </section>
    </div>
  )
}
