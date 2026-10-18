// Picture exports from the scene: a standalone SVG (the same geometry the canvas draws: hexagons in either style,
// harpoon connectors with barbs, badges, boundaries) and draw.io XML with hexagon shapes at the same positions.
import { harpoonGeometry, harpoonPath } from '../geometry/harpoon.ts'
import { ISO_DEPTH, ISO_SQUASH, hexCorners, pointsAttr } from '../geometry/hex.ts'
import type { Point } from '../geometry/hex.ts'
import { computeScene, sceneBounds } from '../geometry/scene.ts'
import type { Scene } from '../geometry/scene.ts'
import { KIND_INFO, protocolFamily } from '../model/kinds.ts'
import type { KindColor } from '../model/kinds.ts'
import type { Model } from '../model/schema.ts'
import type { ExportView } from '../ipc.ts'

interface Palette {
  bg: string
  fill: string
  label: string
  muted: string
  badgeBg: string
  badgeFg: string
  kind: Record<KindColor, string>
  edge: Record<ReturnType<typeof protocolFamily>, string>
}

const DARK: Palette = {
  bg: '#0d1322',
  fill: '#1a2238',
  label: '#eef1f8',
  muted: '#9aa3b8',
  badgeBg: '#1d2539',
  badgeFg: '#dfe4ef',
  kind: { cyan: '#5fd4e8', violet: '#b88cf5', blue: '#79a8f5', green: '#6fdcaa', amber: '#e5b45c', rose: '#f08a9a', slate: '#a3abbf' },
  edge: { http: '#5fd4e8', rpc: '#b88cf5', stream: '#e5b45c', data: '#79a8f5', other: '#a3abbf' },
}

