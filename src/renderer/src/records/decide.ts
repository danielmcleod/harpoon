// Deciding: choose one option of a comparison (accept its proposal, set the others aside), and turn the choice into a
// decision record the team can edit, or have the AI write.
import type { DecisionRecord, SolutionSet, SourceRef } from '@shared/ipc.ts'
import { draftFromSet } from '@shared/model/decisions.ts'
import { acceptProposal, ask, discardProposal } from '../state/ai.ts'
import { toast } from '../state/actions.ts'
import { getState, setAi, setUi } from '../state/store.ts'
import { nextAdrNumber, putDecision, putSet, today, useRecords } from './recordsStore.ts'

export function openRecord(kind: 'set' | 'decision', id: string): void {
  setUi({ view: 'decisions', records: { kind, id }, asOf: null })
}

/**
 * Choose an option: accept its proposal (now, or as planned work in a phase), set the other options aside (kept, so
 * the record shows what was considered), mark the comparison decided and open a drafted decision record.
 */
export async function chooseOption(set: SolutionSet, proposalId: string, o: { planned: boolean; phase: string | null }): Promise<void> {
  const ai = getState().ai
  const chosen = ai.proposals[proposalId]
  if (chosen === undefined) return toast('That option is gone.', 'error')
  if (chosen.status === 'pending' && chosen.ops.length > 0) {
    // Accept everything in the option (not a partial selection left over from a review).
    setAi({ review: null, excluded: {} })
    if (!(await acceptProposal(proposalId, o.planned, o.phase))) return // the accept failed (toasted)
  }
  for (const id of set.options) if (id !== proposalId && ai.proposals[id]?.status === 'pending') await discardProposal(id)
  const model = getState().project?.model
  if (model === undefined) return
  const existing = set.decisionId === null ? undefined : useRecords.getState().decisions.find((d) => d.id === set.decisionId)
  const draft = draftFromSet(set, proposalId, getState().ai.proposals, model, existing?.number ?? nextAdrNumber(), o.planned ? o.phase : null)
  const rec: DecisionRecord = existing === undefined ? draft : { ...existing, ...draft, id: existing.id, createdAt: existing.createdAt }
  await putDecision(rec)
  await putSet({ ...set, status: 'decided', chosen: proposalId, decisionId: rec.id })
  openRecord('decision', rec.id)
  toast(`Decided: ${chosen.title}. ${rec.id.toUpperCase()} drafted; edit it or have the AI write it up.`)
}

/** A new, empty decision record (a decision made in a meeting, without a comparison). */
export async function newDecision(title = 'New decision', source: SourceRef | null = null, context = ''): Promise<DecisionRecord> {
  const number = nextAdrNumber()
  const rec: DecisionRecord = {
    id: `adr-${String(number).padStart(4, '0')}`,
    number,
    title,
    status: 'proposed',
    implementationPlan: '',
    date: today(),
    deciders: [],
    context,
    decision: '',
    consequences: '',
    options: [],
    entityIds: [],
    phase: null,
    supersedes: null,
    supersededBy: null,
    solutionSetId: null,
    links: [],
    source,
    createdAt: Date.now(),
  }
  await putDecision(rec)
  openRecord('decision', rec.id)
  return rec
}

/** Have the AI write (or rewrite) a decision record from its comparison and what it says so far. */
export async function draftWithAi(rec: DecisionRecord, extra = ''): Promise<void> {
  const st = getState()
  const set = rec.solutionSetId === null ? undefined : useRecords.getState().sets.find((s) => s.id === rec.solutionSetId)
  const lines: string[] = [`Decision record ${rec.id} "${rec.title}" (status ${rec.status}).`]
  if (set !== undefined) {
    lines.push(`Problem: ${set.problem}`)
    if (set.constraints.trim() !== '') lines.push(`Constraints: ${set.constraints}`)
    if (set.criteria.length > 0) lines.push(`Criteria (weight): ${set.criteria.map((c) => `${c.name} (${c.weight})`).join(', ')}`)
    for (const id of set.options) {
      const p = st.ai.proposals[id]
      if (p === undefined) continue
      const sc = set.scores.filter((x) => x.option === id).map((x) => `${set.criteria.find((c) => c.id === x.criterion)?.name ?? x.criterion} ${x.score}/5${x.note !== '' ? ` (${x.note})` : ''}`)
      lines.push(
        `Option ${p.option?.key ?? ''} "${p.title}"${id === set.chosen ? ' [CHOSEN]' : ''}: ${p.option?.summary ?? p.rationale}\n  Pros: ${(p.option?.pros ?? []).join('; ') || '-'}\n  Cons: ${(p.option?.cons ?? []).join('; ') || '-'}\n  Effort: ${p.option?.effort ?? '?'}; scores: ${sc.join(', ') || '-'}`,
      )
    }
    if (set.recommendation !== null) lines.push(`Recommended: ${st.ai.proposals[set.recommendation.option]?.title ?? set.recommendation.option}: ${set.recommendation.why}`)
  }
  for (const [k, v] of [
    ['Context so far', rec.context],
    ['Decision so far', rec.decision],
    ['Consequences so far', rec.consequences],
  ] as const) {
    if (v.trim() !== '') lines.push(`${k}:\n${v}`)
  }
  if (extra.trim() !== '') lines.push(`Notes:\n${extra}`)
  await ask(lines.join('\n\n'), { fresh: true, mode: 'decision', context: { decisionId: rec.id, ...(rec.solutionSetId !== null ? { solutionSetId: rec.solutionSetId } : {}) } })
}

/** Have the CLI's own plan mode plan how to build a decision (or an accepted proposal) in the codebase. */
export function planImplementation(context: { decisionId?: string; proposalId?: string }): void {
  void ask('', { fresh: true, mode: 'implement', context })
}
