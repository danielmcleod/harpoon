// The renderer's Content-Security-Policy (boot hardening): one
// policy for the built page's <meta> (electron.vite.config.ts) and for the header main sends with every file of the
// built renderer (renderer-files.ts). Pure: no Electron, no Node.
//
// Scripts come only from the app's own files: no eval, no inline script, no data: script, and Shiki runs its
// JavaScript regex engine, so no 'wasm-unsafe-eval'. Workers: a worker reads its policy from its script's response,
// never from the page. The built renderer is served on app://, so the Diff tab's highlighter
// workers start from their bundled file and get this policy from its header; worker-src is the app's own files only.
// *(over file:// a worker script came without the header, so the workers started from a blob:
// module, and worker-src allowed blob:.)* No frames, plugins, forms or <base>. Styles keep 'unsafe-inline':
// @pierre/diffs lays a diff out with inline style attributes and a <style> element in its shadow root; nothing the
// page loads can leave the app (img, font and connect are the app's own files, data: and blob: only), so inline CSS
// cannot carry data out. Dropping it needs a diff renderer without inline styles.

export const RENDERER_CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
]

/** The policy in the built index.html's <meta http-equiv="Content-Security-Policy">. */
export const RENDERER_CSP = RENDERER_CSP_DIRECTIVES.join('; ')

/** The header form adds what a <meta> policy cannot carry: no page may frame the app. */
export const RENDERER_CSP_HEADER = `${RENDERER_CSP}; frame-ancestors 'none'`

/** A policy's directives by name, each with its source list (lower-cased names, sources as written). */
export function parseCsp(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const words = part
      .trim()
      .split(/\s+/)
      .filter((w) => w !== '')
    const name = words[0]?.toLowerCase()
    if (name === undefined || out.has(name)) continue
    out.set(name, words.slice(1))
  }
  return out
}
