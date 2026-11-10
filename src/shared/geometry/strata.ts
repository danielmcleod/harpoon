// Strata: the architecture as floating levels, for the 3D view. Pure and deterministic, like the scene.
//
// - Every model depth gets its own deck: the top-level nodes on one, their inner parts on the deck below, and so on.
//   Nothing is expanded in place, so nothing pushes its neighbours aside: a node's parts hang under it.
// - A deck keeps the saved hex cells of each level. The parts of one parent form a cluster under that parent; the
//   clusters of a deck are spread until none overlap, so no two nodes on a deck ever do.
// - Above the top level sits the Core deck: the handful of nodes the system turns around, each standing for itself
//   and the nodes that mostly serve it (computed here, view only; nothing is saved).
// - Connectors are drawn on the deepest deck where both ends are visible, lifted to the ancestors on that deck; a
//   connector between a part and a node with no parts of its own rises from one deck to the next ("riser").
import { satellitesOf } from '../model/satellites.ts'
import type { HxNode, Model } from '../model/schema.ts'
import { NODE_R, axialToPixel } from './hex.ts'
import { levelCells } from './scene.ts'

/** Vertical distance between decks (world units; a node hexagon is NODE_R across its radius). */
export const DECK_GAP = 380
/** Circumradius of a Core hexagon. */
export const CORE_R = Math.round(NODE_R * 1.45)
/** Fewer top-level nodes than this and there is nothing to summarise: no Core deck. */
export const CORE_MIN_NODES = 7
const CORE_MAX_GROUPS = 7
const CLUSTER_MARGIN = 56
const DECK_PAD = 64
/** How far a deck may be scaled out, as a whole, before clusters are pushed apart one by one. */
const MAX_SPREAD = 1.8

export interface StrataNode {
  /** A model node id, or `core:<anchor id>` for a Core group. */
  id: string
  kind: 'node' | 'group'
  /** Index into `decks`. */
  deck: number
  x: number
  z: number
  r: number
  /** The node on the deck above this one hangs from (null on the top deck). */
  parent: string | null
  /** The nodes hanging from this one on the deck below. */
  children: string[]
  /** Core group: the top-level nodes it stands for, the anchor first. */
  members: string[]
}

export interface StrataDeck {
  index: number
  /** The model depth shown, or 'core'. */
  depth: number | 'core'
  label: string
  /** Altitude: 0 for the top deck, lower decks below it. */
  y: number
  center: { x: number; z: number }
  radius: number
  nodeIds: string[]
}

export interface StrataEdge {
  id: string
  /** The deck it is drawn on (the lower one for a riser). */
  deck: number
  a: string
  b: string
  /** How many connectors run a→b and b→a. */
  ab: number
  ba: number
  connectorIds: string[]
  /** Every connector in it is asynchronous. */
  async: boolean
  /** Its ends are on different decks. */
  riser: boolean
}

export interface StrataLayout {
  decks: StrataDeck[]
  nodes: Map<string, StrataNode>
  edges: StrataEdge[]
  hasCore: boolean
}

export interface CoreGroup {
  anchor: string
  /** Anchor first, then the rest by id. */
  members: string[]
}

export const coreId = (anchor: string): string => `core:${anchor}`

function deckLabel(depth: number | 'core'): string {
  if (depth === 'core') return 'Core'
  return depth === 0 ? 'System' : depth === 1 ? 'Parts' : depth === 2 ? 'Internals' : `Level ${depth + 1}`
}

function childMap(m: Model): Map<string | null, HxNode[]> {
  const map = new Map<string | null, HxNode[]>()
  for (const n of Object.values(m.nodes)) {
    const list = map.get(n.parentId)
    if (list === undefined) map.set(n.parentId, [n])
    else list.push(n)
  }
  for (const list of map.values()) list.sort((a, b) => (a.id < b.id ? -1 : 1))
  return map
}

interface Disc {
  x: number
  z: number
  r: number
}

/** Push overlapping discs apart, in place, along the line between their centres (the smaller one moves further). */
export function pushApart(items: Disc[], margin: number): void {
  for (let iter = 0; iter < 400; iter++) {
    let worst = 0
    for (let i = 0; i < items.length; i++) {
      const a = items[i] as Disc
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j] as Disc
        let dx = b.x - a.x
        let dz = b.z - a.z
        let d = Math.hypot(dx, dz)
        const need = a.r + b.r + margin
        if (d >= need - 0.5) continue
        if (d < 1e-6) {
          // Same spot: a direction that differs per pair, so a stack fans out.
          const t = (i * 7 + j * 13) * 2.399963
          dx = Math.cos(t)
          dz = Math.sin(t)
          d = 0
        } else {
          dx /= d
          dz /= d
        }
        const overlap = need - d
        worst = Math.max(worst, overlap)
        const wa = b.r / (a.r + b.r)
        const wb = a.r / (a.r + b.r)
        a.x -= dx * overlap * wa
        a.z -= dz * overlap * wa
        b.x += dx * overlap * wb
        b.z += dz * overlap * wb
      }
    }
    if (worst < 0.5) return
  }
}

