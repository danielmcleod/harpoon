import { describe, expect, it } from 'vitest'
import { buildArgv } from '../../src/core/adapters/claude/launch.ts'
import { attachFileToPage } from '../../src/core/export/notion-api.ts'
import type { FetchFn } from '../../src/core/export/notion-api.ts'
import { notionSections, notionZip } from '../../src/core/export/notion.ts'
import { claudeToolPrefix, notionPageId } from '../../src/core/project/publish.ts'
import type { DecisionRecord } from '../../src/shared/ipc.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import { sampleOps } from '../../src/shared/model/sample.ts'
import { emptyModel } from '../../src/shared/model/schema.ts'

const sample = () => applyOps(emptyModel({ id: 'p', name: 'Commerce Platform' }), sampleOps()).model
const adr: DecisionRecord = {
  id: 'adr-0001', number: 1, title: 'Use Kafka for payment events', status: 'accepted', date: '2026-10-18', deciders: [], context: 'c', decision: 'd', consequences: '',
  options: [], entityIds: [], phase: null, supersedes: null, supersededBy: null, solutionSetId: null, links: [], source: null, createdAt: 0,
}

describe('Notion', () => {
  it('reads the page id from a Notion link and names the Claude tools of a server', () => {
    expect(notionPageId('https://www.notion.so/acme/Architecture-1234567890abcdef1234567890abcdef?pvs=4')).toBe('12345678-90ab-cdef-1234-567890abcdef')
    expect(notionPageId('not a page')).toBeNull()
    expect(claudeToolPrefix('claude.ai Notion')).toBe('mcp__claude_ai_Notion__')
  })

  it('lays the pages out as a tree Notion imports', () => {
    const sections = notionSections({ model: sample(), decisions: [adr], notes: null, diagram: 'diagram.png', bundle: 'x-harpoon.zip', date: '2026-10-18' })
    expect(sections.map((s) => s.key)).toEqual(['overview', 'architecture', 'decisions', 'adr:adr-0001'])
    const names = notionZip(sections, [{ name: 'diagram.png', data: 'png' }]).map((e) => e.name)
    expect(names).toEqual([
      'Commerce Platform.md',
      'Commerce Platform/Architecture.md',
      'Commerce Platform/Decision log.md',
      'Commerce Platform/Decision log/ADR-0001 Use Kafka for payment events.md',
      'Commerce Platform/diagram.png',
    ])
    const overview = String(notionZip(sections, [])[0]?.data)
    expect(overview).toContain('](Commerce%20Platform/diagram.png)')
    expect(overview).toContain('[Decision log](Commerce%20Platform/Decision%20log.md)')
  })

  it('attaches a file: upload, send, append a file block', async () => {
    const calls: { url: string; method: string; auth: string | undefined }[] = []
    const fake: FetchFn = (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers['Authorization'] })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(url.endsWith('/file_uploads') ? { id: 'up-1' } : {}), text: () => Promise.resolve('') })
    }
    const id = await attachFileToPage({ fetch: fake, token: 'secret_x', pageId: 'pg', filename: 'b.zip', contentType: 'application/zip', bytes: new Uint8Array([1, 2, 3]) })
    expect(id).toBe('up-1')
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.notion.com/v1', '')}`)).toEqual(['POST /file_uploads', 'POST /file_uploads/up-1/send', 'PATCH /blocks/pg/children'])
    expect(calls.every((c) => c.auth === 'Bearer secret_x')).toBe(true)
  })

  it('a publish pass loads the user’s Notion server and allows only its tools besides Harpoon’s', () => {
    const base = { route: 'readonly' as const, mode: 'readonly' as const, step: 'design' as const }
    const strict = buildArgv({ ...base, mcp: { name: 'harpoon', configFile: 'm.json' } })
    expect(strict).toContain('--strict-mcp-config')
    const pub = buildArgv({ ...base, mcp: { name: 'harpoon', configFile: 'm.json', allow: ['claude.ai Notion'] } })
    expect(pub).not.toContain('--strict-mcp-config')
    expect(pub[pub.indexOf('--allowedTools') + 1]).toBe('mcp__harpoon__*,mcp__claude_ai_Notion__*')
    // Design passes: user settings only (never the repository's), and only code-reading built-in tools.
    expect(strict[strict.indexOf('--setting-sources') + 1]).toBe('user')
    expect(strict[strict.indexOf('--tools') + 1]).toBe('Read,Glob,Grep')
    // Publishing: no built-in tools; a Notion server from the user's config is copied into the run's file, so
    // the pass stays strict.
    expect(pub[pub.indexOf('--tools') + 1]).toBe('')
    const fileServer = buildArgv({ ...base, mcp: { name: 'harpoon', configFile: 'm.json', allow: ['notion'] } })
    expect(fileServer).toContain('--strict-mcp-config')
  })
})

describe('scrubbing', () => {
  it('redacts Notion, Slack and Stripe tokens', async () => {
    const { redactText } = await import('../../src/shared/redact.ts')
    const s = 'notion ntn_1234567890abcdefghijABCDEFGHIJ1234 slack xoxb-1234567890-abcdefghij stripe sk_live_ABCDEFGHIJKLMNOP1234'
    const out = redactText(s, { mode: 'diagnostics' }).text
    expect(out).not.toMatch(/ntn_|xoxb-|sk_live_/)
  })
})
