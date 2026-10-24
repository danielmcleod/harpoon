// Satellites: small supporting parts (a cache, a bucket, a worker…) that sit on a level next to the one node they
// serve and talk to nothing else. Imports from real repos leave many of them at the top level. The Overview detail
// level folds them into their owner (view only), and the `stray-node` lint suggests moving them inside it.
import { ancestorsOf } from './queries.ts'
import type { Model, NodeKind } from './schema.ts'

/** Kinds that support one service rather than stand on their own. */
export const SATELLITE_KINDS: ReadonlySet<NodeKind> = new Set(['cache', 'storage', 'worker', 'scheduler', 'function', 'process', 'module'])

/** The child of `parentId` that `id` is (or is inside), or null when `id` is not under that level. */
function onLevel(m: Model, id: string, parentId: string | null): string | null {
  if (m.nodes[id]?.parentId === parentId) return id
  for (const a of ancestorsOf(m, id)) if (a.parentId === parentId) return a.id
  return null
}

/**
 * Satellites of one level (default: the top level), each mapped to its owner: an internal node of a supporting kind
 * whose connectors (its own and its inner parts') all go to one other node of the same level. A satellite never
 * owns another satellite, so two parts that only talk to each other both stay.
 */
export function satellitesOf(m: Model, parentId: string | null = null): Map<string, string> {
  const partners = new Map<string, Set<string>>()
  for (const c of Object.values(m.connectors)) {
    const a = onLevel(m, c.source, parentId)
    const b = onLevel(m, c.target, parentId)
    if (a === b) continue
    // A connector that leaves the level counts as a partner nobody on the level can own.
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      if (x === null) continue
      const set = partners.get(x) ?? new Set<string>()
      set.add(y ?? '\u0000outside')
      partners.set(x, set)
    }
  }
  const candidates = new Map<string, string>()
  for (const n of Object.values(m.nodes)) {
    if (n.parentId !== parentId || n.boundary !== 'internal' || !SATELLITE_KINDS.has(n.kind) || n.status === 'removed') continue
    const set = partners.get(n.id)
    if (set === undefined || set.size !== 1) continue
    const owner = [...set][0]
    const o = owner === undefined ? undefined : m.nodes[owner]
    if (o === undefined || o.boundary !== 'internal') continue
    candidates.set(n.id, o.id)
  }
  const out = new Map<string, string>()
  for (const [id, owner] of candidates) if (!candidates.has(owner)) out.set(id, owner)
  return out
}