/** One level's nodes on their saved cells, centred on the middle of their bounding box. */
function clusterOf(
  m: Model,
  kids: readonly HxNode[],
): { local: Map<string, { x: number; z: number }>; radius: number } {
  const cells = levelCells(m, kids)
  const raw = new Map<string, { x: number; z: number }>()
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const n of kids) {
    const p = axialToPixel(cells.get(n.id)?.cell ?? { q: 0, r: 0 })
    raw.set(n.id, { x: p.x, z: p.y })
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.y)
    maxZ = Math.max(maxZ, p.y)
  }
  const cx = kids.length === 0 ? 0 : (minX + maxX) / 2
  const cz = kids.length === 0 ? 0 : (minZ + maxZ) / 2
  const local = new Map<string, { x: number; z: number }>()
  let radius = NODE_R
  for (const [id, p] of raw) {
    const q = { x: p.x - cx, z: p.z - cz }
    local.set(id, q)
    radius = Math.max(radius, Math.hypot(q.x, q.z) + NODE_R)
  }
  return { local, radius }
}

/**
 * The Core groups of a model, or null when the top level is small enough to read as it is. Anchors are the top-level
 * nodes with the most connectors (inner parts counted) that do not mostly serve an anchor already chosen; every other
 * node joins the anchor it is most strongly connected to, directly or through nodes that already joined.
 */
export function coreGroups(m: Model): CoreGroup[] | null {
  const tops = Object.values(m.nodes)
    .filter((n) => n.parentId === null)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  if (tops.length < CORE_MIN_NODES) return null
  const isTop = new Set(tops.map((n) => n.id))
  const topOf = new Map<string, string>()
  const descendants = new Map<string, number>()
  for (const n of Object.values(m.nodes)) {
    let cur: HxNode | undefined = n
    const seen = new Set<string>()
    while (cur !== undefined && cur.parentId !== null && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = m.nodes[cur.parentId]
    }
    if (cur === undefined || !isTop.has(cur.id)) continue
    topOf.set(n.id, cur.id)
    if (cur.id !== n.id) descendants.set(cur.id, (descendants.get(cur.id) ?? 0) + 1)
  }

  const weight = new Map<string, Map<string, number>>()
  const bump = (a: string, b: string): void => {
    const row = weight.get(a) ?? new Map<string, number>()
    row.set(b, (row.get(b) ?? 0) + 1)
    weight.set(a, row)
  }
  for (const c of Object.values(m.connectors)) {
    const a = topOf.get(c.source)
    const b = topOf.get(c.target)
    if (a === undefined || b === undefined || a === b) continue
    bump(a, b)
    bump(b, a)
  }
  const w = (a: string, b: string): number => weight.get(a)?.get(b) ?? 0
  const total = (id: string): number => {
    let sum = 0
    for (const v of weight.get(id)?.values() ?? []) sum += v
    return sum
  }
  const score = new Map(tops.map((n) => [n.id, total(n.id) + 0.25 * (descendants.get(n.id) ?? 0)]))
  const byScore = [...tops].sort(
    (a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1),
  )

  const satellites = satellitesOf(m)
  const k = Math.max(3, Math.min(CORE_MAX_GROUPS, Math.round(Math.sqrt(tops.length) * 1.25)))
  const anchors: string[] = []
  for (const n of byScore) {
    if (anchors.length >= k) break
    const t = total(n.id)
    if (t === 0 || satellites.has(n.id)) continue
    // Mostly talks to one anchor already chosen: it belongs to that one.
    if (anchors.some((a) => w(n.id, a) * 2 > t)) continue
    anchors.push(n.id)
  }
  if (anchors.length < 2) return null

  const groupOf = new Map<string, string>(anchors.map((a) => [a, a]))
  const rank = new Map(anchors.map((a, i) => [a, i]))
  for (;;) {
    const joins: [string, string][] = []
    for (const n of tops) {
      if (groupOf.has(n.id)) continue
      let best: string | null = null
      let bestW = 0
      for (const [other, weightTo] of weight.get(n.id) ?? []) {
        const g = groupOf.get(other)
        if (g === undefined) continue
        const better =
          weightTo > bestW ||
          (weightTo === bestW && best !== null && (rank.get(g) ?? 0) < (rank.get(best) ?? 0))
        if (better) {
          best = g
          bestW = weightTo
        }
      }
      if (best !== null) joins.push([n.id, best])
    }
    if (joins.length === 0) break
    for (const [id, g] of joins) groupOf.set(id, g)
  }
  // Connected to nothing that reaches an anchor: the nearest anchor on the grid takes it.
  const cells = levelCells(m, tops)
  const at = (id: string): { x: number; y: number } => axialToPixel(cells.get(id)?.cell ?? { q: 0, r: 0 })
  for (const n of tops) {
    if (groupOf.has(n.id)) continue
    const p = at(n.id)
    let best = anchors[0] as string
    let bestD = Infinity
    for (const a of anchors) {
      const q = at(a)
      const d = Math.hypot(p.x - q.x, p.y - q.y)
      if (d < bestD) {
        best = a
        bestD = d
      }
    }
    groupOf.set(n.id, best)
  }

  return anchors.map((a) => ({
    anchor: a,
    members: [a, ...tops.filter((n) => n.id !== a && groupOf.get(n.id) === a).map((n) => n.id)],
  }))
}

