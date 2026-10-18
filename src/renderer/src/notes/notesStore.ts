// The open project's notes: the notebook index, tasks and mentions across notes; reloaded when notes change.
import { create } from 'zustand'
import type { NoteIndex, NoteTask } from '@shared/ipc.ts'
import { invoke } from '../ipc/client.ts'

interface NotesState {
  index: NoteIndex | null
  tasks: NoteTask[]
  mentions: Record<string, { path: string; title: string }[]>
  /** Bumped when a note changed on disk (editors reload unless they have unsaved edits). */
  changed: { path: string | null; nonce: number }
}

export const useNotes = create<NotesState>(() => ({ index: null, tasks: [], mentions: {}, changed: { path: null, nonce: 0 } }))

export async function loadNotes(): Promise<void> {
  const [idx, more] = await Promise.all([invoke('notes.list'), invoke('notes.index')])
  useNotes.setState({
    ...(idx.ok ? { index: idx.value } : {}),
    ...(more.ok ? { tasks: more.value.tasks, mentions: more.value.mentions } : {}),
  })
}

export function notesChanged(path: string | null): void {
  useNotes.setState((s) => ({ changed: { path, nonce: s.changed.nonce + 1 } }))
  void loadNotes()
}

export const todayIso = (): string => new Date().toISOString().slice(0, 10)
