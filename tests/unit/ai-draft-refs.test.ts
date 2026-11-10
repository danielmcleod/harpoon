// What the agent names must be the diagram's own: a name every object has ("constructor") is not a node.
import { describe, expect, it } from 'vitest'
import { Draft, DraftError, own } from '../../src/core/ai/draft.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import { sampleOps } from '../../src/shared/model/sample.ts'
import { emptyModel } from '../../src/shared/model/schema.ts'

const model = applyOps(emptyModel({ id: 'shop', name: 'Shop' }), sampleOps()).model

describe('references from the agent', () => {
  it('finds a node by id', () => {
    const id = Object.keys(model.nodes)[0] ?? ''
    expect(new Draft(model).nodeRef(id)).toBe(id)
    expect(own(model.nodes, id)?.id).toBe(id)
  })

  it('refuses names that only Object.prototype has', () => {
    const d = new Draft(model)
    for (const ref of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(() => d.nodeRef(ref)).toThrow(DraftError)
      expect(() => d.connectorRef(ref)).toThrow(DraftError)
      expect(own(model.nodes, ref)).toBeUndefined()
    }
  })

  it('still lets a new node take such a name as its id', () => {
    expect(new Draft(model).newNodeId('Constructor')).toBe('constructor')
  })
})
