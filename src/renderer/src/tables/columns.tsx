// Column definitions for every table. Editable cells commit the same ops as the inspector (so undo works); in Docs
// mode, or for derived values, they render as text.
import type { CellContext, ColumnDef, Row } from '@tanstack/react-table'
import { ChevronRight, LocateFixed, Sparkles, StickyNote, Wrench } from 'lucide-react'
import type { Problem } from '@shared/model/lint.ts'
import { quickFix } from '@shared/model/quickfix.ts'
import { resolveWithAi } from '../ai/resolve.ts'
import { useEffect, useState } from 'react'
import { KIND_INFO } from '@shared/model/kinds.ts'
import type { Op } from '@shared/model/ops.ts'
import { FEATURE_CATEGORIES, NODE_KINDS, SENSITIVITIES, STATUSES } from '@shared/model/schema.ts'
import type { Model, Status } from '@shared/model/schema.ts'
import { cn } from '../lib/cn.ts'
import { edit } from '../state/actions.ts'
import { STATUS_COLOR } from '../canvas/lensMarks.ts'
import { STATUS_LABEL } from '../panels/inspector/NodeInspector.tsx'
import { PhasePicker, TeamPicker } from '../panels/inspector/governance.tsx'
import type { ChangeRow, ConnectorRow, DataRow, EndpointRow, ProblemRow, ServiceRow } from './rows.ts'
import { openFiltered } from './tableStore.ts'

export interface ColumnCtx {
  model: Model
  editable: boolean
  showOnCanvas: (kind: 'node' | 'connector', id: string) => void
}

const commit = (ops: Op[], label: string): void => void edit(ops, { label })

// ---- cells -------------------------------------------------------------------------------------------------

function SelectCell<V extends string>({ value, options, labels, editable, onCommit }: { value: V; options: readonly V[]; labels?: Partial<Record<V, string>>; editable: boolean; onCommit: (v: V) => void }): React.JSX.Element {
  if (!editable) return <span>{labels?.[value] ?? value}</span>
  return (
    <select
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onCommit(e.target.value as V)}
      className="h-6 max-w-full rounded border border-transparent bg-transparent px-0.5 text-xs hover:border-input focus:border-ring"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {labels?.[o] ?? o}
        </option>
      ))}
    </select>
  )
}

function TextCell({ value, editable, onCommit, placeholder }: { value: string; editable: boolean; onCommit: (v: string) => void; placeholder?: string }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  if (!editable) return <span>{value}</span>
  return (
    <input
      value={draft}
      placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') setDraft(value)
      }}
      className="h-6 w-full min-w-16 rounded border border-transparent bg-transparent px-1 text-xs outline-none hover:border-input focus:border-ring"
    />
  )
}

function StatusDot({ status }: { status: Status }): React.JSX.Element {
  return <span className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ background: STATUS_COLOR[status] }} />
}

function StatusCell({ status, editable, onCommit }: { status: Status; editable: boolean; onCommit: (s: Status) => void }): React.JSX.Element {
  return (
    <span className="inline-flex items-center">
      <StatusDot status={status} />
      <SelectCell value={status} options={STATUSES} labels={STATUS_LABEL} editable={editable} onCommit={onCommit} />
    </span>
  )
}

/** Stops row clicks from firing when a cell control is used. */
function Stop({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  )
}

function CountLink({ n, onOpen, title }: { n: number; onOpen: () => void; title: string }): React.JSX.Element {
  if (n === 0) return <span className="text-muted-foreground">0</span>
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      className="rounded px-1 text-primary hover:bg-primary/10 hover:underline"
    >
      {n}
    </button>
  )
}

function ShowButton({ onShow }: { onShow: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label="Show on canvas"
      title="Show on canvas"
      onClick={(e) => {
        e.stopPropagation()
        onShow()
      }}
      className="invisible rounded p-0.5 text-muted-foreground group-hover:visible hover:bg-accent hover:text-foreground"
    >
      <LocateFixed className="size-3.5" />
    </button>
  )
}

