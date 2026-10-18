// The repositories a project describes. The project file says which repos (id, remote, a path hint); where each one
// is cloned on this machine lives in app state, since teammates keep their clones in different places. Discovery
// lists the git repos under a folder, with their remotes, so they can be linked in a click.
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, parse, relative, resolve } from 'node:path'
import type { DiscoveredRepo, ResolvedRepo } from '../../shared/ipc.ts'
import type { RepoRef } from '../../shared/model/schema.ts'

const SKIP = new Set(['node_modules', '.git', '.harpoon', 'dist', 'out', 'build', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.idea', '.vscode'])

const isDir = (p: string): Promise<boolean> =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  )

/** The git directory of a working tree (`.git` folder, or the `gitdir:` a worktree's `.git` file points at). */
async function gitDirOf(dir: string): Promise<string | null> {
  const dotGit = join(dir, '.git')
  const s = await stat(dotGit).catch(() => null)
  if (s === null) return null
  if (s.isDirectory()) return dotGit
  const text = await readFile(dotGit, 'utf8').catch(() => '')
  const m = /^gitdir:\s*(.+)$/m.exec(text)
  if (m?.[1] === undefined) return null
  const p = m[1].trim()
  return isAbsolute(p) ? p : resolve(dir, p)
}

/** `origin`'s URL (or the first remote's) from a git config file. */
export function remoteFromConfig(config: string): string | null {
  let section: string | null = null
  const urls: { name: string; url: string }[] = []
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim()
    const sec = /^\[remote\s+"([^"]+)"\]$/.exec(line)
    if (sec !== null) {
      section = sec[1] ?? null
      continue
    }
    if (line.startsWith('[')) section = null
    const url = /^url\s*=\s*(.+)$/.exec(line)
    if (section !== null && url?.[1] !== undefined) urls.push({ name: section, url: url[1].trim() })
  }
  return (urls.find((u) => u.name === 'origin') ?? urls[0])?.url ?? null
}

/** Name, remote and checked-out branch of a working tree (null: not a git repo). */
export async function inspectRepo(dir: string): Promise<DiscoveredRepo | null> {
  const git = await gitDirOf(dir)
  if (git === null) return null
  // A linked worktree keeps its config in the common dir.
  const common = await readFile(join(git, 'commondir'), 'utf8').then(
    (c) => resolve(git, c.trim()),
    () => git,
  )
  const config = await readFile(join(common, 'config'), 'utf8').catch(() => '')
  const head = await readFile(join(git, 'HEAD'), 'utf8').catch(() => '')
  const branch = /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? null
  const remote = remoteFromConfig(config)
  return { path: resolve(dir), name: repoNameOf(remote) ?? basename(resolve(dir)), remote, branch }
}

/** `git@github.com:acme/payments.git` → `payments`. */
export function repoNameOf(remote: string | null): string | null {
  if (remote === null) return null
  const m = /([^/:\\]+?)(\.git)?\/?$/.exec(remote.trim())
  return m?.[1] ?? null
}

/** Git repositories at or below `dir` (a few levels deep; does not descend into a repo it found). */
export async function discoverRepos(dir: string, depth = 3): Promise<DiscoveredRepo[]> {
  const out: DiscoveredRepo[] = []
  const walk = async (d: string, left: number): Promise<void> => {
    const here = await inspectRepo(d)
    if (here !== null) {
      out.push(here)
      return
    }
    if (left === 0 || out.length >= 200) return
    const entries = await readdir(d, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue
      await walk(join(d, e.name), left - 1)
    }
  }
  await walk(resolve(dir), depth)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Same repository? By remote when both have one (ignoring protocol and .git), else by path. */
export function sameRemote(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false
  const norm = (u: string): string =>
    u
      .trim()
      .toLowerCase()
      .replace(/^(https?|ssh|git):\/\//, '')
      .replace(/^[^@]+@/, '')
      .replace(':', '/')
      .replace(/\.git\/?$/, '')
      .replace(/\/$/, '')
  return norm(a) === norm(b)
}

/**
 * Why a path hint from the (shared) project file must not be trusted, or null when it may be used: the AI reads
 * every linked repo, so a hint may only name a git repository, never the home folder, a drive root, or a folder
 * that contains the project.
 */
export async function hintProblem(root: string, hinted: string, home: string = homedir()): Promise<string | null> {
  const p = resolve(hinted)
  const sameAs = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (sameAs(p, parse(p).root)) return 'it is a drive root'
  if (sameAs(p, resolve(home))) return 'it is your home folder'
  const up = relative(p, resolve(root))
  if (up !== '' && !up.startsWith('..') && !isAbsolute(up)) return 'it contains the project folder'
  if ((await inspectRepo(p)) === null) return 'it is not a git repository'
  return null
}

/**
 * Where each linked repo is on this machine: the local path set here (app state), else the project file's path
 * (relative to the project folder) when it exists and passes {@link hintProblem}.
 */
export async function resolveRepos(root: string, repos: readonly RepoRef[], local: Readonly<Record<string, string>>): Promise<ResolvedRepo[]> {
  return Promise.all(
    repos.map(async (r) => {
      const mine = local[r.id]
      if (mine !== undefined && (await isDir(mine))) return { id: r.id, path: resolve(mine), source: 'machine' as const, note: null }
      const hinted = isAbsolute(r.path) ? r.path : resolve(root, r.path)
      if (r.path !== '' && (await isDir(hinted))) {
        const problem = await hintProblem(root, hinted)
        if (problem === null) return { id: r.id, path: hinted, source: 'project' as const, note: null }
        return { id: r.id, path: null, source: 'missing' as const, note: `The project points it at ${hinted}, but ${problem}; Locate it to use it.` }
      }
      return { id: r.id, path: null, source: 'missing' as const, note: null }
    }),
  )
}
