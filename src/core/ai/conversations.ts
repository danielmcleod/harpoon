// AI conversations kept between sessions, per project, on this computer only (HARPOON_HOME/conversations/<project
// id>/<run id>.json): not in the project folder, so chats and the code they quote never reach git or a shared design.
// Enough to show the conversation again and to continue it (the CLI keeps its own session; Harpoon keeps its id).
import { readdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiContext, AiRunView, AiSelection } from '../../shared/ipc.ts'
import { writeJsonAtomic } from '../store/atomic.ts'

/** Conversations kept per project (the oldest go first). */
export const KEEP_PER_PROJECT = 50

export interface SavedConversation {
  version: 1
  projectId: string
  view: AiRunView
  /** The CLI's session or thread, to resume (null: none to resume). */
  sessionId: string | null
  context: AiContext
  selection: AiSelection
  planPrompt: string | null
  planSaved: string | null
  proposalSeq: number
}

const safe = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '_')

export class ConversationStore {
  readonly #dir: string

  constructor(dir: string) {
    this.#dir = dir
  }

  #projectDir(projectId: string): string {
    return join(this.#dir, safe(projectId))
  }

  async save(c: SavedConversation): Promise<void> {
    await writeJsonAtomic(join(this.#projectDir(c.projectId), `${safe(c.view.id)}.json`), c)
  }

  /** The project's conversations, newest first (unreadable files are skipped). */
  async list(projectId: string): Promise<SavedConversation[]> {
    let names: string[]
    try {
      names = (await readdir(this.#projectDir(projectId))).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
    const out: SavedConversation[] = []
    for (const n of names) {
      try {
        const c = JSON.parse(await readFile(join(this.#projectDir(projectId), n), 'utf8')) as SavedConversation
        if (c.version === 1 && typeof c.view?.id === 'string' && Array.isArray(c.view.turns)) out.push(c)
      } catch {
        // a half-written or foreign file: skip it
      }
    }
    return out.sort((a, b) => b.view.createdAt - a.view.createdAt)
  }

  async remove(projectId: string, runId: string): Promise<void> {
    await rm(join(this.#projectDir(projectId), `${safe(runId)}.json`), { force: true })
  }

  /** Keep the newest `keep` conversations of a project. */
  async prune(projectId: string, keep = KEEP_PER_PROJECT): Promise<void> {
    const all = await this.list(projectId)
    for (const c of all.slice(keep)) await this.remove(projectId, c.view.id)
  }
}
