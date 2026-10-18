// Proposals: an AI run's (or later, any) reviewed change set, kept in `.harpoon/proposals/<id>.json` so a plan can
// wait for later. Accepting applies its ops (all, or a chosen subset) to the live model as one undoable step.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { EventBus } from '../bus.ts'
import { HarpoonError } from '../errors.ts'
import type { Logger } from '../log.ts'
import { projectPaths } from '../project/files.ts'
import type { ProjectManager } from '../project/manager.ts'
import { writeJsonAtomic } from '../store/atomic.ts'
import { AI_MODES, AI_VENDORS, EFFORTS } from '../../shared/ipc.ts'
import type { Proposal } from '../../shared/ipc.ts'
import { OpZ, parseOps } from '../../shared/model/ops.ts'
import type { Op } from '../../shared/model/ops.ts'

const ProposalFileZ = z.object({
  id: z.string(),
  runId: z.string(),
  title: z.string(),
  rationale: z.string(),
  risks: z.string().nullable(),
  vendor: z.enum(AI_VENDORS),
  mode: z.enum(AI_MODES),
  prompt: z.string(),
  createdAt: z.number(),
  status: z.enum(['pending', 'accepted', 'discarded']),
  ops: z.array(OpZ),
  source: z.object({ kind: z.enum(['note', 'chat', 'manual']), ref: z.string().nullable(), label: z.string().nullable() }).nullable().default(null),
  option: z
    .object({
      solutionSetId: z.string(),
      key: z.string(),
      summary: z.string().default(''),
      pros: z.array(z.string()).default([]),
      cons: z.array(z.string()).default([]),
      effort: z.enum(EFFORTS).nullable().default(null),
    })
    .nullable()
    .default(null),
})

/** Mark everything a batch adds as planned (accept-as-planned keeps a roadmap layer visible). */
/** New things become planned (and land in `phase`, when given); removals become deprecations in that phase. */
export function asPlanned(ops: readonly Op[], phase: string | null = null): Op[] {
  const ph = phase === null ? {} : { phase }
  return ops.flatMap((o): Op[] => {
    if (o.op === 'addNode') return [{ ...o, node: { ...o.node, status: 'planned', ...ph, features: o.node.features.map((f) => ({ ...f, status: 'planned' as const, ...ph })) } }]
    if (o.op === 'addConnector') return [{ ...o, connector: { ...o.connector, status: 'planned', ...ph } }]
    if (o.op === 'removeNode') return [{ op: 'updateNode', id: o.id, patch: { status: 'deprecated', ...ph } }]
    if (o.op === 'removeConnector') return [{ op: 'updateConnector', id: o.id, patch: { status: 'deprecated', ...ph } }]
    return [o]
  })
}

export class ProposalStore {
  readonly #items = new Map<string, Proposal>()
  #root: string | null = null
  readonly #bus: EventBus
  readonly #log: Logger
  readonly #projects: ProjectManager

  constructor(o: { bus: EventBus; log: Logger; projects: ProjectManager }) {
    this.#bus = o.bus
    this.#log = o.log
    this.#projects = o.projects
  }

  /** Load the open project's saved proposals (call after a project opens). */
  async load(root: string | null): Promise<void> {
    this.#items.clear()
    this.#root = root
    if (root === null) return
    const dir = projectPaths(root).proposalsDir
    const files = await readdir(dir).catch(() => [] as string[])
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      try {
        const p = ProposalFileZ.parse(JSON.parse(await readFile(join(dir, f), 'utf8')))
        this.#items.set(p.id, { ...p, ops: parseOps(p.ops) })
      } catch (err) {
        this.#log.warn('skipping an unreadable proposal', { file: f, err: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  list(): Proposal[] {
    return [...this.#items.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): Proposal | undefined {
    return this.#items.get(id)
  }

  async put(p: Proposal): Promise<void> {
    this.#items.set(p.id, p)
    this.#bus.emit({ kind: 'proposal', proposal: p })
    if (this.#root !== null) await writeJsonAtomic(join(projectPaths(this.#root).proposalsDir, `${p.id}.json`), p, { mode: 0o644 })
  }

  async accept(id: string, opIndexes?: number[], planned = false, phase: string | null = null): Promise<{ version: number }> {
    const p = this.#items.get(id)
    if (p === undefined) throw new HarpoonError('NOT_FOUND', 'That proposal no longer exists.')
    if (p.status !== 'pending') throw new HarpoonError('CONFLICT', `That proposal was already ${p.status}.`)
    let ops = opIndexes === undefined ? p.ops : opIndexes.map((i) => p.ops[i]).filter((o): o is Op => o !== undefined)
    if (planned) ops = asPlanned(ops, phase)
    if (ops.length === 0) throw new HarpoonError('VALIDATION', 'Nothing selected to accept.')
    const r = this.#projects.require().apply(ops, { label: `AI: ${p.title}`, source: 'ai' })
    await this.put({ ...p, status: 'accepted' })
    return r
  }

  async setOption(id: string, option: Proposal['option']): Promise<void> {
    const p = this.#items.get(id)
    if (p === undefined) throw new HarpoonError('NOT_FOUND', 'That proposal no longer exists.')
    await this.put({ ...p, option })
  }

  async discard(id: string): Promise<void> {
    const p = this.#items.get(id)
    if (p === undefined) return
    await this.put({ ...p, status: 'discarded' })
  }
}
