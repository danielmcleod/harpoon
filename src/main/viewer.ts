// Build the self-contained HTML viewer: the prebuilt viewer page (out/viewer) with its script and stylesheet inlined
// and the project embedded as JSON, so the file opens anywhere with no server, no network and no Harpoon install.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** JSON safe inside a <script> element (no `</script>`, no HTML comment openers, no line separators). */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

export async function buildViewerHtml(template: string, dir: string, data: unknown): Promise<string> {
  let html = template
  // <script type="module" crossorigin src="./assets/viewer-xyz.js"></script>
  for (const m of [...template.matchAll(/<script\b[^>]*\bsrc="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/g)]) {
    const js = await readFile(join(dir, m[1] ?? ''), 'utf8')
    // A literal </script> inside the bundle would end the inline element early.
    html = html.replace(m[0], () => `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`)
  }
  // <link rel="stylesheet" crossorigin href="./assets/viewer-xyz.css">
  for (const m of [...template.matchAll(/<link\b[^>]*\bhref="\.\/(assets\/[^"]+\.css)"[^>]*>/g)]) {
    const css = await readFile(join(dir, m[1] ?? ''), 'utf8')
    html = html.replace(m[0], () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
  }
  // <link rel="icon" type="image/svg+xml" href="./favicon.svg" /> (the build makes the path relative)
  for (const m of [...html.matchAll(/<link\b[^>]*\brel="icon"[^>]*\bhref="\.?\/(favicon\.svg)"[^>]*>/g)]) {
    const icon = await readFile(join(dir, m[1] ?? ''), 'utf8').catch(() => null)
    html = html.replace(m[0], () => (icon === null ? '' : `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}" />`))
  }
  html = html.replace(/<script id="harpoon-data" type="application\/json">null<\/script>/, () => `<script id="harpoon-data" type="application/json">${scriptJson(data)}</script>`)
  return html
}
