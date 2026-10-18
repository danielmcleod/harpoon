import { describe, expect, it } from 'vitest'
import { dataScope, effectiveTeam } from '../../src/shared/model/governance.ts'
import { lintModel } from '../../src/shared/model/lint.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import type { Op } from '../../src/shared/model/ops.ts'
import { BoundaryZ, ChannelZ, ConnectorZ, NodeZ, ProjectFileZ, emptyModel } from '../../src/shared/model/schema.ts'
import type { HxConnectorInput, HxNodeInput, Model } from '../../src/shared/model/schema.ts'

const node = (id: string, extra: Partial<HxNodeInput> = {}) => NodeZ.parse({ id, name: id, ...extra })
const conn = (id: string, source: string, target: string, extra: Partial<HxConnectorInput> = {}) => ConnectorZ.parse({ id, source, target, ...extra })

// checkout → payments (inside: payments-api, card-vault) → stripe (external)
function shop(): Model {
  const ops: Op[] = [
    { op: 'updateMeta', patch: { teams: [{ id: 'pay', name: 'Payments', contact: null, color: null }], phases: [{ id: 'p1', name: 'MVP', order: 1, target: null, status: 'active', description: '' }, { id: 'p2', name: 'Phase 2', order: 2, target: null, status: 'not-started', description: '' }] } },
    { op: 'addNode', node: node('checkout'), at: { q: 0, r: 0 } },
    { op: 'addNode', node: node('payments', { team: 'pay' }), at: { q: 2, r: 0 } },
    { op: 'addNode', node: node('payments-api', { parentId: 'payments' }), at: { q: 0, r: 0 } },
    { op: 'addNode', node: node('card-vault', { parentId: 'payments', kind: 'database', dataClasses: ['pci'] }), at: { q: 1, r: 0 } },
    { op: 'addNode', node: node('stripe', { kind: 'saas', boundary: 'external', vendor: 'Stripe' }), at: { q: 4, r: 0 } },
    { op: 'addConnector', connector: conn('c1', 'checkout', 'payments-api', { channelA: ChannelZ.parse({ protocol: 'HTTPS', dataClasses: ['pci'] }) }) },
    { op: 'addConnector', connector: conn('c2', 'payments-api', 'card-vault', { channelA: ChannelZ.parse({ protocol: 'SQL', dataClasses: ['pci'] }) }) },
    { op: 'addConnector', connector: conn('c3', 'payments-api', 'stripe', { channelA: ChannelZ.parse({ protocol: 'HTTPS' }) }) },
  ]
  return applyOps(emptyModel({ id: 'p', name: 'P' }), ops).model
}

const codes = (m: Model): string[] => lintModel(m).map((p) => p.code)

describe('governance', () => {
  it('loads a project file written before these fields existed', () => {
    const p = ProjectFileZ.parse({ schemaVersion: 1, meta: { id: 'p', name: 'P' }, nodes: [{ id: 'a', name: 'A' }], connectors: [{ id: 'c', source: 'a', target: 'a' }] })
    expect(p.nodes[0]).toMatchObject({ notes: '', team: null, dataClasses: [], phase: null })
    expect(p.connectors[0]?.channelA.dataClasses).toEqual([])
    expect(p.meta).toMatchObject({ teams: [], phases: [], dataClasses: [] })
  })

  it('inherits the team from the nearest ancestor', () => {
    const m = shop()
    expect(effectiveTeam(m, 'card-vault')).toEqual({ team: 'pay', inherited: true })
    expect(effectiveTeam(m, 'payments')).toEqual({ team: 'pay', inherited: false })
    expect(effectiveTeam(m, 'checkout')).toBeNull()
  })

  it('derives data scope from tags, connectors and inner parts', () => {
    const s = dataScope(shop())
    expect(s.get('card-vault')?.get('pci')?.own).toBe(true)
    expect(s.get('checkout')?.get('pci')?.via).toEqual(['c1'])
    expect(s.get('payments')?.get('pci')?.inner.sort()).toEqual(['card-vault', 'payments-api'])
    expect(s.has('stripe')).toBe(false)
  })

  it('flags regulated data sent unencrypted, and outside its approved zone', () => {
    const m = shop()
    expect(codes(m)).toContain('data-unencrypted') // c2 is plain SQL
    expect(codes(m)).not.toContain('data-outside-zone') // no zone declared for PCI: not checked

    const zoned = applyOps(m, [{ op: 'addBoundary', boundary: BoundaryZ.parse({ id: 'pci-zone', name: 'PCI', type: 'compliance', dataClasses: ['pci'], nodeIds: ['payments'] }) }]).model
    const outside = lintModel(zoned).filter((p) => p.code === 'data-outside-zone').map((p) => p.nodeId)
    expect(outside).toEqual(['checkout'])
  })

  it('flags work planned before what it depends on', () => {
    const m = applyOps(shop(), [
      { op: 'addNode', node: node('fraud', { status: 'planned', phase: 'p1' }), at: { q: 0, r: 2 } },
      { op: 'addNode', node: node('ml', { status: 'planned', phase: 'p2' }), at: { q: 2, r: 2 } },
      { op: 'addNode', node: node('ledger', { status: 'planned' }), at: { q: 4, r: 2 } },
      { op: 'addConnector', connector: conn('c4', 'fraud', 'ml') },
    ]).model
    const probs = lintModel(m)
    expect(probs.find((p) => p.code === 'phase-order')?.connectorId).toBe('c4')
    expect(probs.filter((p) => p.code === 'planned-no-phase').map((p) => p.nodeId)).toEqual(['ledger'])
  })

  it('lets modules (responsibilities) sit unconnected inside their service', () => {
    const m = applyOps(shop(), [
      { op: 'addNode', node: node('billing', { parentId: 'payments', kind: 'module' }), at: { q: 0, r: 1 } },
      { op: 'addNode', node: node('stray', { parentId: 'payments', kind: 'process' }), at: { q: 1, r: 1 } },
    ]).model
    const orphans = lintModel(m).filter((p) => p.code === 'orphan').map((p) => p.nodeId)
    expect(orphans).toEqual(['stray'])
  })
})
