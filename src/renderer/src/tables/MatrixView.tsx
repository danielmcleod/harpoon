// The dependency matrix: who calls whom, services × services (rows call columns). Cells take the colour of their
// connectors' protocol family; a dot flags cells whose connectors have problems. Click a cell to inspect its
// connectors, double-click to find it on the canvas.
import type { ProtocolFamily } from '@shared/model/kinds.ts'
import { Checkbox } from '../components/ui/Checkbox.tsx'
import { cn } from '../lib/cn.ts'
import { select } from '../state/actions.ts'
import { FAMILY_COLOR } from '../canvas/HarpoonEdge.tsx'
import type { DependencyMatrix, MatrixCell } from './rows.ts'
import { useTables } from './tableStore.ts'

const FAMILY_LABEL: Record<ProtocolFamily, string> = { http: 'HTTP', rpc: 'RPC', stream: 'Streams / events', data: 'Data stores', other: 'Other' }

/** One family fills the cell; mixed cells split diagonally between the first two. */
function cellBackground(c: MatrixCell): string {
  const [a, b] = c.families.map((f) => `color-mix(in oklch, ${FAMILY_COLOR[f]} 55%, transparent)`)
  return b === undefined ? (a ?? 'transparent') : `linear-gradient(135deg, ${a} 50%, ${b} 50%)`
}

interface Props {
  matrix: DependencyMatrix
  inner: boolean
  /** Selected connector ids. */
  selected: readonly string[]
  onOpen: (connectorId: string) => void
}

export function DependencyMatrixView({ matrix, inner, selected, onOpen }: Props): React.JSX.Element {
  const { services, cells } = matrix
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
        <label className="flex items-center gap-1.5 text-xs text-foreground">
          <Checkbox checked={inner} onCheckedChange={(v) => useTables.setState({ matrixInner: v === true })} aria-label="Include inner parts" />
          Include inner parts
        </label>
        <span className="flex-1" />
        {(Object.keys(FAMILY_LABEL) as ProtocolFamily[]).map((f) => (
          <span key={f} className="flex items-center gap-1">
            <span className="size-2.5 rounded-sm" style={{ background: FAMILY_COLOR[f] }} />
            {FAMILY_LABEL[f]}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-hx-rose" />
          Has problems
        </span>
      </div>
      {services.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">No services yet.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table aria-label="Dependency matrix" className="border-separate border-spacing-0 text-[11px]">
            <thead>
              <tr>
                <th className="sticky top-0 left-0 z-20 bg-popover px-2 text-left align-bottom text-[10px] font-normal text-muted-foreground">calls →</th>
                {services.map((s) => (
                  <th key={s.id} scope="col" title={s.name} className="sticky top-0 z-10 h-28 w-7 bg-popover px-0 align-bottom font-normal">
                    <span className={cn('mx-auto block max-h-26 truncate pb-1 [writing-mode:vertical-rl] rotate-180', s.depth > 0 && 'text-muted-foreground')}>{s.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {services.map((r) => (
                <tr key={r.id}>
                  <th scope="row" title={r.name} className={cn('sticky left-0 z-10 max-w-56 truncate bg-popover py-0 pr-2 text-left font-normal', r.depth > 0 && 'text-muted-foreground')} style={{ paddingLeft: 8 + r.depth * 12 }}>
                    {r.name}
                  </th>
                  {services.map((col) => {
                    const c = cells[`${r.id}>${col.id}`]
                    const diag = r.id === col.id
                    if (c === undefined) return <td key={col.id} className={cn('size-7 border-r border-b border-border/40', diag && 'bg-muted/40')} />
                    const active = c.connectorIds.every((id) => selected.includes(id))
                    const first = c.connectorIds[0]
                    return (
                      <td key={col.id} className="size-7 border-r border-b border-border/40 p-0">
                        <button
                          type="button"
                          aria-label={`${r.name} → ${col.name}`}
                          title={`${r.name} → ${col.name}\n${c.protocols.join(', ')} (${c.connectorIds.length} connector${c.connectorIds.length === 1 ? '' : 's'})${c.problems > 0 ? `\n${c.problems} problem${c.problems === 1 ? '' : 's'}` : ''}`}
                          onClick={() => select({ kind: 'connector', ids: c.connectorIds })}
                          onDoubleClick={() => first !== undefined && onOpen(first)}
                          className={cn('relative flex size-7 items-center justify-center font-mono text-[10px] tabular-nums outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring', active && 'ring-2 ring-ring ring-inset')}
                          style={{ background: cellBackground(c) }}
                        >
                          {c.connectorIds.length > 1 ? c.connectorIds.length : ''}
                          {c.problems > 0 && <span aria-label="Has problems" className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-hx-rose" />}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
