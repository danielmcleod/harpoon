// A node expanded in place: a large hexagon holding its inner architecture (the children are their own React Flow
// nodes nested inside it). The title sits at the top edge; the collapse button folds it back.
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { memo } from 'react'
import { hexCorners, pointsAttr } from '@shared/geometry/hex.ts'
import { cn } from '../lib/cn.ts'
import { kindIcon, nodeColor } from '../lib/icons.tsx'
import { focus, toggleExpanded } from '../state/actions.ts'
import { nodeBox } from './box.ts'
import { DIFF_COLOR } from './HexNode.tsx'
import type { HexFlowNode } from './types.ts'

function ContainerNodeImpl({ data, selected }: NodeProps<HexFlowNode>): React.JSX.Element {
  const { node: n, r, dim, diff } = data
  const box = nodeBox(r, 'flat', true)
  const stroke = diff !== null ? DIFF_COLOR[diff] : nodeColor(n)
  const Icon = kindIcon(n.kind)
  const outer = hexCorners(box.center, r - 2)
  const inner = hexCorners(box.center, r - 10)
  return (
    <div className={cn('relative transition-opacity', dim && 'opacity-30')} style={{ width: box.width, height: box.height }} data-node-id={n.id}>
      <Handle id="c" type="source" position={Position.Top} className="hx-anchor" style={{ left: box.center.x, top: box.center.y }} isConnectable={false} />
      <Handle id="c" type="target" position={Position.Top} className="hx-anchor" style={{ left: box.center.x, top: box.center.y }} isConnectable={false} />
      <svg className="absolute inset-0 overflow-visible" width={box.width} height={box.height} aria-hidden>
        {selected && <polygon points={pointsAttr(hexCorners(box.center, r + 6))} fill="none" stroke="var(--ring)" strokeWidth={2} />}
        <polygon
          points={pointsAttr(outer)}
          fill={`color-mix(in oklab, ${stroke} 7%, transparent)`}
          stroke={stroke}
          strokeWidth={2}
          strokeDasharray={n.boundary === 'external' ? '8 6' : undefined}
          strokeLinejoin="round"
          style={{ filter: `drop-shadow(0 0 10px color-mix(in oklab, ${stroke} 40%, transparent))` }}
        />
        <polygon points={pointsAttr(inner)} fill="none" stroke={stroke} strokeOpacity={0.3} strokeWidth={1} />
      </svg>
      <div
        className="absolute flex items-center gap-1.5 rounded-md border bg-popover/95 px-2 py-1 text-xs shadow-sm"
        style={{ left: box.center.x, top: 10, transform: 'translateX(-50%)' }}
      >
        <Icon aria-hidden className="size-3.5" style={{ color: stroke }} />
        <span className="max-w-56 truncate font-semibold">{n.name}</span>
        <button
          type="button"
          title="Open inside (focus)"
          aria-label={`Open ${n.name}`}
          className="nodrag rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            focus(n.id)
          }}
        >
          <Maximize2 className="size-3" />
        </button>
        <button
          type="button"
          title="Collapse"
          aria-label={`Collapse ${n.name}`}
          className="nodrag rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            toggleExpanded(n.id, false)
          }}
        >
          <Minimize2 className="size-3" />
        </button>
      </div>
      {data.childCount === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-10 text-center text-xs text-muted-foreground">
          Drop components here from the palette to map {n.name}&apos;s inner architecture.
        </div>
      )}
    </div>
  )
}

export const ContainerNode = memo(ContainerNodeImpl)
