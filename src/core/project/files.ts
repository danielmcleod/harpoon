// The `.harpoon/` folder: project.json (semantics), layout.json (coordinates), proposals/, views/, scenarios/.
// Arrays are sorted by id and written with stable formatting so a git diff shows only what changed.
import { access, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { HarpoonError } from '../errors.ts'
import { slugify } from '../../shared/model/ids.ts'
import {
  LayoutFileZ,
  ProjectFileZ,
  SCHEMA_VERSION,
  emptyModel,
  layoutFileOf,
  modelFromFiles,
  projectFileOf,
} from '../../shared/model/schema.ts'
import type { LayoutFile, Model } from '../../shared/model/schema.ts'
import { writeFileAtomic } from '../store/atomic.ts'

export const HARPOON_DIRNAME = '.harpoon'

export interface ProjectPaths {
  /** The folder the project belongs to (usually a repo root). */
  root: string
  dir: string
  project: string
  layout: string
  proposalsDir: string
  viewsDir: string
  scenariosDir: string
  docsDir: string
  readme: string
}

export function projectPaths(root: string): ProjectPaths {
  const dir = join(root, HARPOON_DIRNAME)
  return {
    root,
    dir,
    project: join(dir, 'project.json'),
    layout: join(dir, 'layout.json'),
    proposalsDir: join(dir, 'proposals'),
    viewsDir: join(dir, 'views'),
    scenariosDir: join(dir, 'scenarios'),
    docsDir: join(dir, 'docs'),
    readme: join(dir, 'README.md'),
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Accept the project root or its `.harpoon` folder. */
export function normalizeRoot(dir: string): string {
  return basename(dir) === HARPOON_DIRNAME ? join(dir, '..') : dir
}

export function serializeModel(m: Model): { project: string; layout: string } {
  return {
    project: `${JSON.stringify(projectFileOf(m), null, 2)}\n`,
    layout: `${JSON.stringify(layoutFileOf(m), null, 2)}\n`,
  }
}

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown
  } catch (err) {
    throw new HarpoonError('VALIDATION', `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}


/** One message for the repairs made on load (the first few, then how many more). */
export function repairNotice(repairs: readonly string[]): string {
  const shown = repairs.slice(0, 3).join(' ')
  const more = repairs.length > 3 ? ` And ${repairs.length - 3} more (see the log).` : ''
  return `This project had broken references and was repaired: ${shown}${more} Undo is not possible; check the file's history if this is unexpected.`
}

/**
 * Mend what a git merge or a hand edit can leave behind (each side valid on its own, the result not): a node inside a
 * parent that does not exist, or inside itself through a parent cycle, moves to the top level; a connector with a
 * missing end is dropped. Changes `m` in place and returns one line per repair (empty: nothing was wrong).
 */
export function repairModel(m: Model): string[] {
  const repairs: string[] = []
  const detach = (id: string, why: string): void => {
    const n = m.nodes[id]
    if (n === undefined) return
    m.nodes[id] = { ...n, parentId: null }
    repairs.push(`${n.name} (${id}) ${why}; it is now on the top level.`)
  }
  for (const n of Object.values(m.nodes)) {
    if (n.parentId !== null && !Object.hasOwn(m.nodes, n.parentId)) detach(n.id, `was inside "${n.parentId}", which does not exist`)
  }
  // Walk up from every node (sorted, so the same file always mends the same way); the link that closes a cycle goes.
  for (const id of Object.keys(m.nodes).sort()) {
    const seen = new Set<string>([id])
    for (let cur = id; ; ) {
      const up: string | null = m.nodes[cur]?.parentId ?? null
      if (up === null) break
      if (seen.has(up)) {
        detach(cur, `was inside "${up}", which is inside it`)
        break
      }
      seen.add(up)
      cur = up
    }
  }
  for (const c of Object.values(m.connectors)) {
    const missing = [c.source, c.target].filter((end) => !Object.hasOwn(m.nodes, end))
    if (missing.length === 0) continue
    delete m.connectors[c.id]
    repairs.push(`Connector ${c.id} (${c.source} → ${c.target}) was dropped: ${missing.map((x) => `"${x}"`).join(' and ')} ${missing.length === 1 ? 'does' : 'do'} not exist.`)
  }
  return repairs
}

export function parseModel(projectText: string, layoutText: string | null): Model {
  return parseModelWithRepairs(projectText, layoutText).model
}

/** `parseModel`, plus what had to be mended to make the file load (see `repairModel`). */
export function parseModelWithRepairs(projectText: string, layoutText: string | null): { model: Model; repairs: string[] } {
  const raw = parseJson(projectText, 'project.json')
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion
  if (typeof version === 'number' && version > SCHEMA_VERSION) {
    throw new HarpoonError('NEWER_SCHEMA', `This project was saved by a newer Harpoon (schema ${version}).`)
  }
  const p = ProjectFileZ.safeParse(raw)
  if (!p.success) {
    const first = p.error.issues[0]
    const where = first === undefined ? '' : ` at ${first.path.join('.')}: ${first.message}`
    throw new HarpoonError('VALIDATION', `project.json does not match the schema${where}`, { details: p.error.issues })
  }
  let layout: LayoutFile | null = null
  if (layoutText !== null) {
    const l = LayoutFileZ.safeParse(parseJson(layoutText, 'layout.json'))
    // A broken layout is not fatal: nodes without coordinates are auto-placed.
    if (l.success) layout = l.data
  }
  const model = modelFromFiles(p.data, layout)
  return { model, repairs: repairModel(model) }
}

export interface LoadedProject {
  model: Model
  texts: { project: string; layout: string | null }
  /** What `repairModel` mended on the way in (absent: nothing). The texts are the files as read, unrepaired. */
  repairs?: string[]
}

export async function readProject(root: string): Promise<LoadedProject> {
  const paths = projectPaths(root)
  let project: string
  try {
    project = await readFile(paths.project, 'utf8')
  } catch {
    throw new HarpoonError('NOT_FOUND', `No Harpoon project in ${root} (missing ${HARPOON_DIRNAME}/project.json).`)
  }
  const layout = await readFile(paths.layout, 'utf8').catch(() => null)
  const { model, repairs } = parseModelWithRepairs(project, layout)
  return { model, texts: { project, layout }, ...(repairs.length > 0 ? { repairs } : {}) }
}

export async function writeProjectTexts(root: string, texts: { project: string; layout: string }): Promise<void> {
  const paths = projectPaths(root)
  await writeFileAtomic(paths.project, texts.project, { mode: 0o644 })
  await writeFileAtomic(paths.layout, texts.layout, { mode: 0o644 })
}

const README = `# .harpoon

This folder holds a Harpoon architecture design.

- \`project.json\`: services, connectors, boundaries and flows (sorted by id, safe to diff and review).
- \`layout.json\`: where each node sits on the hex grid (kept apart so moving things never clutters a review).
- \`proposals/\`: AI or manual change sets waiting to be accepted.
- \`views/\`: saved views and presentation scenes.
- \`scenarios/\`: traffic-simulation scenarios.
- \`solutions/\`, \`decisions/\`, \`notes/\`, \`tables/\`: comparisons, decision records, notes and saved table views.

It is saved as you work. Git is optional: inside a repository, commit this folder with your code so the
architecture is versioned alongside it.
`

export async function initProject(root: string, name?: string): Promise<LoadedProject> {
  const paths = projectPaths(root)
  if (await exists(paths.project)) {
    throw new HarpoonError('CONFLICT', `${root} already has a Harpoon project.`)
  }
  const display = name?.trim() || basename(root) || 'Architecture'
  const model = emptyModel({ id: slugify(display), name: display })
  const texts = serializeModel(model)
  await writeProjectTexts(root, texts)
  await writeFileAtomic(paths.readme, README, { mode: 0o644 })
  return { model, texts }
}
