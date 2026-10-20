// Where traffic goes and where it stops: the on-prem → load balancer → cloud case from a real project.
import { describe, expect, it } from 'vitest'
import { applyOps } from '../../src/shared/model/ops.ts'
import type { Op } from '../../src/shared/model/ops.ts'
import { ConnectorZ, FlowZ, NodeZ, emptyModel } from '../../src/shared/model/schema.ts'
import { lintModel } from '../../src/shared/model/lint.ts'
import type { Model } from '../../src/shared/model/schema.ts'
import { Simulator } from '../../src/shared/sim/engine.ts'
import { reach, trafficBreaks } from '../../src/shared/sim/paths.ts'

const node = (id: string, kind: string, extra: Record<string, unknown> = {}): Op => ({ op: 'addNode', node: NodeZ.parse({ id, name: id, kind, ...extra }), at: null })
const link = (id: string, source: string, target: string): Op => ({ op: 'addConnector', connector: ConnectorZ.parse({ id, source, target }) })
const build = (ops: Op[]): Model => applyOps(emptyModel({ id: 'h', name: 'Hybrid' }), ops).model

// On-prem users call the orders service, which calls the cloud billing service through an internal ALB. As first
// drawn: the ALB points at the orders service (reversed), and billing's connector leaves from an inner part.
const drawn = (): Op[] => [
  node('users', 'client', { hosting: 'on-prem' }),
  node('orders', 'service', { hosting: 'on-prem' }),
  node('alb', 'network', { hosting: 'cloud' }),
  node('billing', 'service', { hosting: 'cloud' }),
  node('billing-api', 'process', { parentId: 'billing' }),
  node('billing-db', 'database', { hosting: 'cloud' }),
  link('users-orders', 'users', 'orders'),
  link('alb-orders', 'alb', 'orders'),
  link('alb-billing', 'alb', 'billing'),
  link('billing-api-db', 'billing-api', 'billing-db'),
]

describe('traffic paths', () => {
  it('finds where traffic stops and why', () => {
    const m = build(drawn())
    const kinds = trafficBreaks(m).map((b) => `${b.kind}:${b.nodeId}`)
    expect(kinds).toContain('dead-end:orders')
    expect(kinds).toContain('reversed:alb')
    expect(reach(m, ['users']).nodes.has('billing-db')).toBe(false)
  })

  it('reaches the cloud once the link points the right way, through the container', () => {
    const m = build([...drawn().filter((o) => !(o.op === 'addConnector' && o.connector.id === 'alb-orders')), link('orders-alb', 'orders', 'alb')])
    expect(trafficBreaks(m).filter((b) => b.kind !== 'missing-hop')).toEqual([])
    // Into billing, in at billing-api (its receiving part), on to the database.
    expect(reach(m, ['users']).nodes.has('billing-db')).toBe(true)
    const sim = new Simulator(m)
    let f = sim.step({ multiplier: 1, profile: 'constant', faults: [] })
    for (let i = 0; i < 8; i++) f = sim.step({ multiplier: 1, profile: 'constant', faults: [] })
    expect(f.nodes['billing-db']?.rps).toBeGreaterThan(50)
  })

  it('asks for a network hop between on-prem and cloud', () => {
    const m = build([node('a', 'service', { hosting: 'on-prem' }), node('b', 'service', { hosting: 'cloud' }), link('a-b', 'a', 'b')])
    expect(trafficBreaks(m, ['a']).map((b) => b.kind)).toContain('missing-hop')
  })
})

describe('flow checks', () => {
  const base = [
    node('web', 'frontend'),
    node('api', 'service'),
    node('api-handler', 'process', { parentId: 'api' }),
    node('db', 'database'),
    node('cache', 'cache'),
    link('web-api', 'web', 'api'),
    link('handler-db', 'api-handler', 'db'),
    link('api-cache', 'api', 'cache'),
  ]
  const codes = (steps: { connectorId: string; direction?: 'A' | 'B' }[]): string[] => {
    const m = build([...base, { op: 'addFlow', flow: FlowZ.parse({ id: 'f', name: 'F', steps }) }])
    return lintModel(m).filter((p) => p.flowId === 'f').map((p) => p.code)
  }
  it('accepts a flow that goes through an inner part and back to its caller', () => {
    expect(codes([{ connectorId: 'web-api' }, { connectorId: 'handler-db' }, { connectorId: 'api-cache' }])).toEqual([])
  })
  it('catches a gap and a step against a one-way connector', () => {
    expect(codes([{ connectorId: 'handler-db' }, { connectorId: 'web-api' }])).toContain('flow-gap')
    const oneWay = build([...base, { op: 'updateConnector', id: 'api-cache', patch: { duplex: false } }, { op: 'addFlow', flow: FlowZ.parse({ id: 'f', name: 'F', steps: [{ connectorId: 'api-cache', direction: 'B' }] }) }])
    expect(lintModel(oneWay).map((p) => p.code)).toContain('flow-reversed')
  })
})
