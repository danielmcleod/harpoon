// The note taker's files: `.harpoon/notes/project.md` (the project notebook) and one folder per meeting series
// (`.harpoon/notes/<series>/_series.md` plus one `<yyyy-mm-dd>.md` per meeting). Markdown with YAML front matter, so
// they read well on GitHub and in any editor. Tasks are `- [ ]` lines; mentions are `[@Name](harpoon:node/<id>)`.
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import { HarpoonError } from '../errors.ts'
import type { NoteDoc, NoteFrontMatter, NoteIndex, NoteMeta, NoteTask } from '../../shared/ipc.ts'
import { NOTE_ACTIONS, NOTE_ITEM_KINDS } from '../../shared/ipc.ts'
import { HARPOON_DIRNAME } from './files.ts'

const NoteItemZ = z.object({
  id: z.string().max(40),
  kind: z.enum(NOTE_ITEM_KINDS).catch('task'),
  text: z.string().max(2000),
  action: z.enum(NOTE_ACTIONS).catch('none'),
  done: z.boolean().default(false),
})
const FrontZ = z.object({
  title: z.string().max(300).catch('Untitled'),
  date: z.string().max(20).nullable().catch(null).default(null),
  attendees: z.array(z.string().max(200)).max(100).catch([]).default([]),
  summary: z.string().max(20_000).catch('').default(''),
  items: z.array(NoteItemZ).max(200).catch([]).default([]),
  cadence: z.string().max(100).nullable().catch(null).default(null),
})

export const notesDir = (root: string): string => join(root, HARPOON_DIRNAME, 'notes')
const SERIES_FILE = '_series.md'

/** `project.md` or `<series>/<file>.md` only: no escaping the notes folder. */
export function safeNotePath(path: string): string {
  const p = path.replace(/\\/g, '/')
  if (!/^(project\.md|[a-z0-9][a-z0-9-]{0,60}\/(_series|\d{4}-\d{2}-\d{2}(-\d+)?)\.md)$/.test(p)) throw new HarpoonError('VALIDATION', `Not a note path: ${path}`)
  return p
}

export function parseNote(text: string): { meta: NoteFrontMatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  let raw: unknown = {}
  if (m !== null) {
    try {
      raw = parse(m[1] ?? '') ?? {}
    } catch {
      raw = {}
    }
  }
  const meta = FrontZ.parse(raw)
  return { meta, body: m === null ? text : text.slice(m[0].length).replace(/^\r?\n/, '') }
}

export function serializeNote(meta: NoteFrontMatter, body: string): string {
  // Only what is set, so hand-written notes stay tidy.
  const fm: Record<string, unknown> = { title: meta.title }
  if (meta.date !== null) fm['date'] = meta.date
  if (meta.cadence !== null) fm['cadence'] = meta.cadence
  if (meta.attendees.length > 0) fm['attendees'] = meta.attendees
  if (meta.summary.trim() !== '') fm['summary'] = meta.summary
  if (meta.items.length > 0) fm['items'] = meta.items
  return `---\n${stringify(fm, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.replace(/^\n+/, '')}`
}

/** `- [ ] text` / `- [x] text` lines, with their line numbers (0-based) and an optional `due:yyyy-mm-dd`. */
export function tasksIn(body: string): { line: number; text: string; done: boolean; due: string | null }[] {
  const out: { line: number; text: string; done: boolean; due: string | null }[] = []
  body.split(/\r?\n/).forEach((l, i) => {
    const m = /^\s*[-*] \[( |x|X)\] (.+)$/.exec(l)
    if (m === null || (m[2] ?? '').trim() === '') return
    const text = (m[2] ?? '').trim()
    out.push({ line: i, text, done: m[1] !== ' ', due: /\bdue:(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1] ?? null })
  })
  return out
}

/** Entity ids mentioned as `harpoon:<kind>/<id>` links. */
export function mentionsIn(body: string): string[] {
  return [...new Set([...body.matchAll(/\]\(harpoon:(?:node|connector|decision|set)\/([a-z0-9][a-z0-9._-]*)\)/g)].map((m) => m[1] ?? ''))].filter(Boolean)
}

