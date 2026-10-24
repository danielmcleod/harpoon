// Read-only graph queries over the model: hierarchy walks, edge lifting to visible ancestors, neighbours and blast
// radius. Pure functions; callers memoize.
import type { HxConnector, HxNode, Model } from './schema.ts'

export function childrenOf(m: Model, parentId: string | null): HxNode[] {
  return Object.values(m.nodes).filter((n) => n.parentId === parentId)
}

export function hasChildren(m: Model, id: string): boolean {
  for (const n of Object.values(m.nodes)) if (n.parentId === id) return true
  return false
}

/** Parent chain from the node's parent up to the top (nearest first). */
export function ancestorsOf(m: Model, id: string): HxNode[] {
  const out: HxNode[] = []
  let cur = m.nodes[id]?.parentId ?? null
  const seen = new Set<string>()
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur)
    const n = m.nodes[cur]
    if (n === undefined) break
    out.push(n)
    cur = n.parentId
  }
  return out
}

/** Every node under `id` (depth-first). */
export function descendantIds(m: Model, id: string): string[] {
  const kids = new Map<string, string[]>()
  for (const n of Object.values(m.nodes)) {
    if (n.parentId === null) continue
    const list = kids.get(n.parentId)
    if (list === undefined) kids.set(n.parentId, [n.id])
    else list.push(n.id)
  }
  const out: string[] = []
  const stack = [...(kids.get(id) ?? [])]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (cur === undefined) break
    out.push(cur)
    stack.push(...(kids.get(cur) ?? []))
  }
  return out
}

/** `ancestor` is `id` itself or one of its ancestors. */
export function isSelfOrAncestor(m: Model, ancestor: string, id: string): boolean {
  if (ancestor === id) return true
  return ancestorsOf(m, id).some((a) => a.id === ancestor)
}

export function depthOf(m: Model, id: string): number {
  return ancestorsOf(m, id).length
}

/**
 * The node a connector endpoint is drawn at: the endpoint itself when visible, else its nearest visible ancestor.
 * `visible(id)` says whether a node is on screen (its parent chain is expanded / within the focused subgraph);
 * `folded` maps nodes folded into another one (Overview) to the node that stands for them.
 */
export function liftEndpoint(m: Model, id: string, visible: (id: string) => boolean, folded?: ReadonlyMap<string, string>): string | null {
  for (const x of [id, ...ancestorsOf(m, id).map((a) => a.id)]) {
    if (visible(x)) return x
    const into = folded?.get(x)
    if (into !== undefined && visible(into)) return into
  }
  return null
}

export interface LiftedEdge {
  /** Stable key: drawn source → drawn target. */
  key: string
  source: string
  target: string
  /** The model connectors drawn as this edge (several when lifting merges them). */
  connectors: HxConnector[]
  /** A drawn edge also runs the other way on this pair (target → source): draw the two side by side. */
  reciprocal: boolean
}

/**
 * Connectors as drawn: endpoints lifted to visible nodes; connectors that end up inside one node (both ends in the
 * same collapsed subtree) disappear; several that land on the same pair merge into one drawn edge.
 */
export function liftedEdges(m: Model, visible: (id: string) => boolean, folded?: ReadonlyMap<string, string>): LiftedEdge[] {
  const out = new Map<string, LiftedEdge>()
  for (const c of Object.values(m.connectors)) {
    const s = liftEndpoint(m, c.source, visible, folded)
    const t = liftEndpoint(m, c.target, visible, folded)
    if (s === null || t === null || s === t) continue
    // One drawn edge per unordered pair would hide direction; keep direction, so A→B and B→A stay separate.
    const key = `${s}→${t}`
    const e = out.get(key)
    if (e === undefined) out.set(key, { key, source: s, target: t, connectors: [c], reciprocal: false })
    else e.connectors.push(c)
  }
  for (const e of out.values()) e.reciprocal = out.has(`${e.target}→${e.source}`)
  return [...out.values()]
}

export function connectorsOf(m: Model, nodeId: string): HxConnector[] {
  return Object.values(m.connectors).filter((c) => c.source === nodeId || c.target === nodeId)
}

/** Connectors touching the node or anything inside it. */
export function connectorsTouchingSubtree(m: Model, nodeId: string): HxConnector[] {
  const ids = new Set([nodeId, ...descendantIds(m, nodeId)])
  return Object.values(m.connectors).filter((c) => ids.has(c.source) || ids.has(c.target))
}

