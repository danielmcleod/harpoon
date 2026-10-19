// An in-memory window.harpoon: the renderer without Electron. Two uses: development in a plain browser (the sample
// project, editable) and the exported HTML viewer (the embedded project, read-only).
import type { AppEvent, AppState, Cmd, HarpoonApi, ProjectView, Result } from '@shared/ipc.ts'
import { applyOps } from '@shared/model/ops.ts'
import type { Op } from '@shared/model/ops.ts'
import { sampleOps } from '@shared/model/sample.ts'
import { emptyModel } from '@shared/model/schema.ts'

export interface MemoryBridgeOptions {
  project: ProjectView
  readOnly: boolean
  state?: Partial<AppState>
  /** Saved views available to presentations (the viewer embeds them). */
  views?: unknown[]
  /** Other collections the viewer embeds (decision records). */
  collections?: Record<string, unknown[]>
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
  let state: AppState = { schemaVersion: 1, theme: 'dark', nodeStyle: 'flat', recentProjects: [], repoPaths: {}, designsDir: '', notionServers: {}, ai: { vendor: null, claude: { model: null, effort: null }, codex: { model: null, effort: null } }, externalMcp: { enabled: false, port: 47821, token: null }, ...o.state }
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
