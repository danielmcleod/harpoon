// Ownership, data classification, roadmap phase and notes: the controls nodes, connectors and boundaries share.
import { Eye, Pencil } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { dataClassCatalog, dataScope, phasesInOrder } from '@shared/model/governance.ts'
import type { ScopeReason } from '@shared/model/governance.ts'
import type { Op } from '@shared/model/ops.ts'
import { Markdown } from '../../ai/Markdown.tsx'
import { cn } from '../../lib/cn.ts'
import { useModel } from '../../canvas/useScene.ts'
import { TextArea } from './fields.tsx'

/** Every node's data scope (tagged, carried, or held inside), recomputed when the model changes. */
export function useDataScope(): Map<string, Map<string, ScopeReason>> {
  const model = useModel()
  return useMemo(() => dataScope(model), [model])
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'team'

/**
 * A team by name: pick one of the project's teams or type a new name (Enter or leaving the field commits; a new name
 * creates the team in the same undo step). `inherited` shows the team the node gets from a parent.
 */
export function TeamPicker({
  value,
  inherited,
  readOnly,
  onChange,
  compact = false,
}: {
  value: string | null
  inherited?: string | null
  readOnly: boolean
  onChange: (teamId: string | null, pre: Op[]) => void
  /** In a table cell: borderless until hovered. */
  compact?: boolean
}): React.JSX.Element {
  const model = useModel()
  const teams = model.meta.teams
  const nameOf = (id: string | null | undefined): string => (id == null ? '' : (teams.find((t) => t.id === id)?.name ?? id))
  const [draft, setDraft] = useState(nameOf(value))
  useEffect(() => setDraft(nameOf(value)), [value, teams]) // eslint-disable-line react-hooks/exhaustive-deps
  const placeholder = inherited != null ? `${nameOf(inherited)} (inherited)` : 'No team'
  if (readOnly) return <span className={cn('text-xs', value === null && 'text-muted-foreground italic')}>{value !== null ? nameOf(value) : placeholder}</span>

  const commit = (): void => {
    const want = draft.trim()
    if (want === nameOf(value)) return
    if (want === '') return onChange(null, [])
    const hit = teams.find((t) => t.name.toLowerCase() === want.toLowerCase() || t.id === want)
    if (hit !== undefined) return onChange(hit.id, [])
    let id = slug(want)
    for (let i = 2; teams.some((t) => t.id === id); i++) id = `${slug(want)}-${i}`
    onChange(id, [{ op: 'updateMeta', patch: { teams: [...teams, { id, name: want, contact: null, color: null }] } }])
  }
  return (
    <>
      <input
        value={draft}
        list="hx-teams"
        placeholder={placeholder}
        aria-label="Team"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(nameOf(value))
            e.currentTarget.blur()
          }
        }}
        className={cn(
          'w-full rounded-md border text-xs outline-none placeholder:italic focus:border-ring',
          compact ? 'h-6 border-transparent bg-transparent px-1 hover:border-input' : 'h-7 border-input bg-background px-2',
        )}
      />
      <datalist id="hx-teams">
        {teams.map((t) => (
          <option key={t.id} value={t.name} />
        ))}
      </datalist>
    </>
  )
}

