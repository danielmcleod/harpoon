import { describe, expect, it } from 'vitest'
import { compareModels, diffModels } from '../../src/shared/model/diff.ts'
import { OpError, applyOps, parseOps, removeNodeOps } from '../../src/shared/model/ops.ts'
import type { Op } from '../../src/shared/model/ops.ts'
import { ConnectorZ, FlowZ, NodeZ, emptyModel } from '../../src/shared/model/schema.ts'
import type { Model } from '../../src/shared/model/schema.ts'

const node = (id: string, parentId: string | null = null) => NodeZ.parse({ id, name: id, parentId })
const conn = (id: string, source: string, target: string) => ConnectorZ.parse({ id, source, target })

function seed(): Model {
  const ops: Op[] = [
    { op: 'addNode', node: node('gw'), at: { q: 0, r: 0 } },
    { op: 'addNode', node: node('users'), at: { q: 2, r: 0 } },
    { op: 'addNode', node: node('users-api', 'users'), at: { q: 0, r: 0 } },
    { op: 'addNode', node: node('users-db', 'users'), at: { q: 1, r: 0 } },
    { op: 'addConnector', connector: conn('c1', 'gw', 'users-api') },
    { op: 'addConnector', connector: conn('c2', 'users-api', 'users-db') },
    { op: 'addFlow', flow: FlowZ.parse({ id: 'login', name: 'Login', steps: [{ connectorId: 'c1' }] }) },
  ]
  return applyOps(emptyModel({ id: 'p', name: 'P' }), ops).model
}

describe('applyOps', () => {
  it('applies a batch and its inverse restores the model', () => {
    const base = seed()
    const ops: Op[] = [
      { op: 'updateNode', id: 'gw', patch: { name: 'Gateway', techStack: 'Envoy' } },
      { op: 'setLayout', id: 'gw', at: { q: -1, r: 1 } },
      ...removeNodeOps(base, 'users'),
    ]
    const { model, inverse } = applyOps(base, ops)
    expect(model.nodes['users']).toBeUndefined()
    expect(model.nodes['users-db']).toBeUndefined()
    expect(Object.keys(model.connectors)).toEqual([])
    expect(model.flows['login']?.steps).toEqual([])
    expect(model.nodes['gw']?.name).toBe('Gateway')

    const back = applyOps(model, inverse).model
    expect(compareModels(base, back)).toEqual(compareModels(base, base))
    expect(back.layout).toEqual(base.layout)
    expect(back.flows['login']?.steps).toHaveLength(1)
  })

  it('refuses dangling references and cycles without touching the input', () => {
    const base = seed()
    expect(() => applyOps(base, [{ op: 'removeNode', id: 'users' }])).toThrow(OpError)
    expect(() => applyOps(base, [{ op: 'addConnector', connector: conn('x', 'gw', 'nope') }])).toThrow(/target/)
    expect(() => applyOps(base, [{ op: 'updateNode', id: 'users', patch: { parentId: 'users-api' } }])).toThrow(
      /inside itself/,
    )
    expect(base.nodes['users']).toBeDefined()
  })

  it('parses ops without filling patch defaults', () => {
    const [op] = parseOps([{ op: 'updateNode', id: 'gw', patch: { name: 'G', vendor: undefined } }])
    expect(op).toEqual({ op: 'updateNode', id: 'gw', patch: { name: 'G' } })
  })
})

describe('diffModels', () => {
  it('produces ops that turn one model into another', () => {
    const a = seed()
    const b = applyOps(a, [
      { op: 'addNode', node: node('fraud'), at: { q: 4, r: 0 } },
      { op: 'addConnector', connector: conn('c3', 'users-api', 'fraud') },
      { op: 'updateNode', id: 'users-db', patch: { parentId: null, kind: 'database' } },
      { op: 'removeConnector', id: 'c1' },
      { op: 'removeNode', id: 'gw' },
    ]).model
    const ops = diffModels(a, b)
    const result = applyOps(a, ops).model
    const s = compareModels(result, b)
    expect([...s.nodes, ...s.connectors, ...s.flows]).toEqual([])
    expect(s.moved).toEqual([])
  })
})
