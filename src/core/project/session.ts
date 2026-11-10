// One open project: the authoritative model, its version, undo/redo history, autosave and the external-change
// watcher. Every change is an op batch (shared/model/ops.ts); each applied batch is pushed to the renderer as a
// `model` event carrying the same ops, so the renderer's mirror stays in step without resending the model.
import { unwatchFile, watchFile } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { EventBus } from '../bus.ts'
import { HarpoonError } from '../errors.ts'
import type { Logger } from '../log.ts'
import { diffModels } from '../../shared/model/diff.ts'
import { applyOps } from '../../shared/model/ops.ts'
import type { Op } from '../../shared/model/ops.ts'
import type { Model } from '../../shared/model/schema.ts'
import type { HistoryState, ModelSource, ProjectView } from '../../shared/ipc.ts'
import { writeFileAtomic } from '../store/atomic.ts'
import { parseModel, parseModelWithRepairs, projectPaths, repairNotice, serializeModel } from './files.ts'

export const SAVE_DEBOUNCE_MS = 400
export const COALESCE_MS = 1200
export const HISTORY_MAX = 300
const WATCH_INTERVAL_MS = 1000

interface Entry {
  source: ModelSource
  label: string
  ops: Op[]
  inverse: Op[]
  coalesceKey: string | null
  at: number
}

export interface ApplyOptions {
  label?: string
  source?: ModelSource
  /** Consecutive batches with the same key within COALESCE_MS undo as one step (typing in a field). */
  coalesceKey?: string
  /** Renderer transaction id, echoed in the event so the sender can skip its own optimistic change. */
  txId?: string
  /** Not undoable (e.g. accepting an AI proposal records its own entry). */
  record?: boolean
}

export class ProjectSession {
  readonly root: string
  #model: Model
  #version = 1
  #undo: Entry[] = []
  #redo: Entry[] = []
  #saveTimer: ReturnType<typeof setTimeout> | null = null
  /** Saves and looks at the disk, one at a time: a check never reads a save of ours half-way. */
  #saving: Promise<void> = Promise.resolve()
  /** What is on disk as far as we know (last written or read), to tell our own writes from someone else's. */
  #lastTexts: { project: string; layout: string | null }
  #watching = false
  #closed = false
  readonly #bus: EventBus
  readonly #log: Logger

  constructor(o: { root: string; model: Model; texts: { project: string; layout: string | null }; bus: EventBus; log: Logger }) {
    this.root = o.root
    this.#model = o.model
    this.#lastTexts = o.texts
    this.#bus = o.bus
    this.#log = o.log
  }

  get model(): Model {
    return this.#model
  }

  get version(): number {
    return this.#version
  }

