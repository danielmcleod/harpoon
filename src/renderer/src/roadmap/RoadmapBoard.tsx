// The roadmap board: one column per phase (plus Unscheduled) with the changes that land in it, grouped by the
// top-level service they belong to. Drag a card to another column to move it to that phase; click to inspect it.
import { Eye, GripVertical, ScrollText } from 'lucide-react'
import { adrNumber } from '@shared/export/adr.ts'
import { openRecord } from '../records/decide.ts'
import { useRecords } from '../records/recordsStore.ts'
import { useMemo, useState } from 'react'
import { phasesInOrder } from '@shared/model/governance.ts'
import type { Op } from '@shared/model/ops.ts'
import { ancestorsOf } from '@shared/model/queries.ts'
import type { Model } from '@shared/model/schema.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { edit, select } from '../state/actions.ts'
import { setUi, useStore } from '../state/store.ts'
import { useModel } from '../canvas/useScene.ts'
import { STATUS_COLOR } from '../canvas/lensMarks.ts'
import { openSettings } from '../settings/ProjectSettings.tsx'
import { changeRows } from '../tables/rows.ts'
import type { ChangeRow } from '../tables/rows.ts'

const CHANGE_STYLE: Record<string, string> = { add: 'text-[var(--hx-add)]', building: 'text-[var(--hx-warn)]', retire: 'text-[var(--hx-del)]', removed: 'text-[var(--hx-del)]' }

/** Ops that move a change to a phase (null: unscheduled). */
export function movePhaseOps(m: Model, r: ChangeRow, phase: string | null): Op[] {
  if (r.entity === 'node') return [{ op: 'updateNode', id: r.entityId, patch: { phase } }]
  if (r.entity === 'connector') return [{ op: 'updateConnector', id: r.entityId, patch: { phase } }]
  const n = r.nodeId === null ? undefined : m.nodes[r.nodeId]
  return n === undefined ? [] : [{ op: 'updateNode', id: n.id, patch: { features: n.features.map((f) => (f.id === r.entityId ? { ...f, phase } : f)) } }]
}

/** The top-level service a change belongs to (connectors: their source's). */
function groupOf(m: Model, r: ChangeRow): string {
  const nodeId = r.entity === 'connector' ? (m.connectors[r.entityId]?.source ?? null) : (r.nodeId ?? r.entityId)
  if (nodeId === null) return 'Other'
  const top = [...ancestorsOf(m, nodeId)].reverse().find((a) => a.kind !== 'system') ?? m.nodes[nodeId]
  return top?.name ?? 'Other'
}

