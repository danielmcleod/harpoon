import { describe, expect, it } from 'vitest'
import { harpoonGeometry, portFacing } from '../../src/shared/geometry/harpoon.ts'
import { AXIAL_DIRS, axialToPixel, hexSpiral, pixelToAxial, PORT_ORDER } from '../../src/shared/geometry/hex.ts'

describe('hex grid', () => {
  it('round-trips axial and pixel coordinates', () => {
    for (const c of [{ q: 0, r: 0 }, { q: 3, r: -2 }, { q: -4, r: 5 }]) {
      expect(pixelToAxial(axialToPixel(c))).toEqual(c)
    }
  })

  it('puts each neighbour exactly behind its port', () => {
    for (const port of PORT_ORDER) {
      const p = axialToPixel(AXIAL_DIRS[port])
      expect(portFacing(Math.atan2(p.y, p.x))).toBe(port)
    }
  })

  it('spirals through unique cells ring by ring', () => {
    const it = hexSpiral()
    const cells = Array.from({ length: 19 }, () => it.next().value as { q: number; r: number })
    expect(new Set(cells.map((c) => `${c.q},${c.r}`)).size).toBe(19)
  })
})

describe('harpoon geometry', () => {
  const shape = (x: number, y: number) => ({ center: { x, y }, r: 56, squash: 1 })

  it('docks on facing ports and draws two parallel, opposite lines', () => {
    const g = harpoonGeometry(shape(0, 0), shape(300, 0), { duplex: true, gap: 10 })
    expect(g.sourcePort).toBe('se')
    expect(g.targetPort).toBe('nw')
    const b = g.b
    expect(b).not.toBeNull()
    if (b === null) return
    const da = { x: g.a.to.x - g.a.from.x, y: g.a.to.y - g.a.from.y }
    const db = { x: b.to.x - b.from.x, y: b.to.y - b.from.y }
    // Anti-parallel: the cross product is ~0 and the dot product negative.
    expect(Math.abs(da.x * db.y - da.y * db.x)).toBeLessThan(1e-6)
    expect(da.x * db.x + da.y * db.y).toBeLessThan(0)
  })

  it('puts each barb on the outer side of its line', () => {
    const g = harpoonGeometry(shape(0, 0), shape(0, 300), { duplex: true, gap: 10 })
    const b = g.b
    if (b === null) throw new Error('duplex')
    // Going down (A): the left of travel is +x, so A sits right of centre with its barb further right.
    expect(g.a.from.x).toBeGreaterThan(0)
    expect(g.a.barb.x).toBeGreaterThan(g.a.to.x)
    expect(b.barb.x).toBeLessThan(b.to.x)
  })
})
