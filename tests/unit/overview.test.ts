// Overview folds top-level satellites into their owner; the stray lint and its fix move them inside for real;
// reciprocal connectors are drawn side by side.
import { describe, expect, it } from 'vitest'
import { harpoonGeometry, RECIPROCAL_OFFSET } from '../../src/shared/geometry/harpoon.ts'
import { computeScene } from '../../src/shared/geometry/scene.ts'
import { lintModel } from '../../src/shared/model/lint.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import type { Op } from '../../src/shared/model/ops.ts'
import { moveAllStraysOps, quickFix } from '../../src/shared/model/quickfix.ts'
import { satellitesOf } from '../../src/shared/model/satellites.ts'
import { ConnectorZ, NodeZ, emptyModel } from '../../src/shared/model/schema.ts'
import type { NodeKind } from '../../src/shared/model/schema.ts'

const node = (id: string, kind: NodeKind, extra: Record<string, unknown> = {}): Op => ({ op: 'addNode', node: NodeZ.parse({ id, name: id, kind, ...extra }), at: null })
const conn = (source: string, target: string): Op => ({ op: 'addConnector', connector: ConnectorZ.parse({ id: `${source}-${target}`, source, target, duplex: false, channelB: null }) })

const model = applyOps(emptyModel({ id: 'o', name: 'O' }), [
  node('web', 'client', { boundary: 'external' }),
  node('api', 'service'),
  node('api-db', 'database'),
  node('orders', 'service'),
  node('orders-cache', 'cache'),
  node('orders-worker', 'worker'),
  node('mailer', 'worker'),
  node('stripe', 'saas', { boundary: 'external' }),
  node('api-handler', 'process', { parentId: 'api' }),
  conn('web', 'api'),
  conn('api', 'orders'),
  conn('orders', 'orders-cache'),
  conn('orders-worker', 'orders'),
  conn('orders', 'orders-worker'),
  conn('api-handler', 'api-db'),
  // mailer talks to two services: not a satellite.
  conn('orders', 'mailer'),
  conn('api', 'mailer'),
  conn('orders', 'stripe'),
]).model

describe('satellites and Overview', () => {
  it('finds supporting parts that only one top-level node uses', () => {
    expect(Object.fromEntries(satellitesOf(model))).toEqual({ 'orders-cache': 'orders', 'orders-worker': 'orders' })
  })

  it('folds them into their owner in Overview only, collapsing containers and keeping externals', () => {
    const full = computeScene(model, { expanded: new Set(['api']), focusId: null, style: 'flat' })
    expect(full.nodes.has('orders-cache')).toBe(true)
    expect(full.nodes.get('api')?.expanded).toBe(true)

    const ov = computeScene(model, { expanded: new Set(['api']), focusId: null, style: 'flat', detail: 'overview' })
    expect(ov.nodes.has('orders-cache')).toBe(false)
    expect(ov.nodes.has('orders-worker')).toBe(false)
    expect(ov.nodes.get('orders')?.folded.sort()).toEqual(['orders-cache', 'orders-worker'])
    expect(ov.nodes.get('api')?.expanded).toBe(false)
    expect(ov.nodes.has('api-handler')).toBe(false)
    for (const id of ['web', 'stripe', 'mailer', 'api-db']) expect(ov.nodes.has(id)).toBe(true)
    // Edges lift through: the satellite's lines to its owner vanish, the handler's line lifts to api.
    const keys = ov.edges.map((e) => e.key)
    expect(keys).toContain('api→api-db')
    expect(keys.some((k) => k.includes('orders-cache') || k.includes('orders-worker'))).toBe(false)
  })

  it('lints strays and moves them inside their owner, one by one or all at once', () => {
    const strays = lintModel(model).filter((p) => p.code === 'stray-node')
    expect(strays.map((p) => p.message)).toContain('orders-cache is only used by orders; move it inside orders.')
    const first = strays[0]
    if (first === undefined) throw new Error('no stray')
    const fix = quickFix(model, first)
    if (fix === null) throw new Error('no fix')
    const one = applyOps(model, fix.ops).model
    expect(one.nodes[first.nodeId ?? '']?.parentId).toBe('orders')
    expect(one.layout[first.nodeId ?? '']).toBeDefined()

    const all = applyOps(model, moveAllStraysOps(model)).model
    expect(all.nodes['orders-cache']?.parentId).toBe('orders')
    expect(all.nodes['orders-worker']?.parentId).toBe('orders')
    const cells = ['orders-cache', 'orders-worker'].map((id) => all.layout[id])
    expect(cells[0]).not.toEqual(cells[1])
    expect(lintModel(all).some((p) => p.code === 'stray-node')).toBe(false)
  })
})

describe('reciprocal connectors', () => {
  it('pairs A→B with B→A and draws them on parallel lines, not the same pixels', () => {
    const scene = computeScene(model, { expanded: new Set(), focusId: null, style: 'flat' })
    const there = scene.edges.find((e) => e.key === 'orders-worker→orders')
    const back = scene.edges.find((e) => e.key === 'orders→orders-worker')
    expect(there?.reciprocal).toBe(true)
    expect(back?.reciprocal).toBe(true)
    expect(scene.edges.find((e) => e.key === 'api→orders')?.reciprocal).toBe(false)

    const a = { center: { x: 0, y: 0 }, r: 56, squash: 1 }
    const b = { center: { x: 400, y: 0 }, r: 56, squash: 1 }
    const ab = harpoonGeometry(a, b, { duplex: false, offset: RECIPROCAL_OFFSET })
    const ba = harpoonGeometry(b, a, { duplex: false, offset: RECIPROCAL_OFFSET })
    expect(ab.a.from.y).toBeCloseTo(-RECIPROCAL_OFFSET)
    expect(ba.a.from.y).toBeCloseTo(RECIPROCAL_OFFSET)
    // Parallel: both horizontal, a clear gap between them.
    expect(ab.a.to.y).toBeCloseTo(ab.a.from.y)
    expect(Math.abs(ab.a.from.y - ba.a.from.y)).toBeGreaterThan(2 * 5)
  })
})
