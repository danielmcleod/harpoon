// Renderer entry: applies main's initial theme to <html> before the first render, so the first paint matches the
// window's backgroundColor, refuses file drops, then mounts the app.
import './styles/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import { applyTheme, readInitialTheme } from './lib/theme.ts'
import { setState } from './state/store.ts'

if (import.meta.env.DEV && !('harpoon' in window)) {
  const { installDevBridge } = await import('./ipc/memoryBridge.ts')
  installDevBridge()
}

const initialTheme = readInitialTheme()
applyTheme(initialTheme)
setState({ theme: initialTheme })
// A file dropped on the window would navigate away from the app (the hardening blocks it, but the drop still costs
// the page); canvas drops are handled by their own targets.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

const root = document.getElementById('root')
if (root === null) throw new Error('index.html has no #root element')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