const selectColumn = <T,>(): ColumnDef<T, unknown> => ({
  id: 'select',
  header: ({ table }) => (
    <input
      type="checkbox"
      aria-label="Select all rows"
      checked={table.getIsAllRowsSelected()}
      ref={(el) => {
        if (el !== null) el.indeterminate = table.getIsSomeRowsSelected()
      }}
      onChange={table.getToggleAllRowsSelectedHandler()}
    />
  ),
  cell: ({ row }) => (
    <input type="checkbox" aria-label="Select row" checked={row.getIsSelected()} onClick={(e) => e.stopPropagation()} onChange={row.getToggleSelectedHandler()} />
  ),
  enableSorting: false,
  enableColumnFilter: false,
  enableGrouping: false,
  enableHiding: false,
  meta: { width: 28 },
})

const showColumn = <T,>(onShow: (row: T) => void): ColumnDef<T, unknown> => ({
  id: 'show',
  header: '',
  cell: ({ row }) => <ShowButton onShow={() => onShow(row.original)} />,
  enableSorting: false,
  enableColumnFilter: false,
  enableGrouping: false,
  enableHiding: false,
  meta: { width: 30 },
})

// ---- services ----------------------------------------------------------------------------------------------

function NameCell({ row }: { row: Row<ServiceRow> }): React.JSX.Element {
  const r = row.original
  return (
    <span className="flex items-center gap-1" style={{ paddingLeft: row.depth * 14 }}>
      {row.getCanExpand() ? (
        <button
          type="button"
          aria-label={row.getIsExpanded() ? `Collapse ${r.name}` : `Expand ${r.name}`}
          onClick={(e) => {
            e.stopPropagation()
            row.toggleExpanded()
          }}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', row.getIsExpanded() && 'rotate-90')} />
        </button>
      ) : (
        <span className="w-[18px]" />
      )}
      <span className="truncate font-medium">{r.name}</span>
      {r.notes.trim() !== '' && (
        <span title={r.notes.slice(0, 300)}>
          <StickyNote className="size-3 shrink-0 text-muted-foreground" />
        </span>
      )}
    </span>
  )
}

const KIND_LABELS = Object.fromEntries(NODE_KINDS.map((k) => [k, KIND_INFO[k].label])) as Record<(typeof NODE_KINDS)[number], string>

