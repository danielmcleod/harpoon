// Paths that come from project data (evidence, notes) are only ever resolved inside a folder Harpoon chose: relative,
// no `..`, and checked again after following links, so a shared project cannot point the app at the rest of the disk.
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { HarpoonError } from '../errors.ts'

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
