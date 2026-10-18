import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverRepos, remoteFromConfig, repoNameOf, resolveRepos } from '../../src/core/project/repos.ts'
import { RepoRefZ } from '../../src/shared/model/schema.ts'

async function fakeRepo(dir: string, remote: string | null, branch = 'main'): Promise<void> {
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
  await writeFile(join(dir, '.git', 'config'), `[core]\n\tbare = false\n${remote !== null ? `[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ''}`)
}

describe('repositories', () => {
  it('reads the origin remote and names a repo after it', () => {
    expect(remoteFromConfig('[remote "upstream"]\n url = a\n[remote "origin"]\n url = git@github.com:acme/payments.git\n')).toBe('git@github.com:acme/payments.git')
    expect(repoNameOf('https://github.com/acme/web-app.git')).toBe('web-app')
    expect(repoNameOf('git@github.com:acme/payments.git')).toBe('payments')
  })

  it('discovers the repos under a folder without descending into them', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'hp-repos-'))
    await fakeRepo(join(ws, 'payments'), 'git@github.com:acme/payments.git', 'develop')
    await fakeRepo(join(ws, 'group', 'web'), null)
    await fakeRepo(join(ws, 'payments', 'vendor-copy'), null) // inside a repo: not listed
    await mkdir(join(ws, 'node_modules', 'x', '.git'), { recursive: true })
    const found = await discoverRepos(ws)
    expect(found.map((r) => [r.name, r.branch])).toEqual([
      ['payments', 'develop'],
      ['web', 'main'],
    ])
  })

  it('prefers this machine’s path, then the project’s hint', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'hp-resolve-'))
    await mkdir(join(ws, 'project'))
    await fakeRepo(join(ws, 'api'), null)
    await mkdir(join(ws, 'plain'))
    await mkdir(join(ws, 'elsewhere', 'web'), { recursive: true })
    const repos = [
      RepoRefZ.parse({ id: 'api', name: 'api', path: '../api' }),
      RepoRefZ.parse({ id: 'web', name: 'web', path: '../web' }),
      RepoRefZ.parse({ id: 'gone', name: 'gone', path: '../gone' }),
      // A shared project must not widen what the AI reads: not a plain folder, not a folder above the project.
      RepoRefZ.parse({ id: 'plain', name: 'plain', path: '../plain' }),
      RepoRefZ.parse({ id: 'up', name: 'up', path: '..' }),
    ]
    const r = await resolveRepos(join(ws, 'project'), repos, { web: join(ws, 'elsewhere', 'web') })
    expect(r.map((x) => x.source)).toEqual(['project', 'machine', 'missing', 'missing', 'missing'])
    expect(r[3]?.note).toContain('not a git repository')
    expect(r[4]?.note).toContain('contains the project folder')
  })
})