export function strataLayout(m: Model): StrataLayout {
  const children = childMap(m)
  const nodes = new Map<string, StrataNode>()
  const decks: StrataDeck[] = []
  const tops = children.get(null) ?? []
  if (tops.length === 0) return { decks, nodes, edges: [], hasCore: false }

  const groups = coreGroups(m)
  const hasCore = groups !== null
  const offset = hasCore ? 1 : 0

  // The top level, as on the 2D canvas.
  const top = clusterOf(m, tops)
  for (const n of tops) {
    const p = top.local.get(n.id) ?? { x: 0, z: 0 }
    nodes.set(n.id, {
      id: n.id,
      kind: 'node',
      deck: offset,
      x: p.x,
      z: p.z,
      r: NODE_R,
      parent: null,
      children: [],
      members: [],
    })
  }

  // Deeper levels: one cluster per parent, under it.
  const depthOf = new Map<string, number>(tops.map((n) => [n.id, 0]))
  let level = tops
  for (let depth = 1; level.length > 0; depth++) {
    const clusters: { parent: string; disc: Disc; local: Map<string, { x: number; z: number }> }[] = []
    for (const p of level) {
      const kids = children.get(p.id) ?? []
      const at = nodes.get(p.id)
      if (kids.length === 0 || at === undefined) continue
      const c = clusterOf(m, kids)
      clusters.push({ parent: p.id, disc: { x: at.x, z: at.z, r: c.radius }, local: c.local })
    }
    if (clusters.length === 0) break
    // Scale the whole deck out first (it keeps the arrangement of the deck above), then settle what still overlaps.
    let spread = 1
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = (clusters[i] as (typeof clusters)[number]).disc
        const b = (clusters[j] as (typeof clusters)[number]).disc
        const d = Math.hypot(a.x - b.x, a.z - b.z)
        if (d > 1e-6) spread = Math.max(spread, (a.r + b.r + CLUSTER_MARGIN) / d)
      }
    }
    spread = Math.min(spread, MAX_SPREAD)
    for (const c of clusters) {
      c.disc.x *= spread
      c.disc.z *= spread
    }
    pushApart(
      clusters.map((c) => c.disc),
      CLUSTER_MARGIN,
    )
    const next: HxNode[] = []
    for (const c of clusters) {
      const parent = nodes.get(c.parent)
      for (const n of children.get(c.parent) ?? []) {
        const q = c.local.get(n.id) ?? { x: 0, z: 0 }
        nodes.set(n.id, {
          id: n.id,
          kind: 'node',
          deck: depth + offset,
          x: c.disc.x + q.x,
          z: c.disc.z + q.z,
          r: NODE_R,
          parent: c.parent,
          children: [],
          members: [],
        })
        parent?.children.push(n.id)
        depthOf.set(n.id, depth)
        next.push(n)
      }
    }
    level = next
  }

  // The Core deck: each group above the middle of its members, drawn in a little.
  const groupOfTop = new Map<string, string>()
  if (groups !== null) {
    const discs: Disc[] = []
    for (const g of groups) {
      let x = 0
      let z = 0
      for (const id of g.members) {
        const n = nodes.get(id)
        x += n?.x ?? 0
        z += n?.z ?? 0
      }
      discs.push({ x: (x / g.members.length) * 0.72, z: (z / g.members.length) * 0.72, r: CORE_R })
    }
    pushApart(discs, 44)
    groups.forEach((g, i) => {
      const d = discs[i] as Disc
      const id = coreId(g.anchor)
      nodes.set(id, {
        id,
        kind: 'group',
        deck: 0,
        x: d.x,
        z: d.z,
        r: CORE_R,
        parent: null,
        children: [...g.members],
        members: [...g.members],
      })
      for (const member of g.members) {
        groupOfTop.set(member, id)
        const n = nodes.get(member)
        if (n !== undefined) n.parent = id
      }
    })
  }

  // Decks, top to bottom.
  const byDeck = new Map<number, StrataNode[]>()
  for (const n of nodes.values()) byDeck.set(n.deck, [...(byDeck.get(n.deck) ?? []), n])
  for (const index of [...byDeck.keys()].sort((a, b) => a - b)) {
    const list = (byDeck.get(index) ?? []).sort((a, b) => (a.id < b.id ? -1 : 1))
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const n of list) {
      minX = Math.min(minX, n.x - n.r)
      maxX = Math.max(maxX, n.x + n.r)
      minZ = Math.min(minZ, n.z - n.r)
      maxZ = Math.max(maxZ, n.z + n.r)
    }
    const center = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 }
    let radius = 0
    for (const n of list) radius = Math.max(radius, Math.hypot(n.x - center.x, n.z - center.z) + n.r)
    const depth = hasCore && index === 0 ? ('core' as const) : index - offset
    decks.push({
      index,
      depth,
      label: deckLabel(depth),
      y: -index * DECK_GAP,
      center,
      radius: radius + DECK_PAD,
      nodeIds: list.map((n) => n.id),
    })
  }

  return { decks, nodes, edges: strataEdges(m, depthOf, groupOfTop, offset), hasCore }
}

