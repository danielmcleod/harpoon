// Codex failure signals (the "X" rows: Codex's structured errors).
// The frame shapes are the generated protocol's (adapters/codex/protocol/v0.160.0, codex-cli 0.160.1). The
// turn/completed `turn.error` is a TurnError {message, codexErrorInfo, additionalDetails, misalignment}; the `error`
// notification is ErrorNotification {error: TurnError, willRetry, threadId, turnId}; CodexErrorInfo is a unit variant
// (a string) or a single-key object carrying httpStatusCode / turnKind. exec --json flattens them into
// turn.failed{error:{message}} and error{message}. The classifier cases stay SYNTHESIZED until the X fixtures are
// recorded live (tests/fixtures/codex/README.md). `local-<preset>` vendors share this table.
import type { FailureCategory } from '../../../shared/failure.ts'
import type { CodexErrorInfo } from '../../adapters/codex/protocol.ts'
import { isUnknownMethodError } from '../../adapters/codex/protocol.ts'
import type { RegexRule, RpcErrorLike, SignalContext, SignalMatch, SignalTable } from './generic.ts'
import { asRecord, isLocalTarget, num, retryDetail, str } from './generic.ts'

/** A CodexErrorInfo variant's name: the string of a unit variant, the key of a struct variant. */
type CodexErrorInfoName = CodexErrorInfo extends infer T ? (T extends string ? T : keyof T) : never

/**
 * app-server `CodexErrorInfo` variant → category; null = not decisive (the message decides). Typed against the
 * generated union, so a variant a newer protocol adds (or drops) fails the build until it is mapped.
 */
export const CODEX_ERROR_INFO: Readonly<Record<string, FailureCategory | null>> = {
  contextWindowExceeded: 'context_exceeded',
  sessionBudgetExceeded: 'quota_exceeded',
  usageLimitExceeded: 'quota_exceeded',
  rateLimitExceeded: 'rate_limited',
  flexUnavailable: 'model_unavailable',
  serverOverloaded: 'vendor_internal',
  cyberPolicy: 'content_policy',
  misalignmentPolicyViolation: 'content_policy',
  tooManyDenials: 'permission_denied',
  httpConnectionFailed: 'network',
  responseStreamConnectionFailed: 'network',
  responseStreamDisconnected: 'network',
  responseTooManyFailedAttempts: 'vendor_internal',
  internalServerError: 'vendor_internal',
  // The probe checked `codex login status` before the run: a 401 mid-run is an expired login.
  unauthorized: 'auth_expired',
  badRequest: null,
  threadRollbackFailed: 'resume_failed',
  sandboxError: 'sandbox_unavailable',
  activeTurnNotSteerable: null,
  other: null,
} satisfies Record<CodexErrorInfoName, FailureCategory | null>

/** Variants that mean "the server could not be reached": a loopback preset's server is down. */
const CONNECTION_INFO = new Set([
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
])

const MODEL_TEXT =
  /\bmodel\b[^\n]{0,80}(?:does not exist|not found|not supported|is not available|unavailable)|model_not_found/i

