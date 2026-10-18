// The project's teams, roadmap phases and own data classes (the vocab entities point at). Removing one clears the
// references to it in the same undo step.
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { BUILTIN_DATA_CLASSES, phasesInOrder } from '@shared/model/governance.ts'
import { uniqueId } from '@shared/model/ids.ts'
import type { Op } from '@shared/model/ops.ts'
import { PHASE_STATUSES } from '@shared/model/schema.ts'
import type { DataClass, Model, Phase, Team } from '@shared/model/schema.ts'
import { Button } from '../../components/ui/Button.tsx'
import { edit } from '../../state/actions.ts'
import { useModel } from '../../canvas/useScene.ts'
import { TextInput } from './fields.tsx'

const slug = (s: string, fallback: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || fallback

/** Ops that clear every reference to a team, phase or data class. */
function clearRefs(m: Model, field: 'team' | 'phase' | 'dataClasses', id: string): Op[] {
  const ops: Op[] = []
  for (const n of Object.values(m.nodes)) {
    if (field === 'dataClasses' && n.dataClasses.includes(id)) ops.push({ op: 'updateNode', id: n.id, patch: { dataClasses: n.dataClasses.filter((x) => x !== id) } })
    if (field !== 'dataClasses' && n[field] === id) ops.push({ op: 'updateNode', id: n.id, patch: { [field]: null } })
    if (field === 'phase' && n.features.some((f) => f.phase === id)) ops.push({ op: 'updateNode', id: n.id, patch: { features: n.features.map((f) => (f.phase === id ? { ...f, phase: null } : f)) } })
  }
  for (const c of Object.values(m.connectors)) {
    if (field === 'dataClasses') {
      const hasB = c.channelB?.dataClasses.includes(id) === true
      if (c.channelA.dataClasses.includes(id) || hasB) {
        ops.push({
          op: 'updateConnector',
          id: c.id,
          patch: {
            channelA: { ...c.channelA, dataClasses: c.channelA.dataClasses.filter((x) => x !== id) },
            ...(c.channelB !== null && hasB ? { channelB: { ...c.channelB, dataClasses: c.channelB.dataClasses.filter((x) => x !== id) } } : {}),
          },
        })
      }
    } else if (c[field] === id) ops.push({ op: 'updateConnector', id: c.id, patch: { [field]: null } })
  }
  for (const b of Object.values(m.boundaries)) {
    if (field === 'team' && b.team === id) ops.push({ op: 'updateBoundary', id: b.id, patch: { team: null } })
    if (field === 'dataClasses' && b.dataClasses.includes(id)) ops.push({ op: 'updateBoundary', id: b.id, patch: { dataClasses: b.dataClasses.filter((x) => x !== id) } })
  }
  return ops
}

function usageCount(m: Model, field: 'team' | 'phase', id: string): number {
  return Object.values(m.nodes).filter((n) => n[field] === id).length + Object.values(m.connectors).filter((c) => c[field] === id).length
}

export function TeamsEditor({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const model = useModel()
  const teams = model.meta.teams
  const set = (next: Team[], key?: string): void => void edit([{ op: 'updateMeta', patch: { teams: next } }], key !== undefined ? { coalesceKey: key } : { label: 'edit teams' })
  const add = (): void => {
    const id = uniqueId('team', (x) => teams.some((t) => t.id === x))
    set([...teams, { id, name: `Team ${teams.length + 1}`, contact: null, color: null }])
  }
  return (
    <div>
      {teams.length === 0 && <p className="mb-2 text-xs text-muted-foreground">No teams yet. Add them here or type a new team name on any node.</p>}
      <ul className="flex flex-col gap-1">
        {teams.map((t) => (
          <li key={t.id} className="flex items-center gap-1.5">
            <TextInput value={t.name} readOnly={readOnly} onChange={(v) => v.trim() !== '' && set(teams.map((x) => (x.id === t.id ? { ...x, name: v } : x)), `team:${t.id}:name`)} />
            <TextInput value={t.contact ?? ''} placeholder="#channel, email" readOnly={readOnly} onChange={(v) => set(teams.map((x) => (x.id === t.id ? { ...x, contact: v.trim() === '' ? null : v } : x)), `team:${t.id}:contact`)} />
            <span className="w-6 shrink-0 text-right font-mono text-[10.5px] text-muted-foreground tabular-nums" title="Nodes and connectors owned">
              {usageCount(model, 'team', t.id)}
            </span>
            {!readOnly && (
              <button type="button" aria-label={`Remove ${t.name}`} className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => edit([...clearRefs(model, 'team', t.id), { op: 'updateMeta', patch: { teams: teams.filter((x) => x.id !== t.id) } }], { label: 'remove team' })}>
                <Trash2 className="size-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <Button size="sm" variant="ghost" className="mt-1" icon={<Plus />} onClick={add}>
          Add team
        </Button>
      )}
    </div>
  )
}

const PHASE_STATUS_LABEL: Record<Phase['status'], string> = { 'not-started': 'Not started', active: 'Active', done: 'Done' }

export function PhasesEditor({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const model = useModel()
  const phases = phasesInOrder(model.meta)
  const set = (next: Phase[], key?: string): void => void edit([{ op: 'updateMeta', patch: { phases: next.map((p, i) => ({ ...p, order: i + 1 })) } }], key !== undefined ? { coalesceKey: key } : { label: 'edit phases' })
  const update = (id: string, p: Partial<Phase>, key: string): void => set(phases.map((x) => (x.id === id ? { ...x, ...p } : x)), `phase:${id}:${key}`)
  const move = (i: number, d: -1 | 1): void => {
    const next = [...phases]
    const [p] = next.splice(i, 1)
    if (p === undefined) return
    next.splice(i + d, 0, p)
    set(next)
  }
  const add = (): void => {
    const name = `Phase ${phases.length + 1}`
    const id = uniqueId(slug(name, 'phase'), (x) => phases.some((p) => p.id === x))
    set([...phases, { id, name, order: phases.length + 1, target: null, status: 'not-started', description: '' }])
  }
  return (
    <div>
      {phases.length === 0 && <p className="mb-2 text-xs text-muted-foreground">Split planned work into phases (MVP, Phase 2…), then set a phase on planned nodes and connectors.</p>}
      <ol className="flex flex-col gap-1.5">
        {phases.map((p, i) => (
          <li key={p.id} className="rounded-md border p-1.5">
            <div className="flex items-center gap-1.5">
              <span className="w-4 shrink-0 text-center font-mono text-[10.5px] text-muted-foreground">{i + 1}</span>
              <TextInput value={p.name} readOnly={readOnly} onChange={(v) => v.trim() !== '' && update(p.id, { name: v }, 'name')} />
              {!readOnly && (
                <>
                  <button type="button" aria-label="Move earlier" disabled={i === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30" onClick={() => move(i, -1)}>
                    <ArrowUp className="size-3.5" />
                  </button>
                  <button type="button" aria-label="Move later" disabled={i === phases.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30" onClick={() => move(i, 1)}>
                    <ArrowDown className="size-3.5" />
                  </button>
                  <button type="button" aria-label={`Remove ${p.name}`} className="text-muted-foreground hover:text-destructive" onClick={() => edit([...clearRefs(model, 'phase', p.id), { op: 'updateMeta', patch: { phases: phases.filter((x) => x.id !== p.id) } }], { label: 'remove phase' })}>
                    <Trash2 className="size-3.5" />
                  </button>
                </>
              )}
            </div>
            <div className="mt-1 flex items-center gap-1.5 pl-5.5 text-[11px]">
              {readOnly ? (
                <span className="text-muted-foreground">
                  {PHASE_STATUS_LABEL[p.status]}
                  {p.target !== null ? ` · ${p.target}` : ''}
                </span>
              ) : (
                <>
                  <input type="date" aria-label="Target date" value={p.target ?? ''} onChange={(e) => update(p.id, { target: e.target.value === '' ? null : e.target.value }, 'target')} className="h-6 rounded border bg-background px-1 text-[11px]" />
                  <select aria-label="Phase status" value={p.status} onChange={(e) => update(p.id, { status: e.target.value as Phase['status'] }, 'status')} className="h-6 rounded border bg-background px-1 text-[11px]">
                    {PHASE_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {PHASE_STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <span className="ml-auto font-mono text-[10.5px] text-muted-foreground tabular-nums" title="Nodes and connectors in this phase">
                {usageCount(model, 'phase', p.id)}
              </span>
            </div>
          </li>
        ))}
      </ol>
      {!readOnly && (
        <Button size="sm" variant="ghost" className="mt-1" icon={<Plus />} onClick={add}>
          Add phase
        </Button>
      )}
    </div>
  )
}

export function DataClassesEditor({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const model = useModel()
  const own = model.meta.dataClasses
  const set = (next: DataClass[], key?: string): void => void edit([{ op: 'updateMeta', patch: { dataClasses: next } }], key !== undefined ? { coalesceKey: key } : { label: 'edit data classes' })
  const add = (): void => {
    const id = uniqueId('custom', (x) => own.some((d) => d.id === x) || BUILTIN_DATA_CLASSES.some((d) => d.id === x))
    set([...own, { id, label: 'Custom data', regime: null, description: '' }])
  }
  return (
    <div>
      <p className="mb-1.5 text-[11px] text-muted-foreground">
        Built in: {BUILTIN_DATA_CLASSES.map((d) => d.label).join(', ')}. Add your own below (export-controlled, trade secrets…).
      </p>
      <ul className="flex flex-col gap-1">
        {own
          .filter((d) => !BUILTIN_DATA_CLASSES.some((b) => b.id === d.id))
          .map((d) => (
            <li key={d.id} className="flex items-center gap-1.5">
              <TextInput value={d.label} readOnly={readOnly} onChange={(v) => v.trim() !== '' && set(own.map((x) => (x.id === d.id ? { ...x, label: v } : x)), `dc:${d.id}:label`)} />
              <TextInput value={d.regime ?? ''} placeholder="Regime (ITAR…)" readOnly={readOnly} onChange={(v) => set(own.map((x) => (x.id === d.id ? { ...x, regime: v.trim() === '' ? null : v } : x)), `dc:${d.id}:regime`)} />
              {!readOnly && (
                <button type="button" aria-label={`Remove ${d.label}`} className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => edit([...clearRefs(model, 'dataClasses', d.id), { op: 'updateMeta', patch: { dataClasses: own.filter((x) => x.id !== d.id) } }], { label: 'remove data class' })}>
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
      </ul>
      {!readOnly && (
        <Button size="sm" variant="ghost" className="mt-1" icon={<Plus />} onClick={add}>
          Add data class
        </Button>
      )}
    </div>
  )
}
