// Entry of the exported HTML viewer: the project travels inside the page (#harpoon-data); the renderer runs on an
// in-memory, read-only bridge in Docs mode. Panning, expanding, inspecting, flows, the simulator and presentations
// all work offline; editing and AI do not exist here.
import './styles/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { DecisionRecord, ExportView, ProjectView, SavedView } from '@shared/ipc.ts'
import { App } from './app/App.tsx'
import { installMemoryBridge } from './ipc/memoryBridge.ts'
import { applyTheme } from './lib/theme.ts'
import { setState, setUi, useStore } from './state/store.ts'

export interface ViewerData {
  project: ProjectView
  view: ExportView
  views: SavedView[]
  decisions?: DecisionRecord[]
}

;(window as unknown as { __HARPOON_VIEWER__: boolean }).__HARPOON_VIEWER__ = true
const data = JSON.parse(document.getElementById('harpoon-data')?.textContent ?? 'null') as ViewerData | null
const root = document.getElementById('root')
if (root === null) throw new Error('no #root')
if (data === null) {
  root.textContent = 'This viewer has no project embedded.'
} else {
  document.title = `${data.project.model.meta.name} · Harpoon`
  installMemoryBridge({ project: data.project, readOnly: true, state: { theme: data.view.theme, nodeStyle: data.view.style }, views: data.views, collections: { decisions: data.decisions ?? [] } })
  applyTheme({ theme: data.view.theme, resolved: data.view.theme })
  setState({ theme: { theme: data.view.theme, resolved: data.view.theme } })
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  // Once the project is in: open in Docs mode on the exported view.
  const off = useStore.subscribe((s) => {
    if (s.project === null) return
    off()
    setUi((ui) => ({
      mode: 'docs',
      focusId: data.view.focusId,
      expanded: Object.fromEntries(data.view.expanded.map((id) => [id, true as const])),
      detail: data.view.detail ?? 'full',
      fitNonce: ui.fitNonce + 1,
    }))
  })
}