export function serviceColumns(c: ColumnCtx): ColumnDef<ServiceRow, unknown>[] {
  const up = (id: string, patch: Record<string, unknown>, label: string): void => commit([{ op: 'updateNode', id, patch }], label)
  return [
    selectColumn<ServiceRow>(),
    { id: 'name', accessorKey: 'name', header: 'Name', cell: ({ row }) => <NameCell row={row} />, enableGrouping: false, meta: { width: 240, sticky: true } },
    {
      id: 'kind',
      accessorKey: 'kindLabel',
      header: 'Kind',
      cell: ({ row }) => <SelectCell value={row.original.kind as (typeof NODE_KINDS)[number]} options={NODE_KINDS} labels={KIND_LABELS} editable={c.editable} onCommit={(kind) => up(row.original.id, { kind }, 'set kind')} />,
      meta: { width: 120 },
    },
    { id: 'status', accessorKey: 'status', header: 'Status', cell: ({ row }) => <StatusCell status={row.original.status} editable={c.editable} onCommit={(status) => up(row.original.id, { status }, 'set status')} />, meta: { width: 130 } },
    {
      id: 'team',
      accessorKey: 'team',
      header: 'Team',
      cell: ({ row }) =>
        c.editable ? (
          <Stop>
            <TeamPicker compact value={row.original.teamId} inherited={row.original.teamInherited ? row.original.team : null} readOnly={false} onChange={(t, pre) => commit([...pre, { op: 'updateNode', id: row.original.id, patch: { team: t } }], 'set team')} />
          </Stop>
        ) : (
          <span className={cn(row.original.teamInherited && 'text-muted-foreground italic')}>{row.original.team}</span>
        ),
      meta: { width: 140 },
    },
    { id: 'owner', accessorKey: 'owner', header: 'Owner', cell: ({ row }) => <Stop><TextCell value={row.original.owner} editable={c.editable} onCommit={(v) => up(row.original.id, { owner: v.trim() === '' ? null : v }, 'set owner')} /></Stop>, meta: { width: 120 } },
    { id: 'data', accessorKey: 'data', header: 'Data', cell: ({ getValue }) => <span className="text-[var(--hx-rose)]">{String(getValue())}</span>, meta: { width: 120 } },
    {
      id: 'sensitivity',
      accessorKey: 'sensitivity',
      header: 'Sensitivity',
      cell: ({ row }) => (
        <SelectCell
          value={(row.original.sensitivity || 'unset') as 'unset' | (typeof SENSITIVITIES)[number]}
          options={['unset', ...SENSITIVITIES] as const}
          labels={{ unset: '—' }}
          editable={c.editable}
          onCommit={(v) => up(row.original.id, { sensitivity: v === 'unset' ? null : v }, 'set sensitivity')}
        />
      ),
      meta: { width: 110 },
    },
    {
      id: 'phase',
      accessorKey: 'phase',
      header: 'Phase',
      cell: ({ row }) => (c.editable ? <Stop><PhasePicker compact value={row.original.phaseId} readOnly={false} onChange={(phase) => up(row.original.id, { phase }, 'set phase')} /></Stop> : <span>{row.original.phase}</span>),
      meta: { width: 130 },
    },
    { id: 'hosting', accessorKey: 'hosting', header: 'Hosting', meta: { width: 90 } },
    { id: 'provider', accessorKey: 'provider', header: 'Provider', cell: ({ row }) => <Stop><TextCell value={row.original.provider} editable={c.editable} onCommit={(v) => up(row.original.id, { provider: v.trim() === '' ? null : v }, 'set provider')} /></Stop>, meta: { width: 110 } },
    { id: 'region', accessorKey: 'region', header: 'Region', meta: { width: 90 } },
    { id: 'tech', accessorKey: 'tech', header: 'Tech', cell: ({ row }) => <Stop><TextCell value={row.original.tech} editable={c.editable} onCommit={(v) => up(row.original.id, { techStack: v.trim() === '' ? null : v }, 'set tech stack')} /></Stop>, meta: { width: 130 } },
    { id: 'boundary', accessorKey: 'boundary', header: 'Boundary', meta: { width: 80 } },
    { id: 'features', accessorKey: 'features', header: 'Features', meta: { width: 70, align: 'right' }, enableColumnFilter: false },
    {
      id: 'inbound',
      accessorKey: 'inbound',
      header: 'In',
      cell: ({ row }) => <CountLink n={row.original.inbound} title="Connectors into it" onOpen={() => openFiltered('connectors', 'target', row.original.path)} />,
      meta: { width: 50, align: 'right' },
      enableColumnFilter: false,
    },
    {
      id: 'outbound',
      accessorKey: 'outbound',
      header: 'Out',
      cell: ({ row }) => <CountLink n={row.original.outbound} title="Connectors out of it" onOpen={() => openFiltered('connectors', 'source', row.original.path)} />,
      meta: { width: 50, align: 'right' },
      enableColumnFilter: false,
    },
    {
      id: 'problems',
      accessorKey: 'problems',
      header: 'Problems',
      cell: ({ row }) => <CountLink n={row.original.problems} title="Its problems" onOpen={() => openFiltered('problems', 'entityName', row.original.name)} />,
      meta: { width: 70, align: 'right' },
      enableColumnFilter: false,
    },
    { id: 'notes', accessorKey: 'notes', header: 'Notes', cell: ({ getValue }) => <span className="text-muted-foreground">{String(getValue()).split('\n')[0]}</span>, meta: { width: 220 } },
    showColumn<ServiceRow>((r) => c.showOnCanvas('node', r.id)),
  ]
}

// ---- connectors --------------------------------------------------------------------------------------------

