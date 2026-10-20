// A service hexagon in either style: flat neon hex (label inside) or isometric prism (label below). External nodes are
// dashed amber with a vendor badge; planned nodes are dotted and faded; deprecated ones struck through. Nodes with
// inner architecture show an expand badge; double-click expands in place.
import { Handle, NodeToolbar, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { memo } from 'react'
import { ISO_DEPTH, hexCorners, pointsAttr } from '@shared/geometry/hex.ts'
import type { Point } from '@shared/geometry/hex.ts'
import { cn } from '../lib/cn.ts'
import { kindIcon, nodeColor } from '../lib/icons.tsx'
import { focus, startConnect, toggleExpanded } from '../state/actions.ts'
import { Cable, Crosshair, Maximize2, StickyNote } from 'lucide-react'
import { setUi, useStore } from '../state/store.ts'
import { nodeBox } from './box.ts'
import { PortHandles } from './PortHandles.tsx'
import type { HexFlowNode } from './types.ts'

export const DIFF_COLOR = { added: 'var(--hx-add)', modified: 'var(--hx-mod)', removed: 'var(--hx-del)' } as const
export const HEALTH_COLOR = { ok: 'var(--hx-ok)', warn: 'var(--hx-warn)', bad: 'var(--hx-bad)' } as const
export const IMPACT_COLOR = { affected: 'var(--hx-bad)', needed: 'var(--hx-blue)', degraded: 'var(--hx-warn)' } as const
export { STATUS_COLOR } from './lensMarks.ts'

function dashFor(n: HexFlowNode['data']['node']): string | undefined {
  if (n.status === 'planned' || n.status === 'in-progress') return '3 5'
  if (n.boundary === 'external') return '7 5'
  return undefined
}

function HexNodeImpl({ data, selected }: NodeProps<HexFlowNode>): React.JSX.Element {
  const { node: n, r, style, ghost, dim, diff, health } = data
  const box = nodeBox(r, style, false)
  const impact = data.impact
  const stroke =
    diff !== null
      ? DIFF_COLOR[diff]
      : impact !== null && impact.kind !== 'origin'
        ? IMPACT_COLOR[impact.kind]
        : health !== null
          ? HEALTH_COLOR[health]
          : data.lens !== null
            ? data.lens.color
            : nodeColor(n)
  const Icon = kindIcon(n.kind)
  const faded = n.status === 'planned' || n.status === 'removed'
  const struck = n.status === 'deprecated' || n.status === 'removed'

  return (
    <div
      className={cn('relative transition-opacity duration-200', dim && 'opacity-25', ghost && 'opacity-55')}
      style={{ width: box.width, height: box.height }}
      data-node-id={n.id}
    >
      {/* Edges anchor on a hidden centre handle; the drawn geometry comes from the node box, not the handle. */}
      <Handle id="c" type="source" position={Position.Top} className="hx-anchor" style={{ left: box.center.x, top: box.center.y }} isConnectable={false} />
      <Handle id="c" type="target" position={Position.Top} className="hx-anchor" style={{ left: box.center.x, top: box.center.y }} isConnectable={false} />
      {data.editable && !ghost && <PortHandles center={box.center} r={r} squash={box.squash} />}
      {!ghost && <NodeActions id={n.id} editable={data.editable} hasChildren={data.childCount > 0} />}

      {style === 'flat' ? (
        <FlatHex center={box.center} r={r} stroke={stroke} selected={selected} dash={dashFor(n)} faded={faded} external={n.boundary === 'external'} />
      ) : (
        <IsoHex center={box.center} r={r} stroke={stroke} selected={selected} dash={dashFor(n)} faded={faded} external={n.boundary === 'external'} />
      )}

      {style === 'flat' ? (
        <div
          className="pointer-events-none absolute flex flex-col items-center justify-center text-center"
          style={{ left: r * 0.28, right: r * 0.28, top: 0, bottom: 0 }}
        >
          <Icon aria-hidden className="mb-0.5 size-4 shrink-0" style={{ color: stroke }} />
          <span className={cn('line-clamp-2 text-[12px] leading-tight font-medium text-[var(--hx-label)]', struck && 'line-through')}>
            {n.name}
          </span>
          {n.boundary === 'external' && n.vendor !== null ? (
            <span className="mt-0.5 max-w-full truncate text-[9.5px] text-[var(--hx-amber)]">{n.vendor}</span>
          ) : n.techStack !== null ? (
            <span className="mt-0.5 max-w-full truncate text-[9.5px] text-muted-foreground">{n.techStack}</span>
          ) : null}
        </div>
      ) : (
        <>
          <div
            className="pointer-events-none absolute flex items-center justify-center"
            style={{ left: 0, right: 0, top: box.center.y - 9, height: 18 }}
          >
            <Icon aria-hidden className="size-[18px]" style={{ color: stroke }} />
          </div>
          <div
            className="pointer-events-none absolute right-[-30px] left-[-30px] flex flex-col items-center text-center"
            style={{ top: box.center.y * 2 + ISO_DEPTH + 3 }}
          >
            <span className={cn('truncate text-[12px] leading-tight font-medium', n.boundary === 'external' ? 'text-[var(--hx-amber)]' : 'text-[var(--hx-label)]', struck && 'line-through')}>
              {n.name}
            </span>
          </div>
        </>
      )}

      {data.context !== null && (
        <div className="pointer-events-none absolute right-0 left-0 text-center text-[10px] text-muted-foreground" style={{ top: -16 }}>
          {data.context}
        </div>
      )}

      {data.mark !== null && !ghost && (
        <span
          className={cn(
            'pointer-events-auto absolute flex h-[16px] items-center gap-0.5 rounded-full border px-1.5 text-[9.5px] font-semibold shadow-sm',
            data.mark.tone === 'bad' ? 'border-destructive/60 bg-destructive text-white' : data.mark.tone === 'warn' ? 'border-warning/60 bg-warning text-black' : 'border-primary/60 bg-primary text-primary-foreground',
          )}
          style={{ left: box.center.x - r * 0.9, top: box.center.y - (style === 'flat' ? r * 0.95 : r * 0.6) }}
          title={data.mark.title}
          role="img"
          aria-label={data.mark.title}
        >
          {data.mark.label}
        </span>
      )}

      {n.notes.trim() !== '' && !ghost && (
        <span
          className="pointer-events-auto absolute text-muted-foreground"
          style={{ left: box.center.x - r * 0.72, top: box.center.y - (style === 'flat' ? r * 0.72 : r * 0.42) }}
          title={n.notes.length > 300 ? `${n.notes.slice(0, 300)}…` : n.notes}
        >
          <StickyNote aria-label="Has notes" className="size-3" />
        </span>
      )}

      {data.childCount > 0 && !ghost && (
        <button
          type="button"
          title={`Expand to show ${data.childCount} inner part${data.childCount === 1 ? '' : 's'} (double-click)`}
          aria-label={`Expand ${n.name}`}
          className="nodrag absolute flex h-[18px] min-w-[18px] items-center justify-center rounded-full border bg-popover px-1 text-[10px] font-semibold text-foreground shadow-sm hover:border-primary hover:text-primary"
          style={{ left: box.center.x + r * 0.55, top: box.center.y + (style === 'flat' ? r * 0.55 : r * 0.3) }}
          onClick={(e) => {
            e.stopPropagation()
            toggleExpanded(n.id, true)
          }}
        >
          +{data.childCount}
        </button>
      )}

      {impact !== null && (
        <span
          className="pointer-events-none absolute rounded-full px-1.5 text-[9.5px] font-bold text-white shadow"
          style={{ left: box.center.x - 18, top: -10, background: impact.kind === 'origin' ? 'var(--primary)' : IMPACT_COLOR[impact.kind] }}
          title={
            impact.kind === 'origin'
              ? 'Impact analysis starts here'
              : impact.kind === 'degraded'
                ? 'Keeps working with less capacity or without a soft dependency'
                : impact.kind === 'affected'
                  ? impact.hop > 0
                    ? `Breaks if the start fails (${impact.hop} hop${impact.hop === 1 ? '' : 's'} away)`
                    : 'Goes down'
                  : `Needed by the start (${impact.hop} hop${impact.hop === 1 ? '' : 's'} away)`
          }
        >
          {impact.kind === 'origin' ? 'start' : impact.kind === 'degraded' ? 'degraded' : impact.kind === 'affected' ? (impact.hop > 0 ? `breaks · ${impact.hop}` : 'down') : `needed · ${impact.hop}`}
        </span>
      )}
      {data.lens !== null && data.lens.label !== '' && (
        <span
          className="pointer-events-none absolute left-1/2 max-w-[150%] -translate-x-1/2 truncate rounded-full px-1.5 text-[9px] font-semibold tracking-wide whitespace-nowrap uppercase"
          style={
            data.lens.derived
              ? { top: box.height - 6, border: `1px dashed ${data.lens.color}`, color: data.lens.color, background: 'var(--hx-badge-bg)' }
              : { top: box.height - 6, background: data.lens.color, color: 'black' }
          }
          title={data.lens.derived ? 'Derived: inherited from a parent, or in scope through connectors or inner parts' : undefined}
        >
          {data.lens.label}
        </span>
      )}
      {diff !== null && (
        <span
          className="pointer-events-none absolute rounded-full px-1.5 text-[9px] font-bold tracking-wide text-black uppercase"
          style={{ left: box.center.x - 22, top: -8, background: DIFF_COLOR[diff] }}
        >
          {diff === 'added' ? 'new' : diff === 'modified' ? 'changed' : 'removed'}
        </span>
      )}
    </div>
  )
}

/** Actions on the selected node, floating above it (only when it is the one selected node). */
function NodeActions({ id, editable, hasChildren }: { id: string; editable: boolean; hasChildren: boolean }): React.JSX.Element {
  const only = useStore((s) => s.ui.selection?.kind === 'node' && s.ui.selection.ids.length === 1 && s.ui.selection.ids[0] === id && s.ui.connectFrom === null)
  const btn = 'nodrag flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium hover:bg-accent [&_svg]:size-3.5'
  return (
    <NodeToolbar isVisible={only} position={Position.Top} offset={10}>
      <div className="flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-lg">
        {editable && (
          <button type="button" className={btn} title="Connect to another node (C), then click the target" onClick={() => startConnect(id)}>
            <Cable /> Connect
          </button>
        )}
        <button type="button" className={btn} title="Show what this depends on and what depends on it" onClick={() => setUi({ blast: { id, dir: 'both', hops: Infinity } })}>
          <Crosshair /> Impact
        </button>
        <button type="button" className={btn} title={hasChildren ? 'Open its inner architecture' : 'Map its inner architecture'} onClick={() => (hasChildren ? focus(id) : toggleExpanded(id, true))}>
          <Maximize2 /> {hasChildren ? 'Open' : 'Inner parts'}
        </button>
      </div>
    </NodeToolbar>
  )
}

interface ShapeProps {
  center: Point
  r: number
  stroke: string
  selected: boolean
  dash: string | undefined
  faded: boolean
  external: boolean
}

function FlatHex({ center, r, stroke, selected, dash, faded, external }: ShapeProps): React.JSX.Element {
  const w = center.x * 2
  const h = center.y * 2
  return (
    <svg className="absolute inset-0 overflow-visible" width={w} height={h} aria-hidden>
      {selected && (
        <polygon points={pointsAttr(hexCorners(center, r + 5))} fill="none" stroke="var(--ring)" strokeWidth={2} strokeOpacity={0.9} />
      )}
      <polygon
        points={pointsAttr(hexCorners(center, r - 1.5))}
        fill={external ? 'color-mix(in oklab, var(--hx-amber) 9%, var(--hx-fill))' : 'var(--hx-fill)'}
        stroke={stroke}
        strokeWidth={2}
        strokeDasharray={dash}
        strokeLinejoin="round"
        opacity={faded ? 0.65 : 1}
        style={{ filter: `drop-shadow(0 0 7px color-mix(in oklab, ${stroke} 55%, transparent))` }}
      />
      <polygon points={pointsAttr(hexCorners(center, r - 8))} fill="none" stroke={stroke} strokeOpacity={0.22} strokeWidth={1} />
    </svg>
  )
}

function IsoHex({ center, r, stroke, selected, dash, faded, external }: ShapeProps): React.JSX.Element {
  const squash = 0.58
  const top = hexCorners(center, r - 1.5, squash)
  const d = ISO_DEPTH
  const down = (p: Point): Point => ({ x: p.x, y: p.y + d })
  // Corners 0..3 (0°, 60°, 120°, 180°) form the near (lower) half; extrude the three edges between them.
  const sides = [0, 1, 2].map((i) => {
    const a = top[i] as Point
    const b = top[i + 1] as Point
    return [a, b, down(b), down(a)]
  })
  const fill = external ? 'color-mix(in oklab, var(--hx-amber) 10%, var(--hx-fill))' : 'var(--hx-fill)'
  return (
    <svg className="absolute inset-0 overflow-visible" width={center.x * 2} height={center.y * 2 + d} aria-hidden>
      {selected && (
        <polygon points={pointsAttr(hexCorners({ x: center.x, y: center.y + d / 2 }, r + 6, squash))} fill="none" stroke="var(--ring)" strokeWidth={2} />
      )}
      <g opacity={faded ? 0.65 : 1} style={{ filter: `drop-shadow(0 0 6px color-mix(in oklab, ${stroke} 45%, transparent))` }}>
        {sides.map((pts, i) => (
          <polygon
            key={i}
            points={pointsAttr(pts)}
            fill={`color-mix(in oklab, ${stroke} ${i === 1 ? 26 : 16}%, var(--hx-fill))`}
            stroke={stroke}
            strokeWidth={1.5}
            strokeDasharray={dash}
            strokeLinejoin="round"
          />
        ))}
        <polygon points={pointsAttr(top)} fill={fill} stroke={stroke} strokeWidth={2} strokeDasharray={dash} strokeLinejoin="round" />
        <polygon points={pointsAttr(hexCorners(center, r - 10, squash))} fill="none" stroke={stroke} strokeOpacity={0.25} strokeWidth={1} />
      </g>
    </svg>
  )
}

export const HexNode = memo(HexNodeImpl)
