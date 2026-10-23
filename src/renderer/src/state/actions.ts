// Store mutations. Model edits are optimistic: the batch is applied to the local mirror at once and sent to the core
// with a transaction id; the core's `model` event for that id only confirms it. Anyone else's batch (undo, AI,
// external edits) arrives as a `model` event and is applied here. Any mismatch refetches the project.
import { loadNotes, notesChanged } from '../notes/notesStore.ts'
import { loadRecords } from '../records/recordsStore.ts'
import type { AiVendor, AppEvent, AppState, ProjectView, ToastLevel } from '@shared/ipc.ts'
import { applyOps } from '@shared/model/ops.ts'
import type { Op } from '@shared/model/ops.ts'
import { call, invoke } from '../ipc/client.ts'
import { newConnectorOps } from '../canvas/edits.ts'
import { applyTheme } from '../lib/theme.ts'
import { INITIAL_AI, INITIAL_UI, getState, setAi, setState, setUi } from './store.ts'
import type { Mode, Selection } from './store.ts'

let txSeq = 0
const pending = new Set<string>()
let needsResync = false

// ---- toasts ------------------------------------------------------------------------------------------------

let toastSeq = 0
export function toast(message: string, level: ToastLevel = 'info'): void {
  const id = ++toastSeq
  setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, level, message }] }))
  setTimeout(() => dismissToast(id), level === 'error' ? 8000 : 4000)
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

/** The saved model and effort for a vendor. */
export function pickFor(vendor: AiVendor, prefs: AppState): { vendor: AiVendor; model: string | null; effort: string | null } {
  return { vendor, model: prefs.ai[vendor].model, effort: prefs.ai[vendor].effort }
}

// ---- boot / events ------------------------------------------------------------------------------------------

export async function boot(): Promise<void> {
  const [prefs, project, runs] = await Promise.all([invoke('state.get'), invoke('project.current'), invoke('ai.runs')])
  setState((s) => ({
    ready: true,
    prefs: prefs.ok ? prefs.value : s.prefs,
    project: project.ok ? project.value : null,
    ai: {
      ...s.ai,
      // The panel starts from this machine's defaults (Settings → AI).
      ...(prefs.ok ? pickFor(prefs.value.ai.vendor ?? s.ai.vendor, prefs.value) : {}),
      runs: runs.ok ? Object.fromEntries(runs.value.map((r) => [r.id, r])) : {},
    },
  }))
  if (project.ok && project.value !== null) {
    void loadProposals()
    void loadRecords()
  }
}

async function loadProposals(): Promise<void> {
  const r = await invoke('proposal.list')
  if (r.ok) setAi({ proposals: Object.fromEntries(r.value.map((p) => [p.id, p])) })
}

export function handleEvents(batch: AppEvent[]): void {
  for (const e of batch) {
    switch (e.kind) {
      case 'theme':
        applyTheme(e.theme)
        setState({ theme: e.theme })
        break
      case 'toast':
        toast(e.message, e.level)
        break
      case 'project-opened':
        adoptProject(e.project)
        // This project's conversations arrive from the core (kept from earlier sessions); another project's go.
        setAi({ runs: {}, activeRunId: null, review: null, drafts: {} })
        void loadProposals()
        void loadRecords()
        void loadNotes()
        break
      case 'project-closed':
        pending.clear()
        setState((s) => ({ project: null, ui: INITIAL_UI, ai: { ...INITIAL_AI, providers: s.ai.providers, vendor: s.ai.vendor, model: s.ai.model, effort: s.ai.effort } }))
        break
      case 'model':
        onModel(e)
        setState((s) => ({ save: { ...s.save, status: 'saving' } }))
        break
      case 'saved':
        setState({ save: { status: e.error === null ? 'saved' : 'error', at: e.at, error: e.error } })
        break
      case 'ai-run':
        setAi((ai) => ({ runs: { ...ai.runs, [e.run.id]: e.run } }))
        break
      case 'ai-text':
        setAi((ai) => {
          const run = ai.runs[e.runId]
          if (run === undefined) return {}
          const turns = [...run.turns]
          const last = turns.at(-1)
          if (last?.role === 'assistant') turns[turns.length - 1] = { ...last, text: last.text + e.delta }
          else turns.push({ role: 'assistant', text: e.delta })
          return { runs: { ...ai.runs, [e.runId]: { ...run, turns } } }
        })
        break
      case 'ai-draft':
        setAi((ai) => ({ drafts: { ...ai.drafts, [e.runId]: e.ops } }))
        break
      case 'ai-highlight':
        setAi({ highlight: { runId: e.runId, nodeIds: e.nodeIds, note: e.note } })
        break
      case 'proposal':
        setAi((ai) => ({ proposals: { ...ai.proposals, [e.proposal.id]: e.proposal } }))
        break
      case 'notes':
        notesChanged(e.path)
        break
      case 'collection':
        if (e.collection === 'solutions' || e.collection === 'decisions') void loadRecords(e.collection)
        break
    }
  }
}

