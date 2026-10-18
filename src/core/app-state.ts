// HARPOON_HOME/state.json: theme, node style and recent projects. A missing or invalid file gives the defaults
// (an invalid one is kept aside as state.json.bad so nothing is silently lost).
import { rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { AppState, AppStatePatch, RecentProject } from '../shared/ipc.ts'
import { NODE_STYLES, THEMES } from '../shared/ipc.ts'
import { readJsonFile, writeJsonAtomic } from './store/atomic.ts'

export const RECENT_MAX = 12

/** New local designs go here unless the user picked another folder. */
export const DEFAULT_DESIGNS_DIR = join(homedir(), 'Documents', 'Harpoon')

export const DEFAULT_APP_STATE: AppState = {
  schemaVersion: 1,
  theme: 'dark',
  nodeStyle: 'flat',
  recentProjects: [],
  repoPaths: {},
  designsDir: DEFAULT_DESIGNS_DIR,
  notionServers: {},
}

const AppStateZ = z.object({
  schemaVersion: z.literal(1),
  theme: z.enum(THEMES).catch('dark'),
  nodeStyle: z.enum(NODE_STYLES).catch('flat'),
  recentProjects: z
    .array(z.object({ path: z.string(), name: z.string(), openedAt: z.number() }))
    .catch([])
    .transform((r) => r.slice(0, RECENT_MAX)),
  repoPaths: z.record(z.string(), z.record(z.string(), z.string())).catch({}).default({}),
  designsDir: z.string().min(1).catch(DEFAULT_DESIGNS_DIR).default(DEFAULT_DESIGNS_DIR),
  notionServers: z.record(z.string(), z.string()).catch({}).default({}),
})

export class AppStateStore {
  readonly #file: string
  #state: AppState = DEFAULT_APP_STATE

  constructor(file: string) {
    this.#file = file
  }

  get state(): AppState {
    return this.#state
  }

  async load(): Promise<AppState> {
    const r = await readJsonFile(this.#file)
    if (r.kind === 'ok') {
      const p = AppStateZ.safeParse(r.value)
      if (p.success) {
        this.#state = p.data
        return this.#state
      }
    }
    if (r.kind !== 'missing') await rename(this.#file, `${this.#file}.bad`).catch(() => undefined)
    this.#state = DEFAULT_APP_STATE
    return this.#state
  }

  async patch(p: AppStatePatch): Promise<AppState> {
    this.#state = {
      ...this.#state,
      ...(p.theme !== undefined ? { theme: p.theme } : {}),
      ...(p.nodeStyle !== undefined ? { nodeStyle: p.nodeStyle } : {}),
      ...(p.designsDir !== undefined ? { designsDir: p.designsDir } : {}),
    }
    await writeJsonAtomic(this.#file, this.#state)
    return this.#state
  }

  /** Remember (or forget, with null) where this machine keeps one of a project's repos. */
  async setRepoPath(projectId: string, repoId: string, path: string | null): Promise<Record<string, string>> {
    const cur = { ...(this.#state.repoPaths[projectId] ?? {}) }
    if (path === null) delete cur[repoId]
    else cur[repoId] = path
    this.#state = { ...this.#state, repoPaths: { ...this.#state.repoPaths, [projectId]: cur } }
    await writeJsonAtomic(this.#file, this.#state)
    return cur
  }

  async setNotionServer(projectId: string, server: string | null): Promise<void> {
    const next = { ...this.#state.notionServers }
    if (server === null) delete next[projectId]
    else next[projectId] = server
    this.#state = { ...this.#state, notionServers: next }
    await writeJsonAtomic(this.#file, this.#state)
  }

  /** Move (or add) a project to the top of the recent list. */
  async touchRecent(path: string, name?: string, now = Date.now()): Promise<RecentProject[]> {
    const entry: RecentProject = { path, name: name ?? basename(path), openedAt: now }
    const rest = this.#state.recentProjects.filter((r) => r.path !== path)
    this.#state = { ...this.#state, recentProjects: [entry, ...rest].slice(0, RECENT_MAX) }
    await writeJsonAtomic(this.#file, this.#state)
    return this.#state.recentProjects
  }

  async forgetRecent(path: string): Promise<RecentProject[]> {
    this.#state = { ...this.#state, recentProjects: this.#state.recentProjects.filter((r) => r.path !== path) }
    await writeJsonAtomic(this.#file, this.#state)
    return this.#state.recentProjects
  }
}
