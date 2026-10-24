// A Claude or Codex answer given while background work (a shell, a sub-agent) still runs does not end the pass: it waits
// for the turn that follows when the work finishes (Claude frames as Claude Code 2.1 streams them).
import { expect, it } from 'vitest'
import { ClaudeNormalizer } from '../../src/core/adapters/claude/normalize.ts'
import { CodexNormalizer } from '../../src/core/adapters/codex/normalize.ts'

const frames = {
  started: { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'Run the test suite' }] },
  answer: { type: 'result', subtype: 'success', is_error: false, result: 'Started the tests.', modelUsage: {} },
  finished: { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
  followUp: { type: 'result', subtype: 'success', is_error: false, result: 'All 42 tests pass.', modelUsage: {} },
}

it('holds the answer while background work runs, then ends with the follow-up turn', () => {
  const n = new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 1000 })
  const started = n.line(JSON.stringify(frames.started))
  expect(started.signals).toContainEqual({ type: 'waiting', tasks: ['Run the test suite'] })

  const answer = n.line(JSON.stringify(frames.answer))
  expect(answer.events.some((e) => e.type === 'done')).toBe(false)
  expect(n.waiting).toBe(true)

  expect(n.line(JSON.stringify(frames.finished)).drained).toBe(true)
  const done = n.line(JSON.stringify(frames.followUp)).events.find((e) => e.type === 'done')
  expect(done).toMatchObject({ type: 'done', result: 'All 42 tests pass.' })
  expect(n.waiting).toBe(false)
})

// Codex (app-server, frames as 0.160 sends them): a sub-agent runs on its own thread; the main turn ends first.
it('Codex: holds the answer until its sub-agents finish, keeping their words out of the conversation', () => {
  const n = new CodexNormalizer({ step: 'implement', mode: 'autoedit', cwd: '/repo', planNative: false, resumed: false, askTimeoutMs: 1000, allowRules: [], structured: false, loopback: false, now: Date.now })
  n.session('main')
  n.turnStarted('t1')
  const note = (method: string, params: object) => n.notification(method, params)
  const activity = (kind: string) => ({ threadId: 'main', turnId: 't1', item: { type: 'subAgentActivity', id: `a-${kind}`, kind, agentThreadId: 'sub', agentPath: '/root/run_tests' } })
  const started = note('item/started', activity('started'))
  expect(started.signals).toContainEqual({ type: 'waiting', tasks: ['sub-agent /root/run_tests'] })
  note('item/completed', { threadId: 'main', turnId: 't1', item: { type: 'agentMessage', id: 'm1', text: 'started' } })
  const ended = note('turn/completed', { threadId: 'main', turn: { id: 't1', status: 'completed' } })
  expect(ended.events.some((e) => e.type === 'done')).toBe(false)
  expect(n.waiting).toBe(true)

  // The sub-agent's own thread: its report is kept, not shown, and its turn/completed does not end the pass.
  const said = note('item/completed', { threadId: 'sub', turnId: 's1', item: { type: 'agentMessage', id: 'm2', text: 'All 42 tests pass.' } })
  expect(said.events).toEqual([])
  expect(note('turn/completed', { threadId: 'sub', turn: { id: 's1', status: 'completed' } }).events).toEqual([])

  expect(note('item/completed', activity('completed')).subAgentsDone).toBe(true)
  expect(n.subAgentFollowUp()).toContain('All 42 tests pass.')
  n.newTurn()
  note('turn/started', { threadId: 'main', turn: { id: 't2' } })
  note('item/completed', { threadId: 'main', turnId: 't2', item: { type: 'agentMessage', id: 'm3', text: 'Done: the tests pass.' } })
  const done = note('turn/completed', { threadId: 'main', turn: { id: 't2', status: 'completed' } }).events.find((e) => e.type === 'done')
  expect(done).toMatchObject({ result: 'Done: the tests pass.' })
})

it('ends with the answer it has when no follow-up turn comes', () => {
  const n = new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 1000 })
  n.line(JSON.stringify(frames.started))
  n.line(JSON.stringify(frames.answer))
  expect(n.finishHeld().events.find((e) => e.type === 'done')).toMatchObject({ result: 'Started the tests.' })
})
