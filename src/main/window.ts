// The main window: sandboxed, context-isolated renderer with the CJS preload; hidden until ready-to-show;
// backgroundColor and the preload's initial theme both come from the resolved ThemeState. Page zoom keys step
// through keys.ts ZOOM_STEPS (Ctrl+wheel is left to the canvas).
import { BrowserWindow } from 'electron'
import type { Logger } from '@core/log.ts'
import type { ThemeState } from '@shared/ipc.ts'
import { encodeThemeArg } from '../preload/wire.ts'
import { WINDOW_SIZE, WINDOW_TITLE } from './constants.ts'
import { nextZoomFactor } from './keys.ts'
import type { ZoomAction } from './keys.ts'
import { backgroundFor } from './theme.ts'
import type { RendererTarget } from './urls.ts'

export interface MainWindowOptions {
  /** Absolute path of out/preload/index.cjs. */
  preload: string
  target: RendererTarget
  theme: ThemeState
  showImmediately: boolean
  log: Pick<Logger, 'error'>
  /** The window and taskbar icon (out/renderer/icon.png). */
  icon?: string
  /** The page failed to load (smoke runs fail on it). */
  onLoadFailed?: (reason: string) => void
}

export function createMainWindow(o: MainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...WINDOW_SIZE,
    show: false,
    title: WINDOW_TITLE,
    ...(o.icon !== undefined ? { icon: o.icon } : {}),
    backgroundColor: backgroundFor(o.theme.resolved),
    webPreferences: {
      preload: o.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      additionalArguments: [encodeThemeArg(o.theme)],
    },
  })
  resetZoomOnLoad(win.webContents)
  if (o.showImmediately) win.show()
  else win.once('ready-to-show', () => win.show())

  const failed = (reason: string): void => {
    o.log.error('renderer failed to load', { reason })
    o.onLoadFailed?.(reason)
  }
  win.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
    // -3 (ABORTED) is a navigation replaced by another one (e.g. a reload), not a failure.
    if (isMainFrame && code !== -3) failed(`${description} (${code})`)
  })
  // The dev server's page, or the built renderer as app://harpoon/index.html (renderer-files.ts).
  const load = win.loadURL(o.target.url)
  // did-fail-load reports the same failure; the promise is only kept from going unhandled.
  load.catch(() => undefined)
  return win
}

/** What the zoom needs of a window's webContents. */
export interface ZoomTarget {
  getZoomFactor(): number
  setZoomFactor(factor: number): void
  on(event: 'zoom-changed', listener: (event: unknown, direction: 'in' | 'out') => void): unknown
  once(event: 'did-finish-load', listener: () => void): unknown
}

/** Zoom the page one step (a zoom key, a View menu item, a Ctrl+wheel notch). */
export function zoomPage(wc: Pick<ZoomTarget, 'getZoomFactor' | 'setZoomFactor'>, action: ZoomAction): void {
  const now = wc.getZoomFactor()
  const next = nextZoomFactor(now, action)
  if (next !== now) wc.setZoomFactor(next)
}

/** Each new window starts at 100% (Chromium remembers a level per origin across launches). */
export function resetZoomOnLoad(wc: Pick<ZoomTarget, 'getZoomFactor' | 'setZoomFactor' | 'once'>): void {
  wc.once('did-finish-load', () => {
    if (wc.getZoomFactor() !== 1) wc.setZoomFactor(1)
  })
}

/** Bring the window forward: restore, show and focus. */
export function revealWindow(win: BrowserWindow | null): void {
  if (win === null || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

