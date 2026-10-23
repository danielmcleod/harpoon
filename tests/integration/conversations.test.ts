// AI conversations outlive the app: kept per project on this computer, back when the project opens (one that was
// running shows as interrupted), and gone when deleted.
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createCore } from '../../src/core/app-core.ts'
import type { Core } from '../../src/core/app-core.ts'
import { ConversationStore } from '../../src/core/ai/conversations.ts'
import { nullLogger } from '../../src/core/log.ts'
import type { AiRunView, ProjectView } from '../../src/shared/ipc.ts'

const dirs: string[] = []
let core: Core | null = null
afterEach(async () => {
  await core?.shutdown()
  core = null
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'harpoon-'))
  dirs.push(d)
  return d
}

const view = (id: string, status: AiRunView['status']): AiRunView => ({
  id, vendor: 'claude', model: null, effort: null, external: false, tools: [], plan: null, quietSince: null, mode: 'plan', status,
  title: `Conversation ${id}`, createdAt: Date.now(), turns: [{ role: 'user', text: 'Add a fraud scorer' }, { role: 'assistant', text: 'Staged it.' }],
  activity: [], usage: null, proposalId: null, error: null, changeCount: 0, phase: null, questions: null, solutionSetId: null, decisionId: null,
  options: [], activeOption: null, suggestions: null, notePath: null,
})

it('brings back a project’s conversations, and forgets a deleted one', async () => {
  const home = await tmp()
  core = await createCore({ home, log: nullLogger })
  const opened = await core.invoke('project.create', { dir: await tmp(), template: 'sample' })
  if (!opened.ok) throw new Error(opened.error.message)
  const pid = (opened.value as ProjectView).model.meta.id

  // As an earlier session left them: one finished, one cut off mid-run.
  const store = new ConversationStore(join(home, 'conversations'))
  for (const [id, status] of [['ai_old', 'done'], ['ai_cut', 'running']] as const) {
    await store.save({ version: 1, projectId: pid, view: view(id, status), sessionId: `session-${id}`, context: {}, selection: { nodeIds: [], connectorIds: [], focusId: null }, planPrompt: null, planSaved: null, proposalSeq: 1 })
  }
  await store.save({ version: 1, projectId: 'another-project', view: view('ai_other', 'done'), sessionId: null, context: {}, selection: { nodeIds: [], connectorIds: [], focusId: null }, planPrompt: null, planSaved: null, proposalSeq: 0 })

  await core.ai.loadHistory()
  const runs = await core.invoke('ai.runs', undefined)
  if (!runs.ok) throw new Error(runs.error.message)
  const list = runs.value as AiRunView[]
  expect(list.map((r) => r.id).sort()).toEqual(['ai_cut', 'ai_old'])
  const cut = list.find((r) => r.id === 'ai_cut')
  expect(cut?.status).toBe('cancelled')
  expect(cut?.error).toContain('Interrupted')
  expect(list.find((r) => r.id === 'ai_old')?.turns[1]?.text).toBe('Staged it.')

  const del = await core.invoke('ai.delete', { runId: 'ai_old' })
  if (!del.ok) throw new Error(del.error.message)
  expect(await readdir(join(home, 'conversations', pid))).toEqual(['ai_cut.json'])
}, 30_000)
