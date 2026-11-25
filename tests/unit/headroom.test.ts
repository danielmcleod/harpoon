// Load headroom: the base load from the entry points, and the multiplier where the sample architecture first fails.
import { describe, expect, it } from 'vitest'
import { Simulator } from '../../src/shared/sim/engine.ts'
import { baseLoad, headroom } from '../../src/shared/sim/headroom.ts'
import { hasFailure } from '../../src/shared/sim/onsets.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import { sampleOps } from '../../src/shared/model/sample.ts'
import { emptyModel } from '../../src/shared/model/schema.ts'

const model = applyOps(emptyModel({ id: 's', name: 'S' }), sampleOps()).model

const failsAt = (multiplier: number): boolean => {
  const sim = new Simulator(model)
  let bad = false
  for (let i = 0; i < 120; i++) bad = hasFailure(sim.step({ multiplier, profile: 'constant', faults: [] }))
  return bad
}

describe('load headroom', () => {
  it('adds up what the entry points generate', () => {
    const b = baseLoad(model)
    expect(b.entries.length).toBeGreaterThan(0)
    expect(b.total).toBe(b.entries.reduce((a, e) => a + e.rps, 0))
  })

  it('finds the multiplier where something first fails, and what fails', () => {
    const t0 = performance.now()
    const h = headroom(model)
    expect(performance.now() - t0).toBeLessThan(2000)
    expect(h.limit).not.toBeNull()
    const limit = h.limit ?? 0
    expect(limit).toBeGreaterThan(1)
    expect(failsAt(limit)).toBe(false)
    expect(failsAt(limit * 1.5)).toBe(true)
    expect(h.roots.length).toBeGreaterThan(0)
  })

  it('holds further when the bottlenecks are forced healthy', () => {
    const h = headroom(model)
    const forced = headroom(model, h.roots.map((r) => r.ref.id))
    expect(forced.limit === null || forced.limit > (h.limit ?? 0)).toBe(true)
  })
})
