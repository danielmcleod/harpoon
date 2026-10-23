// A Claude answer given while background work (a shell, a sub-agent) still runs does not end the pass: it waits for
// the CLI's follow-up turn when the work finishes (frames as Claude Code 2.1 streams them).
import { expect, it } from 'vitest'
import { ClaudeNormalizer } from '../../src/core/adapters/claude/normalize.ts'

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

it('ends with the answer it has when no follow-up turn comes', () => {
  const n = new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 1000 })
  n.line(JSON.stringify(frames.started))
  n.line(JSON.stringify(frames.answer))
  expect(n.finishHeld().events.find((e) => e.type === 'done')).toMatchObject({ result: 'Started the tests.' })
})
