// Outside agents' access to Harpoon's MCP tools: off by default. When on, a loopback-only MCP host listens on a fixed
// port with one route and a bearer token kept in state.json (on this machine only). Any agent the user configures with
// that URL and token can read the open project and stage changes into a draft; each submit_proposal becomes a
// proposal to review in Harpoon, as with the built-in assistant.
import { randomBytes } from 'node:crypto'
import type { ExternalMcpView } from '../../shared/ipc.ts'
import type { AppStateStore } from '../app-state.ts'
import type { Logger } from '../log.ts'
import { McpHost } from './mcp-host.ts'
import type { McpRoute } from './mcp-host.ts'
import type { AiRunner } from './runner.ts'
import type { BridgeCommand } from './agent-setup.ts'

const ROUTE = 'harpoon'

export class ExternalMcp {
  readonly #o: { state: AppStateStore; ai: AiRunner; log: Logger; bridge: BridgeCommand | null }
  #host: McpHost | null = null
  #route: McpRoute | null = null
  #error: string | null = null

  constructor(o: { state: AppStateStore; ai: AiRunner; log: Logger; bridge: BridgeCommand | null }) {
    this.#o = o
  }

  /** Start listening if the user turned it on (a taken port is reported in the view, never thrown). */
  async start(): Promise<void> {
    const cfg = this.#o.state.state.externalMcp
    if (!cfg.enabled || this.#host !== null) return
    const token = cfg.token ?? (await this.#o.state.setExternalMcp({ token: newToken() })).token ?? newToken()
    const host = new McpHost(this.#o.log, { port: cfg.port })
    try {
      await host.listen()
      this.#route = await host.open(ROUTE, (s) => this.#o.ai.registerExternal(s), undefined, token)
      this.#host = host
      this.#error = null
      this.#o.log.info('outside agents can connect', { port: cfg.port })
    } catch (err) {
      await host.close().catch(() => undefined)
      const code = (err as { code?: string }).code
      this.#error = code === 'EADDRINUSE' ? `Port ${cfg.port} is in use by another program. Pick another port.` : err instanceof Error ? err.message : String(err)
      this.#o.log.warn('outside agent endpoint failed', { err: this.#error })
    }
  }

  async stop(): Promise<void> {
    this.#route?.close()
    this.#route = null
    const h = this.#host
    this.#host = null
    if (h !== null) await h.close()
  }

  async set(req: { enabled?: boolean; port?: number; regenerate?: boolean }): Promise<ExternalMcpView> {
    await this.stop()
    this.#error = null
    await this.#o.state.setExternalMcp({
      ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
      ...(req.port !== undefined ? { port: req.port } : {}),
      ...(req.regenerate === true ? { token: newToken() } : {}),
    })
    await this.start()
    return this.view()
  }

  view(): ExternalMcpView {
    const cfg = this.#o.state.state.externalMcp
    const running = this.#host !== null
    return {
      enabled: cfg.enabled,
      port: cfg.port,
      running,
      url: running ? `http://127.0.0.1:${cfg.port}/mcp/${ROUTE}` : null,
      token: cfg.enabled ? cfg.token : null,
      error: this.#error,
      lastCall: this.#o.ai.externalLastCall,
      bridge: this.#o.bridge,
    }
  }
}

function newToken(): string {
  return randomBytes(32).toString('base64url')
}