/** Ordered: the first matching rule wins. Strings are Codex's own where they are known. */
export const CODEX_REGEX: readonly RegexRule[] = [
  {
    id: 'codex.regex.missing-optional-dependency',
    re: /Missing optional dependency @openai\/codex-/i,
    category: 'cli_missing',
  },
  {
    id: 'codex.regex.unexpected-argument',
    re: /error: unexpected argument '[^']*' found|error: unrecognized subcommand|error: invalid value '[^']*' for '--/i,
    category: 'flag_drift',
  },
  {
    id: 'codex.regex.config-retired',
    re: /wire_api = \\?"chat\\?"|approval_policy = \\?"untrusted\\?"/i,
    category: 'config_invalid',
  },
  { id: 'codex.regex.not-logged-in', re: /Not logged in/i, category: 'auth_required' },
  {
    id: 'codex.regex.unauthorized',
    re: /\b401\b[^\n]{0,40}Unauthorized|unexpected status 401\b|\bUnauthorized\b/,
    category: 'auth_expired',
  },
  { id: 'codex.regex.insufficient-quota', re: /insufficient_quota/i, category: 'billing' },
  {
    id: 'codex.regex.usage-limit',
    re: /hit your usage limit|usage limit (?:has been )?(?:reached|exceeded)/i,
    category: 'quota_exceeded',
    detail: retryDetail,
  },
  {
    id: 'codex.regex.too-many-attempts',
    re: /exceeded retry limit/i,
    category: 'vendor_internal',
  },
  {
    id: 'codex.regex.rate-limit',
    re: /rate limit (?:reached|exceeded)|rate_limit_exceeded|\b429 Too Many Requests/i,
    category: 'rate_limited',
    detail: retryDetail,
  },
  {
    id: 'codex.regex.context-window',
    re: /context window|context_length_exceeded|maximum context length/i,
    category: 'context_exceeded',
  },
  {
    id: 'codex.regex.sandbox-setup',
    re: /CreateRestrictedToken failed|setup refresh had errors/i,
    category: 'sandbox_unavailable',
  },
  // The startup banner says the sandbox Codex actually used: read-only after autoedit was asked for.
  {
    id: 'codex.regex.sandbox-read-only',
    re: /sandbox: read-only/i,
    category: 'sandbox_unavailable',
    when: (ctx) => ctx.mode === 'autoedit',
  },
  // A loopback preset: the server is down, lacks the Responses API (`/responses` 404) or the model.
  {
    id: 'codex.regex.local-responses-404',
    re: /\/responses\b[^\n]{0,80}\b404\b|\b404\b[^\n]{0,80}\/responses\b/i,
    category: 'local_server',
    when: isLocalTarget,
  },
  { id: 'codex.regex.local-model', re: MODEL_TEXT, category: 'local_server', when: isLocalTarget },
  {
    id: 'codex.regex.local-unreachable',
    re: /error sending request|stream disconnected|connection refused/i,
    category: 'local_server',
    when: isLocalTarget,
  },
  { id: 'codex.regex.model', re: MODEL_TEXT, category: 'model_unavailable' },
  {
    id: 'codex.regex.stream-disconnected',
    re: /stream disconnected before completion|error sending request for url/i,
    category: 'network',
  },
  {
    id: 'codex.regex.no-rollout',
    re: /no rollout found for thread|thread not found|failed to resume thread/i,
    category: 'resume_failed',
  },
  {
    id: 'codex.regex.server-error',
    re: /\b(?:500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b|server_error|server is overloaded/i,
    category: 'vendor_internal',
  },
]

// ---- frame access -----------------------------------------------------------------------------------------

type Frame = Record<string, unknown>

interface CodexError {
  frame: Frame
  message: string
  /** The CodexErrorInfo variant name (unit variants are strings, struct variants single-key objects). */
  info?: string
  httpStatus?: number
}

function frames(list: readonly unknown[]): Frame[] {
  const out: Frame[] = []
  for (const v of list) {
    const f = asRecord(v)
    if (f) out.push(f)
  }
  return out
}

function infoOf(v: unknown): { info?: string; httpStatus?: number } {
  if (typeof v === 'string') return { info: v }
  const r = asRecord(v)
  if (!r) return {}
  const key = Object.keys(r)[0]
  if (key === undefined) return {}
  const status = num(asRecord(r[key])?.['httpStatusCode'])
  return status !== undefined ? { info: key, httpStatus: status } : { info: key }
}

function errorFrom(frame: Frame, err: unknown): CodexError | undefined {
  const e = asRecord(err)
  if (!e) return undefined
  const extra = str(e['additionalDetails'])
  const message = [str(e['message']) ?? '', extra ?? ''].filter((s) => s.trim() !== '').join('\n')
  return { frame, message, ...infoOf(e['codexErrorInfo']) }
}

/** A failure frame: app-server turn/completed(failed) or error{willRetry:false}; exec turn.failed. */
function failureOf(f: Frame): CodexError | undefined {
  const method = str(f['method'])
  const params = asRecord(f['params'])
  if (method === 'turn/completed') {
    const turn = asRecord(params?.['turn'])
    if (str(turn?.['status']) !== 'failed') return undefined
    return errorFrom(f, turn?.['error']) ?? { frame: f, message: 'The turn failed' }
  }
  if (method === 'error' && params?.['willRetry'] === false) return errorFrom(f, params['error'])
  if (str(f['type']) === 'turn.failed')
    return errorFrom(f, f['error']) ?? { frame: f, message: 'The turn failed' }
  return undefined
}

/** exec `{"type":"error","message"}`: may be transient (willRetry is not exposed), so text evidence only. */
const execErrorText = (f: Frame): string | undefined =>
  str(f['type']) === 'error' ? str(f['message']) : undefined

const firstLine = (s: string): string => {
  const line = s.trim().split('\n')[0] ?? ''
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

function structured(list: readonly unknown[], ctx: SignalContext): SignalMatch | undefined {
  const fs = frames(list)
  for (let i = fs.length - 1; i >= 0; i--) {
    const e = failureOf(fs[i]!)
    if (!e?.info) continue
    let category = CODEX_ERROR_INFO[e.info]
    if (category === undefined) continue
    if (e.info === 'badRequest' && MODEL_TEXT.test(e.message)) category = 'model_unavailable'
    if (isLocalTarget(ctx)) {
      if (CONNECTION_INFO.has(e.info) || e.httpStatus === 404) category = 'local_server'
      else if (category === 'model_unavailable') category = 'local_server'
    }
    if (category === null) continue
    const match: SignalMatch = {
      category,
      rule: `codex.error.${e.info}`,
      message: firstLine(e.message) || `Codex error: ${e.info}`,
      raw: JSON.stringify(e.frame),
    }
    if (category === 'rate_limited' || category === 'quota_exceeded') {
      return { ...match, ...retryDetail(e.message, ctx) }
    }
    return match
  }
  return undefined
}

function texts(list: readonly unknown[]): string[] {
  const out: string[] = []
  for (const f of frames(list)) {
    const e = failureOf(f)
    if (e) out.push(e.message)
    else {
      const t = execErrorText(f)
      if (t !== undefined) out.push(t)
    }
  }
  return out.filter((t) => t.trim() !== '')
}

/**
 * JSON-RPC errors on the app-server route. First a method the server does not know, in both forms codex-cli 0.160.1
 * gives (-32601, or -32600 "unknown variant `<method>`", protocol.ts isUnknownMethodError): a method the
 * route requires is flag_drift, an optional one capability_missing. Then `thread/resume` refused (the
 * thread or its rollout is gone): resume_failed, retried fresh.
 */
function rpc(e: RpcErrorLike): SignalMatch | undefined {
  // -32601 itself is the generic table's (generic.rpc.method-not-found, same categories); this is the -32600 form.
  if (e.code !== -32601 && isUnknownMethodError(e)) {
    return {
      category: e.required === true ? 'flag_drift' : 'capability_missing',
      rule: 'codex.rpc.unknown-method',
      message: `${e.message ?? 'Unknown method'}${e.method !== undefined ? ` (${e.method})` : ''}`,
    }
  }
  if (e.method === 'thread/resume' && e.code !== -32601) {
    return {
      category: 'resume_failed',
      rule: 'codex.rpc.thread-resume',
      message: `${e.message ?? 'Could not resume the thread'} (thread/resume)`,
    }
  }
  return undefined
}

export const CODEX_SIGNALS: SignalTable = {
  vendor: 'codex',
  hasFailure: (list) => frames(list).some((f) => failureOf(f) !== undefined),
  structured,
  texts,
  rpc,
  regex: CODEX_REGEX,
}
