// A blank window for scripts/make-icons.mjs to render the logo in (driven through Playwright's Electron support).
const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { sandbox: true } })
  void win.loadURL('about:blank')
})
