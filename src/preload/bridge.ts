// window.harpoon: HarpoonApi over an ipcRenderer-like object.
// invoke never rejects (a transport failure becomes INTERNAL); subscribe fans one `harpoon:evt` listener out to
// every subscriber and removes it when the last one leaves. The raw ipcRenderer and its events never reach the page.
import type {
  AppEvent,
  Cmd,
  HarpoonApi,
  InvokeArgs,
  Platform,
  Res,
  Result,
  ThemeState,
} from '../shared/ipc.ts'
import { CMD_CHANNEL, EVT_CHANNEL } from '../shared/ipc.ts'
import { FALLBACK_THEME, decodeThemeArg, makeEnvelope } from './wire.ts'

/** The part of Electron's ipcRenderer the bridge uses. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

export interface BridgeOptions {
  platform: string
  argv: readonly string[]
  /** Where subscriber exceptions are reported (default console.error). */
  onSubscriberError?: (err: unknown) => void
}

const PLATFORMS: readonly Platform[] = ['win32', 'darwin', 'linux']

function isResult(v: unknown): v is Result<unknown> {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  if (r['ok'] === true) return true
  const e = r['error']
  return (
    r['ok'] === false &&
    typeof e === 'object' &&
    e !== null &&
    typeof (e as Record<string, unknown>)['code'] === 'string'
  )
}

const internal = (message: string): Result<never> => ({ ok: false, error: { code: 'INTERNAL', message } })

export function createHarpoonApi(ipc: IpcRendererLike, o: BridgeOptions): HarpoonApi {
  let seq = 0
  const cidBase = Date.now().toString(36)
  const subscribers = new Set<{ cb: (batch: AppEvent[]) => void }>()
  const report = o.onSubscriberError ?? ((err: unknown) => console.error('harpoon subscriber failed', err))
  const listener = (_event: unknown, ...args: unknown[]): void => {
    const batch = args[0]
    if (!Array.isArray(batch)) return
    for (const s of [...subscribers]) {
      try {
        s.cb(batch as AppEvent[])
      } catch (err) {
        report(err)
      }
    }
  }

  const invoke = <C extends Cmd>(cmd: C, ...args: InvokeArgs<C>): Promise<Result<Res<C>>> => {
    const envelope = makeEnvelope(cmd, args[0], `${cidBase}-${++seq}`)
    return ipc.invoke(CMD_CHANNEL, envelope).then(
      (r) => (isResult(r) ? (r as Result<Res<C>>) : internal('Malformed reply from the main process.')),
      (err: unknown) => internal(err instanceof Error ? err.message : String(err)),
    )
  }

  const subscribe = (cb: (batch: AppEvent[]) => void): (() => void) => {
    if (typeof cb !== 'function') throw new TypeError('subscribe needs a callback')
    const entry = { cb }
    subscribers.add(entry)
    if (subscribers.size === 1) ipc.on(EVT_CHANNEL, listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      subscribers.delete(entry)
      if (subscribers.size === 0) ipc.removeListener(EVT_CHANNEL, listener)
    }
  }

  const platform: Platform = (PLATFORMS as readonly string[]).includes(o.platform)
    ? (o.platform as Platform)
    : 'linux'
  const initialTheme: ThemeState = decodeThemeArg(o.argv) ?? FALLBACK_THEME
  return { invoke, subscribe, platform, initialTheme }
}
