import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createEntry, createSeries, mentionsIn, notesIndex, notesTasksAndMentions, parseNote, readNote, serializeNote, tasksIn, toggleTask, writeNote } from '../../src/core/project/notes.ts'

describe('notes', () => {
  it('round-trips front matter and keeps hand-written notes tidy', () => {
    const meta = { title: 'Arch review', date: '2026-10-18', attendees: ['Ana'], summary: '', items: [{ id: 'i1', kind: 'decision' as const, text: 'Use Postgres', action: 'decision' as const, done: false }], cadence: null }
    const text = serializeNote(meta, 'Body with [@Payments](harpoon:node/payment-api).\n')
    expect(text).not.toContain('summary:')
    const back = parseNote(text)
    expect(back.meta).toEqual(meta)
    expect(back.body).toBe('Body with [@Payments](harpoon:node/payment-api).\n')
    expect(parseNote('No front matter at all').meta.title).toBe('Untitled')
  })

  it('finds tasks (with due dates) and mentions', () => {
    const body = '## Action items\n- [ ] Ana: add SQS dlq due:2026-11-01\n- [x] Done thing\n- not a task\nSee [@Ledger](harpoon:node/ledger-db) and [ADR](harpoon:decision/adr-0002).'
    expect(tasksIn(body)).toEqual([
      { line: 1, text: 'Ana: add SQS dlq due:2026-11-01', done: false, due: '2026-11-01' },
      { line: 2, text: 'Done thing', done: true, due: null },
    ])
    expect(mentionsIn(body)).toEqual(['ledger-db', 'adr-0002'])
  })

  it('carries open action items into the next meeting of a series', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hp-notes-'))
    const id = await createSeries(root, { title: 'Architecture review', cadence: 'every 2 weeks', attendees: ['Ana', 'Raj'], description: '' })
    const first = await createEntry(root, id, { date: '2026-10-01' })
    const doc = await readNote(root, first)
    expect(doc.body).toContain('Ana, Raj')
    await writeNote(root, first, doc.meta, doc.body.replace('## Action items\n', '## Action items\n- [ ] Decide on the queue\n- [x] Share the diagram\n'))
    const second = await createEntry(root, id, { date: '2026-10-15' })
    const next = await readFile(join(root, '.harpoon', 'notes', second), 'utf8')
    expect(next).toContain('- [ ] Decide on the queue (carried over)')
    expect(next).not.toContain('Share the diagram')

    const { tasks } = await notesTasksAndMentions(root)
    const open = tasks.find((t) => t.path === first && t.text === 'Decide on the queue')
    expect(open?.done).toBe(false)
    await toggleTask(root, first, open?.line ?? -1, true)
    const idx = await notesIndex(root)
    expect(idx.series[0]?.entries.map((e) => e.date)).toEqual(['2026-10-15', '2026-10-01'])
  })
})
