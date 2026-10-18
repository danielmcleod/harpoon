// Serving the built renderer (the renderer on app://; no file:// reads; boot hardening). The window loads
// app://harpoon/index.html. Before ready, main registers `app` as a privileged
// scheme (APP_SCHEME_PRIVILEGES): standard, so the page has a real origin (relative URLs, 'self', its own storage) as
// on http; secure, so it is a secure context (navigator.clipboard, the Copy buttons); supportFetchAPI, so fetch() of
// its own files works. Main answers the scheme here, from out/renderer only: a built file goes out with its content
// type; anything else is refused, with no body. Every answer, a refusal included, carries the policy as a header
// (csp.ts RENDERER_CSP_HEADER, which adds frame-ancestors), nosniff and no-cache. Every request of the scheme comes through this handler, a worker's script and its imports included, so the
// Diff tab's highlighter workers get the policy from their own response (components/diff/highlighter.ts).
// file:// is refused to the window's session entirely: nothing of the app is served from it, and the
// grantFileProtocolExtraPrivileges fuse is off (electron-builder.yml). The dev server (an http URL) is left alone.
import { extname, resolve } from 'node:path'
import { RENDERER_CSP_HEADER } from './csp.ts'
import { APP_SCHEME, isAppOriginUrl, isInsideDir } from './urls.ts'
import type { RendererTarget } from './urls.ts'

/**
 * The app scheme's privileges (protocol.registerSchemesAsPrivileged, before ready). Nothing else: no bypassCSP, no
 * service workers, no CORS from other origins (the page only ever asks its own origin), no media streaming.
 */
export const APP_SCHEME_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true } as const

/** The part of Electron's `protocol` that registers schemes (before ready). */
export interface SchemeRegistry {
  registerSchemesAsPrivileged(schemes: { scheme: string; privileges: typeof APP_SCHEME_PRIVILEGES }[]): void
}

/** Register app:// (must run before the app is ready; every build, the dev server's included, does it). */
export function registerAppScheme(protocol: SchemeRegistry): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }])
}

/**
 * Content types of what a built renderer holds (anything else inside it goes out as bytes, which nosniff keeps from
 * running). Module scripts and module workers need a JavaScript type. The build has no .wasm: Shiki runs its
 * JavaScript regex engine (a test holds every built file to a known type).
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
}

/** The content type a built file is served with (application/octet-stream when the extension is not known). */
export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * One path segment of a built file, percent-decoded: what Vite writes (`index-CU7tUf8N.js`, `PatchView--7XsiFwe.js`)
 * and nothing that could name another file: no `.` or `..`, no separator of either kind, no `:` (an NTFS stream or a
 * drive), no `%`, space, `$` or control character. A test holds every file of the build to it.
 */
const FILE_NAME = /^[A-Za-z0-9_~+@-][A-Za-z0-9_~+@.-]*$/
/** Windows device names, which name no file whatever follows the dot (`NUL`, `con.js`, `COM1`). */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i

/** A segment a built file can have: FILE_NAME, no trailing dot (Windows drops it), no device name. */
export function isSafeFileName(name: string): boolean {
  return FILE_NAME.test(name) && !name.endsWith('.') && !DEVICE_NAME.test(name)
}

export type RendererFileDecision =
  | { kind: 'serve'; path: string; contentType: string }
  | { kind: 'refuse'; status: 400 | 403 | 404; reason: string }

/**
 * What an app:// request gets: a file inside the built renderer folder is served. Another scheme or host, an
 * unsafe or encoded name (a separator, `..`, a stream, a device), the folder itself and anything unparseable are
 * refused. Chromium has already resolved `.` and `..` (also as %2e) and turned `\` into `/` in a standard URL, and
 * Node's URL does the same for the dot segments, so a traversal can only reach this point encoded, as one segment.
 */
export function rendererFileFor(
  url: string,
  dir: string,
  platform: NodeJS.Platform = process.platform,
): RendererFileDecision {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { kind: 'refuse', status: 400, reason: 'not a URL' }
  }
  if (u.protocol !== `${APP_SCHEME}:`) return { kind: 'refuse', status: 404, reason: 'another scheme' }
  if (!isAppOriginUrl(u)) return { kind: 'refuse', status: 403, reason: 'another host' }
  if (u.pathname === '' || u.pathname === '/') return { kind: 'refuse', status: 404, reason: 'no file named' }
  if (!u.pathname.startsWith('/')) return { kind: 'refuse', status: 400, reason: 'not a path' }
  const names: string[] = []
  for (const raw of u.pathname.slice(1).split('/')) {
    let name: string
    try {
      name = decodeURIComponent(raw)
    } catch {
      return { kind: 'refuse', status: 400, reason: 'a malformed escape' }
    }
    if (!isSafeFileName(name)) return { kind: 'refuse', status: 403, reason: 'an unsafe path' }
    names.push(name)
  }
  const path = resolve(dir, ...names)
  // Inside the folder, and not the folder itself (the names above cannot leave it; this holds whatever they become).
  if (!isInsideDir(path, dir, platform) || isInsideDir(dir, path, platform)) {
    return { kind: 'refuse', status: 403, reason: 'outside the renderer' }
  }
  return { kind: 'serve', path, contentType: contentTypeOf(path) }
}

/**
 * The headers of every answer main gives the window's session for app:// and file://, a refusal included: the
 * policy, nosniff and no-cache (a refusal has no body, so they only keep the record simple and nothing cached).
 */
export function rendererBaseHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': RENDERER_CSP_HEADER,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  }
}

/** The response headers of a served renderer file: its content type and rendererBaseHeaders. */
export function rendererFileHeaders(contentType: string): Record<string, string> {
  return { 'Content-Type': contentType, ...rendererBaseHeaders() }
}

/** A refusal: no body, the base headers (and any extra, such as Allow). */
function refusal(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...rendererBaseHeaders(), ...extra } })
}

/** The part of Electron's `protocol` this module uses. */
export interface ProtocolLike {
  handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void
}

export interface RendererFilesOptions {
  target: RendererTarget
  protocol: ProtocolLike
  /** fs.promises.readFile (asar-aware in Electron's main process). */
  readFile: (path: string) => Promise<Uint8Array>
  log: { warn(msg: string, data?: Record<string, unknown>): void }
  platform?: NodeJS.Platform
}

/**
 * The window's session: file:// refused whatever the target, and app:// answered from the built renderer (true) unless
 * the renderer comes from the dev server (false: nothing to serve).
 */
export function installRendererFiles(o: RendererFilesOptions): boolean {
  o.protocol.handle('file', () => {
    o.log.warn('refused a file request', { reason: 'file:// is not served' })
    return refusal(403)
  })
  const target = o.target
  if (target.kind !== 'app') return false
  const platform = o.platform ?? process.platform
  o.protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return refusal(405, { Allow: 'GET, HEAD' })
    }
    const d = rendererFileFor(request.url, target.dir, platform)
    if (d.kind === 'refuse') {
      o.log.warn('refused an app request', { reason: d.reason })
      return refusal(d.status)
    }
    let body: Uint8Array
    try {
      body = await o.readFile(d.path)
    } catch {
      return refusal(404)
    }
    const headers = rendererFileHeaders(d.contentType)
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers })
  })
  return true
}
