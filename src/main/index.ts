// Electron main entry. Before ready: app:// scheme → home → userData under HARPOON_HOME → AUMID → single-instance
// lock → createCore. On ready: hardening, renderer files, menu, theme, push, IPC router, window.
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { confined } from '@core/project/confine.ts'
import { listCollection } from '@core/project/collections.ts'
import type { ExportView } from '@shared/ipc.ts'
import { bundleEntries } from '@core/export/bundle.ts'
import { zip } from '@core/export/zip.ts'
import { buildViewerHtml } from './viewer.ts'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, dialog, nativeTheme, protocol, shell } from 'electron'
import { attachBundle, canEncrypt, notionExport, notionToken, setNotionToken } from './notion.ts'
import type { BrowserWindow, OpenDialogOptions, SaveDialogOptions, SaveDialogReturnValue } from 'electron'
import { createCore } from '@core/app-core.ts'
import { runMcpBridge } from '@core/ai/mcp-bridge.ts'
import { withoutNotes } from '@shared/model/governance.ts'
import type { Core } from '@core/app-core.ts'
import { HarpoonError, errorMessage } from '@core/errors.ts'
import { homePaths, resolveHome } from '@core/home.ts'
import { createLogger } from '@core/log.ts'
import type { Logger } from '@core/log.ts'
import { parseRequest } from '@shared/ipc-schemas.ts'
import type { AppInfo, Platform } from '@shared/ipc.ts'
import { IPC_PROTOCOL } from '@shared/ipc.ts'
import { APP_ID, QUIT_BUDGET_MS } from './constants.ts'
import { registerCommandIpc } from './ipc.ts'
import { installAppMenu, installWindowKeys } from './menu.ts'
import { PushSink } from './push.ts'
import { installRendererFiles, registerAppScheme } from './renderer-files.ts'
import { createRouter } from './router.ts'
import type { MainHandlers } from './router.ts'
import { installHardening } from './security.ts'
import { ThemeController, backgroundFor } from './theme.ts'
import { allowedExternalUrl, rendererTarget } from './urls.ts'
import type { RendererTarget } from './urls.ts'
import { createMainWindow, revealWindow } from './window.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** Outside agents' stdio bridge: this executable with --mcp (in development, Electron plus the app folder). */
function bridgeCommand(): { command: string; args: string[] } {
  return { command: process.execPath, args: app.isPackaged ? ['--mcp'] : [app.getAppPath(), '--mcp'] }
}
let mainWindow: BrowserWindow | null = null

async function boot(): Promise<void> {
  // `Harpoon --mcp`: a stdio MCP bridge for outside agents, with no window and no single-instance lock (the app the
  // bridge talks to is the running one).
  if (process.argv.includes('--mcp')) {
    // Electron's process.stdin delivers nothing from a pipe on Windows; the inherited handle (fd 0) does.
    const input = createReadStream('', { fd: 0, autoClose: false })
    const code = await runMcpBridge({ stateFile: homePaths(resolveHome()).state, input, output: process.stdout })
    app.exit(code)
    return
  }
  registerAppScheme(protocol)
  const home = resolveHome()
  const paths = homePaths(home)
  app.setPath('userData', paths.electronUserData)
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => revealWindow(mainWindow))

  const log = createLogger({ file: paths.mainLog, console: !app.isPackaged, scope: 'main' })
  process.on('uncaughtException', (err) => log.error('uncaught exception', { err: errorMessage(err) }))
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err: errorMessage(err) }))

  const core = await createCore({ home, log: log.child('core'), bridge: bridgeCommand() })
  await app.whenReady()
  onReady(core, log)
}

