// ACP and Gemini failure signals (the "G" and "ACP" rows). The ACP shapes follow the vendored ACP schema
// (acp-base/protocol/: ErrorCode authRequired -32000 and resourceNotFound -32002, PromptResponse stopReason); the
// Gemini exit codes and
// texts are not yet confirmed live, and the G fixtures are synthesized until they are recorded live. The ACP
// part is shared with later ACP vendors through acpSignals().
import type { FailureCategory } from '../../../shared/failure.ts'
import type { ExitRule, RegexRule, RpcErrorLike, SignalMatch, SignalTable } from './generic.ts'
import { asRecord, num, retryDetail, str } from './generic.ts'

/** ACP `RequestError.authRequired()` (schema ErrorCode "Authentication required"). */
export const ACP_AUTH_REQUIRED = -32000
/** ACP schema ErrorCode "Resource not found" (a session/load or session/resume of a session the agent lacks). */
export const ACP_RESOURCE_NOT_FOUND = -32002

/** PromptResponse stopReason → category (`end_turn`, `max_tokens` and `cancelled` are not failures). */
export const ACP_STOP_REASONS: Readonly<Record<string, FailureCategory>> = {
  refusal: 'content_policy',
  max_turn_requests: 'turn_limit',
}

const INVALID_SESSION = /Invalid session identifier/i
const INVALID_MODE = /Invalid or unavailable mode/i
const UNTRUSTED = /not running in a trusted directory|Cannot enable privileged approval modes/i

/** ACP JSON-RPC error → category (before the generic -32601/-32602 table). */
export function acpRpcMatch(e: RpcErrorLike): SignalMatch | undefined {
  const text = e.message ?? ''
  const message = `${text || 'JSON-RPC error'}${e.method ? ` (${e.method})` : ''}`
  if (e.code === ACP_AUTH_REQUIRED)
    return { category: 'auth_required', rule: 'acp.rpc.auth-required', message }
  const resuming = e.method === 'session/load' || e.method === 'session/resume'
  if (INVALID_SESSION.test(text) || ((e.code === -32602 || e.code === ACP_RESOURCE_NOT_FOUND) && resuming)) {
    return { category: 'resume_failed', rule: 'acp.rpc.invalid-session', message }
  }
  if (INVALID_MODE.test(text)) return { category: 'flag_drift', rule: 'acp.rpc.invalid-mode', message }
  if (UNTRUSTED.test(text)) return { category: 'trust_required', rule: 'acp.rpc.untrusted', message }
  return undefined
}

// ---- frames -----------------------------------------------------------------------------------------------

type Frame = Record<string, unknown>

function frames(list: readonly unknown[]): Frame[] {
  const out: Frame[] = []
  for (const v of list) {
    const f = asRecord(v)
    if (f) out.push(f)
  }
  return out
}

/** A JSON-RPC error response (`{id, error:{code, message}}`). */
function rpcErrorOf(f: Frame): RpcErrorLike | undefined {
  const e = asRecord(f['error'])
  const code = num(e?.['code'])
  if (f['id'] === undefined || code === undefined) return undefined
  const message = str(e?.['message'])
  return message !== undefined ? { code, message } : { code }
}

const stopReasonOf = (f: Frame): string | undefined => str(asRecord(f['result'])?.['stopReason'])

/** Gemini `-p --output-format stream-json`: `{type:'result', status:'error', error:{type, message}}`. */
const streamErrorOf = (f: Frame): string | undefined =>
  str(f['type']) === 'result' && str(f['status']) === 'error'
    ? (str(asRecord(f['error'])?.['message']) ?? 'Gemini reported an error')
    : undefined

const isFailureFrame = (f: Frame): boolean => {
  const stop = stopReasonOf(f)
  return (
    rpcErrorOf(f) !== undefined ||
    (stop !== undefined && ACP_STOP_REASONS[stop] !== undefined) ||
    streamErrorOf(f) !== undefined
  )
}

function structured(list: readonly unknown[]): SignalMatch | undefined {
  const fs = frames(list)
  for (let i = fs.length - 1; i >= 0; i--) {
    const f = fs[i]!
    const stop = stopReasonOf(f)
    const category = stop !== undefined ? ACP_STOP_REASONS[stop] : undefined
    if (stop !== undefined && category !== undefined) {
      return {
        category,
        rule: `acp.stop.${stop}`,
        message: stop === 'refusal' ? 'The model refused the request' : 'Turn limit reached',
        raw: JSON.stringify(f),
      }
    }
    const e = rpcErrorOf(f)
    const m = e ? acpRpcMatch(e) : undefined
    if (m) return { ...m, raw: JSON.stringify(f) }
  }
  return undefined
}