/**
 * Refuse a note path when anything on the way is a link: `.harpoon`, `notes`, the series folder or the file. A
 * repository can hold symlinks, and a note that is really `~/.aws/credentials` must never be read, written,
 * sent to the AI or deleted (recursively, for a series).
 */
async function assertNoLinks(root: string, rel: string): Promise<void> {
  const parts = [HARPOON_DIRNAME, 'notes', ...rel.split('/')]
  let cur = root
  for (const part of parts) {
    cur = join(cur, part)
    const st = await lstat(cur).catch(() => null)
    if (st === null) return // not there yet (writing a new note): nothing to follow
    if (st.isSymbolicLink()) throw new HarpoonError('FORBIDDEN', 'Notes cannot be read or written through a link.')
  }
}

async function readDoc(root: string, path: string): Promise<NoteDoc | null> {
  try {
    await assertNoLinks(root, safeNotePath(path))
    const text = await readFile(join(notesDir(root), safeNotePath(path)), 'utf8')
    const { meta, body } = parseNote(text)
    return { path, meta, body }
  } catch {
    return null
  }
}

export async function readNote(root: string, path: string): Promise<NoteDoc> {
  const d = await readDoc(root, path)
  if (d === null) throw new HarpoonError('NOT_FOUND', 'That note does not exist.')
  return d
}

export async function writeNote(root: string, path: string, meta: NoteFrontMatter, body: string): Promise<void> {
  const file = join(notesDir(root), safeNotePath(path))
  await assertNoLinks(root, safeNotePath(path))
  await mkdir(dirname(file), { recursive: true })
  await assertNoLinks(root, safeNotePath(path))
  await writeFile(file, serializeNote(meta, body), 'utf8')
}

export async function deleteNote(root: string, path: string): Promise<void> {
  const p = safeNotePath(path)
  await assertNoLinks(root, p)
  if (p.endsWith(SERIES_FILE)) await rm(join(notesDir(root), dirname(p)), { recursive: true, force: true })
  else await rm(join(notesDir(root), p), { force: true })
}

const metaOf = (d: NoteDoc): NoteMeta => ({
  path: d.path,
  title: d.meta.title,
  date: d.meta.date,
  openTasks: tasksIn(d.body).filter((t) => !t.done).length,
  items: d.meta.items.length,
})

/** All notebooks: the project notebook and every series with its meetings (newest first). */
export async function notesIndex(root: string): Promise<NoteIndex> {
  const dir = notesDir(root)
  // The notes folder itself must be a real folder (series folders that are links are skipped: isDirectory is false).
  if ((await assertNoLinks(root, '').then(() => false, () => true)) === true) return { project: null, series: [] }
  const project = await readDoc(root, 'project.md')
  const series: NoteIndex['series'] = []
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(e.name)) continue
    const head = await readDoc(root, `${e.name}/${SERIES_FILE}`)
    const files = (await readdir(join(dir, e.name)).catch(() => [] as string[])).filter((f) => /^\d{4}-\d{2}-\d{2}(-\d+)?\.md$/.test(f)).sort().reverse()
    const entries: NoteMeta[] = []
    for (const f of files) {
      const d = await readDoc(root, `${e.name}/${f}`)
      if (d !== null) entries.push(metaOf(d))
    }
    series.push({ id: e.name, title: head?.meta.title ?? e.name, cadence: head?.meta.cadence ?? null, attendees: head?.meta.attendees ?? [], description: head?.body.trim() ?? '', entries })
  }
  return { project: project === null ? null : metaOf(project), series: series.sort((a, b) => a.title.localeCompare(b.title)) }
}

