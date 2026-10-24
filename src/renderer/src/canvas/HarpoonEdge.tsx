// A drawn connector: straight harpoon lines (two anti-parallel ones when duplex) between the two hexagons, each
// ending in a single barb, with the protocol badge at the midpoint. Geometry comes from the live positions of both
// nodes, so lines follow while you drag.
import { StickyNote } from 'lucide-react'
import { BaseEdge, EdgeLabelRenderer, useInternalNode } from '@xyflow/react'
import type { EdgeProps, InternalNode } from '@xyflow/react'
import { memo } from 'react'
import { RECIPROCAL_OFFSET, harpoonGeometry, harpoonPath } from '@shared/geometry/harpoon.ts'
import type { HexShape } from '@shared/geometry/harpoon.ts'
import { protocolFamily } from '@shared/model/kinds.ts'
import { cn } from '../lib/cn.ts'
import { nodeBox } from './box.ts'
import { DIFF_COLOR, HEALTH_COLOR } from './HexNode.tsx'
import type { HarpoonFlowEdge, HexFlowNode } from './types.ts'

export const FAMILY_COLOR = {
  http: 'var(--hx-cyan)',
  rpc: 'var(--hx-violet)',
  stream: 'var(--hx-amber)',
  data: 'var(--hx-blue)',
  other: 'var(--hx-edge)',
} as const

export function shapeOf(n: InternalNode<HexFlowNode>): HexShape {
  const d = n.data
  const box = nodeBox(d.r, d.style, d.expanded)
  const p = n.internals.positionAbsolute
  return { center: { x: p.x + box.center.x, y: p.y + box.center.y }, r: d.r, squash: box.squash }
}

export function badgeText(e: HarpoonFlowEdge['data']): string {
  const cs = e?.connectors ?? []
  const first = cs[0]
  if (first === undefined) return ''
  if (cs.length > 1) return `${first.label ?? first.channelA.protocol} ×${cs.length}`
  return first.label ?? first.channelA.protocol
}

function HarpoonEdgeImpl({ id, source, target, data, selected }: EdgeProps<HarpoonFlowEdge>): React.JSX.Element | null {
  const s = useInternalNode<HexFlowNode>(source)
  const t = useInternalNode<HexFlowNode>(target)
  if (s === undefined || t === undefined || data === undefined) return null
  const first = data.connectors[0]
  if (first === undefined) return null
  // Lifted edges that merge several connectors keep the first one's direction and ports.
  const single = data.connectors.length === 1
  const g = harpoonGeometry(shapeOf(s), shapeOf(t), {
    duplex: first.duplex,
    sourcePort: single && first.source === source ? first.sourcePort : null,
    targetPort: single && first.target === target ? first.targetPort : null,
    offset: data.reciprocal ? RECIPROCAL_OFFSET : 0,
  })
  const family = protocolFamily(first.channelA.protocol)
  const color =
    data.diff !== null ? DIFF_COLOR[data.diff] : data.health !== null ? HEALTH_COLOR[data.health] : FAMILY_COLOR[family]
  const planned = first.status === 'planned' || first.status === 'in-progress'
  const width = selected || data.emphasis ? 2.4 : 1.6
  const common = {
    style: {
      stroke: color,
      strokeWidth: width,
      strokeDasharray: planned ? '5 5' : first.sync === 'async' ? '1 0' : undefined,
      fill: 'none',
      strokeLinejoin: 'round' as const,
      strokeLinecap: 'round' as const,
      opacity: data.dim ? 0.15 : 0.95,
      filter: selected || data.emphasis ? `drop-shadow(0 0 4px ${color})` : undefined,
    },
    interactionWidth: 14,
  }
  // The badge sits where the builder found room on this line (badges never overlap each other).
  const bt = data.badgeT
  const lineFrom = g.b !== null ? { x: (g.a.from.x + g.b.to.x) / 2, y: (g.a.from.y + g.b.to.y) / 2 } : g.a.from
  const lineTo = g.b !== null ? { x: (g.a.to.x + g.b.from.x) / 2, y: (g.a.to.y + g.b.from.y) / 2 } : g.a.to
  const badgeAt = { x: lineFrom.x + (lineTo.x - lineFrom.x) * bt, y: lineFrom.y + (lineTo.y - lineFrom.y) * bt }
  const flip = Math.abs(g.angle) > Math.PI / 2
  const deg = ((flip ? g.angle + Math.PI : g.angle) * 180) / Math.PI
  return (
    <>
      <BaseEdge id={`${id}:a`} path={harpoonPath(g.a)} {...common} />
      {g.b !== null && <BaseEdge id={`${id}:b`} path={harpoonPath(g.b)} {...common} />}
      <EdgeLabelRenderer>
        <div
          className={cn(
            'nodrag nopan pointer-events-auto absolute rounded-md border px-1.5 py-px font-mono text-[10px] leading-4 whitespace-nowrap shadow-sm',
            selected ? 'border-ring' : 'border-border',
            data.dim && 'opacity-20',
          )}
          style={{
            transform: `translate(-50%, -50%) translate(${badgeAt.x}px, ${badgeAt.y}px) rotate(${Math.abs(deg) < 35 ? deg : 0}deg)`,
            background: 'var(--hx-badge-bg)',
            color: 'var(--hx-badge-fg)',
          }}
          title={first.channelB !== null ? `${first.channelA.protocol} ⇄ ${first.channelB.protocol}` : first.channelA.protocol}
        >
          {badgeText(data)}
          {data.connectors.some((c) => c.notes.trim() !== '') && <StickyNote aria-label="Has notes" className="ml-1 inline size-2.5 align-[-1px] opacity-70" />}
          {data.connectors.some((c) => c.channelA.dataClasses.length > 0 || (c.channelB?.dataClasses.length ?? 0) > 0) && (
            <span className="ml-1 inline-block size-1.5 rounded-full bg-[var(--hx-rose)] align-middle" title="Carries regulated data" />
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

export const HarpoonEdge = memo(HarpoonEdgeImpl)
