// A sortable, filterable, groupable, virtualized table over any row type. Tree rows (subRows) expand in place; group
// rows show the value and a count; a click selects the row's entity, a double-click drills in.
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getGroupedRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef, Row, Table } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { TableTab } from '@shared/ipc.ts'
import { cn } from '../lib/cn.ts'
import { cellText } from './rows.ts'
import { patchTab, useTables } from './tableStore.ts'

export interface ColumnMeta {
  /** Fixed width in px (default: auto). */
  width?: number
  /** Kept at the left while scrolling sideways. */
  sticky?: boolean
  align?: 'right'
}

const ROW_H = 30

export function DataTable<T extends { id: string; subRows?: T[] }>({
  tab,
  data,
  columns,
  isActive,
  onRowClick,
  onRowDoubleClick,
  onTable,
}: {
  tab: TableTab
  data: T[]
  columns: ColumnDef<T, unknown>[]
  /** Highlights the rows whose entity is selected elsewhere (canvas, inspector). */
  isActive: (row: T) => boolean
  onRowClick: (row: T) => void
  onRowDoubleClick?: (row: T, r: Row<T>) => void
  /** The live table (for exports and bulk actions on the visible rows). */
  onTable?: (t: Table<T>) => void
}): React.JSX.Element {
  const s = useTables((x) => x.byTab[tab])
  const table = useReactTable<T>({
    data,
    columns,
    getRowId: (r) => r.id,
    getSubRows: (r) => r.subRows,
    state: { sorting: s.sorting, columnFilters: s.filters, grouping: s.grouping, columnVisibility: s.hidden, expanded: s.expanded, rowSelection: s.selected, globalFilter: s.search },
    onSortingChange: (u) => patchTab(tab, { sorting: u }),
    onColumnFiltersChange: (u) => patchTab(tab, { filters: u }),
    onGroupingChange: (u) => patchTab(tab, { grouping: u }),
    onColumnVisibilityChange: (u) => patchTab(tab, { hidden: u }),
    onExpandedChange: (u) => patchTab(tab, { expanded: u }),
    onRowSelectionChange: (u) => patchTab(tab, { selected: u }),
    onGlobalFilterChange: (u: string) => patchTab(tab, { search: u }),
    globalFilterFn: 'includesString',
    // Tree tables: a filter keeps a matching child's parents so it stays in context.
    filterFromLeafRows: true,
    enableSubRowSelection: false,
    groupedColumnMode: false,
    autoResetExpanded: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  })
  useEffect(() => onTable?.(table), [table, onTable])

  const scroller = useRef<HTMLDivElement>(null)
  const rows = table.getRowModel().rows
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 12 })
  const items = virtual.getVirtualItems()
  const padTop = items[0]?.start ?? 0
  const padBottom = items.length > 0 ? virtual.getTotalSize() - (items.at(-1)?.end ?? 0) : 0
  const leaf = table.getVisibleLeafColumns()

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto" role="region" aria-label={`${tab} table`}>
      <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
        <thead className="sticky top-0 z-20 bg-popover">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const meta = h.column.columnDef.meta as ColumnMeta | undefined
                const sorted = h.column.getIsSorted()
                return (
                  <th
                    key={h.id}
                    style={{ width: meta?.width, minWidth: meta?.width }}
                    className={cn('border-b bg-popover px-2 py-1.5 text-left font-medium whitespace-nowrap text-muted-foreground', meta?.sticky === true && 'sticky left-0 z-10', meta?.align === 'right' && 'text-right')}
                  >
                    {h.isPlaceholder ? null : h.column.getCanSort() ? (
                      <button type="button" onClick={h.column.getToggleSortingHandler()} className="inline-flex items-center gap-1 hover:text-foreground">
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {sorted === 'asc' ? <ArrowUp className="size-3" /> : sorted === 'desc' ? <ArrowDown className="size-3" /> : null}
                      </button>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                  </th>
                )
              })}
            </tr>
          ))}
          <tr>
            {leaf.map((c) => {
              const meta = c.columnDef.meta as ColumnMeta | undefined
              return (
                <th key={c.id} className={cn('border-b bg-popover px-1.5 pb-1.5 font-normal', meta?.sticky === true && 'sticky left-0 z-10')}>
                  {c.getCanFilter() ? (
                    <input
                      value={(c.getFilterValue() as string | undefined) ?? ''}
                      onChange={(e) => c.setFilterValue(e.target.value === '' ? undefined : e.target.value)}
                      placeholder="Filter"
                      aria-label={`Filter ${c.id}`}
                      className="h-6 w-full min-w-12 rounded border bg-background px-1.5 text-[11px] outline-none focus:border-ring"
                    />
                  ) : null}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {padTop > 0 && (
            <tr>
              <td style={{ height: padTop }} colSpan={leaf.length} />
            </tr>
          )}
          {items.map((vi) => {
            const row = rows[vi.index]
            if (row === undefined) return null
            if (row.getIsGrouped()) return <GroupRow key={row.id} row={row} span={leaf.length} />
            const active = isActive(row.original)
            return (
              <tr
                key={row.id}
                style={{ height: ROW_H }}
                onClick={() => onRowClick(row.original)}
                onDoubleClick={() => onRowDoubleClick?.(row.original, row)}
                className={cn('group cursor-default', active ? 'bg-primary/12' : row.getIsSelected() ? 'bg-accent/50' : 'hover:bg-accent/40')}
                aria-selected={active}
              >
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta as ColumnMeta | undefined
                  return (
                    <td
                      key={cell.id}
                      style={{ width: meta?.width, maxWidth: meta?.width ?? 320 }}
                      className={cn(
                        'truncate border-b border-border/60 px-2 whitespace-nowrap',
                        meta?.sticky === true && cn('sticky left-0 z-[1]', active ? 'bg-[color-mix(in_oklab,var(--primary)_12%,var(--popover))]' : 'bg-popover group-hover:bg-[color-mix(in_oklab,var(--accent)_40%,var(--popover))]'),
                        meta?.align === 'right' && 'text-right tabular-nums',
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  )
                })}
              </tr>
            )
          })}
          {padBottom > 0 && (
            <tr>
              <td style={{ height: padBottom }} colSpan={leaf.length} />
            </tr>
          )}
        </tbody>
      </table>
      {rows.length === 0 && <p className="p-6 text-center text-xs text-muted-foreground">Nothing matches.</p>}
    </div>
  )
}

function GroupRow<T>({ row, span }: { row: Row<T>; span: number }): React.JSX.Element {
  const col = row.groupingColumnId ?? ''
  const v = row.groupingValue
  return (
    <tr style={{ height: ROW_H }} className="bg-muted/40">
      <td colSpan={span} className="border-b px-2">
        <button type="button" onClick={row.getToggleExpandedHandler()} className="inline-flex items-center gap-1 text-xs font-medium">
          <ChevronRight className={cn('size-3.5 transition-transform', row.getIsExpanded() && 'rotate-90')} />
          <span className="text-muted-foreground">{col}:</span> {cellText(v) === '' ? '—' : cellText(v)}
          <span className="ml-1 rounded bg-background px-1 text-[10px] text-muted-foreground">{row.subRows.length}</span>
        </button>
      </td>
    </tr>
  )
}