function adoptProject(p: ProjectView): void {
  pending.clear()
  needsResync = false
  setState((s) => ({ project: p, ui: { ...INITIAL_UI, leftCollapsed: s.ui.leftCollapsed, rightCollapsed: s.ui.rightCollapsed, fitNonce: s.ui.fitNonce + 1 } }))
}

function onModel(e: Extract<AppEvent, { kind: 'model' }>): void {
  const p = getState().project
  if (p === null) return
  if (e.txId !== undefined && pending.has(e.txId)) {
    pending.delete(e.txId)
    setState({ project: { ...p, history: e.history } })
    if (pending.size === 0 && needsResync) void resync()
    return
  }
  if (pending.size > 0) {
    needsResync = true
    return
  }
  if (e.version !== p.version + 1) {
    void resync()
    return
  }
  try {
    const { model } = applyOps(p.model, e.ops)
    setState({ project: { ...p, model, version: e.version, history: e.history } })
    pruneUi()
  } catch {
    void resync()
  }
}

export async function resync(): Promise<void> {
  needsResync = false
  const r = await invoke('project.current')
  if (r.ok) setState({ project: r.value })
  pruneUi()
}

/** Drop selection/expansion/focus entries that point at things that no longer exist. */
function pruneUi(): void {
  const s = getState()
  const m = s.project?.model
  if (m === undefined) return
  const ui = s.ui
  const sel = ui.selection
  let selection: Selection = sel
  if (sel !== null) {
    const exists = (id: string): boolean =>
      sel.kind === 'node' ? m.nodes[id] !== undefined : sel.kind === 'connector' ? m.connectors[id] !== undefined : m.boundaries[id] !== undefined
    const ids = sel.ids.filter(exists)
    selection = ids.length === 0 ? null : ids.length === sel.ids.length ? sel : { ...sel, ids }
  }
  const expanded = Object.fromEntries(Object.keys(ui.expanded).filter((id) => m.nodes[id] !== undefined).map((id) => [id, true as const]))
  const focusId = ui.focusId !== null && m.nodes[ui.focusId] === undefined ? null : ui.focusId
  if (selection !== sel || focusId !== ui.focusId || Object.keys(expanded).length !== Object.keys(ui.expanded).length) {
    setUi({ selection, expanded, focusId })
  }
}

// ---- model edits ---------------------------------------------------------------------------------------------

export interface EditOptions {
  label?: string
  coalesceKey?: string
}

/** Apply a batch optimistically. Returns false (with a toast) when it does not fit the model. */
export function edit(ops: Op[], o: EditOptions = {}): boolean {
  const p = getState().project
  if (p === null || ops.length === 0) return false
  let model
  try {
    model = applyOps(p.model, ops).model
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error')
    return false
  }
  const txId = `tx${++txSeq}`
  pending.add(txId)
  setState({ project: { ...p, model, version: p.version + 1 }, save: { ...getState().save, status: 'saving' } })
  pruneUi()
  void invoke('project.apply', { ops, txId, ...o }).then((r) => {
    if (r.ok) return
    pending.delete(txId)
    toast(r.error.message, 'error')
    void resync()
  })
  return true
}

export async function undo(): Promise<void> {
  if (getState().project?.history.canUndo !== true) return
  await flushPending()
  const r = await invoke('project.undo')
  if (!r.ok) toast(r.error.message, 'error')
}

/** Jump through history: negative undoes, positive redoes. */
export async function stepHistory(steps: number): Promise<void> {
  if (steps === 0) return
  await flushPending()
  const r = await invoke('project.step', { steps })
  if (!r.ok) toast(r.error.message, 'error')
}

export async function redo(): Promise<void> {
  if (getState().project?.history.canRedo !== true) return
  await flushPending()
  const r = await invoke('project.redo')
  if (!r.ok) toast(r.error.message, 'error')
}

/** Wait until every optimistic batch is confirmed (so undo targets the right one). */
async function flushPending(): Promise<void> {
  for (let i = 0; i < 50 && pending.size > 0; i++) await new Promise((r) => setTimeout(r, 20))
}

// ---- projects -------------------------------------------------------------------------------------------------

export async function openProjectDialog(): Promise<void> {
  const dir = await call('dialog.pickFolder', { title: 'Open or create a Harpoon project' })
  if (dir === null) return
  await openOrCreate(dir)
}

export async function openOrCreate(dir: string, template: 'blank' | 'sample' = 'blank'): Promise<void> {
  const info = await invoke('project.inspect', { dir })
  if (!info.ok) return toast(info.error.message, 'error')
  const r = info.value.hasProject
    ? await invoke('project.open', { dir: info.value.path })
    : await invoke('project.create', { dir: info.value.path, template })
  if (!r.ok) toast(r.error.message, 'error')
}

