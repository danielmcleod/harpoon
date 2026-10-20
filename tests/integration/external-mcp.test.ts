// Outside agents: with access turned on, an MCP client with the token reads the open project and stages a change
// that arrives as a proposal; without the token it gets nothing.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createCore } from '../../src/core/app-core.ts'
import type { Core } from '../../src/core/app-core.ts'
import { nullLogger } from '../../src/core/log.ts'
import { runMcpBridge } from '../../src/core/ai/mcp-bridge.ts'
import { PassThrough } from 'node:stream'
import type { ExternalMcpView, Proposal } from '../../src/shared/ipc.ts'

const dirs: string[] = []
let core: Core | null = null
afterEach(async () => {
  await core?.shutdown()
  core = null
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'harpoon-'))
  dirs.push(d)
  return d
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  // The SDK's own types disagree with exactOptionalPropertyTypes (sessionId?: string).
  await client.connect(transport as unknown as Parameters<Client['connect']>[0])
  return client
}

it('lets an agent with the token read the project and propose a change', async () => {
  core = await createCore({ home: await tmp(), log: nullLogger })
  const port = 40000 + Math.floor(Math.random() * 20000)
  const on = await core.invoke('mcp.external.set', { enabled: true, port })
  if (!on.ok) throw new Error(on.error.message)
  const view = on.value as ExternalMcpView
  expect(view.running).toBe(true)
  const { url, token } = view
  if (url === null || token === null) throw new Error('no endpoint')

  await expect(connect(url, 'wrong-token')).rejects.toThrow()

  // No project open: the agent is told so.
  let client = await connect(url, token)
  const none = await client.callTool({ name: 'get_overview', arguments: {} })
  expect(none.isError).toBe(true)
  await client.close()

  const opened = await core.invoke('project.create', { dir: await tmp(), template: 'sample' })
  if (!opened.ok) throw new Error(opened.error.message)
  client = await connect(url, token)
  const overview = await client.callTool({ name: 'get_overview', arguments: {} })
  expect(JSON.stringify(overview.content)).toContain('auth-service')
  const traffic = await client.callTool({ name: 'check_traffic', arguments: {} })
  expect(JSON.stringify(traffic.content)).toContain('reached')
  const added = await client.callTool({ name: 'add_node', arguments: { name: 'Fraud scorer', kind: 'service' } })
  expect(added.isError).not.toBe(true)
  await client.callTool({ name: 'submit_proposal', arguments: { title: 'Add a fraud scorer', rationale: 'Score orders' } })
  await client.close()

  await expect.poll(async () => {
    const r = await core?.invoke('proposal.list', undefined)
    return r?.ok === true ? (r.value as Proposal[]).map((p) => p.title) : []
  }).toContain('Add a fraud scorer')
}, 30_000)

it('relays a stdio client through the bridge, and says when access is off', async () => {
  core = await createCore({ home: await tmp(), log: nullLogger })
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []
  output.on('data', (d: Buffer) => lines.push(...String(d).split('\n').filter((l) => l.trim() !== '')))
  const done = runMcpBridge({ stateFile: core.paths.state, input, output })
  const ask = async (msg: object, n: number): Promise<void> => {
    input.write(`${JSON.stringify(msg)}\n`)
    await expect.poll(() => lines.length, { timeout: 5000 }).toBeGreaterThanOrEqual(n)
  }
  // Off: an error that says how to turn it on.
  await ask({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 1)
  expect(lines[0]).toContain('Outside agents')
  const on = await core.invoke('mcp.external.set', { enabled: true, port: 40000 + Math.floor(Math.random() * 20000) })
  if (!on.ok) throw new Error(on.error.message)
  await ask({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, 2)
  expect(lines[1]).toContain('"serverInfo"')
  const opened = await core.invoke('project.create', { dir: await tmp(), template: 'sample' })
  if (!opened.ok) throw new Error(opened.error.message)
  await ask({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 3)
  expect(lines[2]).toContain('check_traffic')
  input.end()
  expect(await done).toBe(0)
}, 30_000)
