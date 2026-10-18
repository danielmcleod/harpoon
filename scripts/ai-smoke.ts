// Live smoke test of the AI path (real CLI, real tokens): creates the sample project in a temp folder, asks the
// chosen vendor to plan a change, and prints the run's activity and the resulting proposal.
//   node scripts/ai-smoke.ts [claude|codex] [model|-] [plan|import] [fixture folder to copy in, for import]
import { cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore } from '../src/core/app-core.ts'
import { createLogger } from '../src/core/log.ts'
import type { AiRunView, Proposal } from '../src/shared/ipc.ts'

const vendor = (process.argv[2] ?? 'claude') as 'claude' | 'codex'
const model = process.argv[3] === undefined || process.argv[3] === '-' ? null : process.argv[3]
const mode = (process.argv[4] ?? 'plan') as 'plan' | 'import' | 'solutions' | 'decision' | 'scan' | 'notes'
const fixture = process.argv[5] === '-' ? undefined : process.argv[5]
const promptOverride = process.argv[6]
const home = await mkdtemp(join(tmpdir(), 'harpoon-home-'))
const root = await mkdtemp(join(tmpdir(), 'harpoon-proj-'))
const core = await createCore({ home, log: createLogger({ file: join(home, 'smoke.log'), console: false }) })

let last: AiRunView | null = null
let proposal: Proposal | null = null
const allProposals = new Map<string, Proposal>()
core.bus.on((e) => {
  if (e.kind === 'ai-run') last = e.run
  if (e.kind === 'proposal') {
    proposal = e.proposal
    allProposals.set(e.proposal.id, e.proposal)
  }
  if (e.kind === 'ai-highlight') console.log('highlight', e.nodeIds, e.note)
})

if (fixture !== undefined) await cp(fixture, root, { recursive: true })
const created = await core.invoke('project.create', { dir: root, template: mode === 'import' ? 'blank' : 'sample' })
if (!created.ok) throw new Error(created.error.message)
// HARPOON_SMOKE_REPOS: comma-separated folders to link as the project's repositories (multi-repo runs).
const linked = (process.env['HARPOON_SMOKE_REPOS'] ?? '').split(',').filter((x) => x.trim() !== '')
if (linked.length > 0) {
  const repos = linked.map((path, i) => ({ id: `repo-${i + 1}`, name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? `repo-${i + 1}`, path, remote: null, role: 'service', defaultBranch: null }))
  const r = await core.invoke('project.apply', { ops: [{ op: 'updateMeta', patch: { repos } }], label: 'link repos' })
  if (!r.ok) throw new Error(r.error.message)
}
// notes mode: the prompt is the note's text; the run works on it (HARPOON_SMOKE_NOTE_TASK: summarize | extract).
const noteTask = (process.env['HARPOON_SMOKE_NOTE_TASK'] ?? 'extract') as 'summarize' | 'extract'
if (mode === 'notes') {
  const w = await core.invoke('notes.write', { path: 'project.md', meta: { title: 'Arch review 2026-10-18', date: '2026-10-18', attendees: [], summary: '', items: [], cadence: null }, body: promptOverride ?? '' })
  if (!w.ok) throw new Error(w.error.message)
}
const started = await core.invoke('ai.start', {
  vendor,
  model,
  mode,
  prompt:
    promptOverride !== undefined
      ? promptOverride
      : mode === 'import'
      ? ''
      : 'Add an asynchronous fraud scoring engine that evaluates orders from payment-api via Kafka, and alerts our third-party PagerDuty webhook on high risk.',
  selection: { nodeIds: [], connectorIds: [], focusId: null },
  ...(mode === 'notes' ? { context: { notePath: 'project.md', noteTask } } : {}),
})
if (!started.ok) throw new Error(started.error.message)
console.log('started', (started.value as AiRunView).id)

const t0 = Date.now()
while (Date.now() - t0 < 10 * 60_000) {
  await new Promise((r) => setTimeout(r, 1000))
  const v = last as AiRunView | null
  if (v !== null && (v.status === 'done' || v.status === 'failed' || v.status === 'cancelled')) break
}
const v = last as AiRunView | null
console.log('status', v?.status, 'error', v?.error, 'usage', JSON.stringify(v?.usage))
for (const a of v?.activity ?? []) console.log(' tool', a.status, a.name, a.summary.slice(0, 100))
if (v?.questions != null) for (const q of v.questions) console.log('QUESTION', q.question, '|', q.options.join(' / '))
console.log('reply:', v?.turns.filter((t) => t.role === 'assistant').map((t) => t.text).join('\n---\n').slice(0, 800))
if (v?.solutionSetId != null) {
  const sets = await core.invoke('collection.list', { kind: 'solutions' })
  const set = sets.ok ? (sets.value as { id: string; problem: string; criteria: { name: string; weight: number }[]; recommendation: unknown }[]).find((x) => x.id === v.solutionSetId) : undefined
  console.log('SOLUTION SET', JSON.stringify({ problem: set?.problem, criteria: set?.criteria, recommendation: set?.recommendation }))
  for (const o of allProposals.values()) {
    console.log(`  OPTION ${o.option?.key} ${o.title} | ${o.ops.length} ops | effort ${o.option?.effort} | pros ${o.option?.pros.length} cons ${o.option?.cons.length}`)
    for (const op of o.ops) console.log('     ', op.op, 'node' in op ? `${op.node.id} [${op.node.kind}]` : 'connector' in op ? `${op.connector.source}→${op.connector.target}` : 'id' in op ? op.id : '')
  }
}
if (v?.suggestions != null) {
  console.log('SCAN', v.suggestions.summary.slice(0, 300))
  for (const r of v.suggestions.rules) console.log('  RULE', r.rule.name, `| ${r.applies - r.violations.length}/${r.applies} follow`, JSON.stringify(r.rule.require).slice(0, 120))
  for (const g of v.suggestions.guidelines) console.log('  GUIDELINE', g.title, '|', g.prevalence)
}
if (mode === 'notes') {
  const n = await core.invoke('notes.read', { path: 'project.md' })
  if (n.ok) {
    const doc = n.value as { meta: { summary: string; items: { kind: string; action: string; text: string }[] } }
    console.log('SUMMARY', doc.meta.summary.slice(0, 400))
    for (const it of doc.meta.items) console.log('  ITEM', it.kind, '->', it.action, '|', it.text.slice(0, 110))
  }
}
if (v?.decisionId != null) {
  const ds = await core.invoke('collection.list', { kind: 'decisions' })
  const d = ds.ok ? (ds.value as { id: string; title: string; context: string; decision: string; options: unknown[] }[]).find((x) => x.id === v.decisionId) : undefined
  console.log('DECISION', d?.id, '|', d?.title, '| options', d?.options.length, '\n', d?.decision.slice(0, 300))
}
const p = (v?.mode === 'solutions' ? null : proposal) as Proposal | null
if (p !== null) {
  console.log('PROPOSAL', p.title, '|', p.ops.length, 'ops')
  for (const o of p.ops) console.log('  ', o.op, 'node' in o ? `${o.node.id}${o.node.parentId !== null ? ` (in ${o.node.parentId})` : ''} [${o.node.kind}] features=${o.node.features.length} ev=${o.node.evidence.length}` : 'connector' in o ? `${o.connector.source}→${o.connector.target} ${o.connector.channelA.protocol}${o.connector.sync === 'async' ? ' async' : ''}` : 'id' in o ? o.id : '')
  const acc = await core.invoke('proposal.accept', { id: p.id })
  console.log('accept', acc.ok ? 'ok' : acc.error.message)
}
await core.shutdown()
process.exit(0)
