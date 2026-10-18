// Vendor-independent failure signals (the "*" rows) and the signal-table shape that vendor tables
// (signals/claude.ts, codex.ts, acp-gemini.ts) implement. Consumed by heal/classify.ts.
import type { FailureCategory } from '../../../shared/failure.ts'
import type { Mode } from '../../../shared/run.ts'
import { localPresetIdOf } from '../../../shared/vendors.ts'

export interface SignalContext {
  vendor: string
  exitCode: number | null | undefined
  signal: string | null | undefined
  ranMs: number | undefined
  now: number
  /** The mode the pass asked for (Codex `sandbox: read-only` under autoedit is sandbox_unavailable). */
  mode?: Mode
  /** The target is a loopback local-model server. */
  loopback?: boolean
}

/** A `local-<preset>` vendor, or any target Harpoon knows is a loopback server. */
export const isLocalTarget = (ctx: Pick<SignalContext, 'vendor' | 'loopback'>): boolean =>
  ctx.loopback === true || localPresetIdOf(ctx.vendor) !== null

/** One classifier hit. `rule` is a stable id (`<table>.<stage>.<name>`) used by tests and the heal cache. */
export interface SignalMatch {
  category: FailureCategory
  rule: string
  message: string
  /** Evidence (frame JSON or text); classify.ts redacts and truncates it. */
  raw?: string
  resetsAt?: number
  retryAfterMs?: number
  /** Recovery conditions, e.g. `claude-env-key`. */
  hints?: string[]
}

export interface RegexRule {
  id: string
  re: RegExp
  category: FailureCategory
  hints?: string[]
  /** Applies only in this context (a local target, a requested mode). */
  when?: (ctx: SignalContext) => boolean
  /** Extra fields read from the matching text (a retry delay). */
  detail?: (text: string, ctx: SignalContext) => Pick<SignalMatch, 'resetsAt' | 'retryAfterMs'> | undefined
}

export interface ExitRule {
  id: string
  codes?: readonly number[]
  signals?: readonly string[]
  category: FailureCategory
}

/** A vendor's plug-in for the classifier. Every stage is optional. */
export interface SignalTable {
  vendor: string
  /** Frames that are failure evidence on their own (an error result, an assistant error, a rejection). */
  hasFailure?(frames: readonly unknown[]): boolean
  /** Precedence stage 3: structured fields of non-retry frames. */
  structured?(frames: readonly unknown[], ctx: SignalContext): SignalMatch | undefined
  /** Precedence stage 3, before the generic JSON-RPC table: a vendor's own reading of an RPC error. */
  rpc?(e: RpcErrorLike, ctx: SignalContext): SignalMatch | undefined
  /** Texts carried by structured frames (error result text, errors[]) for the regex stage. */
  texts?(frames: readonly unknown[]): string[]
  /** Frames the vendor will retry by itself (Claude api_retry, Codex willRetry); never a failure alone. */
  isRetry?(frame: unknown): boolean
  /** Supporting evidence from retry frames, consulted only after the regex stage. */
  retryHint?(frames: readonly unknown[], ctx: SignalContext): SignalMatch | undefined
  exit?: readonly ExitRule[]
  regex?: readonly RegexRule[]
}

// ---- helpers ----------------------------------------------------------------------------------------------

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t.startsWith('{')) return undefined
    try {
      return asRecord(JSON.parse(t))
    } catch {
      return undefined
    }
  }
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** The line of `text` containing the first match of `re`, trimmed to 300 chars. */
export function matchedLine(text: string, re: RegExp): string | undefined {
  const m = re.exec(text)
  if (!m) return undefined
  const start = text.lastIndexOf('\n', m.index) + 1
  const endNl = text.indexOf('\n', m.index + m[0].length)
  const line = text.slice(start, endNl === -1 ? undefined : endNl).trim()
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

/** ms per unit, by the unit word's first letter (`ms` apart). */
function unitMs(unit: string): number {
  const u = unit.toLowerCase()
  if (u === 'ms') return 1
  const first = u[0]
  return first === 's' ? 1_000 : first === 'm' ? 60_000 : first === 'h' ? 3_600_000 : 86_400_000
}
// A unit ends where letters end, so compact forms ("7h3m12s") read as three parts.
const DURATION_PART =
  /(\d+(?:\.\d+)?)\s*(ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)(?![a-z])/gi
const RETRY_LEAD =
  /(?:retry(?:ing)? in|try again in|retry after|retryDelay"?\s*[:=]\s*"?|Retry-After:\s*)\s*((?:\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)?(?![a-z])[\s,]*(?:and\s+)?)+)/i