/** Toggle chips for the data-class catalog. Classes the entity only handles by derivation show dashed, with why. */
export function DataClassPicker({
  value,
  derived,
  readOnly,
  onChange,
}: {
  value: string[]
  derived?: Map<string, ScopeReason> | undefined
  readOnly: boolean
  onChange: (v: string[]) => void
}): React.JSX.Element {
  const model = useModel()
  const catalog = dataClassCatalog(model.meta)
  const name = (id: string): string => model.nodes[id]?.name ?? id
  const shown = readOnly ? catalog.filter((c) => value.includes(c.id) || derived?.has(c.id) === true) : catalog
  const unknown = value.filter((v) => !catalog.some((c) => c.id === v))
  if (shown.length === 0 && unknown.length === 0) return <span className="text-xs text-muted-foreground">None</span>
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((c) => {
        const on = value.includes(c.id)
        const why = derived?.get(c.id)
        const viaText =
          why === undefined
            ? ''
            : [
                why.via.length > 0 ? `carried by ${why.via.length} connector${why.via.length > 1 ? 's' : ''}` : '',
                why.inner.length > 0 ? `handled inside by ${why.inner.map(name).join(', ')}` : '',
              ]
                .filter(Boolean)
                .join('; ')
        const inScope = !on && why !== undefined
        return (
          <button
            key={c.id}
            type="button"
            disabled={readOnly}
            aria-pressed={on}
            title={`${c.label}${c.regime !== null ? ` (${c.regime})` : ''}${c.description !== '' ? `: ${c.description}` : ''}${viaText !== '' ? `\nIn scope: ${viaText}` : ''}`}
            onClick={() => onChange(on ? value.filter((x) => x !== c.id) : [...value, c.id])}
            className={cn(
              'rounded-md border px-1.5 py-0.5 text-[11px] disabled:cursor-default',
              on ? 'border-[var(--hx-rose)] bg-[color-mix(in_oklab,var(--hx-rose)_18%,transparent)] font-medium' : inScope ? 'border-dashed border-[var(--hx-rose)] text-foreground' : 'text-muted-foreground hover:bg-accent/60',
            )}
          >
            {c.label}
            {inScope && <span className="ml-1 text-[9.5px] text-muted-foreground">in scope</span>}
          </button>
        )
      })}
      {unknown.map((u) => (
        <span key={u} className="rounded-md border border-[var(--hx-warn)] px-1.5 py-0.5 text-[11px]" title="Not in the data-class catalog">
          {u}?
        </span>
      ))}
    </div>
  )
}

export function PhasePicker({ value, readOnly, onChange, compact = false }: { value: string | null; readOnly: boolean; onChange: (v: string | null) => void; compact?: boolean }): React.JSX.Element {
  const model = useModel()
  const phases = phasesInOrder(model.meta)
  const label = value === null ? 'No phase' : (phases.find((p) => p.id === value)?.name ?? `${value} (missing)`)
  if (readOnly) return <span className={cn('text-xs', value === null && 'text-muted-foreground')}>{label}</span>
  if (phases.length === 0 && value === null) return compact ? <span className="text-muted-foreground">—</span> : <span className="text-[11px] text-muted-foreground">Add roadmap phases in Project settings.</span>
  return (
    <select
      aria-label="Roadmap phase"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      className={cn('w-full rounded-md border text-xs', compact ? 'h-6 border-transparent bg-transparent hover:border-input' : 'h-7 border-input bg-background px-1')}
    >
      <option value="">No phase</option>
      {phases.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {p.target !== null ? ` · ${p.target}` : ''}
        </option>
      ))}
      {value !== null && !phases.some((p) => p.id === value) && <option value={value}>{label}</option>}
    </select>
  )
}

/** Working notes in markdown: write, or read the rendered version. */
export function NotesEditor({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (v: string) => void }): React.JSX.Element {
  const [preview, setPreview] = useState(readOnly || value !== '')
  if (readOnly) return value === '' ? <p className="text-xs text-muted-foreground">No notes.</p> : <div className="text-xs selectable"><Markdown text={value} /></div>
  return (
    <div>
      <div className="mb-1 flex justify-end">
        <button type="button" onClick={() => setPreview(!preview)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
          {preview ? <Pencil className="size-3" /> : <Eye className="size-3" />}
          {preview ? 'Edit' : 'Preview'}
        </button>
      </div>
      {preview && value !== '' ? (
        <div className="cursor-text rounded-md border border-transparent p-1 text-xs hover:border-input" onDoubleClick={() => setPreview(false)}>
          <Markdown text={value} />
        </div>
      ) : (
        <TextArea value={value} rows={4} placeholder="Working notes: gotchas, TODOs, links, who to ask. Markdown. Not included in exports unless you ask." readOnly={false} onChange={onChange} />
      )}
    </div>
  )
}
