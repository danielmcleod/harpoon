// A boundary zone (VPC, namespace, third-party perimeter): a padded hull around its member hexagons, drawn behind
// them. Only the label takes clicks (it selects the boundary), so the zone never gets in the way of nodes and edges.
import type { Node, NodeProps } from '@xyflow/react'
import { memo } from 'react'
import { pointsAttr } from '@shared/geometry/hex.ts'
import type { Point } from '@shared/geometry/hex.ts'
import type { HxBoundary } from '@shared/model/schema.ts'
import { cn } from '../lib/cn.ts'
import { select } from '../state/actions.ts'

export interface ZoneData extends Record<string, unknown> {
  boundary: HxBoundary
  /** Hull points relative to the node box. */
  points: Point[]
  width: number
  height: number
  label: Point
  dim: boolean
}

export type ZoneFlowNode = Node<ZoneData, 'zone'>

const ZONE_COLOR: Record<HxBoundary['type'], string> = {
  vpc: 'var(--hx-blue)',
  subnet: 'var(--hx-cyan)',
  'k8s-namespace': 'var(--hx-violet)',
  dmz: 'var(--hx-amber)',
  compliance: 'var(--hx-rose)',
  'third-party': 'var(--hx-amber)',
  domain: 'var(--hx-green)',
  'cloud-account': 'var(--hx-cyan)',
  region: 'var(--hx-blue)',
  datacenter: 'var(--hx-slate)',
  edge: 'var(--hx-green)',
  other: 'var(--hx-slate)',
}

function ZoneNodeImpl({ data, selected }: NodeProps<ZoneFlowNode>): React.JSX.Element {
  const b = data.boundary
  const color = ZONE_COLOR[b.type]
  const dashed = b.type === 'third-party' || b.type === 'dmz'
  return (
    <div className={cn('pointer-events-none relative', data.dim && 'opacity-30')} style={{ width: data.width, height: data.height }}>
      <svg className="absolute inset-0 overflow-visible" width={data.width} height={data.height} aria-hidden>
        <polygon
          points={pointsAttr(data.points)}
          fill={`color-mix(in oklab, ${color} ${dashed ? 8 : 5}%, transparent)`}
          stroke={color}
          strokeOpacity={selected ? 0.95 : 0.5}
          strokeWidth={selected ? 2 : 1.4}
          strokeDasharray={dashed ? '8 6' : undefined}
          strokeLinejoin="round"
        />
      </svg>
      <button
        type="button"
        className="nodrag pointer-events-auto absolute rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide whitespace-nowrap hover:bg-accent/60"
        style={{ left: data.label.x, top: data.label.y - 22, color }}
        onClick={(e) => {
          e.stopPropagation()
          select({ kind: 'boundary', ids: [b.id] })
        }}
      >
        {b.name}
      </button>
    </div>
  )
}

export const ZoneNode = memo(ZoneNodeImpl)
