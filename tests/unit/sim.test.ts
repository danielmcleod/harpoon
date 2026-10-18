import { describe, expect, it } from 'vitest'
import { Simulator } from '../../src/shared/sim/engine.ts'
import type { Frame, Scenario } from '../../src/shared/sim/engine.ts'
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
})