const LIGHT: Palette = {
  bg: '#f6f7fb',
  fill: '#ffffff',
  label: '#1f2537',
  muted: '#5f6780',
  badgeBg: '#f1f3f8',
  badgeFg: '#2b3247',
  kind: { cyan: '#1e9db3', violet: '#7b4bd6', blue: '#3b6fd1', green: '#2c9c6a', amber: '#c48618', rose: '#cc4766', slate: '#6b7287' },
  edge: { http: '#1e9db3', rpc: '#7b4bd6', stream: '#c48618', data: '#3b6fd1', other: '#6b7287' },
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const f1 = (n: number): string => (Math.round(n * 10) / 10).toString()

export function sceneFor(m: Model, v: ExportView): Scene {
  return computeScene(m, { expanded: new Set(v.expanded), focusId: v.focusId, style: v.style })
}

/** Change marks for a comparison: entities drawn in the diff colours (new green, changed amber, going red). */
export interface SvgMarks {
  nodes: ReadonlyMap<string, 'added' | 'modified' | 'removed'>
  connectors: ReadonlyMap<string, 'added' | 'modified' | 'removed'>
}

const MARK_COLOR = { added: '#3fbf7f', modified: '#e0a53c', removed: '#e05a4f' } as const

export function renderSvg(m: Model, v: ExportView, marks?: SvgMarks, o: { cropToMarks?: boolean } = {}): string {
  const scene = sceneFor(m, v)
  const pal = v.theme === 'light' ? LIGHT : DARK
  let b = sceneBounds(scene)
  // A comparison thumbnail: just the marked area and what it connects to, so the change is readable.
  if (o.cropToMarks === true && marks !== undefined) {
    const ids = new Set<string>()
    for (const id of marks.nodes.keys()) ids.add(id)
    for (const id of marks.connectors.keys()) {
      const c = m.connectors[id]
      if (c !== undefined) for (const end of [c.source, c.target]) ids.add(end)
    }
    const pts = [...ids].flatMap((id) => {
      // A node inside a collapsed container is drawn as the container.
      let cur: string | null = id
      while (cur !== null && !scene.nodes.has(cur)) cur = m.nodes[cur]?.parentId ?? null
      const sn = cur === null ? undefined : scene.nodes.get(cur)
      return sn === undefined ? [] : [{ x: sn.center.x - sn.r, y: sn.center.y - sn.r }, { x: sn.center.x + sn.r, y: sn.center.y + sn.r }]
    })
    if (pts.length > 0) {
      const pad = 90
      b = { minX: Math.min(...pts.map((p) => p.x)) - pad, minY: Math.min(...pts.map((p) => p.y)) - pad, maxX: Math.max(...pts.map((p) => p.x)) + pad, maxY: Math.max(...pts.map((p) => p.y)) + pad }
    }
  }
  const pad = 60
  const x0 = b.minX - pad
  const y0 = b.minY - pad - 30
  const w = b.maxX - b.minX + pad * 2
  const h = b.maxY - b.minY + pad * 2 + 30
  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f1(x0)} ${f1(y0)} ${f1(w)} ${f1(h)}" width="${Math.round(w)}" height="${Math.round(h)}" font-family="Inter, Segoe UI, system-ui, sans-serif">`)
  out.push(`<metadata>${esc(JSON.stringify({ generator: 'Harpoon', project: m.meta.name, nodes: Object.keys(m.nodes).length, connectors: Object.keys(m.connectors).length }))}</metadata>`)
  out.push(`<title>${esc(m.meta.name)}</title>`)
  out.push(`<rect x="${f1(x0)}" y="${f1(y0)}" width="${f1(w)}" height="${f1(h)}" fill="${pal.bg}"/>`)
  out.push(`<text x="${f1(x0 + 24)}" y="${f1(y0 + 34)}" font-size="18" font-weight="600" fill="${pal.label}">${esc(m.meta.name)}</text>`)

  for (const bd of scene.boundaries) {
    const bdm = m.boundaries[bd.id]
    if (bdm === undefined) continue
    const color = bdm.type === 'third-party' || bdm.type === 'dmz' ? pal.kind.amber : bdm.type === 'k8s-namespace' ? pal.kind.violet : pal.kind.blue
    out.push(`<polygon points="${pointsAttr(bd.points)}" fill="${color}" fill-opacity="0.06" stroke="${color}" stroke-opacity="0.55" stroke-width="1.4" ${bdm.type === 'third-party' ? 'stroke-dasharray="8 6"' : ''} stroke-linejoin="round"/>`)
    out.push(`<text x="${f1(bd.labelAt.x)}" y="${f1(bd.labelAt.y - 8)}" font-size="11" font-weight="600" fill="${color}">${esc(bdm.name)}</text>`)
  }

  const colorOf = (id: string): string => {
    const n = m.nodes[id]
    if (n === undefined) return pal.kind.slate
    const mk = marks?.nodes.get(id)
    if (mk !== undefined) return MARK_COLOR[mk]
    return n.boundary === 'external' ? pal.kind.amber : pal.kind[KIND_INFO[n.kind].color]
  }

  // Containers first (behind), then edges, then leaf hexes.
  for (const id of scene.order) {
    const sn = scene.nodes.get(id)
    const n = m.nodes[id]
    if (sn === undefined || n === undefined || !sn.expanded) continue
    const c = colorOf(id)
    out.push(`<polygon points="${pointsAttr(hexCorners(sn.center, sn.r - 2))}" fill="${c}" fill-opacity="0.07" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>`)
    out.push(`<text x="${f1(sn.center.x)}" y="${f1(sn.center.y - (sn.r * Math.sqrt(3)) / 2 + 22)}" font-size="12" font-weight="600" text-anchor="middle" fill="${pal.label}">${esc(n.name)}</text>`)
  }

  for (const e of scene.edges) {
    const s = scene.nodes.get(e.source)
    const t = scene.nodes.get(e.target)
    const c = e.connectors[0]
    if (s === undefined || t === undefined || c === undefined) continue
    const sq = (expanded: boolean): number => (v.style === 'iso' && !expanded ? ISO_SQUASH : 1)
    const g = harpoonGeometry({ center: s.center, r: s.r, squash: sq(s.expanded) }, { center: t.center, r: t.r, squash: sq(t.expanded) }, { duplex: c.duplex })
    const mk = e.connectors.map((x) => marks?.connectors.get(x.id)).find((x) => x !== undefined)
    const color = mk !== undefined ? MARK_COLOR[mk] : pal.edge[protocolFamily(c.channelA.protocol)]
    const dash = c.status === 'planned' || mk === 'removed' ? ' stroke-dasharray="5 5"' : ''
    for (const l of [g.a, g.b]) {
      if (l !== null) out.push(`<path d="${harpoonPath(l)}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"${dash}/>`)
    }
    const text = e.connectors.length > 1 ? `${c.label ?? c.channelA.protocol} ×${e.connectors.length}` : (c.label ?? c.channelA.protocol)
    const tw = text.length * 6 + 10
    out.push(`<g><rect x="${f1(g.mid.x - tw / 2)}" y="${f1(g.mid.y - 8)}" width="${f1(tw)}" height="16" rx="4" fill="${pal.badgeBg}" stroke="${pal.muted}" stroke-opacity="0.4"/><text x="${f1(g.mid.x)}" y="${f1(g.mid.y + 3.5)}" font-size="9.5" font-family="ui-monospace, Consolas, monospace" text-anchor="middle" fill="${pal.badgeFg}">${esc(text)}</text></g>`)
  }

  for (const id of scene.order) {
    const sn = scene.nodes.get(id)
    const n = m.nodes[id]
    if (sn === undefined || n === undefined || sn.expanded) continue
    const c = colorOf(id)
    const dash = n.status === 'planned' ? ' stroke-dasharray="3 5"' : n.boundary === 'external' ? ' stroke-dasharray="7 5"' : ''
    const op = sn.ghost ? ' opacity="0.55"' : n.status === 'planned' ? ' opacity="0.75"' : ''
    if (v.style === 'iso') {
      const top = hexCorners(sn.center, sn.r - 1.5, ISO_SQUASH)
      const down = (p: Point): Point => ({ x: p.x, y: p.y + ISO_DEPTH })
      out.push(`<g${op}>`)
      for (let i = 0; i < 3; i++) {
        const a = top[i] as Point
        const bb = top[i + 1] as Point
        out.push(`<polygon points="${pointsAttr([a, bb, down(bb), down(a)])}" fill="${c}" fill-opacity="${i === 1 ? 0.3 : 0.18}" stroke="${c}" stroke-width="1.5"${dash}/>`)
      }
      out.push(`<polygon points="${pointsAttr(top)}" fill="${pal.fill}" stroke="${c}" stroke-width="2" stroke-linejoin="round"${dash}/>`)
      out.push(`<text x="${f1(sn.center.x)}" y="${f1(sn.center.y + sn.r * ISO_SQUASH + ISO_DEPTH + 16)}" font-size="12" font-weight="500" text-anchor="middle" fill="${n.boundary === 'external' ? pal.kind.amber : pal.label}">${esc(n.name)}</text>`)
      out.push('</g>')
    } else {
      out.push(`<g${op}><polygon points="${pointsAttr(hexCorners(sn.center, sn.r - 1.5))}" fill="${pal.fill}" stroke="${c}" stroke-width="2" stroke-linejoin="round"${dash}/>`)
      out.push(`<text x="${f1(sn.center.x)}" y="${f1(sn.center.y + 2)}" font-size="12" font-weight="500" text-anchor="middle" fill="${pal.label}">${esc(n.name.length > 22 ? `${n.name.slice(0, 21)}…` : n.name)}</text>`)
      const sub = n.boundary === 'external' ? n.vendor : n.techStack
      if (sub !== null) out.push(`<text x="${f1(sn.center.x)}" y="${f1(sn.center.y + 17)}" font-size="9.5" text-anchor="middle" fill="${n.boundary === 'external' ? pal.kind.amber : pal.muted}">${esc(sub)}</text>`)
      out.push('</g>')
    }
  }
  out.push('</svg>')
  return `${out.join('\n')}\n`
}

