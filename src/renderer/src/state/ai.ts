// AI actions: providers, conversations, proposals and the Diff & Merge review.
import type { AiContext, AiMode, AiVendor } from '@shared/ipc.ts'
import { invoke } from '../ipc/client.ts'
import { pickFor, toast } from './actions.ts'
import { getState, setAi, setUi } from './store.ts'

export async function loadProviders(force = false): Promise<void> {
  const r = await invoke('ai.providers', { force })
  if (!r.ok) return toast(r.error.message, 'error')
  setAi((ai) => {
    const providers = r.value
    // Keep the user's pick when it works; otherwise the first provider that does.
    const usable = providers.find((p) => p.id === ai.vendor && p.ok) ?? providers.find((p) => p.ok)
    const vendor = usable?.id ?? ai.vendor
    return vendor === ai.vendor ? { providers } : { providers, ...pickFor(vendor, getState().prefs) }
  })
}

/** Switch the panel's CLI; its model and effort go back to that CLI's saved defaults. */
export function setVendor(vendor: AiVendor): void {
  setAi(pickFor(vendor, getState().prefs))
}

export function setAiMode(mode: AiMode): void {
  setAi({ mode })
}

function selection(): { nodeIds: string[]; connectorIds: string[]; focusId: string | null } {
  const ui = getState().ui
  return {
    nodeIds: ui.selection?.kind === 'node' ? ui.selection.ids : [],
    connectorIds: ui.selection?.kind === 'connector' ? ui.selection.ids : [],
    focusId: ui.focusId,
  }
}

/** Start a new conversation, or continue the active one when it is idle. */
export async function ask(prompt: string, o: { fresh?: boolean; mode?: AiMode; context?: AiContext } = {}): Promise<void> {
  const ai = getState().ai
  const active = ai.activeRunId !== null ? ai.runs[ai.activeRunId] : undefined
  if (o.fresh !== true && active !== undefined && (active.status === 'done' || active.status === 'failed' || active.status === 'cancelled') && o.mode === undefined) {
    const r = await invoke('ai.send', { runId: active.id, prompt })
    if (!r.ok) toast(r.error.message, 'error')
    return
  }
  const mode = o.mode ?? ai.mode
  // Import: the repositories picked in the panel (none picked means all of them).
  const repoIds = mode === 'import' && ai.importRepos !== null && ai.importRepos.length > 0 ? ai.importRepos : undefined
  const context: AiContext | undefined = repoIds !== undefined ? { ...o.context, repoIds } : o.context
  const r = await invoke('ai.start', { vendor: ai.vendor, model: ai.model, effort: ai.effort, mode, prompt, selection: selection(), ...(context !== undefined ? { context } : {}) })
  if (!r.ok) return toast(r.error.message, 'error')
  setAi((s) => ({ activeRunId: r.value.id, runs: { ...s.runs, [r.value.id]: r.value }, review: { kind: 'draft', runId: r.value.id }, excluded: {} }))
  setUi({ aiOpen: true })
}

export function newConversation(): void {
  setAi({ activeRunId: null, review: null, highlight: null, excluded: {} })
}

export async function cancelRun(runId: string): Promise<void> {
  const r = await invoke('ai.cancel', { runId })
  if (!r.ok) toast(r.error.message, 'error')
}

export function reviewProposal(id: string | null): void {
  setAi({ review: id === null ? null : { kind: 'proposal', id }, excluded: {} })
  if (id !== null) setUi({ mode: 'edit', selection: null })
}

export function toggleOp(index: number): void {
  setAi((ai) => {
    const excluded = { ...ai.excluded }
    if (excluded[index] === true) delete excluded[index]
    else excluded[index] = true
    return { excluded }
  })
}

export async function acceptProposal(id: string, asPlanned: boolean, phase: string | null = null): Promise<boolean> {
  const ai = getState().ai
  const p = ai.proposals[id]
  if (p === undefined) return false
  const excluded = ai.review?.kind === 'proposal' && ai.review.id === id ? ai.excluded : {}
  const indexes = p.ops.map((_, i) => i).filter((i) => excluded[i] !== true)
  const r = await invoke('proposal.accept', {
    id,
    asPlanned,
    ...(asPlanned && phase !== null ? { phase } : {}),
    ...(indexes.length !== p.ops.length ? { opIndexes: indexes } : {}),
  })
  if (!r.ok) {
    toast(r.error.message, 'error')
    return false
  }
  setAi({ review: null, excluded: {} })
  const phaseName = phase === null ? null : (getState().project?.model.meta.phases.find((x) => x.id === phase)?.name ?? phase)
  toast(asPlanned ? `Accepted as planned${phaseName !== null ? ` in ${phaseName}` : ''}. Undo to take it back.` : 'Accepted. Undo to take it back.')
  return true
}

export async function discardProposal(id: string): Promise<void> {
  const r = await invoke('proposal.discard', { id })
  if (!r.ok) return toast(r.error.message, 'error')
  setAi((ai) => ({ review: ai.review?.kind === 'proposal' && ai.review.id === id ? null : ai.review }))
}
