// The Tables view: the same project as rows. Services (a tree you can drill into), connectors, endpoints, data
// handling, planned changes and problems, plus a services × services dependency matrix; sort, filter, group, pick columns, edit inline or in bulk, save the setup
// as a named table view, export CSV or Markdown, and jump to any row on the canvas.
import type { Table } from '@tanstack/react-table'
import { DropdownMenu } from 'radix-ui'
import { Bookmark, Columns3, Download, Search, Sparkles, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SavedTable, TableTab } from '@shared/ipc.ts'
import { TABLE_TABS } from '@shared/ipc.ts'
import { dataClassCatalog, phasesInOrder } from '@shared/model/governance.ts'
import { uniqueId } from '@shared/model/ids.ts'
import { lintModel } from '@shared/model/lint.ts'
import type { Problem } from '@shared/model/lint.ts'
import { resolveWithAi } from '../ai/resolve.ts'
import { AI_NOTE_SHORT } from '../ai/AiNote.tsx'
import type { Op } from '@shared/model/ops.ts'
import { STATUSES } from '@shared/model/schema.ts'
import type { Status } from '@shared/model/schema.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { invoke } from '../ipc/client.ts'
import { edit, select, toast } from '../state/actions.ts'
import { setUi, useStore } from '../state/store.ts'
import { useModel } from '../canvas/useScene.ts'
import { reveal } from '../panels/ArchitectureTree.tsx'
import { STATUS_LABEL } from '../panels/inspector/NodeInspector.tsx'
import { changeColumns, connectorColumns, dataColumns, endpointColumns, problemColumns, serviceColumns } from './columns.tsx'
import type { ColumnCtx } from './columns.tsx'
import { DataTable } from './DataTable.tsx'
import { cellText, changeRows, dependencyMatrix, connectorRows, dataRows, endpointRows, problemRows, serviceRows, toCsv, toMarkdown } from './rows.ts'
import { DependencyMatrixView } from './MatrixView.tsx'
import { applySaved, patchTab, setTab, toSaved, useTables } from './tableStore.ts'
import type { ViewTab } from './tableStore.ts'
import { trackWithAi, untracked } from '../ai/track.ts'

const TAB_LABEL: Record<ViewTab, string> = { services: 'Services', connectors: 'Connectors', endpoints: 'Endpoints', data: 'Data', changes: 'Changes', problems: 'Problems', matrix: 'Matrix' }
const VIEW_TABS: readonly ViewTab[] = [...TABLE_TABS, 'matrix']

export function showOnCanvas(kind: 'node' | 'connector', id: string): void {
  const m = useStore.getState().project?.model
  if (m === undefined) return
  if (useStore.getState().ui.view === 'tables') setUi({ view: 'split' })
  if (kind === 'node') reveal(m, id)
  else {
    const c = m.connectors[id]
    if (c === undefined) return
    reveal(m, c.source)
    setTimeout(() => select({ kind: 'connector', ids: [id] }), 100)
  }
}

