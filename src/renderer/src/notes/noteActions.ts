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

const excerpt = (doc: NoteDoc): string => `From the note "${doc.meta.title}"${doc.meta.date !== null ? ` (${doc.meta.date})` : ''}:\n\n${doc.body.trim().slice(0, 6000)}`

/** Summarize, extract items, or (for a meeting series) prepare the next meeting. */
export async function runNoteTask(doc: NoteDoc, task: 'summarize' | 'extract' | 'agenda', seriesPath?: string): Promise<void> {
  if (task === 'agenda') {
    const st = useNotes.getState()
    const series = seriesPath ?? doc.path
    const seriesId = series.split('/')[0] ?? ''
    const open = st.tasks.filter((t) => t.path.startsWith(`${seriesId}/`) && !t.done).map((t) => `- ${t.text} (from ${t.title})`)
    const recent = st.index?.series.find((s) => s.id === seriesId)?.entries.slice(0, 3) ?? []
    const prompt = [`Task: agenda. Prepare the next meeting of "${st.index?.series.find((s) => s.id === seriesId)?.title ?? seriesId}".`, open.length > 0 ? `Open action items:\n${open.join('\n')}` : 'No open action items.', recent.length > 0 ? `Recent meetings: ${recent.map((r) => r.title).join(', ')}.` : '', doc.meta.summary !== '' ? `Last meeting summary:\n${doc.meta.summary}` : '', excerpt(doc)].filter(Boolean).join('\n\n')
    await ask(prompt, { fresh: true, mode: 'notes', context: { notePath: series, noteTask: 'agenda' } })
    return
  }
  await ask(`Task: ${task}.\n\n${excerpt(doc)}`, { fresh: true, mode: 'notes', context: { notePath: doc.path, noteTask: task } })
}

/** Act on one extracted item. */
export async function runItem(doc: NoteDoc, item: NoteItem): Promise<void> {
  const source = sourceOf(doc, item)
  const request = `${item.text}\n\n(Context: ${excerpt(doc).slice(0, 3000)})`
  switch (item.action) {
    case 'solutions':
      return ask(request, { fresh: true, mode: 'solutions', context: { source } })
    case 'plan':
      return ask(request, { fresh: true, mode: 'plan', context: { source } })
    case 'document':
      return ask(`Update the diagram to reflect this: ${request}`, { fresh: true, mode: 'document', context: { source } })
    case 'decision': {
      const rec = await newDecision(item.text.length > 120 ? `${item.text.slice(0, 117)}…` : item.text, source, `${item.text}\n\n(Recorded from ${doc.meta.title}.)`)
      await draftWithAi(rec, excerpt(doc).slice(0, 4000))
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