function strataEdges(
  m: Model,
  depthOf: ReadonlyMap<string, number>,
  groupOfTop: ReadonlyMap<string, string>,
  offset: number,
): StrataEdge[] {
  // Each node's chain, itself first, then its ancestors up to the top level.
  const chains = new Map<string, string[]>()
  for (const id of depthOf.keys()) {
    const chain = [id]
    let cur = m.nodes[id]?.parentId ?? null
    while (cur !== null && chain.length <= (depthOf.get(id) ?? 0)) {
      chain.push(cur)
      cur = m.nodes[cur]?.parentId ?? null
    }
    chains.set(id, chain)
  }
  /** The node standing for `id` on the deck of `depth`: itself, or its ancestor at that depth. */
  const liftTo = (id: string, depth: number): string | null => {
    const chain = chains.get(id)
    const d = depthOf.get(id)
    if (chain === undefined || d === undefined) return null
    return d <= depth ? id : (chain[d - depth] ?? null)
  }
  let maxDepth = 0
  for (const d of depthOf.values()) maxDepth = Math.max(maxDepth, d)

  const out = new Map<string, StrataEdge>()
  const add = (
    deck: number,
    from: string,
    to: string,
    connectorId: string,
    isAsync: boolean,
    riser: boolean,
  ): void => {
    const flip = from > to
    const a = flip ? to : from
    const b = flip ? from : to
    const id = `${deck}:${a}|${b}`
    const e = out.get(id) ?? { id, deck, a, b, ab: 0, ba: 0, connectorIds: [], async: true, riser }
    if (flip) e.ba++
    else e.ab++
    e.connectorIds.push(connectorId)
    e.async = e.async && isAsync
    out.set(id, e)
  }
  const connectors = Object.values(m.connectors).sort((x, y) => (x.id < y.id ? -1 : 1))
  for (const c of connectors) {
    const isAsync = c.sync === 'async'
    for (let depth = 0; depth <= maxDepth; depth++) {
      const s = liftTo(c.source, depth)
      const t = liftTo(c.target, depth)
      if (s === null || t === null || s === t) continue
      const ds = depthOf.get(s) ?? 0
      const dt = depthOf.get(t) ?? 0
      // Drawn once per deck on which at least one end is a node of that deck.
      if (Math.max(ds, dt) !== depth) continue
      add(depth + offset, s, t, c.id, isAsync, ds !== dt)
    }
    if (offset === 1) {
      const s = liftTo(c.source, 0)
      const t = liftTo(c.target, 0)
      const gs = s === null ? undefined : groupOfTop.get(s)
      const gt = t === null ? undefined : groupOfTop.get(t)
      if (gs !== undefined && gt !== undefined && gs !== gt) add(0, gs, gt, c.id, isAsync, false)
    }
  }
  return [...out.values()].sort((x, y) => (x.id < y.id ? -1 : 1))
}

/** Whether `id` hangs (at any depth) from `ancestor` in the layout. */
export function hangsFrom(layout: StrataLayout, id: string, ancestor: string): boolean {
  let cur = layout.nodes.get(id)?.parent ?? null
  for (let i = 0; cur !== null && i < 64; i++) {
    if (cur === ancestor) return true
    cur = layout.nodes.get(cur)?.parent ?? null
  }
  return false
}