/**
 * The retry delay a vendor wrote in its error text, in ms: `Please retry in 41.5s`, `"retryDelay": "41s"`,
 * `try again in 2 days 3 hours 4 minutes`, `Retry-After: 30` (bare numbers are seconds). Undefined when absent.
 */
export function retryAfterFromText(text: string): number | undefined {
  const lead = RETRY_LEAD.exec(text)
  if (!lead) return undefined
  const spec = lead[1]!.trim()
  if (/^\d+(?:\.\d+)?$/.test(spec)) return Math.round(Number(spec) * 1_000)
  let ms = 0
  let parts = 0
  for (const m of spec.matchAll(DURATION_PART)) {
    ms += Number(m[1]) * unitMs(m[2]!)
    parts++
  }
  return parts > 0 ? Math.round(ms) : undefined
}

/** RegexRule.detail for rate and usage limits: the delay written in the text becomes retryAfterMs/resetsAt. */
export function retryDetail(
  text: string,
  ctx: Pick<SignalContext, 'now'>,
): Pick<SignalMatch, 'resetsAt' | 'retryAfterMs'> | undefined {
  const ms = retryAfterFromText(text)
  return ms === undefined ? undefined : { retryAfterMs: ms, resetsAt: ctx.now + ms }
}

// ---- errno (precedence stage 2) ---------------------------------------------------------------------------

export const SPAWN_ERRNOS = ['ENOENT', 'EACCES', 'EINVAL', 'ENOEXEC', 'EPERM', 'UNKNOWN', 'ENOTDIR'] as const
export const NETWORK_ERRNOS = [
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNABORTED',
  'EPROTO',
] as const

/**
 * errno → category. Spawn errnos mean the CLI cannot be started (git → git_missing). ECONNREFUSED to a
 * loopback preset is local_server. ECWD (missing working folder) is folder_guard. EPIPE and friends are left
 * to later stages (the child died first).
 */
export function errnoCategory(
  errno: string,
  o: { vendor: string; loopback?: boolean },
): FailureCategory | undefined {
  const e = errno.toUpperCase()
  if (e === 'ENOSPC' || e === 'EDQUOT') return 'disk_full'
  // spawnChild's own code for a missing working folder (Node reports it as ENOENT on the binary).
  if (e === 'ECWD') return 'folder_guard'
  if ((NETWORK_ERRNOS as readonly string[]).includes(e)) return o.loopback ? 'local_server' : 'network'
  if ((SPAWN_ERRNOS as readonly string[]).includes(e))
    return o.vendor === 'git' ? 'git_missing' : 'cli_missing'
  return undefined
}

// ---- JSON-RPC errors (structured) -------------------------------------------------------------------------

export interface RpcErrorLike {
  code: number
  message?: string
  data?: unknown
  /** The method that failed. */
  method?: string
  /** The method is required by the route ; a missing optional one is capability_missing. */
  required?: boolean
}

export function rpcErrorMatch(e: RpcErrorLike): SignalMatch | undefined {
  const what = e.method ? ` (${e.method})` : ''
  const message = `${e.message ?? 'JSON-RPC error'}${what}`
  if (e.code === -32601) {
    return {
      category: e.required ? 'flag_drift' : 'capability_missing',
      rule: 'generic.rpc.method-not-found',
      message,
    }
  }
  if (e.code === -32602 && e.required === false) {
    return { category: 'capability_missing', rule: 'generic.rpc.invalid-params-optional', message }
  }
  if (e.code === -32001) return { category: 'vendor_internal', rule: 'generic.rpc.overloaded', message }
  return undefined
}

// ---- exit codes (precedence stage 4) ----------------------------------------------------------------------

/** Windows NTSTATUS crash codes as Node reports them (unsigned) and their signed forms. */
export const WINDOWS_CRASH_CODES = [
  3221225477, // 0xC0000005 access violation
  3221226505, // 0xC0000409 stack buffer overrun / fail-fast
  3221225725, // 0xC00000FD stack overflow
  3221225794, // 0xC0000142 DLL initialization failed
  3221225501, // 0xC000001D illegal instruction
  -1073741819,
  -1073740791,
  -1073741571,
  -1073741502,
] as const

