// What notes can set going: AI summaries, item extraction and the next meeting's agenda, and each extracted item's
// action (propose solutions, plan the change, update the diagram, record a decision, add a guideline). Everything
// started from an item remembers it (source note#item), so the note can show what became of it.
import type { NoteDoc, NoteItem, SourceRef } from '@shared/ipc.ts'
import { uniqueId } from '@shared/model/ids.ts'
import { ask } from '../state/ai.ts'
import { edit, toast } from '../state/actions.ts'
import { getState, setUi } from '../state/store.ts'
import { draftWithAi, newDecision } from '../records/decide.ts'
import { useNotes } from './notesStore.ts'

export function openNote(path: string): void {
  setUi({ view: 'notes', note: path })
}

export const sourceOf = (doc: NoteDoc, item: NoteItem): SourceRef => ({ kind: 'note', ref: `${doc.path}#${item.id}`, label: doc.meta.title })

/** Notes longer than this go in part; read_note has the rest. */
const NOTE_INLINE_MAX = 12_000

/** The note by name and path (the AI can read it with read_note). */
const noteRef = (doc: NoteDoc): string => `the note "${doc.meta.title}"${doc.meta.date !== null ? ` (${doc.meta.date})` : ''}, path ${doc.path}`

/** The note's body, whole when it is short. */
function noteBody(doc: NoteDoc): string {
  const body = doc.body.trim()
  return body.length <= NOTE_INLINE_MAX ? body : `${body.slice(0, NOTE_INLINE_MAX)}\n\n[The note goes on: call read_note("${doc.path}", offset ${NOTE_INLINE_MAX}) for the rest.]`
}

/** The lines around where an item was written (a few, not the note). */
function around(doc: NoteDoc, item: NoteItem): string {
  const lines = doc.body.split('\n')
  const key = item.text.toLowerCase().slice(0, 40)
  const i = lines.findIndex((l) => l.toLowerCase().includes(key))
  return i < 0 ? '' : lines.slice(Math.max(0, i - 2), i + 3).join('\n').trim()
}

/** An item's request: the item, where it came from, and the lines around it. */
function itemRequest(doc: NoteDoc, item: NoteItem): string {
  const near = around(doc, item)
  return `${item.text}\n\n(From ${noteRef(doc)}${near !== '' ? `. The lines around it:\n${near}` : ''}\nCall read_note for more of the note.)`
}

/** Summarize, extract items, or (for a meeting series) prepare the next meeting. */
export async function runNoteTask(doc: NoteDoc, task: 'summarize' | 'extract' | 'agenda', seriesPath?: string): Promise<void> {
  if (task === 'agenda') {
    const st = useNotes.getState()
    const series = seriesPath ?? doc.path
    const seriesId = series.split('/')[0] ?? ''
    const open = st.tasks.filter((t) => t.path.startsWith(`${seriesId}/`) && !t.done).map((t) => `- ${t.text} (from ${t.title})`)
    const recent = st.index?.series.find((s) => s.id === seriesId)?.entries.slice(0, 3) ?? []
    const items = open.length > 25 ? [...open.slice(0, 25), `- …and ${open.length - 25} more open items (read_note on the meetings below has them).`] : open
    const prompt = [
      `Task: agenda. Prepare the next meeting of "${st.index?.series.find((s) => s.id === seriesId)?.title ?? seriesId}".`,
      items.length > 0 ? `Open action items:\n${items.join('\n')}` : 'No open action items.',
      recent.length > 0 ? `Recent meetings (read_note for details): ${recent.map((r) => `${r.title} (${r.path})`).join(', ')}.` : '',
      doc.meta.summary !== '' ? `Last meeting summary:\n${doc.meta.summary}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    await ask(prompt, { mode: 'notes', context: { notePath: series, noteTask: 'agenda' } })
    return
  }
  await ask(`Task: ${task}.\n\nFrom ${noteRef(doc)}:\n\n${noteBody(doc)}`, { mode: 'notes', context: { notePath: doc.path, noteTask: task } })
}

/** Act on one extracted item. */
export async function runItem(doc: NoteDoc, item: NoteItem): Promise<void> {
  const source = sourceOf(doc, item)
  const request = itemRequest(doc, item)
  switch (item.action) {
    case 'solutions':
      return ask(request, { mode: 'solutions', context: { source } })
    case 'plan':
      return ask(request, { mode: 'plan', context: { source } })
    case 'document':
      return ask(`Update the diagram to reflect this: ${request}`, { mode: 'document', context: { source } })
    case 'decision': {
      const rec = await newDecision(item.text.length > 120 ? `${item.text.slice(0, 117)}…` : item.text, source, `${item.text}\n\n(Recorded from ${doc.meta.title}.)`)
      await draftWithAi(rec, `From ${noteRef(doc)}:\n${around(doc, item) || item.text}`)
      return
    }
    case 'guideline': {
      const meta = getState().project?.model.meta
      if (meta === undefined) return
      const id = uniqueId(item.text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'guideline', (x) => meta.guidelines.some((g) => g.id === x))
      edit([{ op: 'updateMeta', patch: { guidelines: [...meta.guidelines, { id, title: item.text.slice(0, 200), text: '', enabled: true, evidence: `Agreed in ${doc.meta.title}` }] } }], { label: 'add guideline' })
      toast('Added as a guideline (Project settings → Rules & guidelines).')
      return
    }
    case 'none':
      return
  }
}
