// Harpoon's MCP endpoint for the CLI agents: one loopback HTTP server (Streamable HTTP, stateless, JSON responses),
// one route per AI run (`/mcp/<runId>`) with its own random bearer token. A route exists only while its run does.
// Requests must come from loopback with the exact Host, carry the run's token, and never come from a browser (an
// Origin header is refused, which also stops DNS-rebinding pages).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Logger } from '../log.ts'

export const MCP_SERVER_NAME = 'harpoon'
export const MCP_TOKEN_ENV = 'HARPOON_MCP_TOKEN'
const MAX_BODY = 4 * 1024 * 1024

export interface McpRoute {
  url: string
  token: string
  close(): void
}

interface RouteEntry {
  token: Buffer
  register: (s: McpServer) => void
  onCall?: () => void
}

export class McpHost {
  #server: Server | null = null
  #port = 0
  readonly #routes = new Map<string, RouteEntry>()
  readonly #log: Logger

  constructor(log: Logger) {
    this.#log = log
  }

  async #ensure(): Promise<void> {
    if (this.#server !== null) return
    const server = createServer((req, res) => void this.#handle(req, res))
    // A slow or stalled local client cannot hold sockets open.
    server.headersTimeout = 10_000
    server.requestTimeout = 60_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.#port = (server.address() as AddressInfo).port
    this.#server = server
    this.#log.info('mcp host listening', { port: this.#port })
  }

  /** Open a route for a run; `register` adds the run's tools to a fresh MCP server per request. */
  async open(runId: string, register: (s: McpServer) => void, onCall?: () => void): Promise<McpRoute> {
    await this.#ensure()
    const token = randomBytes(32).toString('base64url')
    this.#routes.set(runId, { token: Buffer.from(token), register, ...(onCall !== undefined ? { onCall } : {}) })
    return {
      url: `http://127.0.0.1:${this.#port}/mcp/${encodeURIComponent(runId)}`,
      token,
      close: () => this.#routes.delete(runId),
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refuse = (status: number, msg: string): void => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain' })
      res.end(msg)
    }
    try {
      if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') return refuse(403, 'forbidden')
      if (req.headers.origin !== undefined) return refuse(403, 'forbidden')
      if (req.headers.host !== `127.0.0.1:${this.#port}`) return refuse(403, 'forbidden')
      const m = /^\/mcp\/([^/?#]+)/.exec(req.url ?? '')
      const route = m?.[1] === undefined ? undefined : this.#routes.get(decodeURIComponent(m[1]))
      const auth = req.headers.authorization ?? ''
      const given = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '')
      // An unknown run and a wrong token look the same, so a local process cannot tell which runs are live.
      if (route === undefined || given.length !== route.token.length || !timingSafeEqual(given, route.token)) return refuse(401, 'unauthorized')
      if (req.method !== 'POST') return refuse(405, 'method not allowed')

      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > MAX_BODY) return refuse(413, 'too large')
        chunks.push(chunk)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      const body: unknown = text === '' ? undefined : JSON.parse(text)
      route.onCall?.()

      const server = new McpServer({ name: MCP_SERVER_NAME, version: '1.0.0' })
      route.register(server)
      // No session id generator: stateless (every request stands alone, which suits per-request servers).
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      // The SDK's own types disagree with exactOptionalPropertyTypes (onclose?: () => void).
      await server.connect(transport as unknown as Parameters<McpServer['connect']>[0])
      await transport.handleRequest(req, res, body)
    } catch (err) {
      this.#log.warn('mcp request failed', { err: err instanceof Error ? err.message : String(err) })
      refuse(500, 'error')
    }
  }

  async close(): Promise<void> {
    this.#routes.clear()
    const s = this.#server
    this.#server = null
    if (s !== null) await new Promise<void>((r) => s.close(() => r()))
  }
}
