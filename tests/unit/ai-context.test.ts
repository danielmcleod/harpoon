// What AI requests carry: conventions by name once they get long, the selection as one line, tools suggested from
// what the user types, and issue links (their tracker and key, empty by default).
import { describe, expect, it } from 'vitest'
import { firstPrompt, scopeLine } from '../../src/core/ai/prompts.ts'
import { keyOf, trackerOf } from '../../src/shared/model/issues.ts'
import { NodeZ, emptyModel } from '../../src/shared/model/schema.ts'
import { alwaysOn, suggestTools } from '../../src/renderer/src/ai/toolHints.ts'
import type { UserTool } from '../../src/shared/ipc.ts'

const NONE = { nodeIds: [], connectorIds: [], focusId: null }

describe('prompts', () => {
  it('inlines short conventions and names long ones (get_rules has the text)', () => {
    const m = emptyModel({ id: 'p', name: 'Shop' })
    m.meta.guidelines = [{ id: 'g1', title: 'Outbox for events', text: 'Write events with the outbox.', enabled: true, evidence: '' }]
    expect(firstPrompt({ mode: 'plan', prompt: 'x', selection: NONE, model: m })).toContain('Write events with the outbox.')
    m.meta.guidelines = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, title: `Guideline ${i}`, text: 'x'.repeat(300), enabled: true, evidence: '' }))
    const p = firstPrompt({ mode: 'plan', prompt: 'x', selection: NONE, model: m })
    expect(p).toContain('call get_rules for their text')
    expect(p).not.toContain('x'.repeat(300))
  })

  it('names the selection with ids, and nothing for none', () => {
    const m = emptyModel({ id: 'p', name: 'Shop' })
    m.nodes['pay'] = NodeZ.parse({ id: 'pay', name: 'Payments' })
    expect(scopeLine({ nodeIds: ['pay'], connectorIds: [], focusId: null }, m)).toBe('Context: Selected nodes: Payments (pay).')
    expect(scopeLine(NONE, m)).toBe('')
  })
})

describe('tools', () => {
  const tools: UserTool[] = [
    { name: 'claude.ai Linear', label: 'Linear', kind: 'connector', ok: true },
    { name: 'github', label: 'github', kind: 'server', ok: true },
    { name: 'sentry', label: 'sentry', kind: 'server', ok: true },
  ]
  it('suggests the tool a message names, or any tracker for "issues"', () => {
    expect(suggestTools('create a Linear issue for this', tools, {}).map((t) => t.label)).toEqual(['Linear'])
    expect(suggestTools('open a PR with the fix', tools, {}).map((t) => t.name)).toEqual(['github'])
    expect(suggestTools('file tickets for these', tools, {}).map((t) => t.name)).toEqual(['claude.ai Linear', 'github'])
    expect(suggestTools('what does checkout call?', tools, {})).toEqual([])
  })
  it('never suggests tools that are off or always on', () => {
    expect(suggestTools('create a Linear issue', tools, { 'claude.ai Linear': 'off' })).toEqual([])
    expect(alwaysOn(tools, { github: 'always', sentry: 'suggest' })).toEqual(['github'])
  })
})

describe('issue links', () => {
  it('knows the tracker and key from the URL', () => {
    expect([trackerOf('https://linear.app/acme/issue/LIN-123/add-scorer'), keyOf('https://linear.app/acme/issue/LIN-123/add-scorer')]).toEqual(['linear', 'LIN-123'])
    expect([trackerOf('https://github.com/acme/shop/issues/42'), keyOf('https://github.com/acme/shop/issues/42')]).toEqual(['github', '#42'])
    expect([trackerOf('https://acme.atlassian.net/browse/PAY-7'), keyOf('https://acme.atlassian.net/browse/PAY-7')]).toEqual(['jira', 'PAY-7'])
  })
  it('defaults to none on older projects', () => {
    expect(NodeZ.parse({ id: 'a', name: 'A' }).issues).toEqual([])
  })
})

describe('link_issue', () => {
  it('stages the link on a planned node (same url again updates it)', async () => {
    const { Draft } = await import('../../src/core/ai/draft.ts')
    const { registerTools } = await import('../../src/core/ai/tools.ts')
    const m = emptyModel({ id: 'p', name: 'Shop' })
    m.nodes['fraud'] = NodeZ.parse({ id: 'fraud', name: 'Fraud scorer', status: 'planned' })
    const draft = new Draft(m)
    const handlers: Record<string, (a: Record<string, unknown>) => Promise<{ isError?: boolean }>> = {}
    const server = { registerTool: (name: string, _c: unknown, h: (a: Record<string, unknown>) => Promise<{ isError?: boolean }>) => (handlers[name] = h) }
    const noop = (): void => undefined
    registerTools(server as never, { draft, mode: 'track', runId: 'r', provenance: 'ai-plan', selection: NONE, onChange: noop, onHighlight: noop, onSubmit: noop, onAsk: noop, onActivity: noop } as never)
    const link = handlers['link_issue']
    expect(link).toBeDefined()
    await link?.({ nodeId: 'fraud', url: 'https://linear.app/acme/issue/LIN-9/x', key: 'LIN-9' })
    await link?.({ nodeId: 'fraud', url: 'https://linear.app/acme/issue/LIN-9/x', key: 'LIN-9', state: 'closed' })
    expect(draft.model.nodes['fraud']?.issues).toMatchObject([{ key: 'LIN-9', tracker: 'linear', state: 'closed' }])
  })
})
