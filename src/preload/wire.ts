// The preload ⇄ main wire format: the command envelope carries the IPC protocol version, and main hands the initial
// ThemeState to the preload as a base64url JSON argument. Shared by main and the sandboxed preload, so it uses only
// web/Node-common globals (btoa, atob, TextEncoder) and no zod.
import type { Cmd, CmdEnvelope, ThemeState } from '../shared/ipc.ts'
import { IPC_PROTOCOL, THEMES } from '../shared/ipc.ts'

/** CmdEnvelope plus the protocol version; main rejects any other version. */
export interface WireEnvelope extends CmdEnvelope {
  v: number
}

export function makeEnvelope(cmd: Cmd, req: unknown, cid: string): WireEnvelope {
  return { v: IPC_PROTOCOL, cmd, req, cid }
}

export const THEME_ARG_PREFIX = '--harpoon-theme='

export const FALLBACK_THEME: ThemeState = { theme: 'dark', resolved: 'dark' }

function toBase64Url(text: string): string {
  let bin = ''
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function isThemeState(v: unknown): v is ThemeState {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (THEMES as readonly unknown[]).includes(r['theme']) && (r['resolved'] === 'light' || r['resolved'] === 'dark')
}

export function encodeThemeArg(s: ThemeState): string {
  return THEME_ARG_PREFIX + toBase64Url(JSON.stringify({ theme: s.theme, resolved: s.resolved }))
}

/** The ThemeState passed on the command line, or null when absent or malformed. */
export function decodeThemeArg(argv: readonly string[]): ThemeState | null {
  const arg = argv.find((a) => a.startsWith(THEME_ARG_PREFIX))
  if (arg === undefined) return null
  try {
    const v: unknown = JSON.parse(fromBase64Url(arg.slice(THEME_ARG_PREFIX.length)))
    return isThemeState(v) ? { theme: v.theme, resolved: v.resolved } : null
  } catch {
    return null
  }
}
