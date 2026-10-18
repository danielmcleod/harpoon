// The AI providers Harpoon drives: the Claude Code and Codex CLIs through its CLI adapters. Probes are cached
// (they spawn the CLIs); `force` re-probes after the user installs or signs in.
import { mkdirSync } from 'node:fs'
import { createClaudeAdapter } from '../adapters/claude/index.ts'
import { createCodexAdapter } from '../adapters/codex/index.ts'
import type { Adapter, ProbeResult } from '../adapters/types.ts'
import type { Logger } from '../log.ts'
import type { AiVendor, ProviderView } from '../../shared/ipc.ts'

const NAMES: Record<AiVendor, string> = { claude: 'Claude Code', codex: 'Codex' }

export class Providers {
  readonly #adapters: Record<AiVendor, Adapter>
  readonly #probes = new Map<AiVendor, Promise<ProbeResult>>()
  readonly #log: Logger

  constructor(o: { probeCwd: string; log: Logger }) {
    mkdirSync(o.probeCwd, { recursive: true })
    this.#log = o.log
    this.#adapters = {
      claude: createClaudeAdapter({}),
      codex: createCodexAdapter({ probeCwd: o.probeCwd }),
    }
  }

  adapter(v: AiVendor): Adapter {
    return this.#adapters[v]
  }

  probe(v: AiVendor, force = false): Promise<ProbeResult> {
    let p = this.#probes.get(v)
    if (p === undefined || force) {
      p = this.#adapters[v].probe({ force }).catch((err: unknown) => {
        this.#log.warn('probe failed', { vendor: v, err: err instanceof Error ? err.message : String(err) })
        throw err
      })
      this.#probes.set(v, p)
    }
    return p
  }

  async views(force = false): Promise<ProviderView[]> {
    return Promise.all(
      (['claude', 'codex'] as const).map(async (v): Promise<ProviderView> => {
        try {
          const r = await this.probe(v, force)
          const blocking = r.checks.find((c) => c.blocking && c.status !== 'pass')
          return {
            id: v,
            name: NAMES[v],
            ok: r.ok,
            version: r.version ?? null,
            account: r.account === undefined ? null : [r.account.method, r.account.plan].filter(Boolean).join(' · '),
            models: r.models.map((m) => ({ id: m.id, label: m.label ?? m.id, isDefault: m.isDefault === true })),
            issue: r.ok ? null : blocking !== undefined ? `${blocking.title}. ${blocking.detail}` : 'Not available.',
          }
        } catch (err) {
          return { id: v, name: NAMES[v], ok: false, version: null, account: null, models: [], issue: err instanceof Error ? err.message : String(err) }
        }
      }),
    )
  }
}
