import { describe, expect, it } from 'vitest'
import { moveOps } from '../../src/renderer/src/canvas/edits.ts'
import { mentionedNodes } from '../../src/renderer/src/notes/mentions.ts'
import { axialToPixel } from '../../src/shared/geometry/hex.ts'
import { computeScene } from '../../src/shared/geometry/scene.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import { sampleOps } from '../../src/shared/model/sample.ts'
import { emptyModel } from '../../src/shared/model/schema.ts'

describe('renderer fixes', () => {
  it('moveOps: a node dropped back in its own cell makes no op; another cell does', () => {
    const model = applyOps(emptyModel({ id: 's', name: 'S' }), sampleOps()).model
    const scene = computeScene(model, { expanded: new Set(), focusId: null, style: 'flat' })
    const node = [...scene.nodes.values()].find((n) => !n.ghost && n.containerId === null)
    if (node === undefined) throw new Error('the sample has no top-level node')
    // A click that slipped two pixels: same cell, same container.
    expect(
      moveOps(model, scene, [{ id: node.id, center: { x: node.center.x + 2, y: node.center.y + 2 } }]),
    ).toEqual([])
    // A real move: far outside the diagram, so the cell is another one.
    const far = axialToPixel({ q: 40, r: 40 })
    const ops = moveOps(model, scene, [
      { id: node.id, center: { x: scene.rootOrigin.x + far.x, y: scene.rootOrigin.y + far.y } },
    ])
    expect(ops).toEqual([{ op: 'setLayout', id: node.id, at: { q: 40, r: 40 } }])
  })

  it('mentionedNodes: a stray % in a mention does not throw', () => {
    expect(
      mentionedNodes(
        'See [@A](harpoon:node/50%) and [@B](harpoon:node/pay%20api), again [@B](harpoon:node/pay%20api).',
      ),
    ).toEqual(['50%', 'pay api'])
  })
})
