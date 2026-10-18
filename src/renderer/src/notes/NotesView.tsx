// The note taker: a project notebook and meeting series (one note per meeting). Write in Markdown with @mentions
// and tasks; the AI summarizes, pulls out what to act on (each item with a suggested action), and prepares the
// next meeting. Open action items across all notes are one click away.
import { CalendarPlus, Check, CircleDot, Eye, FileText, ListTodo, NotebookPen, Pencil, Plus, Sparkles, Trash2, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteAction, NoteDoc, NoteItem } from '@shared/ipc.ts'
import { adrNumber } from '@shared/export/adr.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { invoke } from '../ipc/client.ts'
import { select, toast } from '../state/actions.ts'
import { setUi, useStore } from '../state/store.ts'
import { useModel } from '../canvas/useScene.ts'
import { reveal } from '../panels/ArchitectureTree.tsx'
import { Markdown } from '../ai/Markdown.tsx'
import { AiNote } from '../ai/AiNote.tsx'
import { openRecord } from '../records/decide.ts'
import { useRecords } from '../records/recordsStore.ts'
import { NoteEditor } from './NoteEditor.tsx'
import type { MentionTarget } from './NoteEditor.tsx'
import { runItem, runNoteTask } from './noteActions.ts'
import { loadNotes, todayIso, useNotes } from './notesStore.ts'

const ACTION_LABEL: Record<NoteAction, string> = {
  solutions: 'Propose solutions',
  plan: 'Plan this change',
  document: 'Update the diagram',
  decision: 'Record decision',
  guideline: 'Add guideline',
  none: 'Task',
}

export function NotesView(): React.JSX.Element {
  const index = useNotes((s) => s.index)
  const tasks = useNotes((s) => s.tasks)
  const path = useStore((s) => s.ui.note)
  const editable = useStore((s) => s.ui.mode === 'edit')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    void loadNotes()
  }, [])

  const createProjectNote = async (): Promise<void> => {
    const r = await invoke('notes.write', { path: 'project.md', meta: { title: 'Project notes', date: null, attendees: [], summary: '', items: [], cadence: null }, body: '' })
    if (!r.ok) return toast(r.error.message, 'error')
    setUi({ note: 'project.md' })
  }
  const newMeeting = async (seriesId: string): Promise<void> => {
    const r = await invoke('notes.createEntry', { seriesId, date: todayIso() })
    if (!r.ok) return toast(r.error.message, 'error')
    setUi({ note: r.value })
  }
  const openTasks = tasks.filter((t) => !t.done)

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-popover">
        <div className="min-h-0 flex-1 overflow-y-auto p-2 text-xs">
          <button type="button" onClick={() => setUi({ note: '@tasks' })} className={cn('mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60', path === '@tasks' && 'bg-accent')}>
            <ListTodo className="size-3.5 text-muted-foreground" />
            <span className="flex-1 font-medium">Open action items</span>
            <span className="rounded bg-muted px-1.5 font-mono text-[10.5px] tabular-nums">{openTasks.length}</span>
          </button>
          <h3 className="mb-1 px-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Project notebook</h3>
          {index?.project != null ? (
            <NoteRow path="project.md" title={index.project.title} sub={`${index.project.openTasks} open`} active={path === 'project.md'} icon={<NotebookPen className="size-3.5" />} />
          ) : (
            editable && (
              <button type="button" onClick={() => void createProjectNote()} className="mb-1 w-full rounded-md border border-dashed px-2 py-1.5 text-left text-muted-foreground hover:bg-accent/50">
                + Start the project notebook
              </button>
            )
          )}
          <div className="mt-3 mb-1 flex items-center px-1">
            <h3 className="flex-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Meetings</h3>
            {editable && (
              <button type="button" aria-label="New meeting series" title="New meeting series (a recurring review, a one-off design session…)" onClick={() => setCreating(true)} className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                <Plus className="size-3.5" />
              </button>
            )}
          </div>
          {creating && <NewSeries onDone={(id) => (setCreating(false), id !== null && void newMeeting(id))} />}
          {(index?.series.length ?? 0) === 0 && !creating && <p className="px-1 text-muted-foreground">No meeting series yet.</p>}
          {index?.series.map((s) => (
            <div key={s.id} className="mb-2">
              <div className="group flex items-center gap-1.5 px-1 py-1">
                <Users className="size-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
                {s.cadence !== null && <span className="text-[10px] text-muted-foreground">{s.cadence}</span>}
                {editable && (
                  <button type="button" aria-label={`New meeting in ${s.title}`} title="New meeting (carries over open action items)" onClick={() => void newMeeting(s.id)} className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                    <CalendarPlus className="size-3.5" />
                  </button>
                )}
              </div>
              <ul className="ml-2 border-l pl-1.5">
                {s.entries.map((e) => (
                  <li key={e.path}>
                    <NoteRow path={e.path} title={e.date ?? e.title} sub={e.openTasks > 0 ? `${e.openTasks} open` : ''} active={path === e.path} icon={<FileText className="size-3.5" />} />
                  </li>
                ))}
                {s.entries.length === 0 && <li className="px-1.5 py-1 text-muted-foreground">No meetings yet.</li>}
              </ul>
            </div>
          ))}
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {path === '@tasks' ? (
          <OpenItems />
        ) : path !== null ? (
          <NotePage key={path} path={path} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <NotebookPen className="size-8" />
            <p className="max-w-md">Keep project notes and meeting notes next to the architecture. Mention services with @, add tasks with “- [ ]”, and let the AI summarize, pull out what to act on, and prepare the next meeting.</p>
          </div>
        )}
      </main>
    </div>
  )
}

