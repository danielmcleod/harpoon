// An in-memory window.harpoon: the renderer without Electron. Two uses: development in a plain browser (the sample
// project, editable) and the exported HTML viewer (the embedded project, read-only).
import type { AppEvent, AppState, Cmd, HarpoonApi, HistoryCommit, ProjectView, Result } from '@shared/ipc.ts'
import { applyOps } from '@shared/model/ops.ts'
import type { Op } from '@shared/model/ops.ts'
import { sampleOps } from '@shared/model/sample.ts'
import { NodeZ, emptyModel } from '@shared/model/schema.ts'
import type { Model } from '@shared/model/schema.ts'

export interface MemoryBridgeOptions {
  project: ProjectView
  readOnly: boolean
  state?: Partial<AppState>
  /** Saved views available to presentations (the viewer embeds them). */
  views?: unknown[]
  /** Other collections the viewer embeds (decision records). */
  collections?: Record<string, unknown[]>
  /** A past to scrub through, oldest first (development only: the app reads the real one from git). */
  history?: { commit: HistoryCommit; model: Model }[]
}

/** Dev: a made-up past for the sample, so the Time Machine has something to show without a repository. */
function sampleHistory(): { commit: HistoryCommit; model: Model }[] {
  const ops = sampleOps()
  const legacy: Op = { op: 'addNode', node: NodeZ.parse({ id: 'legacy-billing', name: 'Legacy billing', status: 'deprecated' }), at: { q: 5, r: 4 } }
  const steps = [
    { share: 0.3, legacy: true, subject: 'First map of the platform' },
    { share: 0.55, legacy: true, subject: 'Add payments and its events' },
    { share: 0.8, legacy: false, subject: 'Retire legacy billing, add notifications' },
    { share: 1, legacy: false, subject: 'Document the inner parts' },
  ]
  const day = 86_400_000
  return steps.map((s, i) => ({
    commit: { sha: (i + 1).toString(16).padStart(7, '0'), at: Date.now() - (steps.length - i) * 21 * day, author: 'Sample', subject: s.subject },
    model: applyOps(emptyModel({ id: 'commerce', name: 'Commerce Platform' }), [...ops.slice(0, Math.ceil(ops.length * s.share)), ...(s.legacy ? [legacy] : [])]).model,
  }))
}

/** Dev: the sample project, editable. */
export function installDevBridge(): void {
  installMemoryBridge({
    project: {
      root: '/dev/sample',
      model: applyOps(emptyModel({ id: 'commerce', name: 'Commerce Platform' }), sampleOps()).model,
      version: 1,
      history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    },
    readOnly: false,
    history: sampleHistory(),
  })
}

