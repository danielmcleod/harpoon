// A saved flow as a sequence diagram: one lifeline per participant, one arrow per step (solid for requests, open
// head for async, dashed for replies). Same reading of the flow as the Mermaid export. Click an arrow to inspect
// its connector.
import { Dialog } from 'radix-ui'
import { X } from 'lucide-react'
import { useMemo } from 'react'
import { protocolFamily } from '@shared/model/kinds.ts'
import type { HxFlow } from '@shared/model/schema.ts'
import { flowSequence } from '@shared/model/sequence.ts'
import { Button } from '../components/ui/Button.tsx'
import { select } from '../state/actions.ts'
import { useStore } from '../state/store.ts'
import { useModel } from '../canvas/useScene.ts'
import { FAMILY_COLOR } from '../canvas/HarpoonEdge.tsx'

const COL = 150
const PAD = 24
const HEAD = 34
const ROW = 38

export function FlowSequence({ flow, onClose }: { flow: HxFlow; onClose: () => void }): React.JSX.Element {
  const model = useModel()
  const selection = useStore((s) => s.ui.selection)
  const seq = useMemo(() => flowSequence(model, flow), [model, flow])
  const x = new Map(seq.participants.map((p, i) => [p.id, PAD + COL / 2 + i * COL]))
  const width = Math.max(PAD * 2 + seq.participants.length * COL, 320)
  const top = PAD + HEAD + 24
  const height = top + seq.messages.length * ROW + HEAD + PAD
  const fit = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

  const head = (y: number): React.ReactNode =>
    seq.participants.map((p) => (
      <g key={`${p.id}-${y}`}>
        <rect x={(x.get(p.id) ?? 0) - COL / 2 + 8} y={y} width={COL - 16} height={HEAD} rx={6} className="fill-background stroke-border" />
        <text x={x.get(p.id)} y={y + HEAD / 2} dominantBaseline="central" textAnchor="middle" className="fill-foreground text-[11px] font-medium">
          <title>{p.name}</title>
          {fit(p.name, 20)}
        </text>
      </g>
    ))

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[min(1100px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-popover shadow-2xl outline-none">
          <div className="flex items-center gap-2 border-b px-4 py-2.5">
            <Dialog.Title className="flex-1 text-sm font-semibold">{flow.name}</Dialog.Title>
            <Dialog.Description className="sr-only">The flow as a sequence diagram.</Dialog.Description>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close sequence diagram">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {seq.messages.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">This flow has no steps yet. Select a connector on the canvas and add a request step.</p>
            ) : (
              <svg role="img" aria-label={`Sequence diagram of ${flow.name}`} width={width} height={height} className="mx-auto block">
                <defs>
                  <marker id="seq-solid" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
                  </marker>
                  <marker id="seq-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10" fill="none" stroke="context-stroke" strokeWidth="1.5" />
                  </marker>
                </defs>
                {seq.participants.map((p) => (
                  <line key={p.id} x1={x.get(p.id)} x2={x.get(p.id)} y1={PAD + HEAD} y2={height - PAD - HEAD} strokeDasharray="4 4" className="stroke-border" />
                ))}
                {head(PAD)}
                {head(height - PAD - HEAD)}
                {seq.messages.map((msg, i) => {
                  const y = top + i * ROW + ROW / 2
                  const x1 = x.get(msg.from) ?? 0
                  const x2 = x.get(msg.to) ?? 0
                  const self = x1 === x2
                  const color = FAMILY_COLOR[protocolFamily(msg.protocol)]
                  const active = selection?.kind === 'connector' && selection.ids.includes(msg.connectorId)
                  const path = self ? `M${x1},${y - 8} h36 v16 h-36` : `M${x1 + (x2 > x1 ? 4 : -4)},${y} L${x2 + (x2 > x1 ? -4 : 4)},${y}`
                  return (
                    <g key={msg.step} role="button" aria-label={`Step ${msg.step + 1}: ${msg.label}`} className="cursor-pointer" onClick={() => select({ kind: 'connector', ids: [msg.connectorId] })}>
                      <path d={path} stroke="transparent" strokeWidth={14} fill="none" />
                      <path d={path} stroke={color} strokeWidth={active ? 2.4 : 1.5} fill="none" strokeDasharray={msg.kind === 'reply' ? '5 4' : undefined} markerEnd={`url(#${msg.kind === 'sync' ? 'seq-solid' : 'seq-open'})`} />
                      <text x={self ? x1 + 42 : (x1 + x2) / 2} y={self ? y : y - 6} textAnchor={self ? 'start' : 'middle'} dominantBaseline={self ? 'central' : 'auto'} className="fill-foreground text-[10.5px]">
                        <tspan className="fill-muted-foreground font-mono">{msg.step + 1}. </tspan>
                        {fit(msg.label, Math.max(12, Math.floor((Math.abs(x2 - x1) || COL) / 6.5)))}
                      </text>
                    </g>
                  )
                })}
              </svg>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
