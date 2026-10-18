// Small per-project collections kept beside the model, one JSON file per item under `.harpoon/<kind>/`, so they are
// versioned with the project: saved views (presentation scenes), simulator scenarios, saved table views.
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { HarpoonError } from '../errors.ts'
import { writeJsonAtomic } from '../store/atomic.ts'
import { IdZ } from '../../shared/model/schema.ts'
import type { CollectionItem, CollectionItems, CollectionKind } from '../../shared/ipc.ts'
import { DECISION_STATUSES, TABLE_TABS } from '../../shared/ipc.ts'
import { HARPOON_DIRNAME } from './files.ts'

export const ViewZ = z.object({
  id: IdZ,
  name: z.string().min(1).max(200),
  notes: z.string().max(20_000).default(''),
  order: z.number().default(0),
  focusId: z.string().nullable().default(null),
  expanded: z.array(z.string()).max(2000).default([]),
  nodeStyle: z.enum(['flat', 'iso']).nullable().default(null),
  flowId: z.string().nullable().default(null),
  blast: z.object({ id: z.string(), dir: z.enum(['upstream', 'downstream', 'both']) }).nullable().default(null),
  camera: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).nullable().default(null),
  asOf: z.string().max(100).nullable().default(null),
})

const FaultZ = z.object({
  id: z.string(),
  type: z.enum(['down', 'latency', 'partition', 'ratelimit', 'errors']),
  target: z.string(),
  value: z.number(),
  from: z.number(),
  until: z.number().nullable(),
})

export const ScenarioZ = z.object({
  id: IdZ,
  name: z.string().min(1).max(200),
  multiplier: z.number().min(0).max(1000),
  profile: z.enum(['constant', 'ramp', 'spike', 'diurnal']),
  faults: z.array(FaultZ).max(500),
})

export const TableViewZ = z.object({
  id: IdZ,
  name: z.string().min(1).max(200),
  tab: z.enum(TABLE_TABS),
  hidden: z.array(z.string().max(100)).max(100).default([]),
  sorting: z.array(z.object({ id: z.string().max(100), desc: z.boolean() })).max(10).default([]),
  filters: z.array(z.object({ id: z.string().max(100), value: z.string().max(500) })).max(50).default([]),
  grouping: z.array(z.string().max(100)).max(5).default([]),
  search: z.string().max(500).default(''),
})

const SourceZ = z.object({ kind: z.enum(['note', 'chat', 'manual']), ref: z.string().max(500).nullable(), label: z.string().max(300).nullable() }).nullable().default(null)

export const SolutionSetZ = z.object({
  id: IdZ,
  title: z.string().min(1).max(300),
  problem: z.string().max(20_000).default(''),
  constraints: z.string().max(20_000).default(''),
  criteria: z.array(z.object({ id: z.string().max(100), name: z.string().min(1).max(200), weight: z.number().min(0).max(5) })).max(20).default([]),
  options: z.array(z.string().max(200)).max(10).default([]),
  scores: z
    .array(z.object({ option: z.string().max(200), criterion: z.string().max(100), score: z.number().min(0).max(5), note: z.string().max(2000).default('') }))
    .max(200)
    .default([]),
  recommendation: z.object({ option: z.string().max(200), why: z.string().max(5000) }).nullable().default(null),
  status: z.enum(['open', 'decided', 'abandoned']).default('open'),
  chosen: z.string().max(200).nullable().default(null),
  decisionId: z.string().max(100).nullable().default(null),
  runId: z.string().max(200).nullable().default(null),
  createdAt: z.number().default(0),
  source: SourceZ,
})

export const DecisionZ = z.object({
  id: IdZ,
  number: z.number().int().min(0),
  title: z.string().min(1).max(300),
  status: z.enum(DECISION_STATUSES).default('proposed'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deciders: z.array(z.string().max(200)).max(50).default([]),
  context: z.string().max(50_000).default(''),
  decision: z.string().max(50_000).default(''),
  consequences: z.string().max(50_000).default(''),
  options: z
    .array(
      z.object({
        proposalId: z.string().max(200).nullable().default(null),
        title: z.string().max(300),
        summary: z.string().max(5000).default(''),
        chosen: z.boolean().default(false),
        whyNot: z.string().max(5000).default(''),
      }),
    )
    .max(20)
    .default([]),
  entityIds: z.array(z.string().max(100)).max(500).default([]),
  phase: z.string().max(100).nullable().default(null),
  supersedes: z.string().max(100).nullable().default(null),
  supersededBy: z.string().max(100).nullable().default(null),
  solutionSetId: z.string().max(100).nullable().default(null),
  links: z.array(z.object({ title: z.string().max(300), url: z.string().max(2000) })).max(50).default([]),
  source: SourceZ,
  createdAt: z.number().default(0),
})

interface Spec<K extends CollectionKind> {
  schema: z.ZodType<CollectionItems[K]>
  sort: (a: CollectionItems[K], b: CollectionItems[K]) => number
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)

const SPECS: { [K in CollectionKind]: Spec<K> } = {
  views: { schema: ViewZ, sort: (a, b) => a.order - b.order || byName(a, b) },
  scenarios: { schema: ScenarioZ, sort: byName },
  tables: { schema: TableViewZ, sort: byName },
  solutions: { schema: SolutionSetZ, sort: (a, b) => b.createdAt - a.createdAt },
  decisions: { schema: DecisionZ, sort: (a, b) => a.number - b.number },
}

const dirOf = (root: string, kind: CollectionKind): string => join(root, HARPOON_DIRNAME, kind)

export async function listCollection<K extends CollectionKind>(root: string, kind: K): Promise<CollectionItems[K][]> {
  const spec = SPECS[kind] as unknown as Spec<K>
  const dir = dirOf(root, kind)
  const files = await readdir(dir).catch(() => [] as string[])
  const out: CollectionItems[K][] = []
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    try {
      const raw: unknown = JSON.parse(await readFile(join(dir, f), 'utf8'))
      const r = spec.schema.safeParse(raw)
      if (r.success) out.push(r.data)
    } catch {
      // an unreadable file is skipped, never fatal
    }
  }
  return out.sort(spec.sort)
}

export async function putCollection(root: string, kind: CollectionKind, item: unknown): Promise<CollectionItem> {
  const r = SPECS[kind].schema.safeParse(item)
  if (!r.success) throw new HarpoonError('VALIDATION', r.error.issues[0]?.message ?? 'invalid item')
  await writeJsonAtomic(join(dirOf(root, kind), `${r.data.id}.json`), r.data, { mode: 0o644 })
  return r.data
}

export async function deleteCollection(root: string, kind: CollectionKind, id: string): Promise<void> {
  const parsed = IdZ.safeParse(id)
  if (!parsed.success) throw new HarpoonError('VALIDATION', 'invalid id')
  await rm(join(dirOf(root, kind), `${parsed.data}.json`), { force: true })
}
