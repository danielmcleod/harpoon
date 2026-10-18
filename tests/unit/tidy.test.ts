import { describe, expect, it } from 'vitest'
import { levelCells } from '../../src/shared/geometry/scene.ts'
import { levelLinks, placeBadges, tidyLevel } from '../../src/shared/geometry/tidy.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import { childrenOf } from '../../src/shared/model/queries.ts'
import { sampleOps } from '../../src/shared/model/sample.ts'
import { emptyModel } from '../../src/shared/model/schema.ts'

const model = applyOps(emptyModel({ id: 's', name: 'S' }), sampleOps()).model

describe('tidy layout', () => {
  it('only moves nodes to free cells and never stacks two on one cell', () => {
    for (const parent of [null, 'auth-service']) {
      const kids = childrenOf(model, parent)
      const cells = new Map([...levelCells(model, kids)].map(([id, v]) => [id, v.cell]))
      const moved = tidyLevel(model, parent, cells)
      const after = new Map([...cells, ...moved])
      expect(new Set([...after.values()].map((c) => `${c.q},${c.r}`)).size).toBe(after.size)
      expect(levelLinks(model, parent).length).toBeGreaterThan(0)
    }
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
