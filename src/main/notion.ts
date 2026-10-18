// Notion from the main process: the Notion-ready export (a zip of pages for Notion's Markdown import), the
// integration token (encrypted with the OS keychain via safeStorage, never written in clear), and attaching the
// share bundle to the team's page through Notion's API.
import { withoutNotes } from '@shared/model/governance.ts'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { Core } from '@core/app-core.ts'
import { HarpoonError } from '@core/errors.ts'
import { bundleEntries } from '@core/export/bundle.ts'
import { attachFileToPage } from '@core/export/notion-api.ts'
import { notionSections, notionZip } from '@core/export/notion.ts'
import { zip } from '@core/export/zip.ts'
import { listCollection } from '@core/project/collections.ts'
import { notesIndex, readNote } from '@core/project/notes.ts'
import { getPublish, logPublish, notionPageId } from '@core/project/publish.ts'
import type { ExportView, NoteDoc } from '@shared/ipc.ts'

const tokenFile = (core: Core): string => join(core.paths.home, 'notion-token.bin')

export async function notionToken(core: Core): Promise<string | null> {
  try {
    const enc = await readFile(tokenFile(core))
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(enc) : null
  } catch {
    return null
  }
}

/** OS-backed encryption only (Linux's "basic_text" fallback uses a hard-coded key). */
export function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

export async function setNotionToken(core: Core, token: string | null): Promise<{ hasToken: boolean }> {
  if (token === null) {
    await rm(tokenFile(core), { force: true })
    return { hasToken: false }
  }
  if (!canEncrypt()) throw new HarpoonError('UNSUPPORTED', 'This system has no secure storage (a keychain or keyring) for the token, so it is not saved.')
  await writeFile(tokenFile(core), safeStorage.encryptString(token.trim()), { mode: 0o600 })
  return { hasToken: true }
}

async function notesFor(root: string): Promise<NoteDoc[]> {
  const idx = await notesIndex(root)
  const paths = [...(idx.project !== null ? ['project.md'] : []), ...idx.series.flatMap((s) => s.entries.map((e) => e.path))]
  return (await Promise.all(paths.map((p) => readNote(root, p).catch(() => null)))).filter((d): d is NoteDoc => d !== null)
}

/** The share bundle as zip bytes (what the Notion page gets attached). */
async function bundleBytes(core: Core, view: ExportView, viewerHtml: string | null): Promise<{ name: string; bytes: Buffer }> {
  const s = core.projects.require()
  await s.flush()
  const entries = await bundleEntries({ model: s.model, root: s.root, view, viewerHtml })
  return { name: `${s.model.meta.name.replace(/[^\w.-]+/g, '-')}-harpoon.zip`, bytes: zip(entries) }
}

/** The Notion import zip: pages, the diagram (PNG from the renderer) and the share bundle. */
export async function notionExport(core: Core, view: ExportView, png: string | null, viewerHtml: string | null): Promise<Buffer> {
  const s = core.projects.require()
  const decisions = await listCollection(s.root, 'decisions')
  const notes = view.includeNotes ? await notesFor(s.root) : null
  const bundle = await bundleBytes(core, view, viewerHtml)
  const sections = notionSections({ model: view.includeNotes ? s.model : withoutNotes(s.model), decisions, notes, diagram: png !== null ? 'diagram.png' : null, bundle: bundle.name, date: new Date().toISOString().slice(0, 10) })
  const extras = [...(png !== null ? [{ name: 'diagram.png', data: Buffer.from(png, 'base64') }] : []), { name: bundle.name, data: bundle.bytes }]
  return zip(notionZip(sections, extras))
}

export async function attachBundle(core: Core, view: ExportView, viewerHtml: string | null): Promise<{ filename: string }> {
  const token = await notionToken(core)
  if (token === null) throw new HarpoonError('VALIDATION', 'Add a Notion integration token first (Project settings → Notion).')
  const s = core.projects.require()
  const pub = await getPublish(s.root)
  const pageId = notionPageId(pub.notion.pageUrl)
  if (pageId === null) throw new HarpoonError('VALIDATION', 'Set the Notion page to publish to first (Project settings → Notion).')
  const b = await bundleBytes(core, view, viewerHtml)
  await attachFileToPage({ fetch, token, pageId, filename: b.name, contentType: 'application/zip', bytes: b.bytes, caption: `Harpoon share bundle, ${new Date().toISOString().slice(0, 10)}` })
  await logPublish(s.root, 'api', `Attached ${b.name}`)
  return { filename: b.name }
}