export function connectorColumns(c: ColumnCtx): ColumnDef<ConnectorRow, unknown>[] {
  const conn = (id: string) => c.model.connectors[id]
  const up = (id: string, patch: Record<string, unknown>, label: string): void => commit([{ op: 'updateConnector', id, patch }], label)
  const setA = (id: string, k: string, v: string | null, label: string): void => {
    const cur = conn(id)
    if (cur !== undefined) up(id, { channelA: { ...cur.channelA, [k]: v } }, label)
  }
  return [
    selectColumn<ConnectorRow>(),
    { id: 'source', accessorKey: 'source', header: 'From', meta: { width: 200, sticky: true } },
    { id: 'target', accessorKey: 'target', header: 'To', meta: { width: 200 } },
    { id: 'protocol', accessorKey: 'protocol', header: 'Protocol', cell: ({ row }) => <Stop><TextCell value={row.original.protocol} editable={c.editable} onCommit={(v) => v.trim() !== '' && setA(row.original.id, 'protocol', v, 'set protocol')} /></Stop>, meta: { width: 110 } },
    { id: 'returnProtocol', accessorKey: 'returnProtocol', header: 'Return', meta: { width: 90 } },
    { id: 'sync', accessorKey: 'sync', header: 'Mode', cell: ({ row }) => <SelectCell value={row.original.sync as 'sync' | 'async'} options={['sync', 'async'] as const} editable={c.editable} onCommit={(sync) => up(row.original.id, { sync }, 'set mode')} />, meta: { width: 80 } },
    { id: 'auth', accessorKey: 'auth', header: 'Auth', cell: ({ row }) => <Stop><TextCell value={row.original.auth} placeholder="none" editable={c.editable} onCommit={(v) => setA(row.original.id, 'auth', v.trim() === '' ? null : v, 'set auth')} /></Stop>, meta: { width: 120 } },
    { id: 'encrypted', accessorKey: 'encrypted', header: 'Encrypted', cell: ({ getValue }) => <span className={cn(getValue() === 'no' && 'text-[var(--hx-warn)]')}>{String(getValue())}</span>, meta: { width: 80 } },
    { id: 'data', accessorKey: 'data', header: 'Data', cell: ({ getValue }) => <span className="text-[var(--hx-rose)]">{String(getValue())}</span>, meta: { width: 110 } },
    { id: 'status', accessorKey: 'status', header: 'Status', cell: ({ row }) => <StatusCell status={row.original.status} editable={c.editable} onCommit={(status) => up(row.original.id, { status }, 'set status')} />, meta: { width: 130 } },
    {
      id: 'team',
      accessorKey: 'team',
      header: 'Team',
      cell: ({ row }) => (c.editable ? <Stop><TeamPicker compact value={row.original.teamId} readOnly={false} onChange={(t, pre) => commit([...pre, { op: 'updateConnector', id: row.original.id, patch: { team: t } }], 'set team')} /></Stop> : <span>{row.original.team}</span>),
      meta: { width: 130 },
    },
    {
      id: 'phase',
      accessorKey: 'phase',
      header: 'Phase',
      cell: ({ row }) => (c.editable ? <Stop><PhasePicker compact value={row.original.phaseId} readOnly={false} onChange={(phase) => up(row.original.id, { phase }, 'set phase')} /></Stop> : <span>{row.original.phase}</span>),
      meta: { width: 130 },
    },
    { id: 'notes', accessorKey: 'notes', header: 'Notes', cell: ({ getValue }) => <span className="text-muted-foreground">{String(getValue()).split('\n')[0]}</span>, meta: { width: 200 } },
    showColumn<ConnectorRow>((r) => c.showOnCanvas('connector', r.id)),
  ]
}

// ---- endpoints ---------------------------------------------------------------------------------------------

