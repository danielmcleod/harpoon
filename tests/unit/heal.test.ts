// Healing rejected requests: safe fixes only, checked again before they are sent; the client retries once and says so.
import { afterEach, describe, expect, it } from 'vitest'
import { healRequest } from '../../src/shared/heal.ts'
import { parseRequest } from '../../src/shared/ipc-schemas.ts'

const view = { focusId: null, expanded: [], style: 'flat', theme: 'dark', includeNotes: false }

/** The issues main would send back for `raw`. */
function rejected(cmd: Parameters<typeof parseRequest>[0], raw: unknown): unknown[] {
  const r = parseRequest(cmd, raw)
  if (r.ok) throw new Error('expected a rejection')
  return r.error.details as unknown[]
}

describe('healRequest', () => {
  it('drops unknown fields, trims what is too long, and the result passes the check', () => {
    const raw = { format: 'mermaid', view: { ...view, zoom: 2 }, proposalId: 'x'.repeat(500) }
    const h = healRequest(raw, rejected('export.render', raw))
    expect(h?.changes.join(' ')).toMatch(/dropped “zoom” from view/)
    expect(parseRequest('export.render', h?.value).ok).toBe(true)
    expect(raw.view).toHaveProperty('zoom')
  })

  it('does not guess at a wrong value', () => {
    const raw = { format: 'mermaid', view: { ...view, theme: 'sepia' } }
    expect(healRequest(raw, rejected('export.render', raw))).toBeNull()
  })
})

describe('invoke', () => {
  const w = globalThis as unknown as { harpoon?: unknown }
  afterEach(() => {
    delete w.harpoon
  })

  it('sends a healed request once and reports it', async () => {
    const sent: unknown[] = []
    w.harpoon = {
      subscribe: () => () => {},
      invoke: (cmd: 'export.render', req: unknown) => {
        sent.push(req)
        const r = parseRequest(cmd, req)
        return r.ok ? { ok: true, value: { filename: 'a.mmd', content: '', mime: 'text/plain' } } : r
      },
    }
    const { invoke, onHeal } = await import('../../src/renderer/src/ipc/client.ts')
    const notes: string[] = []
    onHeal((n) => notes.push(n.changes.join('; ')))
    const r = await invoke('export.render', { format: 'mermaid', view: { ...view, zoom: 2 } } as never)
    expect(r.ok).toBe(true)
    expect(sent).toHaveLength(2)
    expect(notes[0]).toMatch(/zoom/)
  })
})
