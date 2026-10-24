// One-click fixes for problems that need no judgement and no AI: references to things that no longer exist (a team,
// phase or data class; a connector a flow step uses; a node a boundary lists) and a two-way link with no reply
// channel; a top-level stray that belongs inside the one service using it. Everything else goes to the AI, which
// checks the code first. Pure: model and problem in, ops out.
import { axialToPixel, coordKey, nearestFreeCell, pixelToAxial } from '../geometry/hex.ts'
import { dataClassCatalog } from './governance.ts'
import type { Problem } from './lint.ts'
import { applyOps } from './ops.ts'
import type { Op } from './ops.ts'
import { ancestorsOf } from './queries.ts'
import { satellitesOf } from './satellites.ts'
import type { HexCoord, Model } from './schema.ts'

export interface QuickFix {
  /** Button text, e.g. "Clear the team". */
  label: string
  ops: Op[]
}

export function quickFix(m: Model, p: Problem): QuickFix | null {
  const node = p.nodeId !== undefined ? m.nodes[p.nodeId] : undefined
  const conn = p.connectorId !== undefined ? m.connectors[p.connectorId] : undefined
  const zone = p.boundaryId !== undefined ? m.boundaries[p.boundaryId] : undefined
  const flow = p.flowId !== undefined ? m.flows[p.flowId] : undefined
  switch (p.code) {
    case 'unknown-team': {
      if (node !== undefined) return { label: 'Clear the team', ops: [{ op: 'updateNode', id: node.id, patch: { team: null } }] }
      if (conn !== undefined) return { label: 'Clear the team', ops: [{ op: 'updateConnector', id: conn.id, patch: { team: null } }] }
      if (zone !== undefined) return { label: 'Clear the team', ops: [{ op: 'updateBoundary', id: zone.id, patch: { team: null } }] }
      return null
    }
    case 'unknown-phase': {
      if (node !== undefined) return { label: 'Clear the phase', ops: [{ op: 'updateNode', id: node.id, patch: { phase: null } }] }
      if (conn !== undefined) return { label: 'Clear the phase', ops: [{ op: 'updateConnector', id: conn.id, patch: { phase: null } }] }
      return null
    }
    case 'unknown-data-class': {
      const known = new Set(dataClassCatalog(m.meta).map((d) => d.id))
      const keep = (ids: string[]): string[] => ids.filter((x) => known.has(x))
      if (node !== undefined) return { label: 'Remove unknown data classes', ops: [{ op: 'updateNode', id: node.id, patch: { dataClasses: keep(node.dataClasses) } }] }
      if (conn !== undefined) {
        const patch = {
          channelA: { ...conn.channelA, dataClasses: keep(conn.channelA.dataClasses) },
          ...(conn.channelB !== null ? { channelB: { ...conn.channelB, dataClasses: keep(conn.channelB.dataClasses) } } : {}),
        }
        return { label: 'Remove unknown data classes', ops: [{ op: 'updateConnector', id: conn.id, patch }] }
      }
      if (zone !== undefined) return { label: 'Remove unknown data classes', ops: [{ op: 'updateBoundary', id: zone.id, patch: { dataClasses: keep(zone.dataClasses) } }] }
      return null
    }
    case 'flow-missing-connector':
      if (flow === undefined) return null
      return { label: 'Drop the missing steps', ops: [{ op: 'updateFlow', id: flow.id, patch: { steps: flow.steps.filter((s) => m.connectors[s.connectorId] !== undefined) } }] }
    case 'boundary-missing-node':
      if (zone === undefined) return null
      return { label: 'Drop the missing nodes', ops: [{ op: 'updateBoundary', id: zone.id, patch: { nodeIds: zone.nodeIds.filter((id) => m.nodes[id] !== undefined) } }] }
    case 'stray-node': {
      const owner = node === undefined ? undefined : satellitesOf(m).get(node.id)
      if (node === undefined || owner === undefined) return null
      return { label: `Move inside ${m.nodes[owner]?.name ?? owner}`, ops: moveInsideOps(m, node.id, owner) }
    }
    case 'duplex-no-return':
      if (conn === undefined) return null
      // A request/response link answers on the same protocol unless someone says otherwise.
      return { label: `Add a ${conn.channelA.protocol} reply`, ops: [{ op: 'updateConnector', id: conn.id, patch: { channelB: { ...conn.channelA, description: null, payloadSchema: null, dataClasses: [] } } }] }
    default:
      return null
  }
}

/**
 * Reparent `id` into `owner` and give it a free cell there, next to the inner parts it talks to (or near the middle
 * when it only talks to the owner itself).
 */
export function moveInsideOps(m: Model, id: string, owner: string): Op[] {
  const siblings = Object.values(m.nodes).filter((n) => n.parentId === owner && n.id !== id)
  const taken = new Set(siblings.map((n) => m.layout[n.id]).filter((c): c is HexCoord => c !== undefined).map(coordKey))
  const near: HexCoord[] = []
  for (const c of Object.values(m.connectors)) {
    const other = c.source === id ? c.target : c.target === id ? c.source : null
    if (other === null) continue
    // The inner part on the owner's level that the connector reaches.
    const part = m.nodes[other]?.parentId === owner ? other : ancestorsOf(m, other).find((a) => a.parentId === owner)?.id
    const at = part === undefined ? undefined : m.layout[part]
    if (at !== undefined) near.push(at)
  }
  let want: HexCoord = { q: 0, r: 0 }
  if (near.length > 0) {
    const px = near.map((c) => axialToPixel(c))
    want = pixelToAxial({ x: px.reduce((s, p) => s + p.x, 0) / px.length, y: px.reduce((s, p) => s + p.y, 0) / px.length })
  }
  const at = nearestFreeCell(want, (c) => taken.has(coordKey(c)))
  return [
    { op: 'updateNode', id, patch: { parentId: owner } },
    { op: 'setLayout', id, at },
  ]
}

/** One edit that moves every top-level stray inside the service that uses it ("Move all strays inside their owners"). */
export function moveAllStraysOps(m: Model): Op[] {
  const ops: Op[] = []
  let cur = m
  for (const [id, owner] of satellitesOf(m)) {
    const step = moveInsideOps(cur, id, owner)
    cur = applyOps(cur, step).model
    ops.push(...step)
  }
  return ops
}