/** The sample, as a local design (no folder to pick). */
export async function createSample(): Promise<void> {
  const r = await invoke('project.createLocal', { name: 'Commerce Platform', template: 'sample' })
  if (!r.ok) toast(r.error.message, 'error')
}

/** A new design saved on this machine only, in the designs folder: no repository needed. */
export async function createLocalDesign(name: string): Promise<void> {
  const r = await invoke('project.createLocal', { name: name.trim() || 'Untitled design' })
  if (!r.ok) toast(r.error.message, 'error')
}

/** Open a single-file design (.harpoon.json) as a local design. */
export async function openDesignFile(): Promise<void> {
  const path = await call('dialog.pickFile', { title: 'Open a Harpoon design', filters: [{ name: 'Harpoon design', extensions: ['json'] }] })
  if (path === null) return
  const r = await invoke('project.importFile', { path })
  if (!r.ok) toast(r.error.message, 'error')
}

/** Copy the open project into another folder (a repository, a shared drive) and continue in the copy. */
export async function saveCopyTo(): Promise<void> {
  const dir = await call('dialog.pickFolder', { title: 'Save a copy of this design into a folder (for example a repository)' })
  if (dir === null) return
  const r = await invoke('project.saveCopy', { dir })
  if (!r.ok) return toast(r.error.message, 'error')
  toast(`Saved a copy in ${r.value.root}; you are now working in the copy.`)
}

/** Save the whole design as one file (the lossless .harpoon.json), to keep or send anywhere. */
export async function saveAsFile(): Promise<void> {
  const r = await invoke('export.render', { format: 'harpoon-json', view: { focusId: null, expanded: [], style: 'flat', theme: 'dark', includeNotes: true } })
  if (!r.ok) return toast(r.error.message, 'error')
  const saved = await invoke('export.save', { filename: r.value.filename, content: r.value.content })
  if (!saved.ok) return toast(saved.error.message, 'error')
  if (saved.value !== null) toast(`Saved ${saved.value}`)
}

export async function closeProject(): Promise<void> {
  await invoke('project.close')
}

// ---- ui -------------------------------------------------------------------------------------------------------

export function select(selection: Selection): void {
  setUi((ui) => ({
    selection,
    featureId: selection?.kind === 'node' && ui.selection?.kind === 'node' && ui.selection.ids[0] === selection.ids[0] ? ui.featureId : null,
  }))
}

export function setMode(mode: Mode): void {
  setUi({ mode, connectFrom: null })
}

// ---- connect mode ----------------------------------------------------------------------------------------------

/** Start connect mode from a node: the next node clicked becomes the target. */
export function startConnect(from: string): void {
  setUi({ connectFrom: from, mode: 'edit' })
}

export function cancelConnect(): void {
  setUi({ connectFrom: null })
}

/** Finish connect mode on `target` (no-op on the source itself). Returns whether a connector was made. */
export function completeConnect(target: string): boolean {
  const s = getState()
  const from = s.ui.connectFrom
  const m = s.project?.model
  if (from === null || m === undefined) return false
  if (from === target) return false
  setUi({ connectFrom: null })
  const made = newConnectorOps(m, from, target)
  if (made === null) return false
  if (!edit(made.ops, { label: 'connect' })) return false
  select({ kind: 'connector', ids: [made.id] })
  toast(`Connected ${m.nodes[from]?.name ?? from} → ${m.nodes[target]?.name ?? target}. Set the protocol in the inspector.`)
  return true
}

export function toggleExpanded(id: string, open?: boolean): void {
  setUi((ui) => {
    const isOpen = ui.expanded[id] === true
    const next = { ...ui.expanded }
    if (open ?? !isOpen) next[id] = true
    else delete next[id]
    return { expanded: next }
  })
}

export function focus(id: string | null): void {
  setUi((ui) => ({ focusId: id, expanded: {}, selection: null, fitNonce: ui.fitNonce + 1 }))
}

export function centerOn(id: string): void {
  setUi((ui) => ({ centerOn: { id, nonce: (ui.centerOn?.nonce ?? 0) + 1 } }))
}

export async function setNodeStyle(style: 'flat' | 'iso'): Promise<void> {
  const r = await invoke('state.set', { nodeStyle: style })
  if (r.ok) setState({ prefs: r.value })
}

export async function setTheme(theme: 'light' | 'dark' | 'system'): Promise<void> {
  const r = await invoke('state.set', { theme })
  if (!r.ok) return
  // Apply at once (main also pushes a theme event; the HTML viewer has no main process to do so).
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const state = { theme, resolved: dark ? ('dark' as const) : ('light' as const) }
  applyTheme(state)
  setState({ prefs: r.value, theme: state })
}
