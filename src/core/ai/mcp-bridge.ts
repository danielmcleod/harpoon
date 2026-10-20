// `Harpoon --mcp`: a stdio MCP server for clients that run a command (Codex plugins, Claude Desktop, VS Code,
// Cursor). Each JSON-RPC line from stdin goes to the running app's outside-agent endpoint (loopback, with the token
// from HARPOON_HOME/state.json, read per request so a new token works at once); each reply goes to stdout. The
// client's configuration holds no token. If Harpoon is not running or outside agents are off, requests get an error
// that says what to do.
import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import type { Readable, Writable } from 'node:stream'

const ROUTE = '/mcp/harpoon'

interface Endpoint {
  port: number
  token: string
}

async function endpoint(stateFile: string): Promise<Endpoint | string> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(stateFile, 'utf8'))
  } catch {
    return 'Harpoon has not been set up on this computer yet. Open Harpoon, then turn on Settings → AI → Outside agents.'
  }
  const ext = (raw as { externalMcp?: { enabled?: unknown; port?: unknown; token?: unknown } }).externalMcp
  if (ext?.enabled !== true || typeof ext.token !== 'string' || typeof ext.port !== 'number') {
    return 'Outside agents are turned off in Harpoon. Turn them on in Settings → AI → Outside agents.'
  }
  return { port: ext.port, token: ext.token }
}

function post(ep: Endpoint, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: ep.port,
        path: ROUTE,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${ep.token}`,
          'content-length': Buffer.byteLength(body),
        },
        timeout: 120_000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error('Harpoon did not answer in time.')))
    req.on('error', reject)
    req.end(body)
  })
}

/** JSON-RPC replies from a JSON or an SSE response body. */
function replies(text: string): string[] {
  const t = text.trim()
  if (t === '') return []
  if (t.startsWith('{') || t.startsWith('[')) return [t]
  return t
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((l) => l !== '')
}

/** Relay stdin to the app until stdin closes. Resolves with the exit code. */
export async function runMcpBridge(o: { stateFile: string; input: Readable; output: Writable }): Promise<number> {
  const write = (obj: unknown): void => void o.output.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`)
  const fail = (id: unknown, message: string): void => {
    if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code: -32000, message } })
  }
  const lines = createInterface({ input: o.input, crlfDelay: Infinity })
  for await (const line of lines) {
    const body = line.trim()
    if (body === '') continue
    let id: unknown
    try {
      id = (JSON.parse(body) as { id?: unknown }).id
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      continue
    }
    const ep = await endpoint(o.stateFile)
    if (typeof ep === 'string') {
      fail(id, ep)
      continue
    }
    try {
      const r = await post(ep, body)
      if (r.status === 401) fail(id, 'Harpoon refused the token. Check that outside agents are on, and that this is the same computer and account.')
      else if (r.status >= 400) fail(id, `Harpoon answered ${r.status}: ${r.text.slice(0, 200)}`)
      else for (const reply of replies(r.text)) write(reply)
    } catch {
      fail(id, 'Harpoon is not running. Open Harpoon (with a project) and try again.')
    }
  }
  return 0
}
