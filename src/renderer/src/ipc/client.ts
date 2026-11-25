// Typed access to main over the preload bridge (the IPC contract in src/shared). `invoke` never rejects:
// a missing bridge (scaffold preload, tests without a mock) or a failed IPC call becomes `{ok:false}`, so callers
// handle one shape. `call` unwraps and throws IpcError for code that prefers exceptions.
//
// Healing: a request the main process rejects for problems with an obvious, safe fix (a field it does not know, text
// or a list over its limit, a number past its range) is repaired and sent once more, and the repair is reported. Other
// failures are remembered for a moment, so the error toast that follows can offer to fix it with AI.
import type {
  AppEvent,
  Cmd,
  HarpoonApi,
  InvokeArgs,
  Res,
  Result,
  ResultCode,
  ResultError,
} from '@shared/ipc.ts'
import { healRequest } from '@shared/heal.ts'
import { parseRequest } from '@shared/ipc-schemas.ts'

export class IpcError extends Error {
  readonly code: ResultCode
  readonly details: unknown
  readonly cmd: string | undefined

  constructor(error: ResultError, cmd?: string) {
    super(error.message)
    this.name = 'IpcError'
    this.code = error.code
    this.details = error.details
    this.cmd = cmd
  }
}

export const NO_BRIDGE_MESSAGE = "Harpoon's main process is not connected to this window."

/** window.harpoon when the preload exposed a usable API (invoke + subscribe), else null. */
export function getHarpoon(): HarpoonApi | null {
  const api = (globalThis as unknown as { harpoon?: Partial<HarpoonApi> }).harpoon
  if (api === undefined || typeof api.invoke !== 'function' || typeof api.subscribe !== 'function')
    return null
  return api as HarpoonApi
}

export function hasBridge(): boolean {
  return getHarpoon() !== null
}

function failure(code: ResultCode, message: string): { ok: false; error: ResultError } {
  return { ok: false, error: { code, message } }
}

function isResult(v: unknown): v is Result<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean'
}

export interface HealNote {
  cmd: string
  /** What was changed, in words. */
  changes: string[]
}

export interface FailureNote {
  cmd: string
  error: ResultError
  at: number
}

let healed: ((n: HealNote) => void) | null = null
let lastFailure: FailureNote | null = null

/** Be told when a rejected request was healed and went through. */
export function onHeal(cb: (n: HealNote) => void): void {
  healed = cb
}

/** The command that just failed with this message (in the last few seconds), for its error toast. */
export function recentFailure(message: string): FailureNote | null {
  const f = lastFailure
  return f !== null && f.error.message === message && Date.now() - f.at < 5000 ? f : null
}

/** A copy of a rejected request with its problems fixed, when every one has a safe fix and the copy passes the check. */
function healArgs<C extends Cmd>(cmd: C, args: InvokeArgs<C>, error: ResultError): { args: InvokeArgs<C>; changes: string[] } | null {
  if (error.code !== 'VALIDATION' || args.length === 0 || !Array.isArray(error.details)) return null
  const h = healRequest(args[0], error.details as unknown[])
  if (h === null || h.changes.length === 0 || !parseRequest(cmd, h.value).ok) return null
  return { args: [h.value, ...args.slice(1)] as unknown as InvokeArgs<C>, changes: h.changes }
}

async function send<C extends Cmd>(api: HarpoonApi, cmd: C, args: InvokeArgs<C>): Promise<Result<Res<C>>> {
  try {
    const r: unknown = await api.invoke(cmd, ...args)
    if (isResult(r)) return r as Result<Res<C>>
    return failure('INTERNAL', `Unexpected reply to ${cmd}.`)
  } catch (err) {
    return failure('INTERNAL', err instanceof Error ? err.message : String(err))
  }
}

/** Run a command. Resolves to the handler's Result; never rejects. */
export async function invoke<C extends Cmd>(cmd: C, ...args: InvokeArgs<C>): Promise<Result<Res<C>>> {
  const api = getHarpoon()
  if (api === null) return failure('INTERNAL', NO_BRIDGE_MESSAGE)
  let r = await send(api, cmd, args)
  if (!r.ok) {
    const fix = healArgs(cmd, args, r.error)
    if (fix !== null) {
      const again = await send(api, cmd, fix.args)
      if (again.ok) {
        console.warn(`Harpoon healed a rejected ${cmd} request: ${fix.changes.join('; ')} (was: ${r.error.message})`)
        healed?.({ cmd, changes: fix.changes })
        return again
      }
      r = again
    }
  }
  if (!r.ok) lastFailure = { cmd, error: r.error, at: Date.now() }
  return r
}

/** The value of an ok Result; throws IpcError otherwise. */
export function unwrap<T>(r: Result<T>, cmd?: string): T {
  if (r.ok) return r.value
  throw new IpcError(r.error, cmd)
}

/** invoke + unwrap: resolves to the value or rejects with IpcError. */
export async function call<C extends Cmd>(cmd: C, ...args: InvokeArgs<C>): Promise<Res<C>> {
  return unwrap(await invoke(cmd, ...args), cmd)
}

/** Subscribe to pushed AppEvent batches; a no-op without a bridge. */
export function subscribeEvents(cb: (batch: AppEvent[]) => void): () => void {
  const api = getHarpoon()
  if (api === null) return () => {}
  return api.subscribe(cb)
}

/** Fire-and-forget renderer log line into main's log (errors are ignored: logging must never throw). */
export function logToMain(level: 'info' | 'warn' | 'error', msg: string, data?: unknown): void {
  void invoke('log.write', data === undefined ? { level, msg } : { level, msg, data })
}
