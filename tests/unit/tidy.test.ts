import { describe, expect, it } from 'vitest'
import { computeScene, levelCells } from '../../src/shared/geometry/scene.ts'
import { arrangeLevel, levelLinks, levelScore, placeBadges } from '../../src/shared/geometry/tidy.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import type { Op } from '../../src/shared/model/ops.ts'
import { childrenOf } from '../../src/shared/model/queries.ts'
import { sampleOps } from '../../src/shared/model/sample.ts'
import { ConnectorZ, NodeZ, emptyModel } from '../../src/shared/model/schema.ts'
import type { HexCoord } from '../../src/shared/model/schema.ts'

const model = applyOps(emptyModel({ id: 's', name: 'S' }), sampleOps()).model
const keys = (cells: ReadonlyMap<string, HexCoord>): Set<string> => new Set([...cells.values()].map((c) => `${c.q},${c.r}`))

/**
 * A ~20-part service imported from a repo: ids say nothing about the call order, so the spiral (id order) tangles
 * the lines. One part has inner parts of its own and is drawn expanded; two outside callers and an outside callee.
 */
function bigService(): ReturnType<typeof applyOps>['model'] {
  const ops: Op[] = []
  const node = (id: string, parentId: string | null, kind: 'service' | 'process' | 'database' = 'process'): void => {
    ops.push({ op: 'addNode', node: NodeZ.parse({ id, name: id, kind, parentId }), at: null })
  }
  const link = (s: string, t: string): void => {
    ops.push({ op: 'addConnector', connector: ConnectorZ.parse({ id: `${s}-${t}`, source: s, target: t, duplex: false, channelB: null }) })
  }
  node('web', null, 'service')
  node('svc', null, 'service')
  node('ledger', null, 'database')
  // Layers: 1 router → 4 handlers → 8 domain parts → 6 stores. Ids are shuffled across layers.
  const router = 'p07'
  const handlers = ['p15', 'p02', 'p19', 'p11']
  const domain = ['p04', 'p17', 'p09', 'p01', 'p13', 'p06', 'p18', 'p10']
  const stores = ['p03', 'p16', 'p12', 'p08', 'p14', 'p05']
  for (const id of [router, ...handlers, ...domain, ...stores]) node(id, 'svc')
  node('p05-a', 'p05')
  node('p05-b', 'p05')
  link('p05-a', 'p05-b')
  for (const h of handlers) link(router, h)
  handlers.forEach((h, i) => {
    link(h, domain[2 * i] as string)
    link(h, domain[2 * i + 1] as string)
  })
  domain.forEach((d, i) => link(d, stores[i % stores.length] as string))
  link('web', router)
  link('web', handlers[1] as string)
  link(stores[2] as string, 'ledger')
  return applyOps(emptyModel({ id: 'b', name: 'B' }), ops).model
}

describe('arrange a level', () => {
  it('only uses free cells and never stacks two nodes on one cell', () => {
    for (const parent of [null, 'auth-service']) {
      const cells = arrangeLevel(model, parent, { timeLimitMs: 100 })
      expect(cells.size).toBe(childrenOf(model, parent).length)
      expect(keys(cells).size).toBe(cells.size)
      expect(levelLinks(model, parent).length).toBeGreaterThan(0)
    }
  })

  it('untangles a 20-part service better than spiral order, with no overlapping containers', () => {
    const m = bigService()
    const expanded = new Set(['svc', 'p05'])
    const spiral = new Map([...levelCells(m, childrenOf(m, 'svc'))].map(([id, v]) => [id, v.cell]))
    const before = levelScore(m, 'svc', spiral, { expanded })
    const after = arrangeLevel(m, 'svc', { expanded, timeLimitMs: 1500 })
    const score = levelScore(m, 'svc', after, { expanded })
    expect(keys(after).size).toBe(19)
    expect(score.crossings).toBeLessThan(before.crossings)
    expect(score.total).toBeLessThan(before.total)
    expect(score.overlaps).toBe(0)

    // Drawn with the result saved: no two hexagons on the level overlap (the expanded container included).
    const saved = applyOps(m, [...after].map(([id, at]) => ({ op: 'setLayout' as const, id, at }))).model
    const scene = computeScene(saved, { expanded, focusId: null, style: 'flat' })
    const level = [...scene.nodes.values()].filter((n) => n.containerId === 'svc')
    for (let i = 0; i < level.length; i++) {
      for (let j = i + 1; j < level.length; j++) {
        const a = level[i]
        const b = level[j]
        if (a === undefined || b === undefined) continue
        expect(Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y)).toBeGreaterThanOrEqual(a.r + b.r)
      }
    }
  })

  it('keeps fixed nodes where they are and places the new ones next to their partners', () => {
    const m = bigService()
    const fixed = new Map([...levelCells(m, childrenOf(m, 'svc'))].map(([id, v]) => [id, v.cell]))
    const ops = [...fixed].filter(([id]) => id !== 'p13').map(([id, at]) => ({ op: 'setLayout' as const, id, at }))
    const placed = applyOps(m, ops).model
    const cells = arrangeLevel(placed, 'svc', { movable: new Set(['p13']), timeLimitMs: 200 })
    for (const [id, c] of cells) if (id !== 'p13') expect(c).toEqual(placed.layout[id])
    expect(keys(cells).size).toBe(cells.size)
  })

  it('slides overlapping badges apart', () => {
    const line = (y: number) => ({ from: { x: 0, y }, to: { x: 300, y } })
    const t = placeBadges(
      [
        { key: 'a', ...line(0), width: 60, height: 18 },
        { key: 'b', ...line(4), width: 60, height: 18 },
      ],
      [],
    )
    expect(t.get('a')).not.toBe(t.get('b'))
  })
})
