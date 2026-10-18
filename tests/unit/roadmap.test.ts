import { describe, expect, it } from 'vitest'
import { asPlanned } from '../../src/core/ai/proposals.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import type { Op } from '../../src/shared/model/ops.ts'
import { modelAsOf } from '../../src/shared/model/roadmap.ts'
import { ConnectorZ, NodeZ, emptyModel } from '../../src/shared/model/schema.ts'
import type { HxNodeInput, Model } from '../../src/shared/model/schema.ts'

const node = (id: string, extra: Partial<HxNodeInput> = {}) => NodeZ.parse({ id, name: id, ...extra })

// legacy (retired in P1) → api (built) → fraud (lands in P1) → ml (lands in P2, with an inner part)
function plan(): Model {
  const ops: Op[] = [
    { op: 'updateMeta', patch: { phases: [{ id: 'p1', name: 'MVP', order: 1, target: null, status: 'active', description: '' }, { id: 'p2', name: 'Phase 2', order: 2, target: null, status: 'not-started', description: '' }] } },
    { op: 'addNode', node: node('api'), at: { q: 0, r: 0 } },
    { op: 'addNode', node: node('legacy', { status: 'deprecated', phase: 'p1' }), at: { q: 1, r: 0 } },
    { op: 'addNode', node: node('fraud', { status: 'planned', phase: 'p1' }), at: { q: 2, r: 0 } },
    { op: 'addNode', node: node('ml', { status: 'planned', phase: 'p2' }), at: { q: 3, r: 0 } },
    { op: 'addNode', node: node('ml-db', { parentId: 'ml', kind: 'database' }), at: { q: 0, r: 0 } },
    { op: 'addNode', node: node('someday', { status: 'planned' }), at: { q: 4, r: 0 } },
    { op: 'addConnector', connector: ConnectorZ.parse({ id: 'c1', source: 'api', target: 'fraud', status: 'planned' }) },
    { op: 'addConnector', connector: ConnectorZ.parse({ id: 'c2', source: 'fraud', target: 'ml', status: 'planned', phase: 'p2' }) },
    { op: 'addConnector', connector: ConnectorZ.parse({ id: 'c3', source: 'api', target: 'legacy' }) },
  ]
  return applyOps(emptyModel({ id: 'p', name: 'P' }), ops).model
}

describe('roadmap projection', () => {
  it('shows the end of the first phase: its arrivals new, its retirements going', () => {
    const p = modelAsOf(plan(), 'p1')
    expect(Object.keys(p?.model.nodes ?? {}).sort()).toEqual(['api', 'fraud', 'legacy'])
    expect(p?.model.nodes['fraud']?.status).toBe('existing')
    expect(p?.summary.nodes).toEqual([
      { id: 'legacy', kind: 'removed', fields: [] },
      { id: 'fraud', kind: 'added', fields: [] },
    ])
    // The unscheduled link to fraud lands with it; the link to legacy goes with it.
    expect(p?.summary.connectors.map((c) => [c.id, c.kind])).toEqual([
      ['c1', 'added'],
      ['c3', 'removed'],
    ])
  })

  it('drops what is retired and brings in later phases with their inner parts', () => {
    const p = modelAsOf(plan(), 'p2')
    expect(Object.keys(p?.model.nodes ?? {}).sort()).toEqual(['api', 'fraud', 'ml', 'ml-db'])
    expect(p?.model.connectors['c1']?.status).toBe('existing')
    expect(Object.keys(p?.model.connectors ?? {}).sort()).toEqual(['c1', 'c2'])
  })

  it('accepting as planned in a phase schedules additions and turns removals into deprecations', () => {
    const ops = asPlanned(
      [
        { op: 'addNode', node: node('new'), at: { q: 0, r: 0 } },
        { op: 'removeNode', id: 'legacy' },
      ],
      'p2',
    )
    expect(ops[0]).toMatchObject({ op: 'addNode', node: { status: 'planned', phase: 'p2' } })
    expect(ops[1]).toEqual({ op: 'updateNode', id: 'legacy', patch: { status: 'deprecated', phase: 'p2' } })
  })
})
