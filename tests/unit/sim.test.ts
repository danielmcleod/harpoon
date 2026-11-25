import { describe, expect, it } from 'vitest'
import { Simulator } from '../../src/shared/sim/engine.ts'
import type { Frame, Scenario } from '../../src/shared/sim/engine.ts'
import { failureReport } from '../../src/shared/sim/explain.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import { sampleOps } from '../../src/shared/model/sample.ts'
import { emptyModel } from '../../src/shared/model/schema.ts'

const model = applyOps(emptyModel({ id: 's', name: 'S' }), sampleOps()).model
const run = (sc: Scenario, seconds: number): Frame => {
  const sim = new Simulator(model)
  let f = sim.step(sc)
  for (let i = 1; i < seconds * 4; i++) f = sim.step(sc)
  return f
}

describe('traffic simulator', () => {
  it('is deterministic and healthy at baseline', () => {
    const sc: Scenario = { multiplier: 1, profile: 'constant', faults: [] }
    const a = run(sc, 5)
    expect(run(sc, 5)).toEqual(a)
    expect(a.throughput).toBeGreaterThan(800)
    expect(a.errorRate).toBeLessThan(0.02)
    expect(a.nodes['api-gateway']?.health).toBe('ok')
  })

  it('saturates under load and cascades a failure upstream', () => {
    const hot = run({ multiplier: 5, profile: 'constant', faults: [] }, 5)
    expect(hot.nodes['payment-api']?.util).toBeGreaterThan(1)
    const down = run({ multiplier: 1, profile: 'constant', faults: [{ id: 'f', type: 'down', target: 'auth-service', value: 0, from: 0, until: null }] }, 5)
    expect(down.nodes['auth-service']?.health).toBe('bad')
    expect(down.edges['gateway-auth']?.errorRate).toBeGreaterThan(0.5)
    expect(down.errorRate).toBeGreaterThan(0.5)
  })

  it('opens a circuit breaker on a failing dependency', () => {
    const f = run({ multiplier: 1, profile: 'constant', faults: [{ id: 'f', type: 'down', target: 'stripe', value: 0, from: 0, until: null }] }, 5)
    expect(f.edges['payments-stripe']?.breakerOpen).toBe(true)
  })

  it('explains failures: one root per injected fault, knock-ons traced back to it', () => {
    const crash = { id: 'f', type: 'down' as const, target: 'auth-service', value: 0, from: 0, until: null }
    const f = run({ multiplier: 1, profile: 'constant', faults: [crash] }, 5)
    const r = failureReport(model, f)
    expect(r.roots.map((x) => x.key)).toEqual(['n:auth-service'])
    expect(r.roots[0]?.reasons[0]?.text).toMatch(/crashed/)
    expect(r.knockOn.length).toBeGreaterThan(3)
    expect(r.knockOn.every((k) => k.roots.includes('n:auth-service'))).toBe(true)
    const gw = r.knockOn.find((k) => k.nodeId === 'api-gateway')
    expect(gw?.reasons.some((x) => x.ref?.kind === 'node')).toBe(true)
  })

  it('names an open breaker and an overload', () => {
    const f = run({ multiplier: 1, profile: 'constant', faults: [{ id: 'f', type: 'down', target: 'stripe', value: 0, from: 0, until: null }] }, 5)
    expect(f.edges['payments-stripe']?.causes?.some((c) => c.kind === 'breaker')).toBe(true)
    expect(failureReport(model, f).roots.map((x) => x.key)).toEqual(['n:stripe'])
    const hot = run({ multiplier: 5, profile: 'constant', faults: [] }, 5)
    expect(hot.nodes['payment-api']?.causes?.some((c) => c.kind === 'overload' && c.dropped > 0)).toBe(true)
  })

  it('forces nodes and links healthy', () => {
    const crash = { id: 'f', type: 'down' as const, target: 'auth-service', value: 0, from: 0, until: null }
    const f = run({ multiplier: 1, profile: 'constant', faults: [crash], healthy: ['auth-service'] }, 5)
    expect(f.nodes['auth-service']?.forced).toBe(true)
    expect(f.nodes['user-db']?.health).toBe('ok')
    expect(f.errorRate).toBeLessThan(0.02)
    const cut = { id: 'p', type: 'partition' as const, target: 'gateway-auth', value: 0, from: 0, until: null }
    expect(run({ multiplier: 1, profile: 'constant', faults: [cut] }, 5).edges['gateway-auth']?.causes?.[0]?.kind).toBe('partition')
    const g = run({ multiplier: 1, profile: 'constant', faults: [cut], healthy: ['gateway-auth'] }, 5)
    expect(g.edges['gateway-auth']?.health).toBe('ok')
    expect(g.errorRate).toBeLessThan(0.02)
  })
})
