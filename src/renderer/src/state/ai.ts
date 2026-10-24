// AI actions: providers, conversations, proposals and the Diff & Merge review.
import type { AiContext, AiImplementRequest, AiMode, AiSelection, AiVendor, ResultCode } from '@shared/ipc.ts'
import { invoke } from '../ipc/client.ts'
import { alwaysOn } from '../ai/toolHints.ts'
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

/** Switch the panel's CLI; its model and effort go back to that CLI's saved defaults (its tools are its own). */
export function setVendor(vendor: AiVendor): void {
  setAi({ ...pickFor(vendor, getState().prefs), tools: [] })
}

/** Ask the CLIs which MCP servers and connectors they have. */
export async function loadUserTools(force = false): Promise<void> {
  const r = await invoke('ai.tools', { force })
  if (!r.ok) return toast(r.error.message, 'error')
  setAi({ userTools: r.value })
}

export function setAiMode(mode: AiMode): void {
  setAi({ mode })
}

/** The canvas selection (and the node the canvas is inside), as AI context. */
export function canvasSelection(): AiSelection {
  const ui = getState().ui
  return {
    nodeIds: ui.selection?.kind === 'node' ? ui.selection.ids : [],
    connectorIds: ui.selection?.kind === 'connector' ? ui.selection.ids : [],
    focusId: ui.focusId,
  }
}

/**
 * What a new conversation gets as context: the canvas selection (the panel's composer, canvas actions), none (runs
 * started from notes, records, settings or lists, which name what they are about), or the ids given.
 */
export type AskScope = 'canvas' | 'none' | AiSelection

const NO_SELECTION: AiSelection = { nodeIds: [], connectorIds: [], focusId: null }

/** Start a new conversation (the open one stays in history). */
export async function ask(prompt: string, o: { mode?: AiMode; context?: AiContext; scope?: AskScope } = {}): Promise<void> {
  const ai = getState().ai
  const mode = o.mode ?? ai.mode
  // The panel shows the conversation's own mode (runs started from a button too), so its box replies to it.
  if (mode !== ai.mode) setAi({ mode })
  // Import: the repositories picked in the panel (none picked means all of them).
  const repoIds = mode === 'import' && ai.importRepos !== null && ai.importRepos.length > 0 ? ai.importRepos : undefined
  const context: AiContext | undefined = repoIds !== undefined ? { ...o.context, repoIds } : o.context
  const tools = [...new Set([...ai.tools, ...alwaysOn(ai.userTools?.[ai.vendor], getState().prefs.ai.tools[ai.vendor])])]
  const scope = o.scope ?? 'none'
  const sel = scope === 'canvas' ? canvasSelection() : scope === 'none' ? NO_SELECTION : scope
  const r = await invoke('ai.start', { vendor: ai.vendor, model: ai.model, effort: ai.effort, tools: mode === 'publish' ? [] : tools, mode, prompt, selection: sel, ...(context !== undefined ? { context } : {}) })
  if (!r.ok) return toast(r.error.message, 'error')
  setAi((s) => ({ activeRunId: r.value.id, runs: { ...s.runs, [r.value.id]: r.value }, review: { kind: 'draft', runId: r.value.id }, excluded: {} }))
  setUi({ aiOpen: true })
}

/** Continue a conversation; `selection`: what the user selected since, sent as this message's context. */
export async function reply(runId: string, prompt: string, o: { selection?: AiSelection } = {}): Promise<boolean> {
  const ai = getState().ai
  const vendor = ai.runs[runId]?.vendor ?? ai.vendor
  const tools = [...new Set([...ai.tools, ...alwaysOn(ai.userTools?.[vendor], getState().prefs.ai.tools[vendor])])]
  const r = await invoke('ai.send', { runId, prompt, tools, ...(o.selection !== undefined ? { selection: o.selection } : {}) })
  if (!r.ok) toast(r.error.message, 'error')
  return r.ok
}

/** Open the panel ready to start a conversation in this mode (the open one stays in history). */
export function startIn(mode: AiMode): void {
  newConversation()
  setAi({ mode })
  setUi({ aiOpen: true })
}

/** Open the Implement dialog for a conversation's plan or a decision's. */
export function openImplement(target: { runId?: string; decisionId?: string }): void {
  setAi({ implementing: target })
}

/** Save a plan as a Markdown file in the plans folder (Settings → AI → Implementing); returns its path. */
export async function savePlan(target: { runId?: string; decisionId?: string }): Promise<string | null> {
  const r = await invoke('ai.savePlan', target)
  if (!r.ok) {
    toast(r.error.message, 'error')
    return null
  }
  toast(`Saved the plan to ${r.value.path}`)
  return r.value.path
}

export async function copyText(text: string, what: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  toast(`Copied ${what}.`)
}

/** Start implementing a plan with the panel's CLI and model. Errors come back (the dialog shows them). */
export async function implementPlan(req: Omit<AiImplementRequest, 'vendor' | 'model' | 'effort'>): Promise<{ code: ResultCode; message: string } | null> {
  const ai = getState().ai
  const r = await invoke('ai.implement', { ...req, vendor: ai.vendor, model: ai.model, effort: ai.effort })
  if (!r.ok) return r.error
  setAi((s) => ({ implementing: null, activeRunId: r.value.id, mode: 'implement', runs: { ...s.runs, [r.value.id]: r.value } }))
  setUi({ aiOpen: true })
  return null
}

/** Answer an Implement run's request to edit a file or run a command. */
export async function answerAsk(runId: string, requestId: string, decision: 'allow' | 'allow-session' | 'deny'): Promise<void> {
  const r = await invoke('ai.answer', { runId, requestId, decision })
  if (!r.ok) toast(r.error.message, 'error')
}

export async function removeWorktree(runId: string): Promise<void> {
  const r = await invoke('ai.removeWorktree', { runId })
  if (!r.ok) toast(r.error.message, 'error')
  else toast('Removed the worktree; its branch is kept.')
}

/** Forget a conversation (here and in the history kept on this computer). */
export async function deleteConversation(runId: string): Promise<void> {
  const r = await invoke('ai.delete', { runId })
  if (!r.ok) return toast(r.error.message, 'error')
  setAi((ai) => {
    const runs = { ...ai.runs }
    delete runs[runId]
    return { runs, ...(ai.activeRunId === runId ? { activeRunId: null, review: null } : {}) }
  })
}

/** Forget the project's finished conversations. */
export async function clearHistory(): Promise<void> {
  const r = await invoke('ai.clear')
  if (!r.ok) return toast(r.error.message, 'error')
  setAi((ai) => {
    const runs = Object.fromEntries(Object.entries(ai.runs).filter(([, v]) => v.status === 'running' || v.status === 'starting'))
    return { runs, ...(ai.activeRunId !== null && runs[ai.activeRunId] === undefined ? { activeRunId: null, review: null } : {}) }
  })
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
