// The share bundle: everything someone needs to read, present or re-import the architecture, in one zip.
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { slugify } from '../../shared/model/ids.ts'
import type { ExportView } from '../../shared/ipc.ts'
import { withoutNotes } from '../../shared/model/governance.ts'
import { projectFileOf } from '../../shared/model/schema.ts'
import type { Model } from '../../shared/model/schema.ts'
import { HARPOON_DIRNAME } from '../project/files.ts'
import { renderExport } from './index.ts'
import type { ZipEntry } from './zip.ts'

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) out.push(p)
    }
  }
  await walk(dir)
  return out
}

/**
 * What of `.harpoon/` a share bundle carries: the model, layout, views, scenarios, table views, comparisons and
 * decision records, and notes only when asked. Never proposals (staged changes with working notes and AI evidence),
 * publish.json (internal Notion ids) or anything else that lands in the folder.
 */
export function sharedProjectFile(rel: string, includeNotes: boolean): boolean {
  const d = HARPOON_DIRNAME
  if ([`${d}/project.json`, `${d}/layout.json`, `${d}/README.md`].includes(rel)) return true
  if (new RegExp(`^${d}/(views|scenarios|tables|decisions|solutions)/[a-z0-9][a-z0-9._-]*\\.json$`).test(rel)) return true
  return includeNotes && new RegExp(`^${d}/notes/[a-z0-9][a-z0-9/._-]*\\.md$`).test(rel)
}

export async function bundleEntries(o: { model: Model; root: string; view: ExportView; viewerHtml: string | null }): Promise<ZipEntry[]> {
  const base = slugify(o.model.meta.name)
  const top = `${base}`
  const entries: ZipEntry[] = []
  // The project itself, as committed (open it with Harpoon: File → Open a folder → this folder).
  for (const f of await filesUnder(join(o.root, HARPOON_DIRNAME))) {
    const rel = relative(o.root, f).replace(/\\/g, '/')
    if (!sharedProjectFile(rel, o.view.includeNotes === true)) continue
    // Working notes stay out of a shared bundle unless asked for.
    const data = rel === `${HARPOON_DIRNAME}/project.json` && o.view.includeNotes !== true ? `${JSON.stringify(projectFileOf(withoutNotes(o.model)), null, 2)}\n` : await readFile(f)
    entries.push({ name: `${top}/${rel}`, data })
  }
  if (o.viewerHtml !== null) entries.push({ name: `${top}/${base}-viewer.html`, data: o.viewerHtml })
  const light: ExportView = { ...o.view, theme: 'light' }
  const dark: ExportView = { ...o.view, theme: 'dark' }
  const add = (format: Parameters<typeof renderExport>[1], v: ExportView, rename?: string): void => {
    const r = renderExport(o.model, format, v)
    if (r.content.trim() !== '') entries.push({ name: `${top}/exports/${rename ?? r.filename}`, data: r.content })
  }
  add('markdown', o.view)
  add('svg', dark, `${base}-dark.svg`)
  add('svg', light, `${base}-light.svg`)
  add('mermaid', o.view)
  add('mermaid-sequence', o.view)
  add('plantuml', o.view)
  add('drawio', o.view)
  add('interchange-json', o.view)
  add('json-schema', o.view)
  entries.push({
    name: `${top}/README.md`,
    data: [
      `# ${o.model.meta.name}`,
      '',
      o.model.meta.description,
      '',
      'Shared from Harpoon.',
      '',
      `- **${base}-viewer.html**: open in any browser for the interactive, read-only diagram (no install needed).`,
      '- **exports/ARCHITECTURE.md**: the written documentation.',
      '- **exports/*.svg / *.drawio / *.mmd / *.puml**: pictures and diagram code for docs and wikis.',
      '- **exports/*.topology.json**: the architecture as JSON for tools and LLMs (schema alongside).',
      '- **.harpoon/**: the Harpoon project. Open this folder in Harpoon to edit it.',
      '',
    ].join('\n'),
  })
  return entries
}
