// Regressions from the domain-layer review: a diff that has to re-point before it removes, a circuit breaker that
// closes again (and a dead consumer whose queue fills up), and a project file a git merge left inconsistent.
import { describe, expect, it } from 'vitest'
import { parseModelWithRepairs } from '../../src/core/project/files.ts'
import { compareModels, diffModels, isEmptySummary } from '../../src/shared/model/diff.ts'
import { lintModel } from '../../src/shared/model/lint.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import type { Op } from '../../src/shared/model/ops.ts'
import { descendantIds } from '../../src/shared/model/queries.ts'
import { sampleOps } from '../../src/shared/model/sample.ts'
import { ConnectorZ, NodeZ, emptyModel } from '../../src/shared/model/schema.ts'
import type { Model } from '../../src/shared/model/schema.ts'
import { Simulator } from '../../src/shared/sim/engine.ts'
import type { Fault, Frame } from '../../src/shared/sim/engine.ts'

const node = (id: string, extra: Record<string, unknown> = {}): Op => ({
  op: 'addNode',
  node: NodeZ.parse({ id, name: id, ...extra }),
  at: null,
})
const link = (id: string, source: string, target: string, extra: Record<string, unknown> = {}): Op => ({
  op: 'addConnector',
  connector: ConnectorZ.parse({ id, source, target, ...extra }),
})
const build = (ops: Op[]): Model => applyOps(emptyModel({ id: 'p', name: 'P' }), ops).model

describe('review fixes', () => {
  it('diffs a removed node whose connector moved to another node, and two nodes trading places', () => {
    // legacy → db, with legacy inside old-group; then: legacy goes, its connector starts at api, and the two groups swap.
    const a = build([
      node('old-group'),
      node('new-group', { parentId: 'old-group' }),
      node('legacy', { parentId: 'old-group' }),
      node('api'),
      node('db'),
      link('c1', 'legacy', 'db'),
    ])
    const b = applyOps(a, [
      { op: 'updateConnector', id: 'c1', patch: { source: 'api' } },
      { op: 'removeNode', id: 'legacy' },
      { op: 'updateNode', id: 'new-group', patch: { parentId: null } },
      { op: 'updateNode', id: 'old-group', patch: { parentId: 'new-group' } },
    ]).model
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const result = applyOps(from, diffModels(from, to)).model
      expect(isEmptySummary(compareModels(result, to))).toBe(true)
    }
  })

  it('closes a circuit breaker once the callee is back, and fills the queue of a consumer that is down', () => {
    const run = (m: Model, faults: Fault[], seconds: number): Frame[] => {
      const sim = new Simulator(m)
      return Array.from({ length: seconds * 4 }, () =>
        sim.step({ multiplier: 1, profile: 'constant', faults }),
      )
    }
    const at = (frames: Frame[], t: number): Frame => frames.find((f) => f.t === t) ?? (frames[0] as Frame)

    // Stripe is down for the first five seconds only.
    const frames = run(
      build(sampleOps()),
      [{ id: 'f', type: 'down', target: 'stripe', value: 0, from: 0, until: 5 }],
      20,
    )
    expect(at(frames, 4).edges['payments-stripe']?.breakerOpen).toBe(true)
    expect(at(frames, 4).nodes['stripe']?.health).toBe('bad')
    const after = at(frames, 19)
    expect(after.edges['payments-stripe']?.breakerOpen).toBe(false)
    expect(after.edges['payments-stripe']?.rps).toBeGreaterThan(0)
    expect(after.nodes['payments-core']?.errorRate).toBeLessThan(0.05)

    // 100 msg/s into a queue whose only consumer is down for ten seconds: all of it waits.
    const queue = build([
      node('app', { kind: 'client', sim: { entryRps: 100 } }),
      node('jobs', { kind: 'queue' }),
      node('worker', { kind: 'worker' }),
      link('in', 'app', 'jobs', { sync: 'async' }),
      link('out', 'jobs', 'worker', { sync: 'async' }),
    ])
    const idle = run(queue, [], 10).at(-1)
    const dead = run(
      queue,
      [{ id: 'f', type: 'down', target: 'worker', value: 0, from: 0, until: null }],
      10,
    ).at(-1)
    expect(idle?.nodes['jobs']?.backlog).toBe(0)
    expect(dead?.nodes['jobs']?.backlog).toBeCloseTo(1000)
    expect(dead?.nodes['worker']?.rps).toBe(0)
  })

  it('mends a parent cycle and a dangling connector when a project file loads', () => {
    const file = JSON.stringify({
      schemaVersion: 1,
      meta: { id: 'p', name: 'P' },
      // Each branch moved one node into the other; one branch deleted `gone` while the other connected to it.
      nodes: [
        { id: 'a', name: 'A', parentId: 'b' },
        { id: 'b', name: 'B', parentId: 'a' },
        { id: 'c', name: 'C', parentId: 'gone' },
      ],
      connectors: [
        { id: 'ok', source: 'c', target: 'a' },
        { id: 'lost', source: 'c', target: 'gone' },
      ],
    })
    const { model, repairs } = parseModelWithRepairs(file, null)
    expect(model.nodes['a']?.parentId).toBe('b')
    expect(model.nodes['b']?.parentId).toBeNull()
    expect(model.nodes['c']?.parentId).toBeNull()
    expect(Object.keys(model.connectors)).toEqual(['ok'])
    expect(repairs).toHaveLength(3)
    expect(lintModel(model).map((p) => p.code)).not.toContain('orphan')
    // The walks are guarded as well: a cycle that gets in some other way must not hang them.
    const cyclic: Model = {
      ...model,
      nodes: { ...model.nodes, b: NodeZ.parse({ id: 'b', name: 'B', parentId: 'a' }) },
    }
    expect(descendantIds(cyclic, 'a')).toEqual(['b'])
  })
})