export function installMemoryBridge(o: MemoryBridgeOptions): void {
  if ((window as unknown as { harpoon?: unknown }).harpoon !== undefined) return
  const listeners = new Set<(b: AppEvent[]) => void>()
  const emit = (e: AppEvent): void => {
    setTimeout(() => {
      for (const l of listeners) l([e])
    }, 5)
  }
  let state: AppState = { schemaVersion: 1, theme: 'dark', nodeStyle: 'flat', recentProjects: [], repoPaths: {}, designsDir: '', notionServers: {}, ai: { vendor: null, claude: { model: null, effort: null }, codex: { model: null, effort: null }, tools: { claude: {}, codex: {} } }, externalMcp: { enabled: false, port: 47821, token: null }, implement: { approvals: 'acceptEdits', git: 'repo', branchTemplate: 'harpoon/{slug}', plansDir: '.harpoon/plans', askTimeoutMin: 30 }, ...o.state }
  let project: ProjectView | null = o.project
  let views: unknown[] = o.views ?? []
  const undo: { ops: Op[]; inverse: Op[]; at: number }[] = []
  const redo: { ops: Op[]; inverse: Op[]; at: number }[] = []
  const entry = (e: { at: number }): { label: string; at: number; source: 'user' } => ({ label: 'change', at: e.at, source: 'user' })
  const history = (): ProjectView['history'] => ({
    canUndo: undo.length > 0,
    canRedo: redo.length > 0,
    undoLabel: undo.length > 0 ? 'change' : null,
    redoLabel: redo.length > 0 ? 'change' : null,
    undo: undo.map(entry),
    redo: redo.map(entry),
  })
  const commit = (ops: Op[], txId?: string): number => {
    if (project === null) return 0
    const r = applyOps(project.model, ops)
    project = { ...project, model: r.model, version: project.version + 1, history: history() }
    emit({ kind: 'model', version: project.version, ops, source: 'user', label: 'change', history: history(), ...(txId !== undefined ? { txId } : {}) })
    if (!o.readOnly) setTimeout(() => emit({ kind: 'saved', at: Date.now(), error: null }), 400)
    return project.version
  }
  const ok = <T,>(value: T): Result<T> => ({ ok: true, value })
  const writable = (): void => {
    if (o.readOnly) throw new Error('This is a read-only view.')
  }

  const handlers: Partial<Record<Cmd, (req: never) => unknown>> = {
    'state.get': () => state,
    'state.set': (req: Partial<AppState>) => (state = { ...state, ...req }),
    'project.current': () => project,
    'project.recent': () => [],
    'project.save': () => undefined,
    'project.close': () => {
      writable()
      project = null
      emit({ kind: 'project-closed' })
    },
    'project.apply': (req: { ops: Op[]; txId?: string }) => {
      writable()
      if (project === null) throw new Error('no project')
      const r = applyOps(project.model, req.ops)
      undo.push({ ops: req.ops, inverse: r.inverse, at: Date.now() })
      redo.length = 0
      return { version: commit(req.ops, req.txId) }
    },
    'project.undo': () => {
      const e = undo.pop()
      if (e === undefined || project === null) return { version: project?.version ?? 0 }
      const r = applyOps(project.model, e.inverse)
      redo.push({ ops: e.ops, inverse: r.inverse, at: e.at })
      return { version: commit(e.inverse) }
    },
    'project.step': (req: { steps: number }) => {
      const h = handlers as Record<string, () => unknown>
      for (let i = 0; i < Math.abs(req.steps); i++) h[req.steps < 0 ? 'project.undo' : 'project.redo']?.()
      return { version: project?.version ?? 0 }
    },
    'project.redo': () => {
      const e = redo.pop()
      if (e === undefined || project === null) return { version: project?.version ?? 0 }
      undo.push(e)
      return { version: commit(e.ops) }
    },
    'history.list': () => ({ commits: (o.history ?? []).map((h) => h.commit), unavailable: null }),
    'history.snapshot': (req: { sha: string }) => {
      const h = o.history?.find((x) => x.commit.sha === req.sha)
      if (h === undefined) throw new Error('That commit is not available here.')
      return { model: h.model, repairs: [] }
    },
    'ai.runs': () => [],
    'proposal.list': () => [],
    'collection.list': (req: { kind: string }) => (req.kind === 'views' ? views : (o.collections?.[req.kind] ?? [])),
    'collection.put': (req: { kind: string; item: { id: string } }) => {
      writable()
      if (req.kind === 'views') views = [...views.filter((v) => (v as { id: string }).id !== req.item.id), req.item]
    },
    'collection.delete': (req: { kind: string; id: string }) => {
      writable()
      if (req.kind === 'views') views = views.filter((v) => (v as { id: string }).id !== req.id)
    },
  }

  const resolved = state.theme === 'light' ? 'light' : 'dark'
  const api: HarpoonApi = {
    invoke: (cmd, ...args) => {
      const h = handlers[cmd] as ((req: unknown) => unknown) | undefined
      if (h === undefined) return Promise.resolve({ ok: false, error: { code: 'UNSUPPORTED', message: `${cmd} is not available here.` } })
      try {
        return Promise.resolve(ok(h(args[0])) as never)
      } catch (err) {
        return Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: err instanceof Error ? err.message : String(err) } })
      }
    },
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    platform: 'win32',
    initialTheme: { theme: resolved, resolved },
  }
  ;(window as unknown as { harpoon: HarpoonApi }).harpoon = api
}
