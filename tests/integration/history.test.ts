// The Time Machine's past, read from a real git repository.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { projectPaths, serializeModel } from '../../src/core/project/files.ts'
import { listHistory, snapshotAt } from '../../src/core/project/history.ts'
import { NodeZ, emptyModel } from '../../src/shared/model/schema.ts'
import type { Model } from '../../src/shared/model/schema.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): void => {
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' },
  )
}

async function save(root: string, m: Model): Promise<void> {
  const paths = projectPaths(root)
  const texts = serializeModel(m)
  await mkdir(paths.dir, { recursive: true })
  await writeFile(paths.project, texts.project)
  await writeFile(paths.layout, texts.layout)
}

describe('project history', () => {
  it('lists the commits that changed the project, oldest first, and reads the model at each', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harpoon-history-'))
    dirs.push(root)
    git(root, 'init', '-q')
    const m = emptyModel({ id: 'shop', name: 'Shop' })
    m.nodes['orders'] = NodeZ.parse({ id: 'orders', name: 'Orders' })
    await save(root, m)
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'Map orders')
    // A commit that does not touch the project is not part of its history.
    await writeFile(join(root, 'README.md'), 'hello\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'Docs')
    m.nodes['payments'] = NodeZ.parse({ id: 'payments', name: 'Payments' })
    await save(root, m)
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'Add payments')

    const history = await listHistory(root)
    expect(history.unavailable).toBeNull()
    expect(history.commits.map((c) => c.subject)).toEqual(['Map orders', 'Add payments'])
    expect(history.commits[0]?.author).toBe('Test')
    const first = await snapshotAt(root, history.commits[0]?.sha ?? '')
    expect(Object.keys(first.model.nodes)).toEqual(['orders'])
    const second = await snapshotAt(root, history.commits[1]?.sha ?? '')
    expect(Object.keys(second.model.nodes).sort()).toEqual(['orders', 'payments'])
  })

  it('says why there is no history outside a repository, and refuses anything but a hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harpoon-history-'))
    dirs.push(root)
    await save(root, emptyModel({ id: 'shop', name: 'Shop' }))
    const history = await listHistory(root)
    expect(history.commits).toEqual([])
    expect(history.unavailable).toMatch(/not in a git repository/)
    await expect(snapshotAt(root, '--output=x')).rejects.toThrow(/Not a commit hash/)
  })
})
