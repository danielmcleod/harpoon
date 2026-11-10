// The Time Machine: one line of time from the project's git history, through today, to the end of each roadmap
// phase. This store holds the past half (the commits and the models read from them); the future half is `ui.asOf`.
// `useProjection` is what the diagram and the 3D levels show instead of today's model: read-only either way.
import { useMemo } from 'react'
import { create } from 'zustand'
import type { HistoryCommit } from '@shared/ipc.ts'
import { modelAsOf } from '@shared/model/roadmap.ts'
import type { Projection } from '@shared/model/roadmap.ts'
import { emptyModel } from '@shared/model/schema.ts'
import type { Model } from '@shared/model/schema.ts'
import { keepRemoved } from '../canvas/useReview.ts'
import { invoke } from '../ipc/client.ts'
import { usePresent } from '../present/presentStore.ts'
import { setUi, useStore } from '../state/store.ts'

type Snapshot = { model: Model } | { error: string }

/** Models kept in memory; the least recently read goes first. */
const KEEP = 48

interface TimeState {
  /** The project folder the history was read for. */
  root: string | null
  loading: boolean
  /** Oldest first. */
  commits: HistoryCommit[]
  /** Why there is no history (not in git, no git), or null. */
  unavailable: string | null
  /** The commit shown (null: today, or a roadmap phase). */
  at: string | null
  /** The commit being read before it is shown. */
  pending: string | null
  snapshots: Record<string, Snapshot>
  playing: boolean
}

const INITIAL: TimeState = {
  root: null,
  loading: false,
  commits: [],
  unavailable: null,
  at: null,
  pending: null,
  snapshots: {},
  playing: false,
}

export const useTime = create<TimeState>(() => INITIAL)

/** Back to today, with nothing read (another project opened, or this one closed). */
export function resetTime(): void {
  useTime.setState(INITIAL)
}

/** Read the commit list for the open project (again when asked: new commits appear as you work). */
export async function loadHistory(root: string): Promise<void> {
  if (useTime.getState().root !== root) useTime.setState({ ...INITIAL, root })
  useTime.setState({ loading: true })
  const r = await invoke('history.list')
  if (useTime.getState().root !== root) return
  useTime.setState(
    r.ok
      ? { loading: false, commits: r.value.commits, unavailable: r.value.unavailable }
      : { loading: false, commits: [], unavailable: r.error.message },
  )
}

async function snapshot(sha: string): Promise<Snapshot> {
  const known = useTime.getState().snapshots[sha]
  if (known !== undefined) return known
  const root = useTime.getState().root
  const r = await invoke('history.snapshot', { sha })
  const snap: Snapshot = r.ok ? { model: r.value.model } : { error: r.error.message }
  if (useTime.getState().root !== root) return snap
  useTime.setState((s) => {
    const next = { ...s.snapshots, [sha]: snap }
    const keys = Object.keys(next)
    // Never the one on screen, nor the one before it (it is what the changes are measured against).
    const i = s.commits.findIndex((c) => c.sha === s.at)
    const keep = new Set([sha, s.at, s.commits[i - 1]?.sha])
    for (const k of keys) {
      if (Object.keys(next).length <= KEEP) break
      if (!keep.has(k)) delete next[k]
    }
    return { snapshots: next }
  })
  return snap
}

/** Show the architecture as committed at `sha`. Resolves once it is on screen (false: superseded or unreadable). */
export async function goCommit(sha: string): Promise<boolean> {
  const { commits } = useTime.getState()
  const i = commits.findIndex((c) => c.sha === sha)
  if (i < 0) return false
  useTime.setState({ pending: sha })
  // The commit before it too: what this commit changed is measured against that one.
  const before = commits[i - 1]
  const [snap] = await Promise.all([snapshot(sha), before === undefined ? null : snapshot(before.sha)])
  if (useTime.getState().pending !== sha) return false
  useTime.setState({ pending: null, at: sha })
  setUi({ asOf: null, connectFrom: null })
  // The next one, so stepping and playing forward do not wait.
  const after = commits[i + 1]
  if (after !== undefined) void snapshot(after.sha)
  return 'model' in snap
}

export function goToday(): void {
  useTime.setState({ at: null, pending: null })
  setUi({ asOf: null, connectFrom: null })
}

export function goPhase(id: string): void {
  useTime.setState({ at: null, pending: null })
  setUi({ asOf: id, connectFrom: null })
}

/**
 * What the diagram shows instead of today's model, or null for today: the architecture as committed (with what that
 * commit added, changed and removed marked like a diff), or as it will be at the end of the picked roadmap phase.
 */
export function useProjection(): Projection | null {
  const model = useStore((s) => s.project?.model)
  const asOf = useStore((s) => s.ui.asOf)
  const at = useTime((s) => s.at)
  const commits = useTime((s) => s.commits)
  const snapshots = useTime((s) => s.snapshots)
  // A presentation's views pick their own phase; the past is not part of a saved view.
  const presenting = usePresent((s) => s.presenting)
  return useMemo(() => {
    if (model === undefined) return null
    if (asOf !== null || at === null || presenting) return asOf === null ? null : modelAsOf(model, asOf)
    const cur = snapshots[at]
    if (cur === undefined || !('model' in cur)) return null
    const i = commits.findIndex((c) => c.sha === at)
    const before = snapshots[commits[i - 1]?.sha ?? '']
    // The first commit is measured against nothing: everything in it is new.
    const base =
      before !== undefined && 'model' in before
        ? before.model
        : emptyModel({ id: cur.model.meta.id, name: cur.model.meta.name })
    return { ...keepRemoved(base, cur.model), index: -1 }
  }, [model, asOf, at, commits, snapshots, presenting])
}
