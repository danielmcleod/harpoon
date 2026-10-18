// `harpoon:cmd` registration (ipc.ts: sender check + zod → core handlers). The sender must be
// the main window's top frame showing the app's own renderer; everything after that is router.ts. The handler
// never throws: every path resolves to a Result.
import { ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { CMD_CHANNEL } from '@shared/ipc.ts'
import type { Router } from './router.ts'
import { senderAllowed } from './urls.ts'
import type { RendererTarget, SenderInfo } from './urls.ts'

export function describeSender(event: IpcMainInvokeEvent, win: BrowserWindow | null): SenderInfo {
  if (win === null || win.isDestroyed()) return { fromMainWindow: false, mainFrame: false, frameUrl: null }
  const frame = event.senderFrame
  const top = win.webContents.mainFrame
  return {
    fromMainWindow: event.sender === win.webContents,
    mainFrame:
      frame !== null && !frame.detached && frame.parent === null && frame.frameToken === top.frameToken,
    frameUrl: frame?.url ?? null,
  }
}

export function registerCommandIpc(o: {
  getWindow: () => BrowserWindow | null
  target: RendererTarget
  router: Router
}): () => void {
  ipcMain.handle(CMD_CHANNEL, (event, raw: unknown) => {
    let ok: boolean
    try {
      ok = senderAllowed(describeSender(event, o.getWindow()), o.target)
    } catch {
      ok = false
    }
    return o.router(ok, raw)
  })
  return () => ipcMain.removeHandler(CMD_CHANNEL)
}
