// The AI panel: pick Claude Code or Codex (and a model), pick what you want (plan a change, document, explain,
// import the repository, check drift), and talk. The agent's changes stream onto the canvas as a live diff and end
// as a proposal you accept, accept as planned, or discard.
import { openNote } from '../notes/noteActions.ts'
import { edit } from '../state/actions.ts'
import { openRecord } from '../records/decide.ts'
import { Bot, ChevronDown, CircleAlert, History, Loader2, NotebookPen, Plus, RefreshCw, Scale, ScanSearch, ScrollText, Send, Square, Wrench, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiMode, AiRunView } from '@shared/ipc.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { ask, cancelRun, loadProviders, newConversation, setAiMode, setVendor } from '../state/ai.ts'
import { setAi, setUi, useStore } from '../state/store.ts'
import { Markdown } from './Markdown.tsx'
import { ProposalCard } from './ProposalCard.tsx'
import { QuestionCard } from './QuestionCard.tsx'
import { AI_NOTE_SHORT, AiNote } from './AiNote.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { useModel } from '../canvas/useScene.ts'

export const MODE_INFO: Record<AiMode, { label: string; hint: string; placeholder: string }> = {
  plan: { label: 'Plan a change', hint: 'Design additions; they land as planned nodes for review.', placeholder: 'e.g. Add an async fraud scorer that consumes orders via Kafka and alerts PagerDuty on high risk' },
  document: { label: 'Document', hint: 'Fill in descriptions, features and contracts from the code.', placeholder: 'e.g. Document the payment services (leave empty for the selection)' },
  explain: { label: 'Explain', hint: 'Ask about the architecture; it highlights what it talks about.', placeholder: 'e.g. What breaks if Redis goes down?' },
  import: {
    label: 'Import repo',
    hint: 'Map the code into services, data stores and connectors. Pick the repositories and say what to bring in; anything else stays out.',
    placeholder: 'Optional scope, e.g. only checkout and payments; from the API gateway just the public routes, not the admin tools',
  },
  drift: { label: 'Drift check', hint: 'Compare the diagram with the code and propose corrections.', placeholder: 'Optional focus' },
  solutions: {
    label: 'Propose solutions',
    hint: 'Describe what you need; get 2 to 4 alternative designs side by side, with pros, cons and scores, then pick one.',
    placeholder: 'e.g. We need fraud scoring on checkout without slowing payments down',
  },
  decision: { label: 'Decision record', hint: 'Write up a decision (started from a decision record).', placeholder: 'What should the record say?' },
  notes: { label: 'Notes', hint: 'Summaries, items and agendas (started from a note).', placeholder: 'What should it do with the note?' },
  publish: { label: 'Publish to Notion', hint: 'Write the architecture, roadmap and decisions to your Notion page (set it up in Project settings → Notion).', placeholder: 'Anything to add to the changelog?' },
  scan: {
    label: 'Scan for patterns',
    hint: 'Read the code for the conventions it follows; suggests checkable rules and guidelines (nothing changes until you add them).',
    placeholder: 'Optional focus, e.g. only service-to-service communication',
  },
}

/** Modes offered as chips (a decision record is started from the record itself). */
const CHIP_MODES: AiMode[] = ['plan', 'solutions', 'document', 'explain', 'import', 'drift', 'scan']

