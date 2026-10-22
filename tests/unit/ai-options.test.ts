// Model, effort and import scope reach the CLIs as their own flags, and the AI start request is checked.
import { describe, expect, it } from 'vitest'
import { buildArgv } from '../../src/core/adapters/claude/launch.ts'
import { execArgv } from '../../src/core/adapters/codex/launch.ts'
import { turnStartParams } from '../../src/core/adapters/codex/params.ts'
import { parseRequest } from '../../src/shared/ipc-schemas.ts'
import { parseClaudeMcpList } from '../../src/core/ai/user-tools.ts'

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

describe('your own tools in a conversation', () => {
  it('reads the connectors claude mcp list reports', () => {
    const out = ['Checking MCP server health…', '', 'claude.ai Linear: https://mcp.linear.app/mcp - ✔ Connected', 'claude.ai Jira: https://mcp.atlassian.com/v1/sse - ✗ Failed to connect', 'linear: npx -y linear-mcp - ✔ Connected'].join('\n')
    expect(parseClaudeMcpList(out)).toEqual([
      { name: 'claude.ai Linear', ok: true },
      { name: 'claude.ai Jira', ok: false },
    ])
  })

  it('Claude keeps reading code and may use the picked server', () => {
    const a = buildArgv({ route: 'readonly', mode: 'readonly', step: 'design', mcp: { name: 'harpoon', configFile: '/tmp/m.json', allow: ['linear'] } })
    expect(a[a.indexOf('--tools') + 1]).toContain('Read')
    expect(a[a.indexOf('--allowedTools') + 1]).toBe('mcp__harpoon__*,mcp__linear__*')
    const publish = buildArgv({ route: 'readonly', mode: 'readonly', step: 'design', mcp: { name: 'harpoon', configFile: '/tmp/m.json', allow: ['notion'], readCode: false } })
    expect(publish[publish.indexOf('--tools') + 1]).toBe('')
  })

  it('Codex keeps the apps on its account off unless picked', () => {
    const base = { step: 'design', mode: 'readonly', cwd: '/tmp', outFile: '/tmp/o' } as const
    const mcp = { name: 'harpoon', url: 'http://127.0.0.1:1/mcp/x', tokenEnv: 'T' }
    expect(execArgv({ ...base, mcp }).join(' ')).toContain('features.apps=false')
    const on = execArgv({ ...base, mcp: { ...mcp, allow: ['codex_apps'] } }).join(' ')
    expect(on).not.toContain('features.apps=false')
    expect(on).not.toContain('codex_apps.default_tools_approval_mode')
  })
})
