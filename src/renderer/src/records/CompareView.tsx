// Comparing proposed solutions: each option's change drawn side by side (new green, changed amber, going red), the
// facts Harpoon computes from the change, the criteria scores (the AI's, editable), a weighted total, and Choose.
import { Check, Eye, Flag, Sparkles, Trophy } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Proposal, SolutionSet } from '@shared/ipc.ts'
import { optionFacts } from '@shared/model/compare.ts'
import type { OptionFacts } from '@shared/model/compare.ts'
import { dataClassLabel, phasesInOrder } from '@shared/model/governance.ts'
import { ancestorsOf } from '@shared/model/queries.ts'
import type { Model } from '@shared/model/schema.ts'
import { renderSvg } from '@shared/export/svg.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { ask, reply, reviewProposal } from '../state/ai.ts'
import { getState, setAi, setUi, useStore } from '../state/store.ts'
import { useModel } from '../canvas/useScene.ts'
import { reviewModel } from '../canvas/useReview.ts'
import { Markdown } from '../ai/Markdown.tsx'
import { TextArea, TextInput } from '../panels/inspector/fields.tsx'
import { chooseOption, openRecord } from './decide.ts'
import { putSet } from './recordsStore.ts'

interface OptionView {
  p: Proposal
  facts: OptionFacts
  svg: string
}

function optionView(base: Model, p: Proposal, style: 'flat' | 'iso', theme: 'light' | 'dark'): OptionView {
  const { facts } = optionFacts(base, p.ops)
  const rv = reviewModel(base, p.ops)
  const marks = {
    nodes: new Map(rv.summary.nodes.map((c) => [c.id, c.kind] as const)),
    connectors: new Map(rv.summary.connectors.map((c) => [c.id, c.kind] as const)),
  }
  // Open the containers the change happens in, so inner parts show.
  const expanded = new Set<string>()
  for (const c of rv.summary.nodes) for (const a of ancestorsOf(rv.model, c.id)) expanded.add(a.id)
  const svg = renderSvg(rv.model, { focusId: null, expanded: [...expanded], style, theme, includeNotes: false }, marks, { cropToMarks: true })
  return { p, facts, svg }
}