export function TablesView(): React.JSX.Element {
  const model = useModel()
  const tab = useTables((s) => s.tab)
  const editable = useStore((s) => s.ui.mode === 'edit')
  const selection = useStore((s) => s.ui.selection)
  const featureId = useStore((s) => s.ui.featureId)
  const problems = useMemo(() => lintModel(model), [model])
  const ctx: ColumnCtx = { model, editable, showOnCanvas }
  // The live table of the open tab (the toolbar reads its columns and rows).
  const [table, setTable] = useState<Table<{ id: string }> | null>(null)
  const onTable = useCallback(<T,>(t: Table<T>): void => setTable(t as unknown as Table<{ id: string }>), [])
  const sel = (kind: 'node' | 'connector' | 'boundary', id: string): boolean => selection?.kind === kind && selection.ids.includes(id)
  const selectEntity = (kind: 'node' | 'connector' | 'boundary', id: string): void => select({ kind, ids: [id] })

  const rows = useMemo(
    () => ({
      services: serviceRows(model, problems),
      connectors: connectorRows(model),
      endpoints: endpointRows(model),
      data: dataRows(model),
      changes: changeRows(model),
    }),
    [model, problems],
  )
  const matrixInner = useTables((s) => s.matrixInner)
  const matrix = useMemo(() => dependencyMatrix(model, problems, matrixInner), [model, problems, matrixInner])
  const counts: Record<ViewTab, number> = {
    services: Object.keys(model.nodes).length,
    connectors: rows.connectors.length,
    endpoints: rows.endpoints.length,
    data: rows.data.length,
    changes: rows.changes.length,
    problems: problems.length,
    matrix: Object.keys(matrix.cells).length,
  }

  let body: React.ReactNode
  switch (tab) {
    case 'services':
      body = (
        <DataTable
          tab={tab}
          data={rows.services}
          columns={serviceColumns(ctx)}
          isActive={(r) => sel('node', r.id)}
          onRowClick={(r) => selectEntity('node', r.id)}
          onRowDoubleClick={(r, row) => (row.getCanExpand() ? row.toggleExpanded() : showOnCanvas('node', r.id))}
          onTable={onTable}
        />
      )
      break
    case 'connectors':
      body = <DataTable tab={tab} data={rows.connectors} columns={connectorColumns(ctx)} isActive={(r) => sel('connector', r.id)} onRowClick={(r) => selectEntity('connector', r.id)} onRowDoubleClick={(r) => showOnCanvas('connector', r.id)} onTable={onTable} />
      break
    case 'endpoints':
      body = (
        <DataTable
          tab={tab}
          data={rows.endpoints}
          columns={endpointColumns(ctx)}
          isActive={(r) => sel('node', r.nodeId) && featureId === r.featureId}
          onRowClick={(r) => {
            select({ kind: 'node', ids: [r.nodeId] })
            setUi({ featureId: r.featureId })
          }}
          onRowDoubleClick={(r) => showOnCanvas('node', r.nodeId)}
          onTable={onTable}
        />
      )
      break
    case 'data':
      body = <DataTable tab={tab} data={rows.data} columns={dataColumns(ctx)} isActive={(r) => sel(r.entity, r.entityId)} onRowClick={(r) => selectEntity(r.entity, r.entityId)} onRowDoubleClick={(r) => showOnCanvas(r.entity, r.entityId)} onTable={onTable} />
      break
    case 'changes':
      body = (
        <DataTable
          tab={tab}
          data={rows.changes}
          columns={changeColumns(ctx)}
          isActive={(r) => (r.entity === 'connector' ? sel('connector', r.entityId) : sel('node', r.nodeId ?? r.entityId))}
          onRowClick={(r) => {
            if (r.entity === 'connector') selectEntity('connector', r.entityId)
            else {
              select({ kind: 'node', ids: [r.nodeId ?? r.entityId] })
              if (r.entity === 'feature') setUi({ featureId: r.entityId })
            }
          }}
          onRowDoubleClick={(r) => (r.entity === 'connector' ? showOnCanvas('connector', r.entityId) : showOnCanvas('node', r.nodeId ?? r.entityId))}
          onTable={onTable}
        />
      )
      break
    case 'problems': {
      const name = (k: string, id: string | null): string => {
        if (id === null) return model.meta.name
        if (k === 'node') return model.nodes[id]?.name ?? id
        if (k === 'connector') {
          const c = model.connectors[id]
          return c === undefined ? id : `${model.nodes[c.source]?.name ?? c.source} → ${model.nodes[c.target]?.name ?? c.target}`
        }
        if (k === 'boundary') return model.boundaries[id]?.name ?? id
        return model.flows[id]?.name ?? id
      }
      body = (
        <DataTable
          tab={tab}
          data={problemRows(problems).map((p) => ({ ...p, entityName: name(p.entity, p.entityId) }))}
          columns={problemColumns(ctx)}
          isActive={(r) => r.entityId !== null && (r.entity === 'node' || r.entity === 'connector' || r.entity === 'boundary') && sel(r.entity, r.entityId)}
          onRowClick={(r) => {
            if (r.entityId !== null && (r.entity === 'node' || r.entity === 'connector' || r.entity === 'boundary')) selectEntity(r.entity, r.entityId)
          }}
          onRowDoubleClick={(r) => {
            if (r.entityId !== null && (r.entity === 'node' || r.entity === 'connector')) showOnCanvas(r.entity, r.entityId)
          }}
          onTable={onTable}
        />
      )
      break
    }
    case 'matrix':
      body = <DependencyMatrixView matrix={matrix} inner={matrixInner} selected={selection?.kind === 'connector' ? selection.ids : []} onOpen={(id) => showOnCanvas('connector', id)} />
      break
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-popover">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <div role="tablist" aria-label="Tables" className="flex items-center gap-0.5">
          {VIEW_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs', tab === t ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {TAB_LABEL[t]}
              <span className="rounded bg-background/70 px-1 font-mono text-[10px] tabular-nums">{counts[t]}</span>
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {tab !== 'matrix' && <Toolbar tab={tab} table={table} />}
      </div>
      {tab !== 'matrix' && <BulkBar tab={tab} editable={editable} />}
      <div key={tab} className="flex min-h-0 flex-1 flex-col">
        {body}
      </div>
    </div>
  )
}

function Toolbar({ tab, table }: { tab: TableTab; table: Table<{ id: string }> | null }): React.JSX.Element {
  const s = useTables((x) => x.byTab[tab])
  const editable = useStore((x) => x.ui.mode === 'edit')
  const [saved, setSaved] = useState<SavedTable[]>([])
  const refresh = (): void => {
    void invoke('collection.list', { kind: 'tables' }).then((r) => r.ok && setSaved(r.value as SavedTable[]))
  }
  useEffect(refresh, [])

  const columns = table?.getAllLeafColumns().filter((c) => c.getCanHide()) ?? []
  const groupable = table?.getAllLeafColumns().filter((c) => c.getCanGroup() && c.id !== 'select' && c.id !== 'show') ?? []

  const exportAs = async (format: 'csv' | 'md'): Promise<void> => {
    const t = table
    if (t === null) return
    const cols = t.getVisibleLeafColumns().filter((c) => c.id !== 'select' && c.id !== 'show')
    const header = cols.map((c) => (typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id))
    // Every matching row, flattened (tree rows included), not just what is on screen.
    const flat = t.getFilteredRowModel().flatRows
    const rows = flat.map((r) => cols.map((c) => cellText(r.getValue(c.id))))
    const content = format === 'csv' ? toCsv(header, rows) : toMarkdown(header, rows)
    const r = await invoke('export.save', { filename: `${tab}.${format}`, content })
    if (!r.ok) toast(r.error.message, 'error')
    else if (r.value !== null) toast(`Saved ${r.value}`, 'info')
  }

  const saveView = async (): Promise<void> => {
    const name = window.prompt('Name this table view', `${TAB_LABEL[tab]} view`)
    if (name === null || name.trim() === '') return
    const id = uniqueId(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'table', (x) => saved.some((v) => v.id === x))
    const r = await invoke('collection.put', { kind: 'tables', item: toSaved(id, name.trim(), tab, s) })
    if (!r.ok) toast(r.error.message, 'error')
    refresh()
  }

  const menu = 'z-50 min-w-48 rounded-lg border bg-popover p-1 text-xs shadow-lg'
  const item = 'flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-accent'
  // Problems: hand what the table shows (after search and filters) to the AI.
  const model = useModel()
  const untrackedWork = tab === 'changes' ? untracked(model, changeRows(model).map((r) => ({ kind: r.entity, id: r.entityId, ...(r.nodeId !== null && r.entity === 'feature' ? { nodeId: r.nodeId } : {}) }))) : []
  const shownProblems = tab === 'problems' && table !== null ? table.getFilteredRowModel().flatRows.map((r) => (r.original as { problem?: Problem }).problem).filter((p): p is Problem => p !== undefined) : []
  return (
    <div className="flex items-center gap-1.5">
      {tab === 'changes' && editable && untrackedWork.length > 0 && (
        <Button size="sm" variant="outline" icon={<Sparkles />} onClick={() => void trackWithAi(untrackedWork)} title={`Create issues in your tracker for planned work that has none, and link them. ${AI_NOTE_SHORT}`}>
          Create issues for untracked ({untrackedWork.length})
        </Button>
      )}
      {tab === 'problems' && editable && shownProblems.length > 0 && (
        <Button size="sm" variant="outline" icon={<Sparkles />} onClick={() => resolveWithAi(shownProblems)} title={`The AI checks the code for each problem shown, then proposes fixes. ${AI_NOTE_SHORT}`}>
          Resolve shown with AI ({shownProblems.length})
        </Button>
      )}
      <label className="relative flex items-center">
        <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
        <input
          value={s.search}
          onChange={(e) => patchTab(tab, { search: e.target.value })}
          placeholder="Search this table"
          aria-label="Search this table"
          className="h-7 w-44 rounded-md border bg-background pr-2 pl-7 text-xs outline-none focus:border-ring"
        />
      </label>
      {(s.filters.length > 0 || s.search !== '') && (
        <Button size="sm" variant="ghost" icon={<X />} onClick={() => patchTab(tab, { filters: [], search: '' })}>
          Clear filters
        </Button>
      )}
      <select
        aria-label="Group by"
        value={s.grouping[0] ?? ''}
        onChange={(e) => patchTab(tab, { grouping: e.target.value === '' ? [] : [e.target.value], expanded: true })}
        className="h-7 rounded-md border bg-background px-1.5 text-xs"
      >
        <option value="">No grouping</option>
        {groupable.map((c) => (
          <option key={c.id} value={c.id}>
            Group by {typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id}
          </option>
        ))}
      </select>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button size="sm" variant="outline" icon={<Columns3 />}>
            Columns
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className={menu}>
            {columns.map((c) => (
              <DropdownMenu.CheckboxItem key={c.id} checked={c.getIsVisible()} onSelect={(e) => e.preventDefault()} onCheckedChange={(v) => c.toggleVisibility(v)} className={item}>
                <span className="flex size-3.5 items-center justify-center rounded border">{c.getIsVisible() ? '✓' : ''}</span>
                {typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id}
              </DropdownMenu.CheckboxItem>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <DropdownMenu.Root onOpenChange={(o) => o && refresh()}>
        <DropdownMenu.Trigger asChild>
          <Button size="sm" variant="outline" icon={<Bookmark />}>
            Views
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className={menu}>
            {saved.length === 0 && <div className="px-2 py-1.5 text-muted-foreground">No saved table views yet.</div>}
            {saved.map((v) => (
              <DropdownMenu.Item key={v.id} onSelect={() => applySaved(v)} className={cn(item, 'group')}>
                <span className="flex-1">{v.name}</span>
                <span className="text-[10px] text-muted-foreground">{TAB_LABEL[v.tab]}</span>
                {editable && (
                  <button
                    type="button"
                    aria-label={`Delete ${v.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void invoke('collection.delete', { kind: 'tables', id: v.id }).then(refresh)
                    }}
                    className="invisible text-muted-foreground group-hover:visible hover:text-destructive"
                  >
                    <Trash2 className="size-3" />
                  </button>
                )}
              </DropdownMenu.Item>
            ))}
            {editable && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item onSelect={() => void saveView()} className={item}>
                  Save this setup as a view…
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button size="sm" variant="outline" icon={<Download />}>
            Export
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className={menu}>
            <DropdownMenu.Item onSelect={() => void exportAs('csv')} className={item}>
              CSV (matching rows, visible columns)…
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => void exportAs('md')} className={item}>
              Markdown table…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  )
}

/** Ticked rows: set team, phase, status or add a data class on all of them at once (one undo step). */
function BulkBar({ tab, editable }: { tab: TableTab; editable: boolean }): React.JSX.Element | null {
  const model = useModel()
  const selected = Object.keys(useTables((x) => x.byTab[tab].selected))
  if (!editable || selected.length === 0 || tab === 'data' || tab === 'problems') return null

  // Resolve ticked row ids to what they edit.
  const targets = selected.flatMap((rid): { kind: 'node' | 'connector' | 'feature'; id: string; nodeId?: string }[] => {
    if (tab === 'services') return model.nodes[rid] !== undefined ? [{ kind: 'node', id: rid }] : []
    if (tab === 'connectors') return model.connectors[rid] !== undefined ? [{ kind: 'connector', id: rid }] : []
    if (tab === 'endpoints') {
      const [nodeId, featureId] = rid.split('/')
      return nodeId !== undefined && featureId !== undefined ? [{ kind: 'feature', id: featureId, nodeId }] : []
    }
    const [k, a, b] = rid.split('/')
    if (k === 'n' && a !== undefined) return [{ kind: 'node', id: a }]
    if (k === 'c' && a !== undefined) return [{ kind: 'connector', id: a }]
    if (k === 'f' && a !== undefined && b !== undefined) return [{ kind: 'feature', id: b, nodeId: a }]
    return []
  })

  const apply = (field: 'team' | 'phase' | 'status' | 'dataClass', value: string | null, label: string): void => {
    const ops: Op[] = []
    const featurePatches = new Map<string, Map<string, Record<string, unknown>>>()
    for (const t of targets) {
      if (t.kind === 'feature') {
        if (field !== 'phase' && field !== 'status') continue
        const per = featurePatches.get(t.nodeId ?? '') ?? new Map<string, Record<string, unknown>>()
        per.set(t.id, { [field]: value })
        featurePatches.set(t.nodeId ?? '', per)
        continue
      }
      if (field === 'dataClass') {
        if (value === null) continue
        if (t.kind === 'node') {
          const n = model.nodes[t.id]
          if (n !== undefined && !n.dataClasses.includes(value)) ops.push({ op: 'updateNode', id: t.id, patch: { dataClasses: [...n.dataClasses, value] } })
        } else {
          const c = model.connectors[t.id]
          if (c !== undefined && !c.channelA.dataClasses.includes(value)) ops.push({ op: 'updateConnector', id: t.id, patch: { channelA: { ...c.channelA, dataClasses: [...c.channelA.dataClasses, value] } } })
        }
        continue
      }
      const patch = { [field]: field === 'status' ? (value as Status) : value }
      ops.push(t.kind === 'node' ? { op: 'updateNode', id: t.id, patch } : { op: 'updateConnector', id: t.id, patch })
    }
    for (const [nodeId, per] of featurePatches) {
      const n = model.nodes[nodeId]
      if (n !== undefined) ops.push({ op: 'updateNode', id: nodeId, patch: { features: n.features.map((f) => (per.has(f.id) ? { ...f, ...per.get(f.id) } : f)) } })
    }
    if (ops.length > 0) edit(ops, { label: `${label} (${targets.length})` })
  }

  const onlyFeatures = targets.every((t) => t.kind === 'feature')
  const sel = 'h-7 rounded-md border bg-background px-1.5 text-xs'
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-primary/8 px-3 py-1.5 text-xs">
      <span className="font-medium">{selected.length} selected</span>
      {!onlyFeatures && (
        <select aria-label="Set team" value="" className={sel} onChange={(e) => e.target.value !== '' && apply('team', e.target.value === '-' ? null : e.target.value, 'set team')}>
          <option value="">Set team…</option>
          <option value="-">No team</option>
          {model.meta.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      <select aria-label="Set phase" value="" className={sel} onChange={(e) => e.target.value !== '' && apply('phase', e.target.value === '-' ? null : e.target.value, 'set phase')}>
        <option value="">Set phase…</option>
        <option value="-">No phase</option>
        {phasesInOrder(model.meta).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select aria-label="Set status" value="" className={sel} onChange={(e) => e.target.value !== '' && apply('status', e.target.value, 'set status')}>
        <option value="">Set status…</option>
        {STATUSES.map((st) => (
          <option key={st} value={st}>
            {STATUS_LABEL[st]}
          </option>
        ))}
      </select>
      {!onlyFeatures && (
        <select aria-label="Add data class" value="" className={sel} onChange={(e) => e.target.value !== '' && apply('dataClass', e.target.value, 'tag data')}>
          <option value="">Add data class…</option>
          {dataClassCatalog(model.meta).map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      )}
      {tab === 'changes' && targets.length > 0 && (
        <Button size="sm" variant="outline" icon={<Sparkles />} onClick={() => void trackWithAi(targets)} title={`Create (or check) the issues for this work in your tracker, and link them. ${AI_NOTE_SHORT}`}>
          Create issues with AI ({targets.length})
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => patchTab(tab, { selected: {} })}>
        Clear selection
      </Button>
    </div>
  )
}
