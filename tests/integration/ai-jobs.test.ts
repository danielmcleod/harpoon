// One job per conversation, and a result that lands in the conversation's own project: the runner driven with a CLI
// adapter that only does what the test tells it to.
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ExitInfo, RunHandle, StartOptions, StopReason } from '../../src/core/adapters/types.ts'
import { ConversationStore } from '../../src/core/ai/conversations.ts'
import { McpHost, MCP_TOKEN_ENV } from '../../src/core/ai/mcp-host.ts'
import { ProposalStore } from '../../src/core/ai/proposals.ts'
import type { Providers } from '../../src/core/ai/providers.ts'
import { AiRunner } from '../../src/core/ai/runner.ts'
import { AppStateStore } from '../../src/core/app-state.ts'
import { EventBus } from '../../src/core/bus.ts'
import { nullLogger } from '../../src/core/log.ts'
import { projectPaths } from '../../src/core/project/files.ts'
import { ProjectManager } from '../../src/core/project/manager.ts'
import type { AiMode, AiRunView } from '../../src/shared/ipc.ts'

/** A CLI pass that runs until the test ends it. */
class FakePass {
  readonly id = 'fake'
  readonly vendor = 'claude' as const
  readonly route = 'stdio' as const
  readonly pid = undefined
  readonly o: StartOptions
  readonly stops: StopReason[] = []
  readonly exited: Promise<ExitInfo>
  #end: (e: ExitInfo) => void = () => undefined

  constructor(o: StartOptions) {
    this.o = o
    this.exited = new Promise((resolve) => {
      this.#end = resolve
    })
  }
  onEvent(): () => void {
    return () => undefined
  }
  onSignal(): () => void {
    return () => undefined
  }
  sessionId(): string {
    return 'session-1'
  }
  cumulativeUsage(): undefined {
    return undefined
  }
  pendingAsks(): string[] {
    return []
  }
  end(): void {
    this.#end({ code: 0, signal: null, sawTerminal: true, ranMs: 1 })
  }
}

const dirs: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'harpoon-'))
  dirs.push(d)
  return d
}

async function setup(): Promise<{
  ai: AiRunner
  projects: ProjectManager
  proposals: ProposalStore
  passes: FakePass[]
}> {
  const home = await tmp()
  const bus = new EventBus()
  const state = new AppStateStore(join(home, 'state.json'))
  await state.load()
  const projects = new ProjectManager({ bus, log: nullLogger, state })
  const proposals = new ProposalStore({ bus, log: nullLogger, projects })
  bus.on((e) => {
    if (e.kind === 'project-opened') void proposals.load(e.project.root)
    else if (e.kind === 'project-closed') void proposals.load(null)
  })
  const passes: FakePass[] = []
  // The stop is recorded, and the pass ends only when the test says so (a CLI takes a while to go away).
  const adapter = {
    start: (o: StartOptions): RunHandle => {
      const p = new FakePass(o)
      passes.push(p)
      return p
    },
    stop: (h: RunHandle, reason: StopReason): Promise<void> => {
      ;(h as FakePass).stops.push(reason)
      if (reason === 'shutdown') (h as FakePass).end()
      return Promise.resolve()
    },
    answer: (): void => undefined,
  }
  const providers = { adapter: () => adapter, probe: () => Promise.resolve({}) } as unknown as Providers
  const mcp = new McpHost(nullLogger)
  const ai = new AiRunner({
    providers,
    mcp,
    bus,
    log: nullLogger,
    projects,
    proposals,
    runsDir: join(home, 'runs'),
    conversations: new ConversationStore(join(home, 'conversations')),
    localRepoPaths: () => ({}),
    notionServer: () => null,
    implementSettings: () => state.state.implement,
    rememberImplement: () => Promise.resolve(),
  })
  closers.push(async () => {
    await ai.shutdown()
    await mcp.close()
    await projects.close(false)
  })
  return { ai, projects, proposals, passes }
}