export function AiPanel(): React.JSX.Element {
  const providers = useStore((s) => s.ai.providers)
  const vendor = useStore((s) => s.ai.vendor)
  const model = useStore((s) => s.ai.model)
  const effort = useStore((s) => s.ai.effort)
  const repos = useModel().meta.repos
  const mode = useStore((s) => s.ai.mode)
  const runs = useStore((s) => s.ai.runs)
  const activeId = useStore((s) => s.ai.activeRunId)
  const proposals = useStore((s) => s.ai.proposals)
  const selection = useStore((s) => s.ui.selection)
  const focusId = useStore((s) => s.ui.focusId)
  const nodes = useStore((s) => s.project?.model.nodes)
  const [text, setText] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const run = activeId !== null ? runs[activeId] : undefined
  const busy = run !== undefined && (run.status === 'running' || run.status === 'starting')
  const provider = providers?.find((p) => p.id === vendor)

  useEffect(() => {
    if (providers === null) void loadProviders()
  }, [providers])

  const scope = useMemo(() => {
    const names = (ids: string[]): string => ids.map((id) => nodes?.[id]?.name ?? id).slice(0, 3).join(', ') + (ids.length > 3 ? ` +${ids.length - 3}` : '')
    if (selection?.kind === 'node') return names(selection.ids)
    if (selection?.kind === 'connector') return `${selection.ids.length} connector${selection.ids.length === 1 ? '' : 's'}`
    if (focusId !== null) return `inside ${nodes?.[focusId]?.name ?? focusId}`
    return 'whole system'
  }, [selection, focusId, nodes])

  const send = (): void => {
    const t = text.trim()
    // Blocked only when the provider is known to be unusable (the list may still be loading).
    if ((t === '' && run !== undefined) || busy || provider?.ok === false) return
    void ask(t)
    setText('')
  }

  // Options of a comparison live in the Decisions view, not here.
  const orphanProposals = Object.values(proposals).filter((p) => p.status === 'pending' && p.option === null && !Object.values(runs).some((r) => r.proposalId === p.id))
  const history = Object.values(runs).sort((a, b) => b.createdAt - a.createdAt)

  return (
    <aside className="flex w-[400px] shrink-0 flex-col border-l bg-panel" aria-label="AI assistant">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b px-3">
        <Bot className="size-4 text-hx-violet" />
        <span className="text-sm font-semibold">AI</span>
        <div className="ml-auto flex items-center">
          <Button variant="ghost" size="icon" className="size-7" aria-label="Conversations" title="Conversations" onClick={() => setShowHistory((x) => !x)}>
            <History />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" aria-label="New conversation" title="New conversation" onClick={newConversation}>
            <Plus />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Close AI panel" onClick={() => setUi({ aiOpen: false })}>
            <X />
          </Button>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-1.5">
        <select aria-label="Provider" title={AI_NOTE_SHORT} value={vendor} onChange={(e) => setVendor(e.target.value as 'claude' | 'codex')} className="h-7 rounded-md border bg-background px-1.5 text-xs">
          {(providers ?? [{ id: 'claude', name: 'Claude Code', ok: true }, { id: 'codex', name: 'Codex', ok: true }]).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.ok ? '' : ' (unavailable)'}
            </option>
          ))}
        </select>
        <ModelPicker provider={provider} value={{ model, effort }} onChange={(v) => setAi(v)} />
      </div>

      {provider !== undefined && !provider.ok && (
        <div className="flex items-start gap-2 border-b bg-warning/10 px-3 py-2 text-xs">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span className="flex-1">
            {provider.name} isn&apos;t ready: {provider.issue ?? 'not found'}. Install it and sign in from a terminal, then refresh.
          </span>
          <button type="button" onClick={() => void loadProviders(true)} className="text-muted-foreground hover:text-foreground" aria-label="Check again">
            <RefreshCw className="size-3.5" />
          </button>
        </div>
      )}

      {showHistory && (
        <div className="max-h-56 overflow-y-auto border-b p-2">
          {history.length === 0 && <p className="px-1 text-xs text-muted-foreground">No conversations yet.</p>}
          {history.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                setAi({ activeRunId: r.id, review: r.proposalId !== null ? { kind: 'proposal', id: r.proposalId } : null, excluded: {} })
                setShowHistory(false)
              }}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/50', r.id === activeId && 'bg-accent')}
            >
              <StatusDot status={r.status} />
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              <span className="text-[10px] text-muted-foreground">{MODE_INFO[r.mode].label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="scroll-region min-h-0 flex-1 overflow-y-auto">
        {run === undefined ? (
          <Intro mode={mode} />
        ) : (
          <Conversation run={run} />
        )}
        {run === undefined && orphanProposals.length > 0 && (
          <div className="flex flex-col gap-2 px-3 pb-3">
            <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Saved proposals</div>
            {orphanProposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} />
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t p-2">
        <div className="mb-1.5 flex items-center gap-1 overflow-x-auto">
          {CHIP_MODES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setAiMode(m)}
              title={MODE_INFO[m].hint}
              className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px]', mode === m ? 'border-primary bg-primary/15 text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {MODE_INFO[m].label}
            </button>
          ))}
        </div>
        {mode === 'import' && repos.length > 1 && <ImportRepos repos={repos} />}
        <div className="rounded-lg border bg-background focus-within:border-ring">
          <textarea
            aria-label="Message to the AI"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                send()
              }
            }}
            rows={3}
            placeholder={run !== undefined && !busy && run.mode === mode ? 'Follow up… (Ctrl+Enter)' : MODE_INFO[mode].placeholder}
            className="block w-full resize-none bg-transparent px-2.5 py-2 text-xs outline-none"
          />
          <div className="flex items-center gap-2 px-2 pb-1.5">
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground" title="Scope: the selection or focused node is sent as context">
              Scope: {scope}
            </span>
            {busy && run !== undefined ? (
              <Button size="sm" variant="outline" icon={<Square />} onClick={() => void cancelRun(run.id)}>
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                icon={<Send />}
                disabled={provider?.ok === false}
                onClick={() => {
                  // A different mode always starts a fresh conversation.
                  if (run !== undefined && run.mode !== mode) {
                    void ask(text.trim(), { fresh: true })
                    setText('')
                  } else send()
                }}
              >
                {run !== undefined && run.mode === mode ? 'Send' : MODE_INFO[mode].label}
              </Button>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-center text-[10.5px] text-muted-foreground">
          Runs your own {provider?.name ?? (vendor === 'codex' ? 'Codex' : 'Claude Code')} on this computer; usage counts against your plan.
        </p>
      </div>
    </aside>
  )
}