function onReady(core: Core, log: Logger): void {
  const target: RendererTarget = rendererTarget({
    devUrl: process.env['ELECTRON_RENDERER_URL'],
    packaged: app.isPackaged,
    rendererDir: join(here, '../renderer'),
  })
  const openExternal = (url: string): void => {
    shell.openExternal(url).catch((err: unknown) => log.warn('openExternal failed', { err: errorMessage(err) }))
  }
  installHardening({ target, openExternal, log })
  installRendererFiles({ target, protocol, readFile: (p) => readFile(p), log })
  installAppMenu(process.platform)

  const push = new PushSink(() => (mainWindow?.isDestroyed() === false ? mainWindow.webContents : null))
  core.bus.on((e) => push.push(e))

  const theme = new ThemeController({
    native: nativeTheme,
    initial: core.state.state.theme,
    onChange: (s) => {
      mainWindow?.setBackgroundColor(backgroundFor(s.resolved))
      core.bus.emit({ kind: 'theme', theme: s })
    },
  })

  /** The self-contained HTML viewer of the open project. */
  const viewerHtml = async (view: ExportView): Promise<string> => {
    const session = core.projects.require()
    const template = await readFile(join(here, '../viewer/viewer.html'), 'utf8').catch(() => {
      throw new HarpoonError('UNSUPPORTED', 'The viewer is not built (run pnpm build).')
    })
    const views = await listCollection(session.root, 'views')
    const decisions = await listCollection(session.root, 'decisions')
    const project = session.view()
    // The viewer is made to be shared: the model only, not this machine's path or the undo history.
    const shared = { root: '', version: project.version, model: view.includeNotes === true ? project.model : withoutNotes(project.model), history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, undo: [], redo: [] } }
    return buildViewerHtml(template, join(here, '../viewer'), { project: shared, view, views, decisions })
  }

  const saveDialog = (opts: SaveDialogOptions): Promise<SaveDialogReturnValue> =>
    mainWindow !== null ? dialog.showSaveDialog(mainWindow, opts) : dialog.showSaveDialog(opts)

  const main: MainHandlers = {
    'app.info': () => Promise.resolve(appInfo(core)),
    'dialog.pickFile': async (req) => {
      const opts: OpenDialogOptions = {
        properties: ['openFile'],
        ...(req.title !== undefined ? { title: req.title } : {}),
        ...(req.filters !== undefined ? { filters: req.filters } : {}),
      }
      const r = mainWindow !== null ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    'dialog.pickFolder': async (req) => {
      const opts: OpenDialogOptions = {
        properties: ['openDirectory', 'createDirectory'],
        ...(req.defaultPath !== undefined ? { defaultPath: req.defaultPath } : {}),
        ...(req.title !== undefined ? { title: req.title } : {}),
      }
      const r = mainWindow !== null ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    'mcp.addToEditor': async (req) => {
      // The install link carries only Harpoon's own bridge command (never text from the page).
      const config = bridgeCommand()
      const url =
        req.editor === 'vscode'
          ? `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'harpoon', type: 'stdio', ...config }))}`
          : `cursor://anysphere.cursor-deeplink/mcp/install?name=harpoon&config=${encodeURIComponent(Buffer.from(JSON.stringify(config)).toString('base64'))}`
      await shell.openExternal(url)
    },
    'shell.open': async (req) => {
      if (req.target === 'url') {
        const url = allowedExternalUrl(req.url)
        if (url === null) throw new HarpoonError('FORBIDDEN', 'That link is not on the allowlist.')
        await shell.openExternal(url)
        return
      }
      if (req.target === 'file') {
        // Files are only ever shown in their folder: opening one would let the OS run it.
        shell.showItemInFolder(req.path)
        return
      }
      const path = req.target === 'home' ? core.paths.home : req.path
      // Folders only: a "folder" that is really a file (a script, a shortcut) is never handed to the shell.
      const st = await stat(path).catch(() => null)
      if (st === null || !st.isDirectory()) throw new HarpoonError('NOT_FOUND', 'That folder does not exist.')
      const err = await shell.openPath(path)
      if (err !== '') throw new HarpoonError('NOT_FOUND', err)
    },
    'evidence.reveal': async (req) => {
      const session = core.projects.require()
      let base = session.root
      if (req.repo !== null) {
        const r = await core.invoke('repo.resolve', undefined)
        const hit = r.ok ? (r.value as { id: string; path: string | null }[]).find((x) => x.id === req.repo) : undefined
        if (hit?.path == null) throw new HarpoonError('NOT_FOUND', 'That repository is not cloned on this machine (Project settings → Repositories).')
        base = hit.path
      }
      shell.showItemInFolder(await confined(base, req.path))
    },
    'log.write': (req) => {
      const data = req.data === undefined ? undefined : { data: req.data }
      log.child('renderer')[req.level](req.msg, data)
      return Promise.resolve()
    },
    'export.save': async (req) => {
      const ext = req.filename.split('.').pop() ?? ''
      const r = await saveDialog({
        defaultPath: join(core.projects.session?.root ?? app.getPath('documents'), req.filename),
        ...(ext !== '' ? { filters: [{ name: ext.toUpperCase(), extensions: [ext] }] } : {}),
      })
      if (r.canceled || r.filePath === undefined) return null
      if (req.base64 !== undefined) await writeFile(r.filePath, Buffer.from(req.base64, 'base64'))
      else await writeFile(r.filePath, req.content ?? '', 'utf8')
      return r.filePath
    },
    'export.bundle': async (req) => {
      const session = core.projects.require()
      await session.flush()
      const html = await viewerHtml(req.view).catch(() => null)
      const entries = await bundleEntries({ model: session.model, root: session.root, view: req.view, viewerHtml: html })
      const name = `${session.model.meta.name.replace(/[^\w.-]+/g, '-')}.zip`
      const r = await saveDialog({ defaultPath: join(session.root, name), filters: [{ name: 'Zip', extensions: ['zip'] }] })
      if (r.canceled || r.filePath === undefined) return null
      await writeFile(r.filePath, zip(entries))
      return r.filePath
    },
    'export.viewer': async (req) => {
      const session = core.projects.require()
      const html = await viewerHtml(req.view)
      const name = `${session.model.meta.name.replace(/[^\w.-]+/g, '-')}-viewer.html`
      const r = await saveDialog({ defaultPath: join(session.root, name), filters: [{ name: 'HTML', extensions: ['html'] }] })
      if (r.canceled || r.filePath === undefined) return null
      await writeFile(r.filePath, html, 'utf8')
      return r.filePath
    },
    'export.notion': async (req) => {
      const session = core.projects.require()
      const html = await viewerHtml(req.view).catch(() => null)
      const bytes = await notionExport(core, req.view, req.png, html)
      const name = `${session.model.meta.name.replace(/[^\w.-]+/g, '-')}-notion.zip`
      const r = await saveDialog({ defaultPath: join(session.root, name), filters: [{ name: 'Zip', extensions: ['zip'] }] })
      if (r.canceled || r.filePath === undefined) return null
      await writeFile(r.filePath, bytes)
      return r.filePath
    },
    'notion.setToken': (req) => setNotionToken(core, req.token),
    'notion.tokenStatus': async () => ({ hasToken: (await notionToken(core)) !== null, canEncrypt: canEncrypt() }),
    'notion.attachBundle': async (req) => attachBundle(core, req.view, await viewerHtml(req.view).catch(() => null)),
    'state.get': () => Promise.resolve(core.state.state),
    'state.set': async (req) => {
      const next = await core.state.patch(req)
      if (req.theme !== undefined) theme.set(req.theme)
      return next
    },
  }

  const router = createRouter({
    parse: parseRequest,
    main,
    core: (cmd, req) => core.invoke(cmd, req),
    onFailure: (cmd, cid, error) => log.warn('command failed', { cmd, cid, code: error.code, msg: error.message }),
  })
  registerCommandIpc({ getWindow: () => mainWindow, target, router })

  const quit = (): void => app.quit()
  const open = (): void => {
    mainWindow = createMainWindow({
      preload: join(here, '../preload/index.cjs'),
      icon: join(here, '../renderer/icon.png'),
      target,
      theme: theme.state,
      showImmediately: false,
      log,
    })
    installWindowKeys(mainWindow, { platform: process.platform, packaged: app.isPackaged, quit })
    mainWindow.on('closed', () => {
      mainWindow = null
    })
  }
  open()

  app.on('activate', () => {
    if (mainWindow === null) open()
    else revealWindow(mainWindow)
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    quitting = true
    e.preventDefault()
    push.flush()
    push.dispose()
    const timer = setTimeout(() => app.exit(0), QUIT_BUDGET_MS)
    void core.shutdown().finally(() => {
      clearTimeout(timer)
      app.exit(0)
    })
  })
}

function appInfo(core: Core): AppInfo {
  return {
    name: 'Harpoon',
    version: app.getVersion(),
    platform: process.platform as Platform,
    arch: process.arch,
    versions: {
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      node: process.versions.node,
    },
    home: core.paths.home,
    packaged: app.isPackaged,
    ipcProtocol: IPC_PROTOCOL,
  }
}

boot().catch((err: unknown) => {
  console.error('Harpoon failed to start', err)
  dialog.showErrorBox('Harpoon failed to start', errorMessage(err))
  app.exit(1)
})
