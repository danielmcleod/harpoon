// The open project (one per window) and the project.* commands.
import { cp, mkdir, readFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { slugify } from '../../shared/model/ids.ts'
import { SCHEMA_VERSION } from '../../shared/model/schema.ts'
import type { AppStateStore } from '../app-state.ts'
import type { EventBus } from '../bus.ts'
import { HarpoonError } from '../errors.ts'
import type { Logger } from '../log.ts'
import { parseOps } from '../../shared/model/ops.ts'
import type { Op } from '../../shared/model/ops.ts'
import { sampleOps } from '../../shared/model/sample.ts'
import type { ApplyRequest, FolderInfo, ProjectView } from '../../shared/ipc.ts'
import { exists, initProject, normalizeRoot, parseModel, projectPaths, readProject, serializeModel, writeProjectTexts } from './files.ts'

/** Is `p` inside (or equal to) `dir`? */
const isInside = (dir: string, p: string): boolean => {
  const rel = relative(resolve(dir), resolve(p))
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':'))
}
import { ProjectSession } from './session.ts'
import type { ApplyOptions } from './session.ts'

export class ProjectManager {
  #session: ProjectSession | null = null
  readonly #bus: EventBus
  readonly #log: Logger
  readonly #state: AppStateStore

  constructor(o: { bus: EventBus; log: Logger; state: AppStateStore }) {
    this.#bus = o.bus
    this.#log = o.log
    this.#state = o.state
  }

  get session(): ProjectSession | null {
    return this.#session
  }

  /** The open session, or CONFLICT when there is none. */
  require(): ProjectSession {
    if (this.#session === null) throw new HarpoonError('CONFLICT', 'No project is open.')
    return this.#session
  }

  async inspect(dir: string): Promise<FolderInfo> {
    const root = resolve(normalizeRoot(dir))
    const paths = projectPaths(root)
    const hasProject = await exists(paths.project)
    let projectName: string | null = null
    if (hasProject) {
      try {
        projectName = (await readProject(root)).model.meta.name
      } catch {
        projectName = null
      }
    }
    return { path: root, hasProject, projectName, isGitRepo: await exists(join(root, '.git')), isLocalDesign: isInside(this.#state.state.designsDir, root) }
  }

  /** A free folder for a new local design: `<designs>/<name>`, numbered when taken. */
  async #localRoot(name: string): Promise<string> {
    const base = slugify(name) || 'design'
    const dir = this.#state.state.designsDir
    let root = join(dir, base)
    for (let i = 2; await exists(root); i++) root = join(dir, `${base}-${i}`)
    await mkdir(root, { recursive: true })
    return root
  }

  /** A design saved on this machine only: no folder to pick, no repository. */
  async createLocal(name: string, template: 'blank' | 'sample' = 'blank'): Promise<ProjectView> {
    return this.create(await this.#localRoot(name), name, template)
  }

  /**
   * A single-file design (the lossless `.harpoon.json` export: the project file plus its layout) opened as a new
   * local design.
   */
  async importFile(path: string): Promise<ProjectView> {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      throw new HarpoonError('VALIDATION', 'That file is not a Harpoon design (.harpoon.json).')
    }
    if (raw === null || typeof raw !== 'object' || !('meta' in raw)) throw new HarpoonError('VALIDATION', 'That file is not a Harpoon design (.harpoon.json).')
    const { layout, ...project } = raw as Record<string, unknown>
    const model = parseModel(JSON.stringify(project), JSON.stringify({ schemaVersion: SCHEMA_VERSION, nodes: layout ?? {} }))
    const root = await this.#localRoot(model.meta.name)
    await writeProjectTexts(root, serializeModel(model))
    return this.open(root)
  }

  /** Copy the open project's `.harpoon/` into another folder (a repository, a shared drive) and open the copy. */
  async saveCopy(dir: string): Promise<ProjectView> {
    const s = this.require()
    await s.flush()
    const target = resolve(normalizeRoot(dir))
    if (await exists(projectPaths(target).project)) throw new HarpoonError('CONFLICT', `${target} already has a Harpoon project.`)
    await cp(projectPaths(s.root).dir, projectPaths(target).dir, { recursive: true, errorOnExist: true, force: false })
    return this.open(target)
  }

  async create(dir: string, name?: string, template: 'blank' | 'sample' = 'blank'): Promise<ProjectView> {
    const root = resolve(normalizeRoot(dir))
    const loaded = await initProject(root, name ?? (template === 'sample' ? 'Commerce Platform' : undefined))
    const view = await this.#adopt(root, loaded)
    if (template === 'sample') {
      // Not undoable: the sample is the starting point.
      this.require().apply(sampleOps(), { label: 'sample', source: 'import', record: false })
      await this.require().flush()
      return this.require().view()
    }
    return view
  }

  async open(dir: string): Promise<ProjectView> {
    const root = resolve(normalizeRoot(dir))
    const loaded = await readProject(root)
    return this.#adopt(root, loaded)
  }

  async #adopt(root: string, loaded: Awaited<ReturnType<typeof readProject>>): Promise<ProjectView> {
    await this.close(false)
    const session = new ProjectSession({ root, model: loaded.model, texts: loaded.texts, bus: this.#bus, log: this.#log })
    session.watch()
    this.#session = session
    await this.#state.touchRecent(root, loaded.model.meta.name || basename(root))
    const view = session.view()
    this.#bus.emit({ kind: 'project-opened', project: view })
    this.#log.info('project opened', { root })
    return view
  }

  async close(announce = true): Promise<void> {
    const s = this.#session
    if (s === null) return
    this.#session = null
    await s.close()
    if (announce) this.#bus.emit({ kind: 'project-closed' })
  }

  apply(req: ApplyRequest, source: ApplyOptions['source'] = 'user'): { version: number } {
    const ops: Op[] = parseOps(req.ops)
    return this.require().apply(ops, {
      source,
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(req.coalesceKey !== undefined ? { coalesceKey: req.coalesceKey } : {}),
      ...(req.txId !== undefined ? { txId: req.txId } : {}),
    })
  }
}
