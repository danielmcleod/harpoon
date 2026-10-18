import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCore } from '../../src/core/app-core.ts'
import type { Core } from '../../src/core/app-core.ts'
import { nullLogger } from '../../src/core/log.ts'
import type { AppEvent, ProjectView } from '../../src/shared/ipc.ts'

const dirs: string[] = []
const cores: Core[] = []
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'harpoon-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function setup(): Promise<{ core: Core; root: string; events: AppEvent[] }> {
  const core = await createCore({ home: await tmp(), log: nullLogger })
  cores.push(core)
  const events: AppEvent[] = []
  core.bus.on((e) => events.push(e))
  return { core, root: await tmp(), events }
}

const ok = <T>(r: { ok: boolean; value?: unknown; error?: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value as T
}

describe('project lifecycle', () => {
  it('creates the sample, edits, undoes and persists', async () => {
    const { core, root, events } = await setup()
    const view = ok<ProjectView>(await core.invoke('project.create', { dir: root, template: 'sample' }))
    expect(Object.keys(view.model.nodes).length).toBeGreaterThan(10)

    ok(await core.invoke('project.apply', { ops: [{ op: 'updateNode', id: 'api-gateway', patch: { name: 'Edge' } }], txId: 't1' }))
    expect(events.some((e) => e.kind === 'model' && e.txId === 't1')).toBe(true)
    ok(await core.invoke('project.save', undefined))
    const saved = JSON.parse(await readFile(join(root, '.harpoon', 'project.json'), 'utf8')) as { nodes: { id: string; name: string }[] }
    expect(saved.nodes.find((n) => n.id === 'api-gateway')?.name).toBe('Edge')

    ok(await core.invoke('project.undo', undefined))
    const cur = ok<ProjectView>(await core.invoke('project.current', undefined))
    expect(cur.model.nodes['api-gateway']?.name).toBe('API Gateway')

    // Bad ops are refused and change nothing.
    const bad = await core.invoke('project.apply', { ops: [{ op: 'removeNode', id: 'auth-service' }] })
    expect(bad.ok).toBe(false)
  })

  it('reopens from disk and picks up external edits as an undoable step', async () => {
    const { core, root, events } = await setup()
    ok(await core.invoke('project.create', { dir: root, name: 'Ext' }))
    ok(await core.invoke('project.apply', { ops: [{ op: 'addNode', node: { id: 'a', name: 'A' }, at: { q: 0, r: 0 } }] }))
    ok(await core.invoke('project.save', undefined))

    const file = join(root, '.harpoon', 'project.json')
    const json = JSON.parse(await readFile(file, 'utf8')) as { nodes: { name: string }[] }
    const first = json.nodes[0]
    if (first !== undefined) first.name = 'Renamed outside'
    await writeFile(file, JSON.stringify(json, null, 2))

    await expect.poll(() => events.some((e) => e.kind === 'model' && e.source === 'external'), { timeout: 8000 }).toBe(true)
    const cur = ok<ProjectView>(await core.invoke('project.current', undefined))
    expect(cur.model.nodes['a']?.name).toBe('Renamed outside')
    expect(cur.history.canUndo).toBe(true)

    ok(await core.invoke('project.close', undefined))
    const reopened = ok<ProjectView>(await core.invoke('project.open', { dir: root }))
    expect(reopened.model.nodes['a']?.name).toBe('Renamed outside')
  })
})

describe('local designs (no repository)', () => {
  it('creates a design in the designs folder, round-trips it through a single file, and saves a copy elsewhere', async () => {
    const { core, root } = await setup()
    const designs = await tmp()
    await core.state.patch({ designsDir: designs })

    const a = ok<ProjectView>(await core.invoke('project.createLocal', { name: 'Payments platform', template: 'sample' }))
    expect(a.root).toBe(join(designs, 'payments-platform'))
    const info = ok<{ isLocalDesign: boolean; isGitRepo: boolean }>(await core.invoke('project.inspect', { dir: a.root }))
    expect(info).toMatchObject({ isLocalDesign: true, isGitRepo: false })
    // A second one with the same name gets its own folder.
    const b = ok<ProjectView>(await core.invoke('project.createLocal', { name: 'Payments platform' }))
    expect(b.root).toBe(join(designs, 'payments-platform-2'))

    // Single file: the lossless export opens as a new local design.
    ok(await core.invoke('project.open', { dir: a.root }))
    const file = join(root, 'design.harpoon.json')
    const json = ok<{ content: string }>(await core.invoke('export.render', { format: 'harpoon-json', view: { focusId: null, expanded: [], style: 'flat', theme: 'dark', includeNotes: true } }))
    await writeFile(file, json.content)
    const c = ok<ProjectView>(await core.invoke('project.importFile', { path: file }))
    expect(Object.keys(c.model.nodes).length).toBe(Object.keys(a.model.nodes).length)
    expect(c.root.startsWith(designs)).toBe(true)

    // Save a copy into another folder (say, a repository) and keep working there.
    const repo = await tmp()
    const d = ok<ProjectView>(await core.invoke('project.saveCopy', { dir: repo }))
    expect(d.root).toBe(repo)
    expect((JSON.parse(await readFile(join(repo, '.harpoon', 'project.json'), 'utf8')) as { meta: { name: string } }).meta.name).toBe('Payments platform')
    expect((await core.invoke('project.saveCopy', { dir: repo })).ok).toBe(false) // it has a project now
  })
})
