// Saved views (presentation scenes) and the presentation itself: an ordered list of views stepped through with the
// arrow keys, panels hidden, the camera gliding between scenes.
import { create } from 'zustand'
import type { SavedView } from '@shared/ipc.ts'
import { uniqueId } from '@shared/model/ids.ts'
import { getCamera, setCamera } from '../canvas/camera.ts'
import { invoke } from '../ipc/client.ts'
import { setNodeStyle, toast } from '../state/actions.ts'
import { getState, setUi } from '../state/store.ts'

interface PresentState {
  views: SavedView[]
  presenting: boolean
  index: number
  /** A generated presentation (the roadmap walkthrough) instead of the saved views. */
  steps: SavedView[] | null
}

export const usePresent = create<PresentState>(() => ({ views: [], presenting: false, index: 0, steps: null }))

/** What is being presented: generated steps, else the saved views. */
export const slides = (s: PresentState): SavedView[] => s.steps ?? s.views

export async function loadViews(): Promise<void> {
  const r = await invoke('collection.list', { kind: 'views' })
  if (r.ok) usePresent.setState({ views: r.value as SavedView[] })
}

export async function saveCurrentView(name: string, notes = ''): Promise<void> {
  const s = getState()
  const views = usePresent.getState().views
  const view: SavedView = {
    id: uniqueId(name, (x) => views.some((v) => v.id === x)),
    name,
    notes,
    order: views.length === 0 ? 0 : Math.max(...views.map((v) => v.order)) + 1,
    focusId: s.ui.focusId,
    expanded: Object.keys(s.ui.expanded),
    detail: s.ui.detail,
    nodeStyle: s.prefs.nodeStyle,
    flowId: s.ui.flowId,
    blast: s.ui.blast === null ? null : { id: s.ui.blast.id, dir: s.ui.blast.dir },
    camera: getCamera(),
    asOf: s.ui.asOf,
  }
  const r = await invoke('collection.put', { kind: 'views', item: view })
  if (!r.ok) return toast(r.error.message, 'error')
  usePresent.setState({ views: [...views, view] })
  toast(`Saved view “${name}”.`)
}

export async function deleteView(id: string): Promise<void> {
  const r = await invoke('collection.delete', { kind: 'views', id })
  if (!r.ok) return toast(r.error.message, 'error')
  usePresent.setState((s) => ({ views: s.views.filter((v) => v.id !== id) }))
}

export async function moveView(id: string, delta: -1 | 1): Promise<void> {
  const views = [...usePresent.getState().views]
  const i = views.findIndex((v) => v.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= views.length) return
  const a = views[i]
  const b = views[j]
  if (a === undefined || b === undefined) return
  views[i] = b
  views[j] = a
  const reordered = views.map((v, k) => ({ ...v, order: k }))
  usePresent.setState({ views: reordered })
  for (const v of reordered) await invoke('collection.put', { kind: 'views', item: v })
}

export function applyView(v: SavedView): void {
  const m = getState().project?.model
  if (m === undefined) return
  const exists = (id: string | null): boolean => id === null || m.nodes[id] !== undefined
  setUi((ui) => ({
    focusId: exists(v.focusId) ? v.focusId : null,
    expanded: Object.fromEntries(v.expanded.filter((id) => m.nodes[id] !== undefined).map((id) => [id, true as const])),
    detail: v.detail ?? 'full',
    flowId: v.flowId !== null && m.flows[v.flowId] !== undefined ? v.flowId : null,
    blast: v.blast !== null && m.nodes[v.blast.id] !== undefined ? { ...v.blast, hops: Infinity } : null,
    asOf: v.asOf !== null && m.meta.phases.some((p) => p.id === v.asOf) ? v.asOf : null,
    selection: null,
    // No camera saved: fit the scene instead.
    fitNonce: v.camera === null ? ui.fitNonce + 1 : ui.fitNonce,
  }))
  if (v.nodeStyle !== null && v.nodeStyle !== getState().prefs.nodeStyle) void setNodeStyle(v.nodeStyle)
  // Let the scene re-render (expansion changes positions) before moving the camera.
  if (v.camera !== null) {
    const cam = v.camera
    setTimeout(() => setCamera(cam, 700), 120)
  }
}

export function startPresentation(from = 0): void {
  const views = usePresent.getState().views
  if (views.length === 0) return toast('Save a view first (Views → Save current view).', 'info')
  const v = views[from]
  usePresent.setState({ presenting: true, index: from, steps: null })
  setUi({ aiOpen: false, mode: 'docs', view: 'canvas' })
  if (v !== undefined) applyView(v)
}

export function stopPresentation(): void {
  const generated = usePresent.getState().steps !== null
  usePresent.setState({ presenting: false, steps: null })
  if (generated) setUi({ asOf: null })
}

/** Walk the roadmap: today, then the architecture at the end of each phase, with what each phase changes. */
export function startRoadmapPresentation(): void {
  const m = getState().project?.model
  if (m === undefined) return
  const phases = [...m.meta.phases].sort((a, b) => a.order - b.order)
  if (phases.length === 0) return toast('Add roadmap phases first (Project settings → Roadmap phases).', 'info')
  const base = { notes: '', order: 0, focusId: null, expanded: [], detail: null, nodeStyle: null, flowId: null, blast: null, camera: null }
  const planned = Object.values(m.nodes).filter((n) => n.status === 'planned' || n.status === 'in-progress').length
  const steps: SavedView[] = [
    { ...base, id: 'roadmap-today', name: `${m.meta.name} today`, notes: planned > 0 ? `${planned} planned components shown dotted.` : '', asOf: null },
    ...phases.map((p, i) => {
      const lands = Object.values(m.nodes).filter((n) => n.phase === p.id && (n.status === 'planned' || n.status === 'in-progress')).map((n) => n.name)
      const goes = Object.values(m.nodes).filter((n) => n.phase === p.id && (n.status === 'deprecated' || n.status === 'removed')).map((n) => n.name)
      const notes = [p.description.trim(), lands.length > 0 ? `New: ${lands.join(', ')}.` : '', goes.length > 0 ? `Retired: ${goes.join(', ')}.` : ''].filter(Boolean).join('\n')
      return { ...base, id: `roadmap-${p.id}`, order: i + 1, name: `End of ${p.name}${p.target !== null ? ` · ${p.target}` : ''}`, notes, asOf: p.id }
    }),
  ]
  usePresent.setState({ presenting: true, index: 0, steps })
  setUi({ aiOpen: false, mode: 'docs', view: 'canvas' })
  const first = steps[0]
  if (first !== undefined) applyView(first)
}

export function stepPresentation(delta: number): void {
  const st = usePresent.getState()
  const views = slides(st)
  const index = st.index
  const next = Math.max(0, Math.min(views.length - 1, index + delta))
  if (next === index) return
  usePresent.setState({ index: next })
  const v = views[next]
  if (v !== undefined) applyView(v)
}
