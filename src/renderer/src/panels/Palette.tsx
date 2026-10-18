// The palette: one hex tile per node kind. Drag a tile onto the canvas (or into an expanded container); click adds
// one to the current level.
import { useState } from 'react'
import { coordKey, hexCorners, nearestFreeCell, pointsAttr } from '@shared/geometry/hex.ts'
import { KIND_INFO } from '@shared/model/kinds.ts'
import { NODE_KINDS } from '@shared/model/schema.ts'
import type { NodeKind } from '@shared/model/schema.ts'
import { KIND_MIME } from '../canvas/Canvas.tsx'
import { newNodeOps } from '../canvas/edits.ts'
import { ChevronDown } from 'lucide-react'
import { cn } from '../lib/cn.ts'
import { colorVar, kindIcon } from '../lib/icons.tsx'
import { edit, select } from '../state/actions.ts'
import { getState } from '../state/store.ts'

function addToLevel(kind: NodeKind): void {
  const s = getState()
  const m = s.project?.model
  if (m === undefined) return
  const parentId = s.ui.focusId
  const taken = new Set(
    Object.values(m.nodes)
      .filter((n) => n.parentId === parentId)
      .map((n) => m.layout[n.id])
      .filter((c) => c !== undefined)
      .map(coordKey),
  )
  const at = nearestFreeCell({ q: 0, r: 0 }, (c) => taken.has(coordKey(c)))
  const made = newNodeOps(m, kind, parentId, at)
  if (edit(made.ops)) select({ kind: 'node', ids: [made.id] })
}

export function Palette(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <section className="flex max-h-[45%] shrink-0 flex-col border-t">
      <button type="button" onClick={() => setOpen(!open)} className="flex h-10 w-full items-center justify-between px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground">
        Palette
        <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
      </button>
      {open && (
        <div className="grid min-h-0 grid-cols-4 gap-1.5 overflow-y-auto px-2 pb-3">
          {NODE_KINDS.map((k) => {
            const info = KIND_INFO[k]
            const Icon = kindIcon(k)
            const color = info.externalByDefault && k === 'saas' ? 'var(--hx-amber)' : colorVar(info.color)
            return (
              <button
                key={k}
                type="button"
                draggable
                title={`${info.label}: ${info.hint}. Drag onto the canvas, or click to add.`}
                onDragStart={(e) => {
                  e.dataTransfer.setData(KIND_MIME, k)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => addToLevel(k)}
                className="group flex flex-col items-center gap-1 rounded-lg border border-transparent py-1.5 hover:border-border hover:bg-accent/50"
              >
                <svg viewBox="0 0 44 40" className="h-9 w-10 overflow-visible" aria-hidden>
                  <polygon
                    points={pointsAttr(hexCorners({ x: 22, y: 20 }, 19))}
                    fill="var(--hx-fill)"
                    stroke={color}
                    strokeWidth={1.8}
                    strokeDasharray={info.externalByDefault ? '4 3' : undefined}
                    style={{ filter: `drop-shadow(0 0 4px color-mix(in oklab, ${color} 50%, transparent))` }}
                  />
                  <foreignObject x="13" y="11" width="18" height="18">
                    <Icon className="size-[18px]" style={{ color }} />
                  </foreignObject>
                </svg>
                <span className="text-[10.5px] leading-none text-muted-foreground group-hover:text-foreground">{info.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