  view(): ProjectView {
    return { root: this.root, model: this.#model, version: this.#version, history: this.history() }
  }

  history(): HistoryState {
    const entry = (e: Entry): { label: string; at: number; source: ModelSource } => ({ label: e.label, at: e.at, source: e.source })
    return {
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
      undoLabel: this.#undo.at(-1)?.label ?? null,
      redoLabel: this.#redo.at(-1)?.label ?? null,
      undo: this.#undo.slice(-60).map(entry),
      redo: this.#redo.slice(-60).map(entry),
    }
  }

  /** Undo (steps < 0) or redo (steps > 0) several steps. */
  step(steps: number): { version: number } {
    for (let i = 0; i < Math.abs(steps); i++) {
      if (steps < 0 && this.#undo.length > 0) this.undo()
      else if (steps > 0 && this.#redo.length > 0) this.redo()
    }
    return { version: this.#version }
  }

  /** Apply a batch; throws HarpoonError(VALIDATION) when an op does not fit the model. */
  apply(ops: readonly Op[], o: ApplyOptions = {}): { version: number } {
    if (this.#closed) throw new HarpoonError('CONFLICT', 'The project is closed.')
    if (ops.length === 0) return { version: this.#version }
    let result
    try {
      result = applyOps(this.#model, ops)
    } catch (err) {
      throw new HarpoonError('VALIDATION', err instanceof Error ? err.message : String(err))
    }
    const label = o.label ?? describeOps(ops)
    if (o.record !== false) {
      const now = Date.now()
      const last = this.#undo.at(-1)
      if (o.coalesceKey !== undefined && last?.coalesceKey === o.coalesceKey && now - last.at < COALESCE_MS) {
        last.ops = [...last.ops, ...ops]
        last.inverse = [...result.inverse, ...last.inverse]
        last.at = now
      } else {
        this.#undo.push({ source: o.source ?? 'user', label, ops: [...ops], inverse: result.inverse, coalesceKey: o.coalesceKey ?? null, at: now })
        if (this.#undo.length > HISTORY_MAX) this.#undo.shift()
      }
      this.#redo = []
    }
    this.#commit(result.model, [...ops], o.source ?? 'user', label, o.txId)
    return { version: this.#version }
  }

  undo(): { version: number } {
    const e = this.#undo.pop()
    if (e === undefined) return { version: this.#version }
    const r = applyOps(this.#model, e.inverse)
    this.#redo.push(e)
    this.#commit(r.model, e.inverse, 'undo', `Undo ${e.label}`)
    return { version: this.#version }
  }

  redo(): { version: number } {
    const e = this.#redo.pop()
    if (e === undefined) return { version: this.#version }
    const r = applyOps(this.#model, e.ops)
    e.inverse = r.inverse
    this.#undo.push(e)
    this.#commit(r.model, e.ops, 'redo', `Redo ${e.label}`)
    return { version: this.#version }
  }

  #commit(model: Model, ops: Op[], source: ModelSource, label: string, txId?: string): void {
    this.#model = model
    this.#version++
    this.#bus.emit({
      kind: 'model',
      version: this.#version,
      ops,
      source,
      label,
      history: this.history(),
      ...(txId !== undefined ? { txId } : {}),
    })
    this.#scheduleSave()
  }

  #scheduleSave(): void {
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer)
    this.#saveTimer = setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS)
  }

  /** Write pending changes now (Ctrl+S, close, quit). A save that failed is tried again by the next one. */
  async flush(): Promise<void> {
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer)
    this.#saveTimer = null
    return this.#inTurn(() => this.#save())
  }

  #inTurn(task: () => Promise<void>): Promise<void> {
    this.#saving = this.#saving.then(task).catch((err: unknown) => {
      this.#log.error('a project file task failed', { err: err instanceof Error ? err.message : String(err) })
    })
    return this.#saving
  }

  async #save(): Promise<void> {
    try {
      // Never overwrite what we have not seen: a git pull or a hand edit since the last save comes in first, and
      // then there is nothing of ours left to write.
      if (!(await this.#takeExternal())) {
        const texts = serializeModel(this.#model)
        if (texts.project !== this.#lastTexts.project || texts.layout !== this.#lastTexts.layout) await this.#write(texts)
      }
      // Also when nothing was new, so the window's save indicator settles.
      this.#bus.emit({ kind: 'saved', at: Date.now(), error: null })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.#log.error('saving the project failed', { err: msg })
      this.#bus.emit({ kind: 'saved', at: Date.now(), error: msg })
      this.#bus.emit({ kind: 'toast', level: 'error', message: `Could not save the project: ${msg}` })
    }
  }

  /**
   * The two files, each recorded as written only once it has landed: after a failure (both, or the layout alone)
   * the next save still sees the difference and writes again, and the watcher does not take half a save of ours
   * for someone else's change.
   */
  async #write(texts: { project: string; layout: string }): Promise<void> {
    const paths = projectPaths(this.root)
    await writeFileAtomic(paths.project, texts.project, { mode: 0o644 })
    this.#lastTexts = { project: texts.project, layout: this.#lastTexts.layout }
    await writeFileAtomic(paths.layout, texts.layout, { mode: 0o644 })
    this.#lastTexts = texts
  }

  /** Poll the two files (no directory handle stays open, so git and the OS can move the folder freely). */
  watch(): void {
    if (this.#watching) return
    this.#watching = true
    const paths = projectPaths(this.root)
    const onChange = (): void =>
      void this.#inTurn(async () => {
        await this.#takeExternal()
      })
    watchFile(paths.project, { interval: WATCH_INTERVAL_MS }, onChange)
    watchFile(paths.layout, { interval: WATCH_INTERVAL_MS }, onChange)
  }

  /**
   * Take in what someone else wrote (git pull, hand edits, another tool) as one undoable step; true when the model
   * changed. Only ever runs in turn with the saves (#inTurn). Never throws.
   */
  async #takeExternal(): Promise<boolean> {
    if (this.#closed) return false
    const paths = projectPaths(this.root)
    const project = await readFile(paths.project, 'utf8').catch(() => null)
    const layout = await readFile(paths.layout, 'utf8').catch(() => null)
    if (project === null) return false
    const last = this.#lastTexts
    if (project === last.project && layout === last.layout) return false
    let disk: Model
    let repairs: string[]
    try {
      ;({ model: disk, repairs } = parseModelWithRepairs(project, layout))
    } catch (err) {
      this.#log.warn('ignoring an unreadable external change', { err: err instanceof Error ? err.message : String(err) })
      return false
    }
    // The same model as we last saw, only written differently (line endings, a formatter): nothing to take in, and
    // edits not saved yet stay.
    const rewritten = (): boolean => {
      try {
        return diffModels(parseModel(last.project, last.layout), disk).length === 0
      } catch {
        return false
      }
    }
    let step: { ops: Op[]; inverse: Op[]; model: Model } | null = null
    try {
      const ops = rewritten() ? [] : diffModels(this.#model, disk)
      if (ops.length > 0) {
        const r = applyOps(this.#model, ops)
        step = { ops, inverse: r.inverse, model: r.model }
      }
    } catch (err) {
      // What is on disk stays unseen (#lastTexts as it was): the next change saved here goes over it.
      const msg = err instanceof Error ? err.message : String(err)
      this.#log.error('an external change could not be loaded', { err: msg })
      this.#bus.emit({ kind: 'toast', level: 'error', message: `Changes made outside Harpoon could not be loaded (${msg}). The next change saved here replaces them.` })
      return false
    }
    this.#lastTexts = { project, layout }
    if (step === null) return false
    // External edits come in as one undoable step.
    this.#undo.push({ source: 'external', label: 'external change', ops: step.ops, inverse: step.inverse, coalesceKey: null, at: Date.now() })
    this.#redo = []
    this.#model = step.model
    this.#version++
    this.#bus.emit({
      kind: 'model',
      version: this.#version,
      ops: step.ops,
      source: 'external',
      label: 'external change',
      history: this.history(),
    })
    this.#bus.emit({ kind: 'toast', level: 'info', message: 'Loaded changes made outside Harpoon. Undo to revert them.' })
    if (repairs.length > 0) this.#bus.emit({ kind: 'toast', level: 'warn', message: repairNotice(repairs) })
    return true
  }

  async close(): Promise<void> {
    if (this.#closed) return
    await this.flush()
    this.#closed = true
    if (this.#watching) {
      const paths = projectPaths(this.root)
      unwatchFile(paths.project)
      unwatchFile(paths.layout)
    }
  }
}

/** A short undo label for a batch ("add Fraud Engine", "3 changes"). */
export function describeOps(ops: readonly Op[]): string {
  if (ops.length === 1) {
    const o = ops[0]
    if (o === undefined) return 'change'
    switch (o.op) {
      case 'addNode':
        return `add ${o.node.name}`
      case 'removeNode':
        return 'delete node'
      case 'updateNode':
        return Object.keys(o.patch).includes('parentId') ? 'move into group' : 'edit node'
      case 'addConnector':
        return 'connect'
      case 'removeConnector':
        return 'delete connector'
      case 'updateConnector':
        return 'edit connector'
      case 'setLayout':
        return 'move'
      default:
        return 'change'
    }
  }
  if (ops.every((o) => o.op === 'setLayout')) return `move ${ops.length} nodes`
  if (ops.some((o) => o.op === 'removeNode')) return 'delete'
  return `${ops.length} changes`
}
