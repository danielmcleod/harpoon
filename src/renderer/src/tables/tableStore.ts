// Table state per tab (sorting, filters, grouping, hidden columns, expanded rows, ticked rows), kept while you switch
// tabs or go back to the diagram.
import type { ColumnFiltersState, ExpandedState, GroupingState, RowSelectionState, SortingState, VisibilityState } from '@tanstack/react-table'
import { create } from 'zustand'
import type { SavedTable, TableTab } from '@shared/ipc.ts'
import { TABLE_TABS } from '@shared/ipc.ts'

export interface TabState {
  sorting: SortingState
  filters: ColumnFiltersState
  grouping: GroupingState
  hidden: VisibilityState
  expanded: ExpandedState
  selected: RowSelectionState
  search: string
}

const EMPTY: TabState = { sorting: [], filters: [], grouping: [], hidden: {}, expanded: {}, selected: {}, search: '' }

/** Columns hidden until asked for (keeps the first view readable). */
const DEFAULT_HIDDEN: Partial<Record<TableTab, VisibilityState>> = {
  services: { provider: false, region: false, tech: false, sensitivity: false, owner: false, notes: false, boundary: false },
  connectors: { returnProtocol: false, notes: false, team: false },
}

/** The tables plus the dependency matrix (not a table: no saved views, no columns). */
export type ViewTab = TableTab | 'matrix'

interface TablesState {
  tab: ViewTab
  byTab: Record<TableTab, TabState>
  /** Matrix: inner parts get their own rows and columns. */
  matrixInner: boolean
}

export const useTables = create<TablesState>(() => ({
  tab: 'services',
  byTab: Object.fromEntries(TABLE_TABS.map((t) => [t, { ...EMPTY, hidden: DEFAULT_HIDDEN[t] ?? {} }])) as Record<TableTab, TabState>,
  matrixInner: false,
}))

export function setTab(tab: ViewTab): void {
  useTables.setState({ tab })
}

type Updater<T> = T | ((old: T) => T)

export function patchTab(tab: TableTab, p: { [K in keyof TabState]?: Updater<TabState[K]> }): void {
  useTables.setState((s) => {
    const cur = s.byTab[tab]
    const next = { ...cur }
    for (const [k, v] of Object.entries(p) as [keyof TabState, Updater<unknown>][]) {
      ;(next as Record<string, unknown>)[k] = typeof v === 'function' ? (v as (o: unknown) => unknown)(cur[k]) : v
    }
    return { byTab: { ...s.byTab, [tab]: next } }
  })
}

/** Open a table filtered on one column (drill-down from a count or a link). */
export function openFiltered(tab: TableTab, column: string, value: string): void {
  patchTab(tab, { filters: [{ id: column, value }], grouping: [], search: '' })
  setTab(tab)
}

export function toSaved(id: string, name: string, tab: TableTab, s: TabState): SavedTable {
  return {
    id,
    name,
    tab,
    hidden: Object.entries(s.hidden)
      .filter(([, v]) => !v)
      .map(([k]) => k),
    sorting: s.sorting.map((x) => ({ id: x.id, desc: x.desc })),
    filters: s.filters.map((f) => ({ id: f.id, value: String(f.value) })),
    grouping: [...s.grouping],
    search: s.search,
  }
}

export function applySaved(v: SavedTable): void {
  patchTab(v.tab, {
    hidden: Object.fromEntries(v.hidden.map((k) => [k, false])),
    sorting: v.sorting,
    filters: v.filters,
    grouping: v.grouping,
    search: v.search,
    expanded: {},
    selected: {},
  })
  setTab(v.tab)
}