export function endpointColumns(c: ColumnCtx): ColumnDef<EndpointRow, unknown>[] {
  const upFeature = (r: EndpointRow, patch: Record<string, unknown>, label: string): void => {
    const n = c.model.nodes[r.nodeId]
    if (n === undefined) return
    commit([{ op: 'updateNode', id: n.id, patch: { features: n.features.map((f) => (f.id === r.featureId ? { ...f, ...patch } : f)) } }], label)
  }
  return [
    selectColumn<EndpointRow>(),
    { id: 'service', accessorKey: 'service', header: 'Service', meta: { width: 200, sticky: true } },
    { id: 'name', accessorKey: 'name', header: 'Feature', cell: ({ row }) => <Stop><TextCell value={row.original.name} editable={c.editable} onCommit={(name) => name.trim() !== '' && upFeature(row.original, { name }, 'rename feature')} /></Stop>, meta: { width: 170 } },
    {
      id: 'category',
      accessorKey: 'category',
      header: 'Category',
      cell: ({ row }) => <SelectCell value={row.original.category as (typeof FEATURE_CATEGORIES)[number]} options={FEATURE_CATEGORIES} editable={c.editable} onCommit={(category) => upFeature(row.original, { category }, 'set category')} />,
      meta: { width: 100 },
    },
    { id: 'protocol', accessorKey: 'protocol', header: 'Protocol', cell: ({ row }) => <Stop><TextCell value={row.original.protocol} editable={c.editable} onCommit={(v) => upFeature(row.original, { protocol: v.trim() === '' ? null : v }, 'set protocol')} /></Stop>, meta: { width: 100 } },
    {
      id: 'endpoint',
      accessorKey: 'endpoint',
      header: 'Endpoint',
      cell: ({ row }) => (
        <Stop>
          <span className="font-mono">
            <TextCell value={row.original.endpoint} placeholder="POST /v1/…" editable={c.editable} onCommit={(v) => upFeature(row.original, { endpoint: v.trim() === '' ? null : v }, 'set endpoint')} />
          </span>
        </Stop>
      ),
      meta: { width: 260 },
    },
    { id: 'status', accessorKey: 'status', header: 'Status', cell: ({ row }) => <StatusCell status={row.original.status} editable={c.editable} onCommit={(status) => upFeature(row.original, { status }, 'set status')} />, meta: { width: 130 } },
    { id: 'phase', accessorKey: 'phase', header: 'Phase', cell: ({ row }) => (c.editable ? <Stop><PhasePicker compact value={row.original.phaseId} readOnly={false} onChange={(phase) => upFeature(row.original, { phase }, 'set phase')} /></Stop> : <span>{row.original.phase}</span>), meta: { width: 130 } },
    { id: 'sla', accessorKey: 'sla', header: 'SLA', meta: { width: 160 } },
    { id: 'contract', accessorKey: 'contract', header: 'Contract', meta: { width: 90 } },
    showColumn<EndpointRow>((r) => c.showOnCanvas('node', r.nodeId)),
  ]
}

// ---- data, changes, problems (read-only lists; click to inspect) -------------------------------------------

export function dataColumns(c: ColumnCtx): ColumnDef<DataRow, unknown>[] {
  return [
    { id: 'dataClass', accessorKey: 'dataClass', header: 'Data', cell: ({ getValue }) => <span className="font-medium text-[var(--hx-rose)]">{String(getValue())}</span>, meta: { width: 120, sticky: true } },
    { id: 'regime', accessorKey: 'regime', header: 'Regime', meta: { width: 110 } },
    { id: 'name', accessorKey: 'name', header: 'Where', meta: { width: 300 } },
    { id: 'how', accessorKey: 'how', header: 'How', meta: { width: 170 } },
    { id: 'encrypted', accessorKey: 'encrypted', header: 'Encrypted', cell: ({ getValue }) => <span className={cn(getValue() === 'no' && 'font-medium text-[var(--hx-bad)]')}>{String(getValue())}</span>, meta: { width: 80 } },
    { id: 'zone', accessorKey: 'zone', header: 'Zone', cell: ({ getValue }) => <span className={cn(String(getValue()).startsWith('outside') && 'font-medium text-[var(--hx-bad)]')}>{String(getValue())}</span>, meta: { width: 180 } },
    showColumn<DataRow>((r) => c.showOnCanvas(r.entity, r.entityId)),
  ]
}