export function CompareView({ set }: { set: SolutionSet }): React.JSX.Element {
  const model = useModel()
  const proposals = useStore((s) => s.ai.proposals)
  const style = useStore((s) => s.prefs.nodeStyle)
  const theme = useStore((s) => s.theme.resolved)
  const editable = useStore((s) => s.ui.mode === 'edit')
  const [refine, setRefine] = useState('')
  const options = useMemo(
    () => set.options.map((id) => proposals[id]).filter((p): p is Proposal => p !== undefined).map((p) => optionView(model, p, style, theme)),
    [set.options, proposals, model, style, theme],
  )
  const decided = set.status === 'decided'
  const scoreOf = (pid: string, crit: string): number | null => set.scores.find((s) => s.option === pid && s.criterion === crit)?.score ?? null
  const totals = options.map((o) => {
    let w = 0
    let t = 0
    for (const c of set.criteria) {
      const s = scoreOf(o.p.id, c.id)
      if (s === null) continue
      w += c.weight
      t += s * c.weight
    }
    return w === 0 ? null : t / w
  })
  const best = Math.max(...totals.map((t) => t ?? -1))
  const setScore = (pid: string, crit: string, score: number): void => {
    const rest = set.scores.filter((s) => !(s.option === pid && s.criterion === crit))
    void putSet({ ...set, scores: [...rest, { option: pid, criterion: crit, score, note: set.scores.find((s) => s.option === pid && s.criterion === crit)?.note ?? '' }] })
  }

  const factRows: { label: string; hint: string; cell: (f: OptionFacts) => React.ReactNode }[] = [
    { label: 'Adds', hint: 'New nodes / connectors', cell: (f) => `${f.nodes.added} nodes, ${f.connectors.added} links` },
    { label: 'Changes', hint: 'Existing nodes / connectors modified', cell: (f) => `${f.nodes.modified} nodes, ${f.connectors.modified} links` },
    { label: 'Removes', hint: 'Existing nodes / connectors removed', cell: (f) => (f.nodes.removed + f.connectors.removed === 0 ? '—' : `${f.nodes.removed} nodes, ${f.connectors.removed} links`) },
    { label: 'Services touched', hint: 'Existing top-level services it changes or connects to', cell: (f) => (f.servicesTouched.length === 0 ? '—' : f.servicesTouched.join(', ')) },
    { label: 'New vendors', hint: 'Third parties it brings in', cell: (f) => (f.newVendors.length === 0 ? '—' : f.newVendors.join(', ')) },
    { label: 'Data exposure', hint: 'Regulated data reaching more components than before', cell: (f) => (f.dataExposure.length === 0 ? '—' : f.dataExposure.map((d) => `${dataClassLabel(model.meta, d.cls)} +${d.more}`).join(', ')) },
    { label: 'New problems', hint: 'Problems that appear with it', cell: (f) => (f.newProblems === 0 ? '—' : <span className="text-[var(--hx-warn)]">{f.newProblems}</span>) },
    { label: 'Impact', hint: 'Existing components that depend on what it changes', cell: (f) => (f.impact === 0 ? '—' : `${f.impact} upstream`) },
  ]

  return (
    <div className="flex flex-col gap-4 p-4">
      <header>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Comparison · {decided ? 'decided' : set.status}</div>
            <TextInput value={set.title} readOnly={!editable} onChange={(title) => title.trim() !== '' && void putSet({ ...set, title })} className="text-base font-semibold" />
          </div>
          {set.decisionId !== null && (
            <Button size="sm" variant="outline" onClick={() => openRecord('decision', set.decisionId ?? '')}>
              Open {set.decisionId.toUpperCase()}
            </Button>
          )}
        </div>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Problem</div>
            <TextArea value={set.problem} rows={3} readOnly={!editable} onChange={(problem) => void putSet({ ...set, problem })} />
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Constraints</div>
            <TextArea value={set.constraints} rows={3} placeholder="Budget, timeline, what is acceptable…" readOnly={!editable} onChange={(constraints) => void putSet({ ...set, constraints })} />
          </div>
        </div>
        {set.recommendation !== null && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/5 p-2.5 text-xs">
            <Trophy className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <div>
              <span className="font-medium">AI recommends {proposals[set.recommendation.option]?.title ?? set.recommendation.option}.</span> {set.recommendation.why}
            </div>
          </div>
        )}
      </header>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        {options.map((o, i) => (
          <OptionCard key={o.p.id} o={o} set={set} total={totals[i] ?? null} best={totals[i] === best && best > 0} editable={editable} />
        ))}
      </div>

      <section className="overflow-x-auto rounded-xl border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-muted/40">
              <th className="w-48 px-3 py-2 text-left font-medium text-muted-foreground">Compared on</th>
              {options.map((o) => (
                <th key={o.p.id} className="px-3 py-2 text-left font-semibold">
                  <span className="mr-1.5 rounded bg-background px-1 font-mono">{o.p.option?.key}</span>
                  {o.p.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={options.length + 1} className="bg-background px-3 pt-2 pb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
                Computed from each change
              </td>
            </tr>
            {factRows.map((r) => (
              <tr key={r.label} className="border-t">
                <td className="px-3 py-1.5 text-muted-foreground" title={r.hint}>
                  {r.label}
                </td>
                {options.map((o) => (
                  <td key={o.p.id} className="px-3 py-1.5">
                    {r.cell(o.facts)}
                  </td>
                ))}
              </tr>
            ))}
            {set.criteria.length > 0 && (
              <tr>
                <td colSpan={options.length + 1} className="bg-background px-3 pt-3 pb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Criteria (score 1–5, weight 1–5)
                </td>
              </tr>
            )}
            {set.criteria.map((c) => (
              <tr key={c.id} className="border-t">
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="flex-1">{c.name}</span>
                    <select
                      aria-label={`Weight of ${c.name}`}
                      disabled={!editable}
                      value={c.weight}
                      onChange={(e) => void putSet({ ...set, criteria: set.criteria.map((x) => (x.id === c.id ? { ...x, weight: Number(e.target.value) } : x)) })}
                      className="h-6 rounded border bg-background px-0.5 text-[11px] disabled:border-transparent"
                      title="Weight"
                    >
                      {[1, 2, 3, 4, 5].map((w) => (
                        <option key={w} value={w}>
                          ×{w}
                        </option>
                      ))}
                    </select>
                  </div>
                </td>
                {options.map((o) => {
                  const sc = scoreOf(o.p.id, c.id)
                  const note = set.scores.find((s) => s.option === o.p.id && s.criterion === c.id)?.note ?? ''
                  return (
                    <td key={o.p.id} className="px-3 py-1.5" title={note}>
                      <div className="flex items-center gap-0.5" role="radiogroup" aria-label={`${c.name} score for ${o.p.title}`}>
                        {[1, 2, 3, 4, 5].map((n) => (
                          <button
                            key={n}
                            type="button"
                            role="radio"
                            aria-checked={sc === n}
                            disabled={!editable}
                            onClick={() => setScore(o.p.id, c.id, n)}
                            className={cn('size-4 rounded-sm border text-[0px]', sc !== null && n <= sc ? 'border-primary bg-primary/70' : 'bg-background')}
                          >
                            {n}
                          </button>
                        ))}
                        {note !== '' && <span className="ml-1.5 truncate text-[10.5px] text-muted-foreground">{note}</span>}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
            {set.criteria.length > 0 && (
              <tr className="border-t bg-muted/30 font-semibold">
                <td className="px-3 py-2">Weighted score</td>
                {options.map((o, i) => (
                  <td key={o.p.id} className={cn('px-3 py-2 tabular-nums', totals[i] === best && best > 0 && 'text-primary')}>
                    {totals[i] === null ? '—' : `${(totals[i] ?? 0).toFixed(1)} / 5`}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {editable && set.runId !== null && !decided && (
        <section className="flex items-end gap-2 rounded-xl border p-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-xs font-medium">Refine with AI</div>
            <TextArea value={refine} rows={2} placeholder="e.g. Make B use SQS instead of Kafka · Add an option with no new vendors · Score cost higher" onChange={setRefine} />
          </div>
          <Button
            size="sm"
            icon={<Sparkles />}
            disabled={refine.trim() === ''}
            onClick={() => {
              const run = set.runId === null ? undefined : getState().ai.runs[set.runId]
              if (run !== undefined && run.status !== 'running' && run.status !== 'starting') {
                setAi({ activeRunId: run.id, mode: 'solutions' })
                setUi({ aiOpen: true })
                void reply(run.id, refine.trim())
              } else void ask(refine.trim(), { mode: 'solutions', context: { solutionSetId: set.id } })
              setRefine('')
            }}
          >
            Ask
          </Button>
        </section>
      )}
    </div>
  )
}

function OptionCard({ o, set, total, best, editable }: { o: OptionView; set: SolutionSet; total: number | null; best: boolean; editable: boolean }): React.JSX.Element {
  const phases = phasesInOrder(useModel().meta)
  const [phase, setPhase] = useState<string>('')
  const chosen = set.chosen === o.p.id
  const decided = set.status === 'decided'
  const opt = o.p.option
  return (
    <article className={cn('flex flex-col rounded-xl border bg-popover', chosen && 'border-primary ring-1 ring-primary/50', decided && !chosen && 'opacity-70')}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-muted font-mono text-xs font-semibold">{opt?.key}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{o.p.title}</div>
          <div className="text-[10.5px] text-muted-foreground">
            {opt?.effort !== null && opt?.effort !== undefined ? `Effort ${opt.effort}` : 'Effort ?'}
            {total !== null && ` · ${total.toFixed(1)}/5`}
            {o.p.status === 'pending' && o.facts.stale > 0 && <span className="text-[var(--hx-warn)]"> · {o.facts.stale} changes no longer apply</span>}
            {o.p.status === 'discarded' && ' · set aside'}
          </div>
        </div>
        {chosen && (
          <span className="flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10.5px] font-medium text-primary">
            <Check className="size-3" />
            Chosen
          </span>
        )}
        {!chosen && best && !decided && <Trophy className="size-4 text-primary" aria-label="Highest weighted score" />}
      </div>
      <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(o.svg)}`} alt={`Diagram of option ${opt?.key ?? ''}`} className="h-56 w-full border-b bg-background object-contain" />
      <div className="flex flex-1 flex-col gap-2 p-3 text-xs">
        <div className="text-muted-foreground">
          <Markdown text={opt?.summary ?? o.p.rationale} />
        </div>
        {(opt?.pros.length ?? 0) > 0 && (
          <ul className="flex flex-col gap-0.5">
            {opt?.pros.map((x) => (
              <li key={x} className="flex gap-1.5">
                <span className="text-[var(--hx-add)]">+</span>
                {x}
              </li>
            ))}
          </ul>
        )}
        {(opt?.cons.length ?? 0) > 0 && (
          <ul className="flex flex-col gap-0.5">
            {opt?.cons.map((x) => (
              <li key={x} className="flex gap-1.5">
                <span className="text-[var(--hx-del)]">−</span>
                {x}
              </li>
            ))}
          </ul>
        )}
        {o.p.risks !== null && o.p.risks.trim() !== '' && <p className="text-[11px] text-[var(--hx-warn)]">Risks: {o.p.risks}</p>}
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
          <Button
            size="sm"
            variant="outline"
            icon={<Eye />}
            disabled={o.p.status !== 'pending' || o.p.ops.length === 0}
            onClick={() => {
              reviewProposal(o.p.id)
              setUi({ view: 'canvas', asOf: null })
            }}
          >
            Review on canvas
          </Button>
          {editable && !decided && (
            <>
              {phases.length > 0 && (
                <select aria-label="Phase for the chosen option" value={phase} onChange={(e) => setPhase(e.target.value)} className="h-7 rounded-md border bg-background px-1 text-xs" title="Accept now, or as planned work in a phase">
                  <option value="">accept now</option>
                  {phases.map((p) => (
                    <option key={p.id} value={p.id}>
                      plan in {p.name}
                    </option>
                  ))}
                </select>
              )}
              <Button size="sm" icon={phase === '' ? <Check /> : <Flag />} onClick={() => void chooseOption(set, o.p.id, { planned: phase !== '', phase: phase === '' ? null : phase })}>
                Choose
              </Button>
            </>
          )}
        </div>
      </div>
    </article>
  )
}
