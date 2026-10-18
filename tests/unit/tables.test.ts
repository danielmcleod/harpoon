import { describe, expect, it } from 'vitest'
import { applyOps } from '../../src/shared/model/ops.ts'
import { sampleOps } from '../../src/shared/model/sample.ts'
import { emptyModel } from '../../src/shared/model/schema.ts'
import { changeRows, connectorRows, dependencyMatrix, serviceRows, toCsv, toMarkdown } from '../../src/renderer/src/tables/rows.ts'

const sample = () => applyOps(emptyModel({ id: 'p', name: 'P' }), sampleOps()).model

describe('table rows', () => {
  it('nests services as a tree and counts their links', () => {
    const rows = serviceRows(sample())
    const auth = rows.find((r) => r.id === 'auth-service')
    expect(auth?.subRows?.map((r) => r.id)).toContain('user-db')
    expect(rows.find((r) => r.id === 'api-gateway')?.outbound).toBeGreaterThan(0)
    expect(connectorRows(sample()).length).toBe(Object.keys(sample().connectors).length)
  })

  it('lists planned work, phased first', () => {
    const m = applyOps(sample(), [
      { op: 'updateMeta', patch: { phases: [{ id: 'p1', name: 'MVP', order: 1, target: null, status: 'active', description: '' }] } },
      { op: 'updateNode', id: 'user-service', patch: { status: 'planned' } },
      { op: 'updateNode', id: 'notification-worker', patch: { status: 'deprecated', phase: 'p1' } },
    ]).model
    expect(changeRows(m).map((r) => [r.entityId, r.change, r.phase])).toEqual([
      ['notification-worker', 'retire', 'MVP'],
      ['user-service', 'add', ''],
    ])
  })

  it('builds the dependency matrix, lifted to top-level services unless asked for inner parts', () => {
    const m = applyOps(sample(), [{ op: 'updateConnector', id: 'gateway-auth', patch: { channelA: { ...sample().connectors['gateway-auth']!.channelA, protocol: '' } } }]).model
    const top = dependencyMatrix(m)
    expect(top.services.some((s) => s.id === 'user-api')).toBe(false)
    const cell = top.cells['api-gateway>auth-service']
    expect(cell?.connectorIds).toEqual(['gateway-auth'])
    expect(cell?.problems).toBeGreaterThan(0)
    expect(top.cells['payment-api>stripe']?.family).toBe('http')
    const inner = dependencyMatrix(m, undefined, true)
    expect(inner.services.find((s) => s.id === 'user-api')?.depth).toBe(1)
    expect(inner.cells['user-api>user-db']?.family).toBe('data')
  })

  it('quotes CSV and escapes Markdown', () => {
    expect(toCsv(['a', 'b'], [['x, y', 'say "hi"']])).toBe('a,b\r\n"x, y","say ""hi"""\r\n')
    expect(toMarkdown(['a'], [['p|q']])).toContain('p\\|q')
  })
})