export type BlastDirection = 'upstream' | 'downstream' | 'both'

/**
 * Nodes reachable from `id` along connectors within `hops` (Infinity: all). Downstream = what `id` calls (it breaks
 * if they break); upstream = who calls `id` (they break if it breaks).
 */
export function blastRadius(m: Model, id: string, dir: BlastDirection, hops = Infinity): Set<string> {
  // A service's connectors usually attach to its inner parts: start from the whole subtree.
  const start = [id, ...descendantIds(m, id)]
  const out = new Set<string>(start)
  let frontier = start
  for (let h = 0; h < hops && frontier.length > 0; h++) {
    const next: string[] = []
    for (const cur of frontier) {
      for (const c of Object.values(m.connectors)) {
        if ((dir === 'downstream' || dir === 'both') && c.source === cur && !out.has(c.target)) {
          out.add(c.target)
          next.push(c.target)
        }
        if ((dir === 'upstream' || dir === 'both') && c.target === cur && !out.has(c.source)) {
          out.add(c.source)
          next.push(c.source)
        }
      }
    }
    frontier = next
  }
  return out
}

/** Upstream callers and downstream dependencies of a node (direct only). */
export function neighbours(m: Model, id: string): { upstream: HxNode[]; downstream: HxNode[] } {
  const up = new Map<string, HxNode>()
  const down = new Map<string, HxNode>()
  for (const c of Object.values(m.connectors)) {
    if (c.target === id) {
      const n = m.nodes[c.source]
      if (n !== undefined) up.set(n.id, n)
    }
    if (c.source === id) {
      const n = m.nodes[c.target]
      if (n !== undefined) down.set(n.id, n)
    }
  }
  return { upstream: [...up.values()], downstream: [...down.values()] }
}

/** Human path for a node: "Payments › payment-api". */
export function pathLabel(m: Model, id: string): string {
  const n = m.nodes[id]
  if (n === undefined) return id
  return [...ancestorsOf(m, id).reverse().map((a) => a.name), n.name].join(' › ')
}

/**
 * Callers and dependencies of a node including everything inside it (only nodes outside the subtree), with the
 * connectors that cross its edge: a collapsed service's real connections.
 */
export function subtreeNeighbours(m: Model, id: string): { upstream: HxNode[]; downstream: HxNode[]; connectors: HxConnector[] } {
  const inside = new Set([id, ...descendantIds(m, id)])
  const up = new Map<string, HxNode>()
  const down = new Map<string, HxNode>()
  const crossing: HxConnector[] = []
  for (const c of Object.values(m.connectors)) {
    const si = inside.has(c.source)
    const ti = inside.has(c.target)
    if (si === ti) continue
    crossing.push(c)
    const other = m.nodes[si ? c.target : c.source]
    if (other === undefined) continue
    if (si) down.set(other.id, other)
    else up.set(other.id, other)
  }
  return { upstream: [...up.values()], downstream: [...down.values()], connectors: crossing }
}

export interface ImpactHit {
  /** Hops from the origin (0 = the origin itself or its inner parts). */
  hop: number
  /** affected: breaks if the origin fails (calls it, directly or not); needed: the origin depends on it. */
  kind: 'origin' | 'affected' | 'needed'
}

/**
 * Impact analysis from a node (and everything inside it): who is affected if it fails (callers, walking connectors
 * backwards) and what it needs to work (dependencies, walking forwards), with the hop count of each.
 */
export function impactOf(m: Model, id: string, dir: BlastDirection, hops = Infinity): Map<string, ImpactHit> {
  const out = new Map<string, ImpactHit>()
  const start = [id, ...descendantIds(m, id)]
  for (const s of start) out.set(s, { hop: 0, kind: 'origin' })
  const walk = (kind: 'affected' | 'needed'): void => {
    let frontier = start
    for (let h = 1; h <= hops && frontier.length > 0; h++) {
      const next: string[] = []
      for (const cur of frontier) {
        for (const c of Object.values(m.connectors)) {
          const other = kind === 'affected' ? (c.target === cur ? c.source : null) : c.source === cur ? c.target : null
          if (other === null || out.has(other)) continue
          out.set(other, { hop: h, kind })
          next.push(other)
        }
      }
      frontier = next
    }
  }
  if (dir === 'upstream' || dir === 'both') walk('affected')
  if (dir === 'downstream' || dir === 'both') walk('needed')
  return out
}
