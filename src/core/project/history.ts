// The project's past, read from git: the commits that changed .harpoon/project.json or layout.json, and the model as
// it was at any of them. Read-only (`git log`, `git show`); nothing is checked out, so the working tree never moves.
import { relative } from 'node:path'
import type { HistoryCommit, ProjectHistory } from '../../shared/ipc.ts'
import type { Model } from '../../shared/model/schema.ts'
import { HarpoonError } from '../errors.ts'
import { resolvePathEnv } from '../proc/path-env.ts'
import { execCapture } from '../proc/spawn.ts'
import { parseModelWithRepairs, projectPaths } from './files.ts'

/** The most recent commits shown; older history is left out. */
export const HISTORY_LIMIT = 300
const SHA = /^[0-9a-f]{7,40}$/
const FIELD = '\u001f'

async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; out: string; err: string; missing: boolean }> {
  const path = (await resolvePathEnv()).path
  const r = await execCapture('git', args, {
    cwd,
    env: { ...process.env, PATH: path, GIT_TERMINAL_PROMPT: '0' },
    timeoutMs: 30_000,
    killTree: true,
  })
  return {
    ok: r.error === undefined && r.code === 0,
    out: r.stdout,
    err: r.stderr.trim(),
    missing: r.error !== undefined,
  }
}

/** A project file's path as git wants it in `log -- <path>` and `show <rev>:./<path>`: relative, forward slashes. */
function inRepo(root: string, file: string): string {
  return relative(root, file).split('\\').join('/')
}

/** The commits that changed the project's two files, oldest first. */
export async function listHistory(root: string): Promise<ProjectHistory> {
  const paths = projectPaths(root)
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'])
  if (inside.missing) return { commits: [], unavailable: 'git was not found, so the history cannot be read.' }
  if (!inside.ok)
    return {
      commits: [],
      unavailable:
        'This project is not in a git repository, so it has no history yet. Commit the .harpoon folder to start one.',
    }
  const log = await git(root, [
    'log',
    '-n',
    String(HISTORY_LIMIT),
    `--format=%H${FIELD}%at${FIELD}%an${FIELD}%s`,
    '--',
    inRepo(root, paths.project),
    inRepo(root, paths.layout),
  ])
  // A repository without commits yet: `git log` fails, and there is simply no history.
  if (!log.ok) return { commits: [], unavailable: null }
  const commits: HistoryCommit[] = []
  for (const line of log.out.split('\n')) {
    const [sha, at, author, ...subject] = line.trim().split(FIELD)
    if (sha === undefined || at === undefined || !SHA.test(sha)) continue
    commits.push({ sha, at: Number(at) * 1000, author: author ?? '', subject: subject.join(FIELD) })
  }
  return { commits: commits.reverse(), unavailable: null }
}

/** The model as committed at `sha` (repaired like any loaded project; `repairs` says what was wrong with it). */
export async function snapshotAt(root: string, sha: string): Promise<{ model: Model; repairs: string[] }> {
  // The revision goes into a git argument: only a plain hash, never anything git could read as an option or a path.
  if (!SHA.test(sha)) throw new HarpoonError('VALIDATION', 'Not a commit hash.')
  const paths = projectPaths(root)
  const project = await git(root, ['show', `${sha}:./${inRepo(root, paths.project)}`])
  if (!project.ok)
    throw new HarpoonError('NOT_FOUND', `The project file is not in commit ${sha.slice(0, 7)}.`)
  // Layouts arrived with the first saved positions: an older commit may have none.
  const layout = await git(root, ['show', `${sha}:./${inRepo(root, paths.layout)}`])
  return parseModelWithRepairs(project.out, layout.ok ? layout.out : null)
}