export const GENERIC_EXIT: readonly ExitRule[] = [
  { id: 'generic.exit.windows-crash', codes: WINDOWS_CRASH_CODES, category: 'process_crash' },
  {
    id: 'generic.exit.crash-signal',
    signals: ['SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL', 'SIGFPE', 'SIGKILL', 'SIGTERM', 'SIGTRAP'],
    category: 'process_crash',
  },
  // 128 + signal from a shell/wrapper: SIGILL, SIGTRAP, SIGABRT, SIGBUS, SIGFPE, SIGKILL, SIGSEGV, SIGTERM.
  {
    id: 'generic.exit.signal-status',
    codes: [132, 133, 134, 135, 136, 137, 139, 143],
    category: 'process_crash',
  },
  // Shell/launcher could not find or run the command (POSIX 126/127, cmd.exe 9009).
  { id: 'generic.exit.command-not-found', codes: [126, 127, 9009], category: 'cli_missing' },
]

// ---- regexes (precedence stage 5) -------------------------------------------------------------------------

export const GENERIC_REGEX: readonly RegexRule[] = [
  {
    id: 'generic.regex.disk-full',
    re: /No space left on device|\bENOSPC\b|not enough space on the disk|There is not enough space/i,
    category: 'disk_full',
  },
  {
    id: 'generic.regex.loopback-refused',
    re: /ECONNREFUSED[^\n]{0,40}(?:127\.0\.0\.1|localhost|\[?::1\]?)/i,
    category: 'local_server',
  },
  {
    id: 'generic.regex.network',
    re: /\b(?:ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ECONNABORTED)\b|getaddrinfo|socket hang up|network is unreachable|Could not resolve host|fetch failed|unable to get local issuer certificate|self[- ]signed certificate in certificate chain/i,
    category: 'network',
  },
  {
    id: 'generic.regex.command-not-found',
    re: /is not recognized as an internal or external command|: command not found|cannot execute binary file|Exec format error|is not a valid Win32 application/i,
    category: 'cli_missing',
  },
  // git_state carries the recovery condition its card needs (heal/categories.ts `git-dubious` / `git-lock`).
  {
    id: 'generic.regex.git-dubious',
    re: /detected dubious ownership|unsafe repository/i,
    category: 'git_state',
    hints: ['git-dubious'],
  },
  {
    id: 'generic.regex.git-lock',
    re: /index\.lock'?:? File exists|Another git process seems to be running/i,
    category: 'git_state',
    hints: ['git-lock'],
  },
]

// ---- heuristics (precedence stage 6) ----------------------------------------------------------------------

const FLAG_DRIFT_HEURISTIC = [
  /\b(?:unknown|unrecognized|unexpected|invalid|unsupported)\b[^\n]{0,40}\b(?:options?|arguments?|flags?|subcommands?|parameters?)\b/i,
  /\berror:[^\n]{0,80}'--?[A-Za-z][\w-]*'/,
] as const
const OOM_HEURISTIC = /JavaScript heap out of memory|FATAL ERROR: [^\n]*Allocation failed|out of memory/i

/** Stage 6. Only consulted on a failed exit with nothing more specific. */
export function heuristicMatch(texts: readonly string[]): SignalMatch | undefined {
  for (const t of texts) {
    for (const re of FLAG_DRIFT_HEURISTIC) {
      const line = matchedLine(t, re)
      if (line) return { category: 'flag_drift', rule: 'generic.heuristic.flag-drift', message: line, raw: t }
    }
    const oom = matchedLine(t, OOM_HEURISTIC)
    if (oom) return { category: 'process_crash', rule: 'generic.heuristic.oom', message: oom, raw: t }
  }
  return undefined
}

// ---- retry frames ------------------------------------------------------------------------------------------

/** A frame the vendor itself will retry: `{willRetry:true}` at the top level or in JSON-RPC `params`. */
export function isWillRetryFrame(frame: unknown): boolean {
  const f = asRecord(frame)
  if (!f) return false
  if (f['willRetry'] === true) return true
  const params = asRecord(f['params'])
  return params?.['willRetry'] === true
}

export const GENERIC_SIGNALS: SignalTable = {
  vendor: '*',
  isRetry: isWillRetryFrame,
  exit: GENERIC_EXIT,
  regex: GENERIC_REGEX,
}
