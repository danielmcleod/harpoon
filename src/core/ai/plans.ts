// Implementation plans saved as Markdown files: `<plans folder>/<yyyy-mm-dd>-<slug>.md`. The folder is a setting on
// this machine (default `.harpoon/plans` in the project): a relative one stays inside the project folder.
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { HarpoonError } from '../errors.ts'
import { writeFileAtomic } from '../store/atomic.ts'
import { isPlainRelative } from '../project/confine.ts'
import { slugify } from './git-prep.ts'

/** The plans folder for a project: an absolute setting as it is, a relative one under the project (never outside it). */
export async function plansFolder(root: string, setting: string): Promise<string> {
  const dir = setting.trim()
  if (isAbsolute(dir)) {
    await mkdir(dir, { recursive: true })
    return dir
  }
  if (!isPlainRelative(dir)) throw new HarpoonError('VALIDATION', 'The plans folder must be inside the project (no "..") or an absolute folder. Change it in Settings → AI → Implementing.')
  const realRoot = await realpath(root)
  const target = resolve(realRoot, dir)
  await mkdir(target, { recursive: true })
  const real = await realpath(target)
  const rel = relative(realRoot, real)
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new HarpoonError('FORBIDDEN', 'The plans folder leads outside the project.')
  return real
}

/**
 * Write a plan as `<yyyy-mm-dd>-<slug>.md` (a `-2`, `-3`… suffix when a different plan has that name; the same plan
 * again reuses its file). Returns the file's path.
 */
export async function savePlanFile(o: { root: string; plansDir: string; title: string; markdown: string; now?: Date }): Promise<string> {
  const dir = await plansFolder(o.root, o.plansDir)
  const base = `${(o.now ?? new Date()).toISOString().slice(0, 10)}-${slugify(o.title)}`
  const body = o.markdown.endsWith('\n') ? o.markdown : `${o.markdown}\n`
  for (let n = 1; n < 100; n++) {
    const file = join(dir, `${base}${n === 1 ? '' : `-${n}`}.md`)
    const existing = await readFile(file, 'utf8').catch(() => null)
    if (existing !== null && existing !== body) continue
    if (existing === null) await writeFileAtomic(file, body)
    return file
  }
  throw new HarpoonError('CONFLICT', `Too many plans named ${base} in ${dir}.`)
}
