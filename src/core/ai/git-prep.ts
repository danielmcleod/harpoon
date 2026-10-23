// Git before an Implement run, as Settings → AI → Implementing says: follow the repository's own instructions (the
// default: Harpoon runs no git), create a branch first, work in a separate worktree, or work in place. Only plain
// `git` commands through the project's process helper; nothing is ever pushed.
import { basename, dirname, join } from 'node:path'
import type { GitPolicy } from '../../shared/ipc.ts'
import { HarpoonError } from '../errors.ts'
import { resolvePathEnv } from '../proc/path-env.ts'
import { execCapture } from '../proc/spawn.ts'

export const DEFAULT_BRANCH_TEMPLATE = 'harpoon/{slug}'

/** A short, branch- and folder-safe name from a title ("Add a fraud scorer" → "add-a-fraud-scorer"). */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return s === '' ? 'plan' : s
}

/** The template with `{slug}` and `{date}` (yyyy-mm-dd) filled in. */
export function branchName(template: string, slug: string, now = new Date()): string {
  const t = template.trim() === '' ? DEFAULT_BRANCH_TEMPLATE : template.trim()
  return t.replaceAll('{slug}', slug).replaceAll('{date}', now.toISOString().slice(0, 10))
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const path = (await resolvePathEnv()).path
  const r = await execCapture('git', args, { cwd, env: { ...process.env, PATH: path, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 60_000, killTree: true })
  if (r.error !== undefined) throw new HarpoonError('SPAWN', `Could not run git (${r.error.message}). Install git, or choose "Follow the repository's instructions".`)
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() }
}

/** Uncommitted changes in the repository (paths as git prints them); empty when clean. */
export async function uncommitted(repo: string): Promise<string[]> {
  const r = await git(repo, ['status', '--porcelain'])
  if (!r.ok) throw new HarpoonError('VALIDATION', `${repo} is not a git repository (${r.err || 'git status failed'}).`)
  // Harpoon's own design files (.harpoon/) change as you work in Harpoon; a new branch carries them along.
  return r.out === '' ? [] : r.out.split('\n').map((l) => l.slice(3)).filter((p) => !p.replace(/^"/, '').startsWith('.harpoon/'))
}

async function checkBranch(repo: string, branch: string): Promise<void> {
  const r = await git(repo, ['check-ref-format', '--branch', branch])
  if (!r.ok) throw new HarpoonError('VALIDATION', `"${branch}" is not a valid branch name. Change the branch template in Settings → AI → Implementing.`)
  const exists = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (exists.ok) throw new HarpoonError('CONFLICT', `The branch "${branch}" already exists in ${basename(repo)}.`)
}

export interface GitPrep {
  /** Where the run works (the worktree, or the repository itself). */
  cwd: string
  branch: string | null
  worktree: string | null
  /** For the prompt: what Harpoon did, and what the agent should do about git. */
  instruction: string
}

/**
 * Prepare one repository for an Implement run. `force` continues on uncommitted changes (they stay where they are:
 * a new branch carries them, a worktree starts clean from HEAD).
 */
export async function prepareGit(o: { repo: string; policy: GitPolicy; template: string; slug: string; force?: boolean }): Promise<GitPrep> {
  const branch = branchName(o.template, o.slug)
  switch (o.policy) {
    case 'none':
      return { cwd: o.repo, branch: null, worktree: null, instruction: 'Work in the repository as it is. Do not create branches, commit or push unless the user asks.' }
    case 'repo':
      return {
        cwd: o.repo,
        branch: null,
        worktree: null,
        instruction: `Follow this repository's own instructions (CLAUDE.md, AGENTS.md, its skills and config) for branches, commits and pull requests. If they say nothing about branches, work on a new branch named "${branch}". Never push unless those instructions say to.`,
      }
    case 'branch': {
      const dirty = await uncommitted(o.repo)
      if (dirty.length > 0 && o.force !== true) throw new HarpoonError('CONFLICT', `${basename(o.repo)} has uncommitted changes (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? '…' : ''}). Commit or stash them, or continue anyway.`)
      await checkBranch(o.repo, branch)
      const r = await git(o.repo, ['switch', '-c', branch])
      if (!r.ok) throw new HarpoonError('INTERNAL', `Could not create the branch "${branch}": ${r.err}`)
      return { cwd: o.repo, branch, worktree: null, instruction: `Harpoon created and switched to the branch "${branch}" for this work. Stay on it; follow the repository's own instructions for commits. Never push unless they say to.` }
    }
    case 'worktree': {
      await uncommitted(o.repo)
      await checkBranch(o.repo, branch)
      const path = join(dirname(o.repo), `${basename(o.repo)}-harpoon-${o.slug}`)
      const r = await git(o.repo, ['worktree', 'add', '-b', branch, path])
      if (!r.ok) throw new HarpoonError('INTERNAL', `Could not create the worktree at ${path}: ${r.err}`)
      return { cwd: path, branch, worktree: path, instruction: `Harpoon made a separate git worktree for this work at ${path}, on the new branch "${branch}". Work only there; follow the repository's own instructions for commits. Never push unless they say to.` }
    }
  }
}

/** Remove a worktree Harpoon made (its branch stays). */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  const r = await git(repo, ['worktree', 'remove', path])
  if (!r.ok) throw new HarpoonError('CONFLICT', `Could not remove the worktree: ${r.err} (commit or discard its changes first).`)
}
