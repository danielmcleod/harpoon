// Application menu and window keys (close and quit; the UI control standards). macOS
// gets the standard app, Edit and Window menus (Cmd+Q → app.quit → before-quit → the quit path; Edit makes copy/paste
// work) and a View menu with the zoom items. Windows and Linux get no menu bar; Ctrl+Q is caught in the window's
// before-input-event and routed to the same quit path. The zoom keys (Ctrl/Cmd with + - 0) are caught there on every
// platform, so they zoom in the same steps whether a menu carries them or not. Unpackaged builds keep F12 for
// DevTools.
import { BrowserWindow, Menu } from 'electron'
import { keyAction } from './keys.ts'
import type { ZoomAction } from './keys.ts'
import { zoomPage } from './window.ts'

function zoomFocused(action: ZoomAction): void {
  const win = BrowserWindow.getFocusedWindow()
  if (win !== null && !win.isDestroyed()) zoomPage(win.webContents, action)
}

export function installAppMenu(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        // The accelerators only label the items: before-input-event (installWindowKeys) takes the keys first.
        submenu: [
          { label: 'Actual Size', accelerator: 'Cmd+0', click: () => zoomFocused('zoomReset') },
          { label: 'Zoom In', accelerator: 'Cmd+Plus', click: () => zoomFocused('zoomIn') },
          { label: 'Zoom Out', accelerator: 'Cmd+-', click: () => zoomFocused('zoomOut') },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  )
}

export function installWindowKeys(
  win: BrowserWindow,
  o: { platform: NodeJS.Platform; packaged: boolean; quit: () => void },
): void {
  win.webContents.on('before-input-event', (e, input) => {
    const action = keyAction(input, o)
    if (action === null) return
    e.preventDefault()
    if (action === 'quit') o.quit()
    else if (action === 'devtools') win.webContents.toggleDevTools()
    else zoomPage(win.webContents, action)
  })
}
