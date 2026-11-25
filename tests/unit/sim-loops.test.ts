// Calls in a loop (A → B → A) and random architectures: nothing fails without a cause the explainer can name.
import { describe, expect, it } from 'vitest'
import { Simulator } from '../../src/shared/sim/engine.ts'
import type { Frame } from '../../src/shared/sim/engine.ts'
import { failureReport } from '../../src/shared/sim/explain.ts'
import { headroom } from '../../src/shared/sim/headroom.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import type { Op } from '../../src/shared/model/ops.ts'
import { ChannelZ, ConnectorZ, NodeZ, emptyModel } from '../../src/shared/model/schema.ts'
import type { Model } from '../../src/shared/model/schema.ts'

const KINDS = ['service', 'database', 'cache', 'queue', 'worker', 'gateway', 'process', 'function', 'saas', 'stream'] as const

function build(nodes: { id: string; kind: string; parentId?: string | null }[], links: { s: string; t: string; sync?: 'sync' | 'async'; retries?: number; timeoutMs?: number | null; breaker?: boolean; fanout?: number }[]): Model {
  const ops = [
    ...nodes.map((n, i) => ({ op: 'addNode', node: NodeZ.parse({ id: n.id, name: n.id, kind: n.kind, parentId: n.parentId ?? null }), at: { q: i, r: 0 } })),
    ...links.map((l, j) => ({
      op: 'addConnector',
      connector: ConnectorZ.parse({ id: `c${j}`, source: l.s, target: l.t, sync: l.sync ?? 'sync', channelA: ChannelZ.parse({ protocol: 'https' }), policies: { retries: l.retries ?? 0, timeoutMs: l.timeoutMs ?? null, circuitBreaker: l.breaker ?? false }, ...(l.fanout !== undefined ? { sim: { fanout: l.fanout, payloadKb: null } } : {}) }),
    })),
  ] as Op[]
  return applyOps(emptyModel({ id: 's', name: 'S' }), ops).model
}

const run = (m: Model, multiplier: number, ticks = 120): Frame => {
  const sim = new Simulator(m)
  let f = sim.step({ multiplier, profile: 'constant', faults: [] })
  for (let i = 1; i < ticks; i++) f = sim.step({ multiplier, profile: 'constant', faults: [] })
  return f
}

/** Failing roots the explainer has nothing to say about. */
const unexplained = (m: Model, f: Frame): string[] => failureReport(m, f).roots.filter((r) => r.health === 'bad' && r.reasons[0]?.text === 'No cause recorded').map((r) => r.key)

describe('calls in a loop', () => {
  it('do not add up their errors tick after tick', () => {
    const m = build([{ id: 'web', kind: 'client' }, { id: 'a', kind: 'service' }, { id: 'b', kind: 'service' }, { id: 'c', kind: 'service' }], [{ s: 'web', t: 'a' }, { s: 'a', t: 'b' }, { s: 'b', t: 'c' }, { s: 'c', t: 'a' }, { s: 'b', t: 'a' }])
    const f = run(m, 0.05, 2400)
    expect(Object.values(f.nodes).every((n) => n.health === 'ok')).toBe(true)
    expect(headroom(m).limit).not.toBe(0)
  })

  it('random architectures never fail without a cause, at any load', () => {
    let seed = 1
    const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
    const bad: string[] = []
    for (let trial = 0; trial < 150; trial++) {
      seed = trial + 7
      const ids = Array.from({ length: 6 + Math.floor(rnd() * 12) }, (_, i) => `n${i}`)
      const nodes = ids.map((id, i) => ({ id, kind: i === 0 ? 'client' : pick(KINDS), parentId: i > 2 && rnd() < 0.3 ? pick(ids.slice(1, i)) : null }))
      const links = Array.from({ length: ids.length * 2 }, () => ({ s: pick(ids), t: pick(ids), sync: rnd() < 0.7 ? ('sync' as const) : ('async' as const), retries: rnd() < 0.3 ? 3 : 0, timeoutMs: rnd() < 0.3 ? 500 : null, breaker: rnd() < 0.3, ...(rnd() < 0.3 ? { fanout: 1 + Math.floor(rnd() * 3) } : {}) })).filter((l) => l.s !== l.t)
      const m = build(nodes, links)
      for (const x of [0.05, 1, 5]) {
        const u = unexplained(m, run(m, x))
        if (u.length > 0) bad.push(`trial ${trial} at ${x}×: ${u.join(', ')}`)
      }
    }
    expect(bad).toEqual([])
  })
})
