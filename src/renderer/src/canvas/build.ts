// Scene → React Flow nodes and edges. Nodes inside an expanded container are nested (`parentId`) so they move with
// it; React Flow positions are box top-lefts relative to the parent box.
import type { Scene } from '@shared/geometry/scene.ts'
import type { HexStyle } from '@shared/geometry/hex.ts'
import type { ChangeSummary } from '@shared/model/diff.ts'
import { ancestorsOf, pathLabel } from '@shared/model/queries.ts'
import { BoundaryZ } from '@shared/model/schema.ts'
import type { LensMark } from './lensMarks.ts'
import type { NodeMark } from './overlays.ts'
import type { Model } from '@shared/model/schema.ts'
import { nodeBox } from './box.ts'
import { badgeText } from './HarpoonEdge.tsx'
import { harpoonGeometry } from '@shared/geometry/harpoon.ts'
import { ISO_SQUASH } from '@shared/geometry/hex.ts'
import { placeBadges } from '@shared/geometry/tidy.ts'
import type { BadgeInput } from '@shared/geometry/tidy.ts'
import type { HarpoonFlowEdge, Health, HexFlowNode } from './types.ts'
import type { ZoneFlowNode } from './ZoneNode.tsx'

export interface BuildInput {
  model: Model
  scene: Scene
  style: HexStyle
  editable: boolean
  selectedNodes: ReadonlySet<string>
  selectedConnectors: ReadonlySet<string>
  selectedBoundaries: ReadonlySet<string>
  /** Nodes to keep at full opacity (blast radius / search); null: all. */
  highlight: ReadonlySet<string> | null
  diff: ChangeSummary | null
  health: ReadonlyMap<string, Health> | null
  edgeHealth: ReadonlyMap<string, Health> | null
  emphasisConnectors: ReadonlySet<string> | null
  impact: ReadonlyMap<string, { hop: number; kind: 'origin' | 'affected' | 'needed' | 'degraded' }> | null
  /** Lens on: each node's mark, and the legend keys hidden (a node whose keys are all hidden dims). */
  lens: { marks: ReadonlyMap<string, LensMark>; hidden: ReadonlySet<string> } | null
  marks?: ReadonlyMap<string, NodeMark> | null
}