export function RoadmapBoard(): React.JSX.Element {
  const model = useModel()
  const editable = useStore((s) => s.ui.mode === 'edit')
  const selection = useStore((s) => s.ui.selection)
  const phases = phasesInOrder(model.meta)
  const rows = useMemo(() => changeRows(model), [model])
  const decisions = useRecords((s) => s.decisions)
  const [over, setOver] = useState<string | null>(null)

  const columns: { id: string | null; name: string; sub: string }[] = [
    { id: null, name: 'Unscheduled', sub: 'Planned or retiring, no phase yet' },
    ...phases.map((p) => ({ id: p.id, name: p.name, sub: [p.target !== null ? `target ${p.target}` : null, p.status === 'not-started' ? 'not started' : p.status].filter(Boolean).join(' · ') })),
  ]
  const inColumn = (id: string | null): ChangeRow[] => rows.filter((r) => (id === null ? r.phaseId === null || !phases.some((p) => p.id === r.phaseId) : r.phaseId === id))

  const drop = (phase: string | null, key: string): void => {
    const r = rows.find((x) => x.id === key)
    if (r === undefined || r.phaseId === phase) return
    const ops = movePhaseOps(model, r, phase)
    if (ops.length > 0) edit(ops, { label: phase === null ? 'unschedule' : `move to ${phases.find((p) => p.id === phase)?.name ?? phase}` })
  }
  const inspect = (r: ChangeRow): void => {
    if (r.entity === 'connector') select({ kind: 'connector', ids: [r.entityId] })
    else {
      select({ kind: 'node', ids: [r.nodeId ?? r.entityId] })
      if (r.entity === 'feature') setUi({ featureId: r.entityId })
    }
  }
  const isSelected = (r: ChangeRow): boolean =>
    r.entity === 'connector' ? selection?.kind === 'connector' && selection.ids.includes(r.entityId) : selection?.kind === 'node' && selection.ids.includes(r.nodeId ?? r.entityId)

  if (phases.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="max-w-md text-sm text-muted-foreground">
          The roadmap board lays out planned work by phase. Add phases (MVP, Phase 2…) first, then drag planned nodes, connectors and features into them.
        </p>
        <Button size="sm" onClick={() => openSettings('phases')}>
          Add roadmap phases
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto bg-background p-3">
      {columns.map((col) => {
        const items = inColumn(col.id)
        const groups = new Map<string, ChangeRow[]>()
        for (const r of items) {
          const g = groupOf(model, r)
          groups.set(g, [...(groups.get(g) ?? []), r])
        }
        const key = col.id ?? '__none'
        return (
          <section
            key={key}
            aria-label={col.name}
            onDragOver={(e) => {
              if (!editable) return
              e.preventDefault()
              setOver(key)
            }}
            onDragLeave={() => setOver((o) => (o === key ? null : o))}
            onDrop={(e) => {
              e.preventDefault()
              setOver(null)
              drop(col.id, e.dataTransfer.getData('text/x-harpoon-change'))
            }}
            className={cn('flex w-72 shrink-0 flex-col rounded-xl border bg-popover', over === key && 'border-primary ring-1 ring-primary/50', col.id === null && 'border-dashed')}
          >
            <header className="flex items-start gap-2 border-b px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{col.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">{col.sub}</div>
              </div>
              <span className="rounded bg-muted px-1.5 font-mono text-[10.5px] tabular-nums">{items.length}</span>
              {col.id !== null && (
                <button
                  type="button"
                  title="Show the architecture at the end of this phase"
                  aria-label={`Show ${col.name} on the diagram`}
                  onClick={() => setUi({ view: 'canvas', asOf: col.id, fitNonce: useStore.getState().ui.fitNonce + 1 })}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Eye className="size-3.5" />
                </button>
              )}
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {decisions
                .filter((d) => (col.id === null ? false : d.phase === col.id) && d.status !== 'rejected')
                .map((d) => (
                  <button key={d.id} type="button" onClick={() => openRecord('decision', d.id)} className="mb-1.5 flex w-full items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-left text-[11px] hover:bg-accent/50">
                    <ScrollText className="size-3 shrink-0 text-muted-foreground" />
                    <span className="font-mono text-[10px] text-muted-foreground">{adrNumber(d.number)}</span>
                    <span className="min-w-0 flex-1 truncate">{d.title}</span>
                  </button>
                ))}
              {items.length === 0 && <p className="px-1 py-4 text-center text-[11px] text-muted-foreground">{editable ? 'Drag changes here.' : 'Nothing in this phase.'}</p>}
              {[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([g, rs]) => (
                <div key={g} className="mb-2.5">
                  <div className="mb-1 px-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{g}</div>
                  <ul className="flex flex-col gap-1">
                    {rs.map((r) => (
                      <li
                        key={r.id}
                        draggable={editable}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/x-harpoon-change', r.id)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => inspect(r)}
                          className={cn('flex w-full items-start gap-1.5 rounded-md border bg-background px-2 py-1.5 text-left text-xs hover:border-primary/50', isSelected(r) && 'border-primary bg-primary/10')}
                        >
                          {editable && <GripVertical className="mt-0.5 size-3 shrink-0 cursor-grab text-muted-foreground" />}
                          <span className="mt-1 size-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[r.status] }} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{r.name.split(' › ').at(-1)}</span>
                            <span className="block truncate text-[10.5px] text-muted-foreground">
                              <span className={cn('font-medium', CHANGE_STYLE[r.change])}>{r.change}</span> · {r.what}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
