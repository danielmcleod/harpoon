// Git before an Implement run, against a real temporary repository: a branch, a refusal on uncommitted changes, a
// worktree beside the repository; and plan files named by date and title, kept inside the project.
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { branchName, prepareGit, removeWorktree, slugify } from '../../src/core/ai/git-prep.ts'
import { savePlanFile } from '../../src/core/ai/plans.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
async function repo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'harpoon-git-'))
  dirs.push(parent)
  const dir = join(parent, 'shop')
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: parent, encoding: 'utf8' })
  git('init', '-q', '-b', 'main', dir)
  const inRepo = (...a: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' })
  await writeFile(join(dir, 'README.md'), 'shop\n')
  inRepo('add', '.')
  inRepo('commit', '-q', '-m', 'init')
  return dir
}

it('names branches and plans from the title', () => {
  expect(slugify('ADR 0003: Add a Fraud Scorer!')).toBe('adr-0003-add-a-fraud-scorer')
  expect(branchName('feature/{date}-{slug}', 'fraud', new Date('2026-10-23T10:00:00Z'))).toBe('feature/2026-10-23-fraud')
})

it('creates a branch, refuses on uncommitted changes, and makes a worktree', async () => {
  const dir = await repo()
  const b = await prepareGit({ repo: dir, policy: 'branch', template: 'harpoon/{slug}', slug: 'fraud' })
  expect(b.branch).toBe('harpoon/fraud')
  expect(execFileSync('git', ['-C', dir, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('harpoon/fraud')

  await writeFile(join(dir, 'README.md'), 'changed\n')
  await expect(prepareGit({ repo: dir, policy: 'branch', template: 'harpoon/{slug}', slug: 'other' })).rejects.toThrow(/uncommitted/)

  const w = await prepareGit({ repo: dir, policy: 'worktree', template: 'harpoon/{slug}', slug: 'scorer' })
  expect(w.worktree).toBe(join(dir, '..', 'shop-harpoon-scorer'))
  // The worktree starts from the last commit, without the uncommitted change.
  expect((await readFile(join(w.cwd, 'README.md'), 'utf8')).trim()).toBe('shop')
  await removeWorktree(dir, w.cwd)

  const r = await prepareGit({ repo: dir, policy: 'repo', template: 'harpoon/{slug}', slug: 'x' })
  expect(r.instruction).toContain('CLAUDE.md')
}, 30_000)

it('saves plans in the project’s plans folder, never outside it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harpoon-plans-'))
  dirs.push(root)
  const now = new Date('2026-10-23T10:00:00Z')
  const a = await savePlanFile({ root, plansDir: '.harpoon/plans', title: 'Add a fraud scorer', markdown: '# Plan A', now })
  expect(a.replace(/\\/g, '/')).toMatch(/\/\.harpoon\/plans\/2026-10-23-add-a-fraud-scorer\.md$/)
  expect(await savePlanFile({ root, plansDir: '.harpoon/plans', title: 'Add a fraud scorer', markdown: '# Plan A', now })).toBe(a)
  expect(await savePlanFile({ root, plansDir: '.harpoon/plans', title: 'Add a fraud scorer', markdown: '# Plan B', now })).toMatch(/scorer-2\.md$/)
  await expect(savePlanFile({ root, plansDir: '../elsewhere', title: 'x', markdown: 'x', now })).rejects.toThrow(/inside the project/)
})