/** Open (and done) tasks across every note, and which notes mention which entities. */
export async function notesTasksAndMentions(root: string): Promise<{ tasks: NoteTask[]; mentions: Record<string, { path: string; title: string }[]> }> {
  const idx = await notesIndex(root)
  const paths = [...(idx.project !== null ? ['project.md'] : []), ...idx.series.flatMap((s) => s.entries.map((e) => e.path))]
  const tasks: NoteTask[] = []
  const mentions: Record<string, { path: string; title: string }[]> = {}
  for (const p of paths) {
    const d = await readDoc(root, p)
    if (d === null) continue
    for (const t of tasksIn(d.body)) tasks.push({ path: p, title: d.meta.title, date: d.meta.date, ...t })
    for (const id of mentionsIn(d.body)) (mentions[id] ??= []).push({ path: p, title: d.meta.title })
  }
  return { tasks, mentions }
}

// Built from lines so the empty bullet and task keep their trailing space (editors strip it from source).
const BLANK_TASK = '- [ ] '
export const MEETING_TEMPLATE = ['## Attendees', '', '## Agenda', '- ', '', '## Discussion', '', '## Decisions', '', '## Action items', BLANK_TASK, ''].join('\n')

export async function createSeries(root: string, o: { title: string; cadence: string | null; attendees: string[]; description: string }): Promise<string> {
  const base = o.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'meetings'
  const existing = new Set((await readdir(notesDir(root), { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name))
  let id = base
  for (let i = 2; existing.has(id); i++) id = `${base}-${i}`
  await writeNote(root, `${id}/${SERIES_FILE}`, { title: o.title, date: null, attendees: o.attendees, summary: '', items: [], cadence: o.cadence }, o.description)
  return id
}

/**
 * A new meeting in a series: the meeting template, the series' usual attendees, and the open action items of the
 * previous meeting carried over (so nothing is dropped between meetings).
 */
export async function createEntry(root: string, seriesId: string, o: { date: string; title?: string; body?: string }): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(seriesId)) throw new HarpoonError('VALIDATION', 'Bad series id.')
  const head = await readDoc(root, `${seriesId}/${SERIES_FILE}`)
  const files = (await readdir(join(notesDir(root), seriesId)).catch(() => [] as string[])).filter((f) => /^\d{4}-\d{2}-\d{2}(-\d+)?\.md$/.test(f)).sort()
  let name = `${o.date}.md`
  for (let i = 2; files.includes(name); i++) name = `${o.date}-${i}.md`
  const prev = files.at(-1)
  const carried = prev === undefined ? [] : tasksIn((await readDoc(root, `${seriesId}/${prev}`))?.body ?? '').filter((t) => !t.done)
  let body = o.body ?? MEETING_TEMPLATE
  if (carried.length > 0) {
    const lines = carried.map((t) => `- [ ] ${t.text.replace(/\s*\(carried over\)$/, '')} (carried over)`).join('\n')
    body = body.includes('## Action items') ? body.replace(/## Action items\n(- \[ \] ?\n)?/, `## Action items\n${lines}\n${BLANK_TASK}\n`) : `${body.trimEnd()}\n\n## Action items\n${lines}\n`
  }
  if (head !== null && head.meta.attendees.length > 0) body = body.replace('## Attendees\n', `## Attendees\n${head.meta.attendees.join(', ')}\n`)
  const path = `${seriesId}/${name}`
  await writeNote(root, path, { title: o.title ?? `${head?.meta.title ?? seriesId} · ${o.date}`, date: o.date, attendees: head?.meta.attendees ?? [], summary: '', items: [], cadence: null }, body)
  return path
}

/** Tick or untick one task line. */
export async function toggleTask(root: string, path: string, line: number, done: boolean): Promise<void> {
  const d = await readNote(root, path)
  const lines = d.body.split(/\r?\n/)
  const l = lines[line]
  if (l === undefined || !/^\s*[-*] \[( |x|X)\] /.test(l)) throw new HarpoonError('CONFLICT', 'That task moved; reopen the note.')
  lines[line] = l.replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]')
  await writeNote(root, path, d.meta, lines.join('\n'))
}