export function buildFlow(i: BuildInput): { nodes: (HexFlowNode | ZoneFlowNode)[]; edges: HarpoonFlowEdge[] } {
  const { model: m, scene } = i
  const childCount = new Map<string, number>()
  for (const n of Object.values(m.nodes)) {
    if (n.parentId !== null) childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1)
  }
  // Markers on hidden nodes show on the nearest drawn container.
  const marks = new Map<string, NodeMark>()
  for (const [id, mk] of i.marks ?? []) {
    const at = scene.nodes.has(id) ? id : ancestorsOf(m, id).find((a) => scene.nodes.has(a.id))?.id
    if (at === undefined) continue
    const prev = marks.get(at)
    if (prev === undefined || at === id) marks.set(at, at === id ? mk : { ...mk, title: `Inside: ${mk.title}` })
  }
  const diffKind = new Map<string, NonNullable<HexFlowNode['data']['diff']>>()
  const connDiff = new Map<string, NonNullable<HexFlowNode['data']['diff']>>()
  for (const c of i.diff?.nodes ?? []) diffKind.set(c.id, c.kind)
  for (const c of i.diff?.connectors ?? []) connDiff.set(c.id, c.kind)

  const zones: ZoneFlowNode[] = scene.boundaries.map((b) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of b.points) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    const boundary = m.boundaries[b.id]
    return {
      id: `zone:${b.id}`,
      type: 'zone',
      position: { x: minX, y: minY },
      zIndex: -10,
      selectable: false,
      draggable: false,
      focusable: false,
      selected: i.selectedBoundaries.has(b.id),
      data: {
        boundary: boundary ?? BoundaryZ.parse({ id: b.id, name: b.id, type: 'other' }),
        points: b.points.map((p) => ({ x: p.x - minX, y: p.y - minY })),
        width: maxX - minX,
        height: maxY - minY,
        label: { x: b.labelAt.x - minX, y: b.labelAt.y - minY },
        dim: i.highlight !== null,
      },
    }
  })

  const nodes: HexFlowNode[] = []
  for (const id of scene.order) {
    const sn = scene.nodes.get(id)
    const n = m.nodes[id]
    if (sn === undefined || n === undefined) continue
    const box = nodeBox(sn.r, i.style, sn.expanded)
    let x = sn.center.x - box.center.x
    let y = sn.center.y - box.center.y
    if (sn.containerId !== null) {
      const parent = scene.nodes.get(sn.containerId)
      if (parent !== undefined) {
        const pb = nodeBox(parent.r, i.style, true)
        x -= parent.center.x - pb.center.x
        y -= parent.center.y - pb.center.y
      }
    }
    nodes.push({
      id,
      type: sn.expanded ? 'container' : 'hex',
      position: { x, y },
      ...(sn.containerId !== null ? { parentId: sn.containerId } : {}),
      width: box.width,
      height: box.height,
      selected: i.selectedNodes.has(id),
      draggable: i.editable && !sn.ghost,
      connectable: i.editable && !sn.ghost,
      zIndex: sn.expanded ? sn.depth * 2 : sn.depth * 2 + 1,
      data: {
        node: n,
        r: sn.r,
        style: i.style,
        expanded: sn.expanded,
        ghost: sn.ghost,
        childCount: childCount.get(id) ?? 0,
        dim: (i.highlight !== null && !i.highlight.has(id)) || (i.lens !== null && (i.lens.marks.get(id)?.keys ?? []).every((k) => i.lens?.hidden.has(k) === true)),
        diff: diffKind.get(id) ?? null,
        health: i.health?.get(id) ?? null,
        editable: i.editable,
        context: sn.ghost && n.parentId !== null ? pathLabel(m, n.parentId) : null,
        impact: i.impact?.get(id) ?? null,
        lens: i.lens?.marks.get(id) ?? null,
        mark: marks.get(id) ?? null,
      },
    })
  }

  // Badges: slide along their lines so none overlaps another badge or a node.
  const sq = (expanded: boolean): number => (i.style === 'iso' && !expanded ? ISO_SQUASH : 1)
  const badgeInputs: BadgeInput[] = []
  for (const e of scene.edges) {
    const s = scene.nodes.get(e.source)
    const t = scene.nodes.get(e.target)
    const first = e.connectors[0]
    if (s === undefined || t === undefined || first === undefined) continue
    const g = harpoonGeometry({ center: s.center, r: s.r, squash: sq(s.expanded) }, { center: t.center, r: t.r, squash: sq(t.expanded) }, { duplex: first.duplex })
    const from = g.b !== null ? { x: (g.a.from.x + g.b.to.x) / 2, y: (g.a.from.y + g.b.to.y) / 2 } : g.a.from
    const to = g.b !== null ? { x: (g.a.to.x + g.b.from.x) / 2, y: (g.a.to.y + g.b.from.y) / 2 } : g.a.to
    const text = badgeText({ connectors: e.connectors, dim: false, diff: null, emphasis: false, health: null, badgeT: 0.5 })
    badgeInputs.push({ key: e.key, from, to, width: text.length * 6.2 + 14, height: 18 })
  }
  const obstacles = [...scene.nodes.values()].filter((n) => !n.expanded).map((n) => ({ center: n.center, r: n.r * 0.9 }))
  const badgeT = placeBadges(badgeInputs, obstacles)

  const edges: HarpoonFlowEdge[] = scene.edges.map((e) => {
    const ids = e.connectors.map((c) => c.id)
    const diff = ids.map((c) => connDiff.get(c)).find((k) => k !== undefined) ?? null
    const health = ids.map((c) => i.edgeHealth?.get(c)).find((h) => h !== undefined) ?? null
    return {
      id: e.key,
      type: 'harpoon',
      source: e.source,
      target: e.target,
      sourceHandle: 'c',
      targetHandle: 'c',
      selected: ids.some((c) => i.selectedConnectors.has(c)),
      zIndex: 5,
      data: {
        connectors: e.connectors,
        dim: i.highlight !== null && !(i.highlight.has(e.source) && i.highlight.has(e.target)),
        diff,
        emphasis: i.emphasisConnectors !== null && ids.some((c) => i.emphasisConnectors?.has(c) === true),
        badgeT: badgeT.get(e.key) ?? 0.5,
        health,
      },
    }
  })

  return { nodes: [...zones, ...nodes], edges }
}