const request = (mode: AiMode, prompt: string): Parameters<AiRunner['start']>[0] => ({
  vendor: 'claude',
  mode,
  prompt,
  selection: { nodeIds: [], connectorIds: [], focusId: null },
})
const statusOf = (ai: AiRunner, id: string): AiRunView['status'] | undefined =>
  ai.list().find((r) => r.id === id)?.status

it('keeps a stopped conversation busy until its CLI is gone, then takes the reply', async () => {
  const { ai, projects, passes } = await setup()
  await projects.create(await tmp(), 'Shop', 'sample')
  const run = await ai.start(request('explain', 'What calls the ledger?'))
  await expect.poll(() => passes.length).toBe(1)
  const first = passes[0]
  if (first === undefined) throw new Error('no pass')

  ai.cancel(run.id)
  expect(first.stops).toEqual(['user'])
  // The CLI is still going away: the conversation is not free yet, and a reply is refused rather than run beside it.
  expect(statusOf(ai, run.id)).toBe('running')
  await expect(ai.send(run.id, 'And the gateway?')).rejects.toThrow('Wait for the current answer first.')
  expect(passes.length).toBe(1)

  first.end()
  await expect.poll(() => statusOf(ai, run.id)).toBe('cancelled')
  await ai.send(run.id, 'And the gateway?')
  await expect.poll(() => passes.length).toBe(2)
  const second = passes[1]
  // The reply's own MCP config is there (the stopped job removed only its own).
  expect(second?.o.mcp !== undefined && existsSync(second.o.mcp.configFile)).toBe(true)
  expect(first.o.mcp?.configFile).not.toBe(second?.o.mcp?.configFile)
  // A follow-up answered without Harpoon's tools is an answer, not a failure.
  second?.end()
  await expect.poll(() => statusOf(ai, run.id)).toBe('done')
  expect(ai.list().find((r) => r.id === run.id)?.error).toBeNull()
  expect(second?.o.mcp !== undefined && existsSync(second.o.mcp.configFile)).toBe(false)
}, 30_000)

it('saves a proposal in the project the conversation belongs to, not the one open when it ends', async () => {
  const { ai, projects, proposals, passes } = await setup()
  const a = await projects.create(await tmp(), 'Shop', 'sample')
  const run = await ai.start(request('plan', 'Add a fraud scorer'))
  await expect.poll(() => passes.length).toBe(1)
  const pass = passes[0]
  if (pass?.o.mcp === undefined) throw new Error('no MCP route')

  // The agent stages a change through the run's own route.
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(pass.o.mcp.url), {
    requestInit: { headers: { Authorization: `Bearer ${pass.o.env?.[MCP_TOKEN_ENV] ?? ''}` } },
  })
  // The SDK's own types disagree with exactOptionalPropertyTypes (sessionId?: string).
  await client.connect(transport as unknown as Parameters<Client['connect']>[0])
  const added = await client.callTool({
    name: 'add_node',
    arguments: { name: 'Fraud scorer', kind: 'service' },
  })
  expect(added.isError).not.toBe(true)
  // "constructor" is every object's, not a node: no connector may hang off it.
  const dangling = await client.callTool({
    name: 'add_connector',
    arguments: { source: 'constructor', target: 'fraud-scorer', protocol: 'HTTPS' },
  })
  expect(dangling.isError).toBe(true)
  await client.close()

  // The user moves on to another project before the pass ends.
  const b = await projects.create(await tmp(), 'Other', 'blank')
  pass.end()
  const inA = projectPaths(a.root).proposalsDir
  await expect.poll(() => readdir(inA).catch(() => [] as string[])).toEqual([`p-${run.id}.json`])
  expect(await readdir(projectPaths(b.root).proposalsDir).catch(() => [])).toEqual([])
  expect(proposals.list()).toEqual([])

  // Back in its project, the proposal is there to review.
  await projects.open(a.root)
  await expect.poll(() => proposals.list().map((p) => p.id)).toEqual([`p-${run.id}`])
}, 30_000)
