// Paths that come from project data (evidence, notes) are only ever resolved inside a folder Harpoon chose: relative,
// no `..`, and checked again after following links, so a shared project cannot point the app at the rest of the disk.
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { HarpoonError, errnoCode } from '../errors.ts'

/** A relative path with no drive, no leading slash and no `..` segment. */
export function isPlainRelative(p: string): boolean {
  const s = p.replace(/\\/g, '/')
  return s !== '' && !isAbsolute(s) && !/^[a-zA-Z]:/.test(s) && !s.startsWith('/') && !s.split('/').includes('..') && !s.includes('\0')
}

const within = (base: string, p: string): boolean => {
  const rel = relative(base, p)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** `rel` resolved under `base`, following links on both, and refused if it ends up outside. */
export async function confined(base: string, rel: string): Promise<string> {
  if (!isPlainRelative(rel)) throw new HarpoonError('FORBIDDEN', 'Only paths inside the project or a linked repository can be opened.')
  const realBase = await realpath(base)
  const target = await realpath(resolve(realBase, rel)).catch(() => {
    throw new HarpoonError('NOT_FOUND', 'That file is not there (it may have moved, or the repository is not cloned here).')
  })
  if (!within(realBase, target)) throw new HarpoonError('FORBIDDEN', 'That path leads outside the project.')
  return target
}

/**
 * The folder `rel` under `base` for writing, made step by step when it is not there: a link on the way is followed
 * only while it stays inside `base`, and nothing is ever created outside it.
 */
export async function confinedDir(base: string, rel: string): Promise<string> {
  if (!isPlainRelative(rel)) throw new HarpoonError('FORBIDDEN', 'Only folders inside the project can be written to.')
  const realBase = await realpath(base)
  let cur = realBase
  for (const part of rel.split(/[\\/]/)) {
    if (part === '' || part === '.') continue
    await mkdir(join(cur, part)).catch((err: unknown) => {
      if (errnoCode(err) !== 'EEXIST') throw err
    })
    // A link that leads nowhere has no real path: refused like one that leads outside.
    const next = await realpath(join(cur, part)).catch(() => null)
    if (next === null || !within(realBase, next)) throw new HarpoonError('FORBIDDEN', 'That path leads outside the project.')
    cur = next
  }
  return cur
}

/** Refuse `file` when it is a link: what is written to it would land wherever the link points. */
export async function assertNotLink(file: string): Promise<void> {
  const st = await lstat(file).catch(() => null)
  if (st?.isSymbolicLink() === true) throw new HarpoonError('FORBIDDEN', 'Files are not written through a link.')
}