function Intro({ mode }: { mode: AiMode }): React.JSX.Element {
  return (
    <div className="p-4">
      <h3 className="text-sm font-semibold">{MODE_INFO[mode].label}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{MODE_INFO[mode].hint}</p>
      <AiNote className="mt-4" />
      <ul className="mt-4 flex flex-col gap-2 text-xs text-muted-foreground">
        <li>• It runs in this project&apos;s folder, read-only: it can read the code but never edits files.</li>
        <li>• It changes the diagram only through Harpoon&apos;s tools, into a draft you review here and on the canvas.</li>
        <li>• Select nodes (or open one) first to give it a scope.</li>
      </ul>
    </div>
  )
}

function StatusDot({ status }: { status: AiRunView['status'] }): React.JSX.Element {
  if (status === 'running' || status === 'starting') return <Loader2 className="size-3 shrink-0 animate-spin text-info" />
  return <span className={cn('size-2 shrink-0 rounded-full', status === 'done' ? 'bg-success' : status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground')} />
}

function Conversation({ run }: { run: AiRunView }): React.JSX.Element {
  const proposal = useStore((s) => (run.proposalId !== null ? s.ai.proposals[run.proposalId] : undefined))
  const highlight = useStore((s) => s.ai.highlight)
  const [showTools, setShowTools] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const busy = run.status === 'running' || run.status === 'starting'
  const lastText = run.turns.at(-1)?.text.length ?? 0
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [run.turns.length, lastText, run.activity.length, proposal?.id])
  const tools = run.activity
  const failed = tools.filter((t) => t.status === 'failed').length

  return (
    <div className="flex flex-col gap-3 p-3">
      {run.turns.map((t, i) => (
        <div key={i} className={cn(t.role === 'user' ? 'ml-8 self-end rounded-xl rounded-br-sm bg-primary/15 px-3 py-2 text-xs' : '')}>
          {t.role === 'user' ? <span className="whitespace-pre-wrap selectable">{t.text || MODE_INFO[run.mode].label}</span> : <Markdown text={t.text} />}
        </div>
      ))}

      {tools.length > 0 && (
        <div className="rounded-lg border bg-background/60">
          <button type="button" onClick={() => setShowTools((x) => !x)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground">
            <Wrench className="size-3" />
            <span className="flex-1">
              {tools.length} step{tools.length === 1 ? '' : 's'}
              {failed > 0 ? ` · ${failed} corrected` : ''}
              {run.changeCount > 0 ? ` · ${run.changeCount} change${run.changeCount === 1 ? '' : 's'} staged` : ''}
            </span>
            <ChevronDown className={cn('size-3 transition-transform', !showTools && '-rotate-90')} />
          </button>
          {(showTools || busy) && (
            <ul className="max-h-48 overflow-y-auto px-2.5 pb-2">
              {(showTools ? tools : tools.slice(-4)).map((a) => (
                <li key={a.id} className="flex items-start gap-1.5 py-0.5 text-[11px]">
                  <span className={cn('mt-1 size-1.5 shrink-0 rounded-full', a.status === 'ok' ? 'bg-success' : a.status === 'failed' ? 'bg-warning' : 'bg-info')} />
                  <span className={cn('min-w-0 flex-1', a.status === 'failed' && 'text-muted-foreground')}>
                    <span className="font-mono text-[10.5px] text-muted-foreground">{a.name}</span> {a.summary}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {busy && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {run.status === 'starting' ? 'Starting…' : (run.phase ?? 'Working…')}
        </div>
      )}
      {highlight !== null && highlight.runId === run.id && highlight.note !== null && (
        <div className="rounded-md border border-info/40 bg-info/10 px-2.5 py-1.5 text-[11.5px]">
          {highlight.note}
          <button type="button" className="ml-2 text-muted-foreground underline" onClick={() => setAi({ highlight: null })}>
            clear
          </button>
        </div>
      )}
      {run.questions !== null && run.questions.length > 0 && !busy && <QuestionCard runId={run.id} questions={run.questions} />}
      {run.error !== null && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-2.5 py-1.5 text-xs selectable">{run.error}</div>
      )}
      {proposal !== undefined && <ProposalCard proposal={proposal} />}
      {run.mode === 'solutions' && run.options.length > 0 && <SolutionsCard run={run} />}
      {run.mode === 'notes' && run.notePath !== null && !busy && run.status === 'done' && (
        <div className="rounded-xl border bg-background p-3 text-xs">
          <Button size="sm" icon={<NotebookPen />} onClick={() => openNote(run.notePath ?? '')}>
            Open the note
          </Button>
        </div>
      )}
      {run.mode === 'scan' && run.suggestions !== null && (run.suggestions.rules.length > 0 || run.suggestions.guidelines.length > 0) && <ScanCard run={run} busy={busy} />}
      {run.mode === 'decision' && run.decisionId !== null && !busy && (
        <div className="rounded-xl border bg-background p-3 text-xs">
          <div className="mb-2 flex items-center gap-1.5 font-semibold">
            <ScrollText className="size-4 text-primary" />
            Decision record drafted
          </div>
          <Button size="sm" onClick={() => openRecord('decision', run.decisionId ?? '')}>
            Open {run.decisionId.toUpperCase()}
          </Button>
        </div>
      )}
      {run.usage !== null && (
        <div className="text-[10.5px] text-muted-foreground">
          {run.vendor === 'claude' ? 'Claude' : 'Codex'}
          {run.model !== null ? ` · ${run.model}` : ''} · {(run.usage.input + run.usage.output).toLocaleString()} tokens
          {run.usage.costUsd !== null ? ` · $${run.usage.costUsd.toFixed(3)}` : ''}
        </div>
      )}
      <div ref={end} />
    </div>
  )
}

/** Solutions mode: the options as they take shape, then a button to compare them. */
function SolutionsCard({ run }: { run: AiRunView }): React.JSX.Element {
  const busy = run.status === 'running' || run.status === 'starting'
  return (
    <div className="rounded-xl border bg-background p-3 text-xs">
      <div className="mb-2 flex items-center gap-1.5 font-semibold">
        <Scale className="size-4 text-primary" />
        {busy ? 'Designing options' : `${run.options.length} options to compare`}
      </div>
      <ul className="mb-2.5 flex flex-col gap-1">
        {run.options.map((o) => (
          <li key={o.key} className={cn('flex items-center gap-2 rounded-md border px-2 py-1.5', busy && run.activeOption === o.key && 'border-primary/60 bg-primary/5')}>
            <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted font-mono text-[10.5px] font-semibold">{o.key}</span>
            <span className="min-w-0 flex-1 truncate">{o.title}</span>
            <span className="text-[10.5px] text-muted-foreground tabular-nums">{o.changes} changes</span>
            {busy && run.activeOption === o.key && <Loader2 className="size-3 animate-spin text-primary" />}
          </li>
        ))}
      </ul>
      {run.solutionSetId !== null && !busy && (
        <Button size="sm" icon={<Scale />} onClick={() => openRecord('set', run.solutionSetId ?? '')}>
          Compare options
        </Button>
      )}
      {!busy && <p className="mt-2 text-[11px] text-muted-foreground">Follow up to refine: “make B use SQS instead of Kafka”, “add an option without new vendors”.</p>}
    </div>
  )
}

/** Scan mode: suggested rules (with how the project does against them) and guidelines; add the ones you want. */
function ScanCard({ run, busy }: { run: AiRunView; busy: boolean }): React.JSX.Element | null {
  const meta = useStore((s) => s.project?.model.meta)
  const sug = run.suggestions
  if (sug === null || meta === undefined) return null
  const hasRule = (id: string, name: string): boolean => meta.rules.some((r) => r.id === id || r.name === name)
  const hasGuideline = (title: string): boolean => meta.guidelines.some((g) => g.title === title)
  const addRule = (r: (typeof sug.rules)[number]['rule']): void => {
    let id = r.id
    for (let i = 2; meta.rules.some((x) => x.id === id); i++) id = `${r.id}-${i}`
    edit([{ op: 'updateMeta', patch: { rules: [...meta.rules, { ...r, id }] } }], { label: `add rule ${r.name}` })
  }
  const addGuideline = (g: (typeof sug.guidelines)[number]): void => {
    const base = g.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'guideline'
    let id = base
    for (let i = 2; meta.guidelines.some((x) => x.id === id); i++) id = `${base}-${i}`
    edit([{ op: 'updateMeta', patch: { guidelines: [...meta.guidelines, { id, title: g.title, text: g.text, enabled: true, evidence: `${g.prevalence}${g.evidence !== '' ? `: ${g.evidence}` : ''}` }] } }], { label: 'add guideline' })
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-background p-3 text-xs">
      <div className="flex items-center gap-1.5 font-semibold">
        <ScanSearch className="size-4 text-primary" />
        {busy ? 'Finding patterns…' : 'Patterns found'}
      </div>
      {sug.summary !== '' && (
        <div className="text-muted-foreground">
          <Markdown text={sug.summary} />
        </div>
      )}
      {sug.rules.length > 0 && (
        <div>
          <div className="mb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Rules (checked against the diagram)</div>
          <ul className="flex flex-col gap-1.5">
            {sug.rules.map((x) => {
              const added = hasRule(x.rule.id, x.rule.name)
              const follow = x.applies - x.violations.length
              return (
                <li key={x.rule.id} className="rounded-md border p-2">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{x.rule.name}</div>
                      <div className="text-[11px] text-muted-foreground">{x.rationale}</div>
                    </div>
                    <Button size="sm" variant={added ? 'ghost' : 'outline'} disabled={added} onClick={() => addRule(x.rule)}>
                      {added ? 'Added' : 'Add'}
                    </Button>
                  </div>
                  <div className={cn('mt-1 text-[11px]', x.violations.length === 0 ? 'text-success' : 'text-warning')}>
                    {follow} of {x.applies} follow it
                    {x.violations.length > 0 ? `; breaking: ${x.violations.slice(0, 5).map((v) => v.name).join(', ')}${x.violations.length > 5 ? '…' : ''}` : ''}
                  </div>
                  {x.evidence !== '' && (
                    <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground" title={x.evidence}>
                      Seen in: {x.evidence}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {sug.guidelines.length > 0 && (
        <div>
          <div className="mb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Guidelines (conventions in code)</div>
          <ul className="flex flex-col gap-1.5">
            {sug.guidelines.map((g) => {
              const added = hasGuideline(g.title)
              return (
                <li key={g.title} className="flex items-start gap-2 rounded-md border p-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{g.title}</div>
                    <div className="text-[11px] text-muted-foreground">{g.text}</div>
                    <div className="mt-0.5 text-[10.5px] text-muted-foreground">{g.prevalence}</div>
                  </div>
                  <Button size="sm" variant={added ? 'ghost' : 'outline'} disabled={added} onClick={() => addGuideline(g)}>
                    {added ? 'Added' : 'Add'}
                  </Button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Import: which linked repositories to read (none picked: all of them). */
function ImportRepos({ repos }: { repos: readonly { id: string; name: string }[] }): React.JSX.Element {
  const picked = useStore((s) => s.ai.importRepos)
  const on = (id: string): boolean => picked === null || picked.length === 0 || picked.includes(id)
  const toggle = (id: string): void => {
    const cur = repos.filter((r) => on(r.id)).map((r) => r.id)
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    // Back to "all" when every one is on; never none.
    setAi({ importRepos: next.length === 0 || next.length === repos.length ? null : next })
  }
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1 text-[11px]" role="group" aria-label="Repositories to import">
      <span className="text-muted-foreground">Repositories:</span>
      {repos.map((r) => (
        <button
          key={r.id}
          type="button"
          aria-pressed={on(r.id)}
          onClick={() => toggle(r.id)}
          className={cn('rounded-md border px-1.5 py-0.5', on(r.id) ? 'border-primary/60 bg-primary/10 text-foreground' : 'text-muted-foreground line-through')}
        >
          {r.name}
        </button>
      ))}
    </div>
  )
}