const xq = (s: string): string => esc(s).replace(/\n/g, '&#10;')

/** draw.io / diagrams.net: hexagons at the scene positions, containers behind, dual connectors with labels. */
export function renderDrawio(m: Model, v: ExportView): string {
  const scene = sceneFor(m, v)
  const pal = LIGHT
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>']
  const cid = (id: string): string => `n-${id}`
  const ordered = [...scene.order].sort((a, b) => Number(scene.nodes.get(b)?.expanded ?? false) - Number(scene.nodes.get(a)?.expanded ?? false))
  for (const id of ordered) {
    const sn = scene.nodes.get(id)
    const n = m.nodes[id]
    if (sn === undefined || n === undefined) continue
    const color = n.boundary === 'external' ? pal.kind.amber : pal.kind[KIND_INFO[n.kind].color]
    const w = sn.r * 2
    const h = sn.r * Math.sqrt(3)
    const style = [
      'shape=hexagon',
      'perimeter=hexagonPerimeter2',
      'whiteSpace=wrap',
      'html=1',
      'size=0.25',
      `strokeColor=${color}`,
      `fillColor=${sn.expanded ? 'none' : '#ffffff'}`,
      'strokeWidth=2',
      sn.expanded ? 'verticalAlign=top;spacingTop=12;fontStyle=1' : '',
      n.boundary === 'external' || n.status === 'planned' ? 'dashed=1' : '',
    ].filter((x) => x !== '').join(';')
    const label = `${n.name}${n.techStack !== null && !sn.expanded ? `\n${n.techStack}` : ''}`
    cells.push(
      `<mxCell id="${xq(cid(id))}" value="${xq(label)}" style="${style};" vertex="1" parent="1"><mxGeometry x="${f1(sn.center.x - w / 2)}" y="${f1(sn.center.y - h / 2)}" width="${f1(w)}" height="${f1(h)}" as="geometry"/></mxCell>`,
    )
  }
  let i = 0
  for (const e of scene.edges) {
    const c = e.connectors[0]
    if (c === undefined) continue
    const color = pal.edge[protocolFamily(c.channelA.protocol)]
    const base = `endArrow=openThin;endFill=0;html=1;strokeColor=${color};strokeWidth=1.5;${c.sync === 'async' ? 'dashed=1;' : ''}`
    cells.push(`<mxCell id="e${i++}" value="${xq(c.label ?? c.channelA.protocol)}" style="${base}" edge="1" parent="1" source="${xq(cid(e.source))}" target="${xq(cid(e.target))}"><mxGeometry relative="1" as="geometry"/></mxCell>`)
    if (c.duplex && c.channelB !== null) {
      cells.push(`<mxCell id="e${i++}" value="${xq(c.channelB.protocol)}" style="${base}dashed=1;opacity=70;" edge="1" parent="1" source="${xq(cid(e.target))}" target="${xq(cid(e.source))}"><mxGeometry relative="1" as="geometry"/></mxCell>`)
    }
  }
  return `<mxfile host="Harpoon"><diagram name="${xq(m.meta.name)}"><mxGraphModel grid="1" gridSize="10" page="0"><root>\n${cells.join('\n')}\n</root></mxGraphModel></diagram></mxfile>\n`
}
