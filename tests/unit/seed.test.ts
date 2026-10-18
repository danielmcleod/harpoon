import { describe, expect, it } from 'vitest'
import { applySeed } from '../../src/core/ingest/apply-seed.ts'
import { Draft } from '../../src/core/ai/draft.ts'
import { kindFromImage, seedRepository } from '../../src/core/ingest/seed.ts'
import { emptyModel } from '../../src/shared/model/schema.ts'

describe('repository seed', () => {
  it('reads docker-compose services, kinds and links', async () => {
    const seed = await seedRepository('tests/fixtures/shop')
    const kinds = Object.fromEntries(seed.nodes.map((n) => [n.name, n.kind]))
    expect(kinds).toMatchObject({ gateway: 'gateway', 'orders-db': 'database', cache: 'cache', kafka: 'stream', orders: 'service' })
    expect(seed.links).toContainEqual(expect.objectContaining({ from: 'orders', to: 'payments', protocol: 'HTTP' }))
    expect(kindFromImage('bitnami/rabbitmq:3').kind).toBe('queue')
  })

  it('stages the seed into a draft with layout and evidence', async () => {
    const seed = await seedRepository('tests/fixtures/shop')
    const draft = new Draft(emptyModel({ id: 'p', name: 'P' }))
    const r = applySeed(draft, seed, 'run1')
    expect(r.added).toBe(7)
    const m = draft.model
    expect(Object.keys(m.layout)).toHaveLength(7)
    expect(m.nodes['orders']?.evidence[0]?.path).toBe('docker-compose.yml')
    expect(new Set(Object.values(m.layout).map((c) => `${c.q},${c.r}`)).size).toBe(7)
  })
})
