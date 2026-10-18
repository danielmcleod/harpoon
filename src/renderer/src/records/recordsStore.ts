// Solution sets and decision records of the open project (`.harpoon/solutions/`, `.harpoon/decisions/`), kept in
// memory for the Decisions view, the inspector and the roadmap board; reloaded when they change on disk.
import { create } from 'zustand'
import type { DecisionRecord, SolutionSet } from '@shared/ipc.ts'
import { invoke } from '../ipc/client.ts'
import { toast } from '../state/actions.ts'

interface RecordsState {
  sets: SolutionSet[]
  decisions: DecisionRecord[]
}

export const useRecords = create<RecordsState>(() => ({ sets: [], decisions: [] }))

export async function loadRecords(kind?: 'solutions' | 'decisions'): Promise<void> {
  if (kind !== 'decisions') {
    const r = await invoke('collection.list', { kind: 'solutions' })
    if (r.ok) useRecords.setState({ sets: r.value as SolutionSet[] })
  }
  if (kind !== 'solutions') {
    const r = await invoke('collection.list', { kind: 'decisions' })
    if (r.ok) useRecords.setState({ decisions: r.value as DecisionRecord[] })
  }
}

export async function putSet(set: SolutionSet): Promise<boolean> {
  useRecords.setState((s) => ({ sets: s.sets.some((x) => x.id === set.id) ? s.sets.map((x) => (x.id === set.id ? set : x)) : [set, ...s.sets] }))
  const r = await invoke('collection.put', { kind: 'solutions', item: set })
  if (!r.ok) toast(r.error.message, 'error')
  return r.ok
}

export async function putDecision(d: DecisionRecord): Promise<boolean> {
  useRecords.setState((s) => ({ decisions: (s.decisions.some((x) => x.id === d.id) ? s.decisions.map((x) => (x.id === d.id ? d : x)) : [...s.decisions, d]).sort((a, b) => a.number - b.number) }))
  const r = await invoke('collection.put', { kind: 'decisions', item: d })
  if (!r.ok) toast(r.error.message, 'error')
  return r.ok
}

export async function deleteRecord(kind: 'solutions' | 'decisions', id: string): Promise<void> {
  if (kind === 'solutions') useRecords.setState((s) => ({ sets: s.sets.filter((x) => x.id !== id) }))
  else useRecords.setState((s) => ({ decisions: s.decisions.filter((x) => x.id !== id) }))
  const r = await invoke('collection.delete', { kind, id })
  if (!r.ok) toast(r.error.message, 'error')
}

export function nextAdrNumber(): number {
  return useRecords.getState().decisions.reduce((n, d) => Math.max(n, d.number), 0) + 1
}

export const today = (): string => new Date().toISOString().slice(0, 10)
