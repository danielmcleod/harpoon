// Turn a repository seed into draft ops: nodes (reusing existing ones with the same name), connectors, one boundary
// per Kubernetes namespace, all laid out left-to-right by dependency on the hex grid, clear of existing nodes.
import { coordKey } from '../../shared/geometry/hex.ts'
import { slugify } from '../../shared/model/ids.ts'
import type { Op } from '../../shared/model/ops.ts'
import { BoundaryZ, ChannelZ, ConnectorZ, NodeZ } from '../../shared/model/schema.ts'
import type { HexCoord } from '../../shared/model/schema.ts'
import type { Draft } from '../ai/draft.ts'
import type { Seed } from './seed.ts'

/** Columns by longest dependency path (sources left), rows centred: cells for a top-level layered layout. */
export function layeredCells(ids: readonly string[], edges: readonly { from: string; to: string }[]): Map<string, HexCoord> {
  const rank = new Map<string, number>(ids.map((id) => [id, 0]))
  // Longest-path ranking, bounded so cycles cannot loop forever.
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false
    for (const e of edges) {
      const a = rank.get(e.from)
      const b = rank.get(e.to)
      if (a === undefined || b === undefined || e.from === e.to) continue
      if (b < a + 1 && a + 1 < ids.length) {
        rank.set(e.to, a + 1)
        changed = true
      }
    }
    if (!changed) break
  }
  const cols = new Map<number, string[]>()
  for (const id of ids) {
    const r = rank.get(id) ?? 0
    const l = cols.get(r)
    if (l === undefined) cols.set(r, [id])
    else l.push(id)
  }
  const out = new Map<string, HexCoord>()
  for (const [r, list] of cols) {
    const q = r * 2
    list.forEach((id, i) => {
      // axialToPixel: y depends on r + q/2, so subtract q/2 to keep columns vertically centred.
      out.set(id, { q, r: i - Math.floor(list.length / 2) - Math.floor(q / 2) })
    })
  }
  return out
}

export function applySeed(draft: Draft, seed: Seed, runId: string, repoId: string | null = null): { added: number; links: number } {
  if (seed.nodes.length === 0) return { added: 0, links: 0 }
  const m = draft.model
  const prov = { source: 'ai-import' as const, runId, at: Date.now() }
  const idOf = new Map<string, string>()
  const fresh: string[] = []
  for (const n of seed.nodes) {
    const existing = Object.values(m.nodes).find((x) => x.parentId === null && (x.name.toLowerCase() === n.name.toLowerCase() || x.id === slugify(n.name)))
    if (existing !== undefined) idOf.set(n.key, existing.id)
    else {
      const id = draft.newNodeId(n.name)
      idOf.set(n.key, id)
      fresh.push(n.key)
    }
  }

  // Lay out new nodes as their own block to the right of whatever is already on the canvas.
  const cells = layeredCells(fresh, seed.links.filter((l) => fresh.includes(l.from) && fresh.includes(l.to)))
  const existingCells = Object.values(m.nodes).filter((x) => x.parentId === null).map((x) => m.layout[x.id]).filter((c): c is HexCoord => c !== undefined)
  const qShift = existingCells.length === 0 ? 0 : Math.max(...existingCells.map((c) => c.q)) + 3
  const taken = new Set(existingCells.map(coordKey))

  const ops: Op[] = []
  for (const key of fresh) {
    const n = seed.nodes.find((x) => x.key === key)
    const id = idOf.get(key)
    if (n === undefined || id === undefined) continue
    let at = cells.get(key) ?? { q: 0, r: 0 }
    at = { q: at.q + qShift, r: at.r - Math.floor(qShift / 2) }
    while (taken.has(coordKey(at))) at = { q: at.q, r: at.r + 1 }
    taken.add(coordKey(at))
    ops.push({
      op: 'addNode',
      node: NodeZ.parse({
        id,
        name: n.name,
        kind: n.kind,
        boundary: n.external ? 'external' : 'internal',
        techStack: n.techStack,
        vendor: n.vendor,
        description: n.description,
        evidence: n.evidence.map((e) => ({ repo: repoId, path: e.path, lines: e.line === null ? null : [e.line, e.line], snippet: null })),
        confidence: 0.9,
        provenance: prov,
      }),
      at,
    })
  }

  let links = 0
  const seen = new Set(Object.values(m.connectors).map((c) => `${c.source}->${c.target}`))
  for (const l of seed.links) {
    const source = idOf.get(l.from)
    const target = idOf.get(l.to)
    if (source === undefined || target === undefined || source === target || seen.has(`${source}->${target}`)) continue
    seen.add(`${source}->${target}`)
    links++
    ops.push({
      op: 'addConnector',
      connector: ConnectorZ.parse({
        id: `${source}-${target}`.slice(0, 80),
        source,
        target,
        duplex: !l.async,
        sync: l.async ? 'async' : 'sync',
        channelA: ChannelZ.parse({ protocol: l.protocol }),
        channelB: l.async ? null : ChannelZ.parse({ protocol: l.protocol }),
        evidence: [{ repo: repoId, path: l.evidence.path, lines: l.evidence.line === null ? null : [l.evidence.line, l.evidence.line], snippet: null }],
        confidence: 0.7,
        provenance: prov,
      }),
    })
  }

  const namespaces = new Map<string, string[]>()
  for (const n of seed.nodes) {
    if (n.namespace === null) continue
    const id = idOf.get(n.key)
    if (id === undefined) continue
    namespaces.set(n.namespace, [...(namespaces.get(n.namespace) ?? []), id])
  }
  for (const [ns, nodeIds] of namespaces) {
    const id = `ns-${slugify(ns)}`
    if (m.boundaries[id] !== undefined) continue
    ops.push({ op: 'addBoundary', boundary: BoundaryZ.parse({ id, name: ns, type: 'k8s-namespace', nodeIds }) })
  }

  draft.apply(ops)
  return { added: fresh.length, links }
}
