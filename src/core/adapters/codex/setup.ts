// vendorSetup for Codex (the `vendor_setup` executor: calls Codex windowsSandbox/setupStart, waits for
// setupCompleted, then the executor re-probes; the Codex Windows sandbox procedure, X11b). Runs only
// when recovery.execute calls it for a user's click: one private app-server, `windowsSandbox/setupStart{mode:
// 'unelevated'}`, then the `windowsSandbox/setupCompleted` notification. The elevated setup (a UAC prompt) is never
// run from here; it stays a copied command.
import type { ResolvedCli } from '../../proc/resolve-cli.ts'
import { JsonRpcError } from '../../proc/jsonrpc.ts'
import { SpawnError } from '../../proc/spawn.ts'
import { AppServer, isUnknownMethod } from './rpc.ts'
import { rec, str } from './wire.ts'

export const SETUP_CALL = 'windowsSandbox/setupStart'
export const SETUP_DONE = 'windowsSandbox/setupCompleted'

export interface SetupOutcome {
  ok: boolean
  /** One plain sentence (Codex's own error text when it failed). */
  detail: string
}

export interface SetupInput {
  cli: Pick<ResolvedCli, 'command' | 'prefixArgs'>
  /** `app-server --listen stdio://` with the user's root `-c` overrides. */
  args: readonly string[]
  env: Record<string, string>
  cwd: string
  signal: AbortSignal
  platform?: NodeJS.Platform
  /** Upper bound besides the signal. */
  timeoutMs: number
  initializeTimeoutMs?: number
}

const sentence = (s: string): string => {
  const t = s.trim().replace(/\s+/g, ' ')
  return /[.!?]$/.test(t) ? t : `${t}.`
}

/** The unelevated Windows sandbox setup over a private app-server; never throws for a vendor answer. */
export async function runSandboxSetup(i: SetupInput): Promise<SetupOutcome> {
  if ((i.platform ?? process.platform) !== 'win32') {
    return { ok: false, detail: 'The Codex Windows sandbox exists only on Windows.' }
  }
  if (i.signal.aborted) return { ok: false, detail: 'The setup was cancelled before it started.' }
  let server: AppServer
  try {
    server = await AppServer.spawn({
      cli: i.cli,
      args: i.args,
      cwd: i.cwd,
      env: i.env,
      label: { purpose: 'probe' },
    })
  } catch (err) {
    const e = SpawnError.from(err, i.cli.command)
    return { ok: false, detail: `Harpoon could not start Codex (${e.code}: ${e.message}).` }
  }
  let onDone: (o: SetupOutcome) => void = () => undefined
  const done = new Promise<SetupOutcome>((resolve) => {
    onDone = resolve
  })
  server.peer.onNotification(SETUP_DONE, (params) => {
    const p = rec(params)
    if (str(p?.['mode']) !== undefined && str(p?.['mode']) !== 'unelevated') return
    const error = str(p?.['error'])
    onDone(
      p?.['success'] === true
        ? { ok: true, detail: 'Codex set up its Windows sandbox.' }
        : {
            ok: false,
            detail: sentence(
              error !== undefined && error !== '' ? error : 'Codex reported that the setup failed',
            ),
          },
    )
  })
  server.peer.onClose(() => onDone({ ok: false, detail: 'Codex stopped before the setup finished.' }))
  const onAbort = (): void =>
    onDone({ ok: false, detail: 'The setup took too long, so Harpoon stopped it.' })
  i.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(onAbort, i.timeoutMs)
  timer.unref()
  try {
    await server.initialize(false, i.initializeTimeoutMs)
    const r = rec(
      await server.peer.request(
        SETUP_CALL,
        { mode: 'unelevated' },
        { timeoutMs: i.initializeTimeoutMs ?? 15_000 },
      ),
    )
    if (r?.['started'] === false) return { ok: false, detail: 'Codex did not start the setup.' }
    return await done
  } catch (err) {
    if (isUnknownMethod(err))
      return {
        ok: false,
        detail: 'This Codex cannot set up its Windows sandbox from Harpoon. Update Codex.',
      }
    if (err instanceof JsonRpcError)
      return { ok: false, detail: sentence(`Codex refused the setup: ${err.message.slice(0, 200)}`) }
    return { ok: false, detail: sentence(err instanceof Error ? err.message : String(err)) }
  } finally {
    clearTimeout(timer)
    i.signal.removeEventListener('abort', onAbort)
    await server.shutdown(3_000)
  }
}
