// Where the renderer may come from, which IPC senders are trusted, which permissions it gets and which links may open
// externally (boot hardening, the IPC sender check). Pure: no Electron, so the rules are
// unit-tested.
import { resolve, sep } from 'node:path'
import { allowedExternalUrl as sharedAllowedExternalUrl } from '@shared/external-links.ts'
import { EXTERNAL_HOSTS } from './constants.ts'

/**
 * The built renderer's origin (the renderer on app://): main registers `app` as a privileged
 * standard, secure scheme before ready and answers app://harpoon/<file> from out/renderer (renderer-files.ts). The
 * window loads APP_INDEX_URL; the routes live in its hash.
 */
export const APP_SCHEME = 'app'
export const APP_HOST = 'harpoon'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`

/** Dev: the electron-vite server; built: out/renderer (`dir`), served as app://harpoon/. */
export type RendererTarget =
  { kind: 'url'; url: string; origin: string } | { kind: 'app'; dir: string; url: string; origin: string }

/**
 * The dev server URL counts only for an unpackaged app and only when it is http(s): a packaged build never loads a
 * page an environment variable points at.
 */
export function rendererTarget(o: {
  devUrl: string | undefined
  packaged: boolean
  rendererDir: string
}): RendererTarget {
  if (!o.packaged && o.devUrl !== undefined && o.devUrl.trim() !== '') {
    const u = parseUrl(o.devUrl.trim())
    if (u !== null && (u.protocol === 'http:' || u.protocol === 'https:')) {
      return { kind: 'url', url: u.href, origin: u.origin }
    }
  }
  return { kind: 'app', dir: resolve(o.rendererDir), url: APP_INDEX_URL, origin: APP_ORIGIN }
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function foldCase(p: string, platform: NodeJS.Platform): string {
  return platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p
}

/** `child` is `dir` or inside it (case-insensitive on Windows/macOS). */
export function isInsideDir(
  child: string,
  dir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const c = foldCase(resolve(child), platform)
  const d = foldCase(resolve(dir), platform)
  return c === d || c.startsWith(d.endsWith(sep) ? d : d + sep)
}

/**
 * An app://harpoon URL: no user, no port, the host in any case. Chromium lower-cases a standard scheme's host;
 * Node's URL keeps a custom scheme's host as written and gives it an opaque origin ("null"), so the parts are
 * compared instead of `origin`.
 */
export function isAppOriginUrl(u: URL): boolean {
  return (
    u.protocol === `${APP_SCHEME}:` &&
    u.hostname.toLowerCase() === APP_HOST &&
    u.port === '' &&
    u.username === '' &&
    u.password === ''
  )
}

/** A URL of the app's own renderer: the dev origin, or the built renderer's app://harpoon origin. */
export function isAppUrl(raw: string, t: RendererTarget): boolean {
  const u = parseUrl(raw)
  if (u === null) return false
  if (t.kind === 'url') return u.origin === t.origin
  return isAppOriginUrl(u)
}

/**
 * A navigation that replaces the app's own page (reload, crash reload): top frame, a new document, an app URL. A
 * navigation elsewhere (a dropped file) is blocked by the hardening, so the page stays and so must its push state.
 */
export function isAppDocumentLoad(
  nav: { url: string; isMainFrame: boolean; isSameDocument: boolean },
  t: RendererTarget,
): boolean {
  return nav.isMainFrame && !nav.isSameDocument && isAppUrl(nav.url, t)
}

export interface SenderInfo {
  /** event.sender is the main window's webContents. */
  fromMainWindow: boolean
  /** event.senderFrame is that window's top-level frame (not a subframe, not detached). */
  mainFrame: boolean
  /** The sender frame's URL (null when the frame is gone). */
  frameUrl: string | null
}

/** Only the main window's top frame showing the app's own renderer may send commands. */
export function senderAllowed(s: SenderInfo, t: RendererTarget): boolean {
  return s.fromMainWindow && s.mainFrame && s.frameUrl !== null && isAppUrl(s.frameUrl, t)
}

/** The only permission the renderer gets: navigator.clipboard.writeText, which every Copy button uses. */
export const RENDERER_PERMISSIONS: readonly string[] = ['clipboard-sanitized-write']

/**
 * A permission request or check is granted only for a permission on RENDERER_PERMISSIONS, asked by the top frame
 * of the app's own renderer. Clipboard reads, notifications, media and everything else stay denied.
 */
export function permissionAllowed(
  q: { permission: string; requestingUrl: string | null | undefined; isMainFrame: boolean },
  t: RendererTarget,
): boolean {
  if (!RENDERER_PERMISSIONS.includes(q.permission) || !q.isMainFrame) return false
  return q.requestingUrl != null && q.requestingUrl !== '' && isAppUrl(q.requestingUrl, t)
}

/**
 * The href to open in the default browser, or null: https only, a host on the allowlist (or its subdomain), no
 * credentials and no custom port. The rule lives in src/shared/external-links.ts, shared with core's `open_docs`.
 */
export function allowedExternalUrl(raw: string, hosts: readonly string[] = EXTERNAL_HOSTS): string | null {
  return sharedAllowedExternalUrl(raw, hosts)
}

/** Scheme + host of a URL for logs (never the path or query, which may carry data). */
export function urlForLog(raw: string): string {
  const u = parseUrl(raw)
  if (u === null) return '[invalid url]'
  return u.protocol === 'file:' ? 'file:' : `${u.protocol}//${u.host}`
}
