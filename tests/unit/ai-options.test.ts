// Model, effort and import scope reach the CLIs as their own flags, and the AI start request is checked.
import { describe, expect, it } from 'vitest'
import { buildArgv } from '../../src/core/adapters/claude/launch.ts'
import { execArgv } from '../../src/core/adapters/codex/launch.ts'
import { turnStartParams } from '../../src/core/adapters/codex/params.ts'
import { parseRequest } from '../../src/shared/ipc-schemas.ts'

const start = { vendor: 'claude', mode: 'import', prompt: 'only checkout', selection: { nodeIds: [], connectorIds: [], focusId: null } }

describe('ai.start request', () => {
  it('takes effort and context (import repos, notes)', () => {
    const r = parseRequest('ai.start', { ...start, model: 'claude-opus-5-5', effort: 'high', context: { repoIds: ['api', 'web'], notePath: 'project.md', noteTask: 'summarize' } })
    expect(r.ok).toBe(true)
  })
  it('refuses a model id that is not one', () => {
    expect(parseRequest('ai.start', { ...start, model: 'opus; rm -rf /' }).ok).toBe(false)
    expect(parseRequest('ai.start', { ...start, effort: 'HIGH --x' }).ok).toBe(false)
  })
})

describe('effort flags', () => {
  it('Claude gets --effort', () => {
    const a = buildArgv({ route: 'readonly', mode: 'readonly', step: 'design', model: 'opus', effort: 'high' })
    expect(a.join(' ')).toContain('--model opus --effort high')
  })
  it('Codex gets it on turn/start and in exec', () => {
    expect(turnStartParams({ threadId: 't', prompt: 'p', effort: 'xhigh' })).toMatchObject({ effort: 'xhigh' })
    const a = execArgv({ step: 'design', mode: 'readonly', cwd: '/tmp', model: 'gpt-6-luna', effort: 'low', outFile: '/tmp/o' })
    expect(a).toContain('model_reasoning_effort="low"')
  })
})
