import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../src/core/bus.ts'
import { nullLogger } from '../../src/core/log.ts'
import { initProject } from '../../src/core/project/files.ts'
import { ProjectSession } from '../../src/core/project/session.ts'
import { parseOps } from '../../src/shared/model/ops.ts'
import type { AppEvent } from '../../src/shared/ipc.ts'
import type * as Atomic from '../../src/core/store/atomic.ts'

// Writes of a file whose name ends with `failing.suffix` fail, as a locked file or a full disk would make them.
const failing = vi.hoisted(() => ({ suffix: null as string | null }))
vi.mock('../../src/core/store/atomic.ts', async (original) => {
  const real = await original<typeof Atomic>()
  const writeFileAtomic: typeof real.writeFileAtomic = async (file, data, opts) => {
    if (failing.suffix !== null && file.endsWith(failing.suffix)) throw new Error('disk says no')
    await real.writeFileAtomic(file, data, opts)
  }
  return { ...real, writeFileAtomic }
})

const dirs: string[] = []
afterEach(async () => {
  failing.suffix = null
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function open(): Promise<{
  session: ProjectSession
  events: AppEvent[]
  project: string
  layout: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'hp-save-'))
  dirs.push(root)
  const loaded = await initProject(root, 'Save')
  const bus = new EventBus()
  const events: AppEvent[] = []
  bus.on((e) => events.push(e))
  const session = new ProjectSession({ root, model: loaded.model, texts: loaded.texts, bus, log: nullLogger })
  return {
    session,
    events,
    project: join(root, '.harpoon', 'project.json'),
    layout: join(root, '.harpoon', 'layout.json'),
  }
}

const addNode = (id: string, name: string, q = 0) =>
  parseOps([{ op: 'addNode', node: { id, name }, at: { q, r: 0 } }])
const saves = (events: AppEvent[]): (string | null)[] =>
  events.flatMap((e) => (e.kind === 'saved' ? [e.error] : []))

describe('saving a project', () => {
  it('writes again after a save that failed, also when only the layout failed', async () => {
    const { session, events, project, layout } = await open()
    session.apply(addNode('a', 'A'))
    failing.suffix = 'layout.json'
    await session.flush()
    expect(saves(events).at(-1)).toContain('disk says no')
    expect(await readFile(project, 'utf8')).toContain('"a"')
    expect(await readFile(layout, 'utf8')).not.toContain('"a"')

    failing.suffix = null
    await session.flush() // Ctrl+S, with nothing changed since
    expect(saves(events).at(-1)).toBeNull()
    expect(await readFile(layout, 'utf8')).toContain('"a"')
    // Our own half-save was never taken for someone else's change.
    expect(events.some((e) => e.kind === 'model' && e.source === 'external')).toBe(false)
    expect(session.model.nodes['a']?.name).toBe('A')
  })

  it('takes in a change made outside before saving, instead of overwriting it', async () => {
    const { session, events, project } = await open()
    session.apply(addNode('a', 'A'))
    await session.flush()
    await writeFile(project, (await readFile(project, 'utf8')).replace('"name": "A"', '"name": "Pulled"'))

    session.apply(addNode('b', 'B', 2)) // not saved yet when the save finds the other change
    await session.flush()
    expect(events.some((e) => e.kind === 'model' && e.source === 'external')).toBe(true)
    expect(session.model.nodes['a']?.name).toBe('Pulled')
    expect(await readFile(project, 'utf8')).toContain('"name": "Pulled"')
    expect(session.history().canUndo).toBe(true)
  })

  it('keeps unsaved edits when the file was only rewritten (same model, other formatting)', async () => {
    const { session, events, project } = await open()
    session.apply(addNode('a', 'A'))
    await session.flush()
    await writeFile(project, JSON.stringify(JSON.parse(await readFile(project, 'utf8'))))

    session.apply(addNode('b', 'B', 2))
    await session.flush()
    expect(events.some((e) => e.kind === 'model' && e.source === 'external')).toBe(false)
    expect(await readFile(project, 'utf8')).toContain('"b"')
  })
})