function texts(list: readonly unknown[]): string[] {
  const out: string[] = []
  for (const f of frames(list)) {
    const e = rpcErrorOf(f)
    if (e?.message !== undefined) out.push(e.message)
    const s = streamErrorOf(f)
    if (s !== undefined) out.push(s)
  }
  return out.filter((t) => t.trim() !== '')
}

/** Regexes every ACP vendor shares. */
export const ACP_REGEX: readonly RegexRule[] = [
  { id: 'acp.regex.invalid-session', re: INVALID_SESSION, category: 'resume_failed' },
  { id: 'acp.regex.invalid-mode', re: INVALID_MODE, category: 'flag_drift' },
]

/** An ACP vendor's table: the shared ACP stages plus the vendor's exit codes and regexes (first). */
export function acpSignals(
  vendor: string,
  extra: { exit?: readonly ExitRule[]; regex?: readonly RegexRule[] } = {},
): SignalTable {
  return {
    vendor,
    hasFailure: (list) => frames(list).some(isFailureFrame),
    structured,
    texts,
    rpc: acpRpcMatch,
    ...(extra.exit ? { exit: extra.exit } : {}),
    regex: [...(extra.regex ?? []), ...ACP_REGEX],
  }
}

// ---- Gemini -----------------------------------------------------------------------------------------------

/**
 * Gemini's FatalError exit codes (packages/core/src/utils/errors.ts: 41 auth, 42 input, 44 sandbox,
 * 52 config, 53 turn limit, 54 tool, 55 trust); 130 is a cancel, 1 is general. The adapter's config
 * (adapters/gemini) carries the same table. 54 = FatalToolExecutionError: currently only NO_SPACE_LEFT.
 */
export const GEMINI_EXIT_CODES: Readonly<Record<number, FailureCategory>> = {
  41: 'auth_required',
  42: 'flag_drift',
  44: 'sandbox_unavailable',
  52: 'config_invalid',
  53: 'turn_limit',
  54: 'disk_full',
  55: 'trust_required',
}

/** An ACP vendor's exit-code table as classifier rules (`<vendor>.exit.<code>`), in code order. */
export function exitRulesOf(vendor: string, codes: Readonly<Record<number, FailureCategory>>): ExitRule[] {
  return Object.entries(codes)
    .map(([code, category]) => ({ id: `${vendor}.exit.${code}`, codes: [Number(code)], category }))
    .sort((a, b) => (a.codes[0] ?? 0) - (b.codes[0] ?? 0))
}

export const GEMINI_EXIT: readonly ExitRule[] = exitRulesOf('gemini', GEMINI_EXIT_CODES)

/** Ordered: the first matching rule wins. A daily quota beats a per-minute rate limit beats a bare 429. */
export const GEMINI_REGEX: readonly RegexRule[] = [
  { id: 'gemini.regex.auth-method', re: /Please set an Auth method/i, category: 'auth_required' },
  { id: 'gemini.regex.untrusted', re: UNTRUSTED, category: 'trust_required' },
  {
    id: 'gemini.regex.quota-daily',
    re: /PerDay|per[ -]day\b|daily (?:quota|limit)/i,
    category: 'quota_exceeded',
    detail: retryDetail,
  },
  {
    id: 'gemini.regex.rate-per-minute',
    re: /PerMinute|per[ -]minute\b/i,
    category: 'rate_limited',
    detail: retryDetail,
  },
  {
    id: 'gemini.regex.resource-exhausted',
    re: /RESOURCE_EXHAUSTED/,
    category: 'quota_exceeded',
    detail: retryDetail,
  },
  {
    id: 'gemini.regex.429',
    re: /\b429\b|Too Many Requests/i,
    category: 'rate_limited',
    detail: retryDetail,
  },
  {
    id: 'gemini.regex.context',
    re: /exceeds the maximum number of tokens/i,
    category: 'context_exceeded',
  },
  {
    id: 'gemini.regex.model',
    re: /models\/[\w.-]+ is not found|not found for API version|\bmodel\b[^\n]{0,60}not found/i,
    category: 'model_unavailable',
  },
  { id: 'gemini.regex.no-space', re: /NO_SPACE_LEFT/, category: 'disk_full' },
]

export const GEMINI_SIGNALS: SignalTable = acpSignals('gemini', { exit: GEMINI_EXIT, regex: GEMINI_REGEX })
