import { describe, expect, it } from 'vitest'
import { coreGroups, strataLayout } from '../../src/shared/geometry/strata.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import { sampleOps } from '../../src/shared/model/sample.ts'
import { NodeZ, emptyModel } from '../../src/shared/model/schema.ts'

const sample = applyOps(emptyModel({ id: 'commerce', name: 'Commerce' }), sampleOps()).model

describe('strata layout', () => {
  it('puts every node on a deck with nothing overlapping', () => {
    const l = strataLayout(sample)
    expect(l.decks.map((d) => d.label)).toEqual(['Core', 'System', 'Parts'])
    const placed = [...l.nodes.values()]
    expect(placed.filter((n) => n.kind === 'node')).toHaveLength(Object.keys(sample.nodes).length)
    for (const a of placed)
      for (const b of placed)
        if (a.id < b.id && a.deck === b.deck)
          expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(a.r + b.r - 1)
  })

  it('groups the top level around its busiest nodes, each node in exactly one group', () => {
    const groups = coreGroups(sample) ?? []
    const tops = Object.values(sample.nodes).filter((n) => n.parentId === null)
    expect(groups.length).toBeGreaterThan(1)
    expect(groups.length).toBeLessThan(tops.length)
    expect(groups.flatMap((g) => g.members).sort()).toEqual(tops.map((n) => n.id).sort())
  })

  it('draws a connector between a part and an outside node as a riser on the lower deck', () => {
    const l = strataLayout(sample)
    const risers = l.edges.filter((e) => e.riser)
    expect(risers.length).toBeGreaterThan(0)
    for (const e of risers)
      expect(Math.max(l.nodes.get(e.a)?.deck ?? 0, l.nodes.get(e.b)?.deck ?? 0)).toBe(e.deck)
  })

  it('has no Core deck for a small top level', () => {
    const small = applyOps(emptyModel({ id: 's', name: 'S' }), [
      { op: 'addNode', node: NodeZ.parse({ id: 'a', name: 'A' }), at: { q: 0, r: 0 } },
      { op: 'addNode', node: NodeZ.parse({ id: 'b', name: 'B' }), at: { q: 1, r: 0 } },
    ]).model
    expect(strataLayout(small).hasCore).toBe(false)
  })
})
