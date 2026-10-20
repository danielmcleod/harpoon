// Availability: single points of failure, what a failure takes down, and the simulator's zone faults.
import { describe, expect, it } from 'vitest'
import { applyOps } from '../../src/shared/model/ops.ts'
import type { Op } from '../../src/shared/model/ops.ts'
import { ConnectorZ, NodeZ, emptyModel } from '../../src/shared/model/schema.ts'
import type { Model } from '../../src/shared/model/schema.ts'
import { failureImpact, resilienceFindings } from '../../src/shared/model/resilience.ts'
import { Simulator } from '../../src/shared/sim/engine.ts'
import type { Frame, Scenario } from '../../src/shared/sim/engine.ts'

const node = (id: string, kind: string, extra: Record<string, unknown> = {}): Op => ({ op: 'addNode', node: NodeZ.parse({ id, name: id, kind, ...extra }), at: null })
const link = (id: string, source: string, target: string, extra: Record<string, unknown> = {}): Op => ({ op: 'addConnector', connector: ConnectorZ.parse({ id, source, target, ...extra }) })
const build = (ops: Op[]): Model => applyOps(emptyModel({ id: 'r', name: 'R' }), ops).model

// Web → api (one instance) → db; api → recommendations (soft).
const shop = (api: Record<string, unknown>): Model =>
  build([
    node('web', 'frontend'),
    node('api', 'service', { resilience: api }),
    node('db', 'database', { resilience: { deployment: 'multi-zone', zones: ['a', 'b'], backups: true } }),
    node('recs', 'service', { resilience: { deployment: 'single', instances: 1 } }),
    link('web-api', 'web', 'api'),
    link('api-db', 'api', 'db'),
    link('api-recs', 'api', 'recs', { dependency: 'soft' }),
  ])

describe('resilience', () => {
  it('finds a single point of failure on the request path, and not once it spans zones', () => {
    const weak = resilienceFindings(shop({ deployment: 'single', instances: 1, zones: ['a'] }))
    expect(weak.filter((f) => f.kind === 'spof').map((f) => f.nodeId)).toEqual(['api'])
    // recs sits behind a soft dependency: not on the hard request path.
    expect(weak.some((f) => f.nodeId === 'recs' && f.kind === 'spof')).toBe(false)
    const strong = resilienceFindings(shop({ deployment: 'multi-zone', instances: 3, zones: ['a', 'b'] }))
    expect(strong.some((f) => f.kind === 'spof')).toBe(false)
  })

  it('works out what a failure takes down', () => {
    const m = shop({ deployment: 'multi-zone', instances: 3, zones: ['a', 'b'] })
    expect(failureImpact(m, 'api', 'instance').get('web')).toBe('degraded')
    expect(failureImpact(m, 'api', 'down').get('web')).toBe('down')
    // The soft dependency only degrades its caller.
    expect(failureImpact(m, 'recs', 'down').get('api')).toBe('degraded')
  })

  it('simulates a zone outage: single-zone nodes go down, multi-zone ones keep going', () => {
    const m = shop({ deployment: 'single', instances: 1, zones: ['a'] })
    const sc: Scenario = { multiplier: 1, profile: 'constant', faults: [{ id: 'z', type: 'zone', target: 'a', value: 0, from: 0, until: null }] }
    const sim = new Simulator(m)
    let f: Frame = sim.step(sc)
    for (let i = 0; i < 12; i++) f = sim.step(sc)
    expect(f.nodes['api']?.health).toBe('bad')
    expect(f.nodes['db']?.errorRate ?? 1).toBeLessThan(0.05)
  })

  it('does not fail a caller through a soft dependency', () => {
    const m = shop({ deployment: 'multi-zone', instances: 3, zones: ['a', 'b'] })
    const sc: Scenario = { multiplier: 1, profile: 'constant', faults: [{ id: 'd', type: 'down', target: 'recs', value: 0, from: 0, until: null }] }
    const sim = new Simulator(m)
    let f: Frame = sim.step(sc)
    for (let i = 0; i < 12; i++) f = sim.step(sc)
    expect(f.nodes['recs']?.health).toBe('bad')
    expect(f.nodes['api']?.errorRate ?? 1).toBeLessThan(0.05)
  })
})
