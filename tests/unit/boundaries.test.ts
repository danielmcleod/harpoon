// Boundary checks without AI, and the request "Check with AI" sends for one zone.
import { expect, it } from 'vitest'
import { boundaryProblems } from '../../src/shared/model/boundaries.ts'
import { BoundaryZ, ConnectorZ, NodeZ, emptyModel } from '../../src/shared/model/schema.ts'
import type { Model } from '../../src/shared/model/schema.ts'
import { boundaryCheckPrompt } from '../../src/renderer/src/ai/boundaryPrompt.ts'

function shop(): Model {
  const m = emptyModel({ id: 'p', name: 'Shop' })
  const node = (id: string, kind: 'service' | 'saas' | 'cache' | 'database', extra: Record<string, unknown> = {}): void => {
    m.nodes[id] = NodeZ.parse({ id, name: id, kind, ...extra })
  }
  node('api', 'service')
  node('orders', 'service')
  node('cache', 'cache', { parentId: 'api' })
  node('stripe', 'saas', { boundary: 'external' })
  node('reports', 'service')
  node('db', 'database')
  node('billing', 'service')
  m.connectors['c1'] = ConnectorZ.parse({ id: 'c1', source: 'reports', target: 'db' })
  m.connectors['c2'] = ConnectorZ.parse({ id: 'c2', source: 'reports', target: 'billing' })
  m.boundaries['vpc'] = BoundaryZ.parse({ id: 'vpc', name: 'Prod VPC', type: 'vpc', nodeIds: ['api', 'orders', 'cache', 'stripe', 'reports'] })
  m.boundaries['vpc2'] = BoundaryZ.parse({ id: 'vpc2', name: 'Data VPC', type: 'vpc', nodeIds: ['orders'] })
  m.boundaries['empty'] = BoundaryZ.parse({ id: 'empty', name: 'Old subnet', type: 'subnet', nodeIds: [] })
  return m
}

it('finds misplaced members, overlaps and empty zones', () => {
  const codes = boundaryProblems(shop()).map((p) => `${p.code}:${p.nodeId ?? p.boundaryId ?? ''}`)
  expect(codes).toEqual(
    expect.arrayContaining([
      'boundary-wrong-level:cache', // cache lives inside api, the zone is drawn at the top level
      'boundary-outside-party:stripe', // a third party inside a VPC
      'boundary-isolated-member:reports', // all its links leave the VPC
      'boundary-overlap:orders', // in two VPCs
      'boundary-empty:empty',
    ]),
  )
  expect(codes).not.toContain('boundary-isolated-member:api')
})

it('asks the AI about one zone: members, neighbours, crossing links and what Harpoon found', () => {
  const p = boundaryCheckPrompt(shop(), 'vpc') ?? ''
  expect(p).toContain('Check the boundary "Prod VPC" (id vpc, type vpc)')
  expect(p).toContain('- stripe (id stripe, saas, external)')
  expect(p).toContain('Other nodes on that level, not in it:\n- db (id db, database)')
  expect(p).toContain('c1: reports → db')
  expect(p).toContain('[boundary-outside-party]')
  expect(p).toContain('upsert_boundary')
  expect(boundaryCheckPrompt(shop(), 'gone')).toBeNull()
})