function NoteRow({ path, title, sub, active, icon }: { path: string; title: string; sub: string; active: boolean; icon: React.ReactNode }): React.JSX.Element {
  return (
    <button type="button" onClick={() => setUi({ note: path })} className={cn('flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/60', active && 'bg-accent')}>
      <span className="text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {sub !== '' && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </button>
  )
}

function NewSeries({ onDone }: { onDone: (id: string | null) => void }): React.JSX.Element {
  const [title, setTitle] = useState('Architecture review')
  const [cadence, setCadence] = useState('every 2 weeks')
  const [attendees, setAttendees] = useState('')
  return (
    <form
      className="mb-2 flex flex-col gap-1.5 rounded-md border p-2"
      onSubmit={(e) => {
        e.preventDefault()
        void invoke('notes.createSeries', { title: title.trim() || 'Meetings', cadence: cadence.trim() || null, attendees: attendees.split(',').map((x) => x.trim()).filter(Boolean), description: '' }).then((r) => {
          if (!r.ok) toast(r.error.message, 'error')
          onDone(r.ok ? r.value : null)
        })
      }}
    >
      <input autoFocus aria-label="Series title" value={title} onChange={(e) => setTitle(e.target.value)} className="h-7 rounded border bg-background px-2 text-xs" />
      <input aria-label="Cadence" value={cadence} onChange={(e) => setCadence(e.target.value)} placeholder="weekly, every 2 weeks, one-off" className="h-7 rounded border bg-background px-2 text-xs" />
      <input aria-label="Usual attendees" value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="Usual attendees, comma separated" className="h-7 rounded border bg-background px-2 text-xs" />
      <div className="flex gap-1.5">
        <Button size="sm" type="submit">
          Create and start a meeting
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** Every unchecked task across all notes; tick it here or open its note. */
function OpenItems(): React.JSX.Element {
  const tasks = useNotes((s) => s.tasks)
  const [showDone, setShowDone] = useState(false)
  const shown = tasks.filter((t) => showDone || !t.done).sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || (b.date ?? '').localeCompare(a.date ?? ''))
  return (
    <div className="mx-auto max-w-3xl p-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex-1 text-base font-semibold">Open action items</h2>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          show done
        </label>
      </div>
      {shown.length === 0 && <p className="text-sm text-muted-foreground">Nothing open. Tasks are “- [ ] …” lines in any note.</p>}
      <ul className="flex flex-col gap-1">
        {shown.map((t) => (
          <li key={`${t.path}:${t.line}`} className="flex items-start gap-2 rounded-md border bg-popover px-3 py-2 text-xs">
            <input type="checkbox" aria-label="Done" checked={t.done} className="mt-0.5" onChange={(e) => void invoke('notes.toggleTask', { path: t.path, line: t.line, done: e.target.checked })} />
            <span className={cn('min-w-0 flex-1', t.done && 'text-muted-foreground line-through')}>
              <Markdown text={t.text} />
            </span>
            {t.due !== null && <span className={cn('shrink-0 rounded px-1.5 text-[10.5px]', !t.done && t.due < todayIso() ? 'bg-destructive/15 text-destructive' : 'bg-muted')}>due {t.due}</span>}
            <button type="button" onClick={() => setUi({ note: t.path })} className="shrink-0 text-[10.5px] text-muted-foreground hover:text-foreground hover:underline">
              {t.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function NotePage({ path }: { path: string }): React.JSX.Element {
  const model = useModel()
  const editable = useStore((s) => s.ui.mode === 'edit')
  const changed = useNotes((s) => s.changed)
  const decisions = useRecords((s) => s.decisions)
  const sets = useRecords((s) => s.sets)
  const [doc, setDoc] = useState<NoteDoc | null>(null)
  const [preview, setPreview] = useState(false)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef<NoteDoc | null>(null)
  latest.current = doc

  const load = async (): Promise<void> => {
    const r = await invoke('notes.read', { path })
    if (r.ok) setDoc(r.value)
    else toast(r.error.message, 'error')
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  // Changed elsewhere (the AI wrote a summary, a task was ticked in Open items): reload unless mid-edit.
  useEffect(() => {
    if ((changed.path === path || changed.path === null) && !dirty.current && changed.nonce > 0) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed])
  // Save a moment after the last keystroke (and when leaving the note).
  const save = (): void => {
    const d = latest.current
    if (d === null || !dirty.current) return
    dirty.current = false
    void invoke('notes.write', { path: d.path, meta: d.meta, body: d.body }).then((r) => !r.ok && toast(r.error.message, 'error'))
  }
  useEffect(() => () => save(), [])  
  const update = (p: Partial<NoteDoc>): void => {
    setDoc((d) => (d === null ? d : { ...d, ...p }))
    dirty.current = true
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(save, 700)
  }

  const mentionTargets = useMemo(
    () => (): MentionTarget[] => [
      ...Object.values(model.nodes).map((n) => ({ kind: 'node' as const, id: n.id, label: n.name, detail: n.kind })),
      ...decisions.map((d) => ({ kind: 'decision' as const, id: d.id, label: `${adrNumber(d.number)} ${d.title}`, detail: 'decision' })),
      ...sets.map((s) => ({ kind: 'set' as const, id: s.id, label: s.title, detail: 'comparison' })),
    ],
    [model.nodes, decisions, sets],
  )
  const onMention = (kind: string, id: string): void => {
    if (kind === 'node' && model.nodes[id] !== undefined) {
      setUi({ view: 'split' })
      reveal(model, id)
    } else if (kind === 'connector' && model.connectors[id] !== undefined) select({ kind: 'connector', ids: [id] })
    else if (kind === 'decision') openRecord('decision', id)
    else if (kind === 'set') openRecord('set', id)
  }

  if (doc === null) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  const isSeries = path.endsWith('/_series.md')
  const seriesId = path.includes('/') ? (path.split('/')[0] ?? null) : null
  const toggleTask = (line: number, done: boolean): void => {
    const lines = doc.body.split('\n')
    const l = lines[line]
    if (l === undefined) return
    lines[line] = l.replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]')
    update({ body: lines.join('\n') })
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <input
            aria-label="Title"
            readOnly={!editable}
            value={doc.meta.title}
            onChange={(e) => update({ meta: { ...doc.meta, title: e.target.value } })}
            className="min-w-48 flex-1 bg-transparent text-base font-semibold outline-none"
          />
          {doc.meta.date !== null && <input type="date" aria-label="Date" readOnly={!editable} value={doc.meta.date} onChange={(e) => update({ meta: { ...doc.meta, date: e.target.value || null } })} className="h-7 rounded-md border bg-background px-1 text-xs" />}
          <Button size="sm" variant="ghost" icon={preview ? <Pencil /> : <Eye />} onClick={() => setPreview(!preview)}>
            {preview ? 'Edit' : 'Preview'}
          </Button>
          {editable && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 />}
              className="text-muted-foreground"
              aria-label="Delete note"
              onClick={() => {
                if (!window.confirm(isSeries ? 'Delete this meeting series and all its meetings?' : 'Delete this note?')) return
                void invoke('notes.delete', { path }).then(() => setUi({ note: null }))
              }}
            />
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {preview || !editable ? (
            <div className="py-3">
              <Markdown text={doc.body} onMention={onMention} {...(editable ? { onToggleTask: toggleTask } : {})} />
            </div>
          ) : (
            <NoteEditor value={doc.body} readOnly={!editable} mentions={mentionTargets} onChange={(body) => update({ body })} />
          )}
        </div>
      </div>
      <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-popover p-3 text-xs">
        {editable && (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" icon={<Sparkles />} onClick={() => (save(), void runNoteTask(doc, 'summarize'))}>
              Summarize
            </Button>
            <Button size="sm" variant="outline" icon={<ListTodo />} title="Find tasks, decisions, open questions and changes, each with a suggested action" onClick={() => (save(), void runNoteTask(doc, 'extract'))}>
              Extract items
            </Button>
            {seriesId !== null && (
              <Button size="sm" variant="outline" icon={<CalendarPlus />} title="Draft the next meeting's agenda from open items, pending proposals and problems" onClick={() => (save(), void runNoteTask(doc, 'agenda', `${seriesId}/_series.md`))}>
                Prep next meeting
              </Button>
            )}
            <AiNote compact className="w-full" />
          </div>
        )}
        {doc.meta.summary !== '' && (
          <section>
            <h3 className="mb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Summary</h3>
            <div className="rounded-md border bg-background p-2">
              <Markdown text={doc.meta.summary} onMention={onMention} />
            </div>
          </section>
        )}
        <section>
          <h3 className="mb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Items {doc.meta.items.length > 0 && `(${doc.meta.items.filter((i) => !i.done).length} open)`}</h3>
          {doc.meta.items.length === 0 && <p className="text-muted-foreground">Extract items to turn the discussion into next steps: decisions to record, changes to plan, questions to explore.</p>}
          <ul className="flex flex-col gap-1.5">
            {doc.meta.items.map((it) => (
              <ItemRow key={it.id} doc={doc} item={it} editable={editable} onDone={(done) => update({ meta: { ...doc.meta, items: doc.meta.items.map((x) => (x.id === it.id ? { ...x, done } : x)) } })} />
            ))}
          </ul>
        </section>
      </aside>
    </div>
  )
}

function ItemRow({ doc, item, editable, onDone }: { doc: NoteDoc; item: NoteItem; editable: boolean; onDone: (done: boolean) => void }): React.JSX.Element {
  const ref = `${doc.path}#${item.id}`
  // Select the stable collections, filter after (a filtered array is new every time and would loop).
  const allProposals = useStore((s) => s.ai.proposals)
  const allSets = useRecords((s) => s.sets)
  const allDecisions = useRecords((s) => s.decisions)
  const proposals = Object.values(allProposals).filter((p) => p.source?.ref === ref && p.option === null)
  const sets = allSets.filter((x) => x.source?.ref === ref)
  const decisions = allDecisions.filter((x) => x.source?.ref === ref)
  const reviewProposal = (id: string): void => {
    setUi({ view: 'canvas', aiOpen: true })
    useStore.setState((s) => ({ ai: { ...s.ai, review: { kind: 'proposal', id }, excluded: {} } }))
  }
  return (
    <li className={cn('rounded-md border bg-background p-2', item.done && 'opacity-60')}>
      <div className="flex items-start gap-1.5">
        <input type="checkbox" aria-label="Done" disabled={!editable} checked={item.done} onChange={(e) => onDone(e.target.checked)} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 text-[10px] tracking-wide text-muted-foreground uppercase">{item.kind}</div>
          <div className={cn(item.done && 'line-through')}>{item.text}</div>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {editable && item.action !== 'none' && !item.done && (
          <Button size="sm" variant="outline" icon={<CircleDot />} onClick={() => void runItem(doc, item)}>
            {ACTION_LABEL[item.action]}
          </Button>
        )}
        {proposals.map((p) => (
          <button key={p.id} type="button" onClick={() => reviewProposal(p.id)} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] hover:bg-accent">
            Proposal: {p.title} · {p.status}
          </button>
        ))}
        {sets.map((x) => (
          <button key={x.id} type="button" onClick={() => openRecord('set', x.id)} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] hover:bg-accent">
            Comparison · {x.status}
          </button>
        ))}
        {decisions.map((d) => (
          <button key={d.id} type="button" onClick={() => openRecord('decision', d.id)} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10.5px] hover:bg-accent">
            <Check className="size-3" />
            {adrNumber(d.number)} · {d.status}
          </button>
        ))}
      </div>
    </li>
  )
}
