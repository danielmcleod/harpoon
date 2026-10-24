// Checks on boundary zones that need no AI: a zone with nothing in it, outside parties inside a network zone, members
// drawn on another level than their zone, a node in two zones of a kind that cannot overlap, a subnet outside every
// VPC, and a member whose links all leave the zone.
import type { HxBoundary, HxNode, Model } from './schema.ts'
import type { Problem } from './lint.ts'

/** Zones that only hold the system's own deployables (an outside party inside one is misplaced). */
const NETWORK_ZONES: ReadonlySet<HxBoundary['type']> = new Set(['vpc', 'subnet', 'k8s-namespace', 'cloud-account', 'datacenter'])
/** Zones a node can be in only one of (of the same type, on the same level). */
const EXCLUSIVE_ZONES: ReadonlySet<HxBoundary['type']> = new Set(['vpc', 'subnet', 'k8s-namespace', 'cloud-account', 'datacenter', 'region'])

/** The node standing for `id` on the level drawn inside `parentId` (itself, or its ancestor there). */
function atLevel(m: Model, id: string, parentId: string | null): string | null {
  for (let cur: string | null = id, i = 0; cur !== null && i < 64; i++) {
    const n: HxNode | undefined = m.nodes[cur]
    if (n === undefined) return null
    if (n.parentId === parentId) return cur
    cur = n.parentId
  }
  return null
}

export function boundaryProblems(m: Model): Problem[] {
  const out: Problem[] = []
  const zones = Object.values(m.boundaries)
  for (const b of zones) {
    const members = b.nodeIds.filter((id) => m.nodes[id] !== undefined)
    if (members.length === 0) {
      out.push({ severity: 'info', code: 'boundary-empty', message: `Boundary ${b.name} has nothing in it.`, boundaryId: b.id })
      continue
    }
    for (const id of members) {
      const n = m.nodes[id]
      if (n === undefined) continue
      if (n.parentId !== b.parentId) {
        const where = b.parentId === null ? 'the top level' : `inside ${m.nodes[b.parentId]?.name ?? b.parentId}`
        out.push({ severity: 'warn', code: 'boundary-wrong-level', message: `${n.name} is in boundary ${b.name}, which is drawn on ${where}, but ${n.name} is not on that level.`, boundaryId: b.id, nodeId: id })
      }
      if (NETWORK_ZONES.has(b.type) && n.boundary === 'external') {
        out.push({ severity: 'warn', code: 'boundary-outside-party', message: `${n.name} is outside the system, yet it sits in ${b.name} (${b.type}).`, boundaryId: b.id, nodeId: id })
      }
    }
    // A member whose links all leave the zone (only for zones with several members).
    if (members.length >= 3) {
      const inside = new Set(members)
      for (const id of members) {
        const ends: string[] = []
        for (const c of Object.values(m.connectors)) {
          const s = atLevel(m, c.source, b.parentId)
          const t = atLevel(m, c.target, b.parentId)
          if (s === id && t !== null && t !== id) ends.push(t)
          else if (t === id && s !== null && s !== id) ends.push(s)
        }
        if (ends.length >= 2 && ends.every((e) => !inside.has(e))) {
          out.push({ severity: 'info', code: 'boundary-isolated-member', message: `${m.nodes[id]?.name ?? id} is in ${b.name} but all its links go outside it; check it belongs there.`, boundaryId: b.id, nodeId: id })
        }
      }
    }
    // A subnet on a level that has VPCs, outside all of them.
    if (b.type === 'subnet') {
      const vpcs = zones.filter((z) => z.type === 'vpc' && z.parentId === b.parentId)
      if (vpcs.length > 0 && !vpcs.some((v) => members.every((id) => v.nodeIds.includes(id)))) {
        out.push({ severity: 'info', code: 'boundary-subnet-outside-vpc', message: `Subnet ${b.name} is not inside any VPC on its level.`, boundaryId: b.id })
      }
    }
  }
  // One node, two zones of a kind that cannot overlap (two VPCs, two namespaces).
  const seen = new Map<string, HxBoundary>()
  for (const b of zones) {
    if (!EXCLUSIVE_ZONES.has(b.type)) continue
    for (const id of b.nodeIds) {
      const key = `${b.type}|${id}`
      const first = seen.get(key)
      if (first !== undefined && first.id !== b.id) {
        out.push({ severity: 'warn', code: 'boundary-overlap', message: `${m.nodes[id]?.name ?? id} is in two ${b.type} zones: ${first.name} and ${b.name}.`, boundaryId: b.id, nodeId: id })
      } else seen.set(key, b)
    }
  }
  return out
}
