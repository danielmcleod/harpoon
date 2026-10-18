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

export function parseModel(projectText: string, layoutText: string | null): Model {
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
  return modelFromFiles(p.data, layout)
}

export interface LoadedProject {
  model: Model
  texts: { project: string; layout: string | null }
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
  return { model: parseModel(project, layout), texts: { project, layout } }
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