export function changeColumns(c: ColumnCtx): ColumnDef<ChangeRow, unknown>[] {
  const setPhase = (r: ChangeRow, phase: string | null): void => {
    if (r.entity === 'node') commit([{ op: 'updateNode', id: r.entityId, patch: { phase } }], 'set phase')
    else if (r.entity === 'connector') commit([{ op: 'updateConnector', id: r.entityId, patch: { phase } }], 'set phase')
    else {
      const n = r.nodeId === null ? undefined : c.model.nodes[r.nodeId]
      if (n !== undefined) commit([{ op: 'updateNode', id: n.id, patch: { features: n.features.map((f) => (f.id === r.entityId ? { ...f, phase } : f)) } }], 'set phase')
    }
  }
  return [
    selectColumn<ChangeRow>(),
    { id: 'phase', accessorKey: 'phase', header: 'Phase', cell: ({ row }) => (c.editable ? <Stop><PhasePicker compact value={row.original.phaseId} readOnly={false} onChange={(p) => setPhase(row.original, p)} /></Stop> : <span>{row.original.phase || 'No phase'}</span>), sortingFn: (a, b) => a.original.phaseOrder - b.original.phaseOrder, meta: { width: 140, sticky: true } },
    { id: 'change', accessorKey: 'change', header: 'Change', meta: { width: 80 } },
    { id: 'name', accessorKey: 'name', header: 'What', meta: { width: 320 } },
    { id: 'what', accessorKey: 'what', header: 'Kind', meta: { width: 140 } },
    { id: 'status', accessorKey: 'status', header: 'Status', cell: ({ row }) => <span><StatusDot status={row.original.status} />{STATUS_LABEL[row.original.status]}</span>, meta: { width: 110 } },
    { id: 'issues', accessorKey: 'issues', header: 'Tracked', cell: ({ row }) => <span className={row.original.tracked ? '' : 'text-muted-foreground'}>{row.original.issues}</span>, meta: { width: 130 } },
    showColumn<ChangeRow>((r) => (r.entity === 'connector' ? c.showOnCanvas('connector', r.entityId) : c.showOnCanvas('node', r.nodeId ?? r.entityId))),
  ]
}

const SEV_COLOR = { error: 'var(--hx-bad)', warn: 'var(--hx-warn)', info: 'var(--hx-blue)' } as const

export function problemColumns(c: ColumnCtx): ColumnDef<ProblemRow & { entityName: string }, unknown>[] {
  return [
    {
      id: 'severity',
      accessorKey: 'severity',
      header: 'Severity',
      cell: ({ getValue }: CellContext<ProblemRow & { entityName: string }, unknown>) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: SEV_COLOR[getValue() as ProblemRow['severity']] }} />
          {String(getValue())}
        </span>
      ),
      meta: { width: 90, sticky: true },
    },
    { id: 'entityName', accessorKey: 'entityName', header: 'Where', meta: { width: 220 } },
    { id: 'message', accessorKey: 'message', header: 'Problem', meta: { width: 520 } },
    { id: 'code', accessorKey: 'code', header: 'Check', meta: { width: 150 } },
    ...(c.editable
      ? [
          {
            id: 'fix',
            header: '',
            cell: ({ row }: CellContext<ProblemRow & { entityName: string }, unknown>) => <FixCell model={c.model} problem={row.original.problem} />,
            enableSorting: false,
            enableColumnFilter: false,
            enableGrouping: false,
            enableHiding: false,
            meta: { width: 64 },
          },
        ]
      : []),
    showColumn<ProblemRow & { entityName: string }>((r) => {
      if (r.entity === 'node' && r.entityId !== null) c.showOnCanvas('node', r.entityId)
      if (r.entity === 'connector' && r.entityId !== null) c.showOnCanvas('connector', r.entityId)
    }),
  ]
}

/** A problem's one-click fix (when it needs no judgement) and its AI fix. */
function FixCell({ model, problem }: { model: Model; problem: Problem }): React.JSX.Element {
  const fix = quickFix(model, problem)
  return (
    <span className="flex items-center gap-0.5">
      {fix !== null && (
        <button type="button" title={`${fix.label} (no AI)`} aria-label={fix.label} onClick={(e) => (e.stopPropagation(), commit(fix.ops, fix.label.toLowerCase()))} className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
          <Wrench className="size-3.5" />
        </button>
      )}
      <button type="button" title="Resolve with AI" aria-label={`Resolve with AI: ${problem.message}`} onClick={(e) => (e.stopPropagation(), resolveWithAi([problem]))} className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-primary">
        <Sparkles className="size-3.5" />
      </button>
    </span>
  )
}
