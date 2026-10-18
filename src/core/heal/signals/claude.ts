// Claude Code failure signals (the "C" rows: Claude Code's auth and limit messages).
// Structured fields come from stream-json frames:
// assistant.error, system/api_retry.error, rate_limit_event.rate_limit_info, result.{subtype,
// startup_failure_reason, terminal_reason, api_error_status}, system/model_refusal_no_fallback.
import type { FailureCategory } from '../../../shared/failure.ts'
import type {
  SDKAssistantMessageError,
  SDKRateLimitInfo,
  SDKStartupFailureReason,
  TerminalReason,
} from '@anthropic-ai/claude-agent-sdk'
import type { RegexRule, SignalContext, SignalMatch, SignalTable } from './generic.ts'
import { asRecord, num, str } from './generic.ts'

/** `assistant.error` / `api_retry.error` → category; null = not decisive on its own. Exhaustive over the SDK. */
export const CLAUDE_ASSISTANT_ERRORS: Readonly<Record<SDKAssistantMessageError, FailureCategory | null>> = {
  authentication_failed: 'auth_required',
  oauth_org_not_allowed: 'auth_required',
  account_on_hold: 'billing',
  verification_required: 'auth_required',
  billing_error: 'billing',
  rate_limit: 'rate_limited',
  overloaded: 'vendor_internal',
  invalid_request: null,
  model_not_found: 'model_unavailable',
  server_error: 'vendor_internal',
  unknown: null,
  max_output_tokens: 'turn_limit',
  cloud_credential_error: 'auth_required',
}

/** `result.startup_failure_reason` (CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1) → category. */
export const CLAUDE_STARTUP_FAILURES: Readonly<Record<SDKStartupFailureReason, FailureCategory | null>> = {
  org_pin_api_key_conflict: 'auth_required',
  provider_not_allowed: 'auth_required',
  org_verify_failed: 'auth_expired',
  org_pin_mismatch: 'auth_required',
  managed_settings_invalid: 'config_invalid',
  remote_settings_required_unavailable: 'network',
  gateway_signin_required: 'auth_expired',
  gateway_access_denied: 'auth_required',
  proxy_invalid: 'network',
  temp_dir_unusable: null,
  cwd_unavailable: 'folder_guard',
  shell_tool_missing: 'cli_missing',
  session_held_by_background: 'resume_failed',
  worktree_resume_refused: 'resume_failed',
  worktree_unverified: 'resume_failed',
  cli_version_too_old: 'cli_version',
  bypass_root: 'config_invalid',
}

export const CLAUDE_TERMINAL_REASONS: Readonly<Partial<Record<TerminalReason, FailureCategory>>> = {
  prompt_too_long: 'context_exceeded',
  max_turns: 'turn_limit',
  budget_exhausted: 'turn_limit',
  structured_output_retry_exhausted: 'stream_malformed',
}

type RateLimitType = NonNullable<SDKRateLimitInfo['rateLimitType']>

/** Rejections of these windows are usage quotas (wait for the reset); others are plain rate limits. */
export const CLAUDE_QUOTA_WINDOWS: readonly RateLimitType[] = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
]

/** Ordered: the first matching rule wins. Strings are the CLI's own (see header). */
export const CLAUDE_REGEX: readonly RegexRule[] = [
  {
    id: 'claude.regex.no-conversation',
    re: /No conversation found with session ID/i,
    category: 'resume_failed',
  },
  {
    id: 'claude.regex.requires-flag',
    re: /requires --(?:verbose|print)\b|--include-partial-messages requires/i,
    category: 'flag_drift',
  },
  {
    id: 'claude.regex.unknown-option',
    re: /\bunknown option\b|error: option '[^']+' argument missing|error: unknown command/i,
    category: 'flag_drift',
  },
  {
    id: 'claude.regex.login-expired',
    re: /OAuth token (?:has expired|(?:has been )?revoked)|Login expired/i,
    category: 'auth_expired',
  },
  { id: 'claude.regex.not-logged-in', re: /Not logged in/i, category: 'auth_required' },
  {
    id: 'claude.regex.invalid-api-key',
    re: /Invalid API key|API key is invalid/i,
    category: 'auth_required',
    hints: ['claude-env-key'],
  },
  {
    id: 'claude.regex.api-401',
    re: /API Error: 401\b|Invalid authentication credentials/i,
    category: 'auth_required',
  },
  // `claude auth status` JSON (exit 1) and the generic "/login" hint, after the specific auth strings.
  { id: 'claude.regex.auth-status', re: /"loggedIn"\s*:\s*false/, category: 'auth_required' },
  { id: 'claude.regex.run-login', re: /Please run \/login/i, category: 'auth_required' },
  { id: 'claude.regex.credit-balance', re: /Credit balance is too low/i, category: 'billing' },
  { id: 'claude.regex.hit-limit', re: /hit your [^\n]*limit/i, category: 'quota_exceeded' },
  { id: 'claude.regex.rate-429', re: /Request rejected \(429\)|API Error: 429\b/i, category: 'rate_limited' },
  {
    id: 'claude.regex.overloaded',
    re: /Repeated 529 Overloaded|API Error: 5\d\d\b|overloaded_error/i,
    category: 'vendor_internal',
  },
  { id: 'claude.regex.prompt-too-long', re: /prompt is too long/i, category: 'context_exceeded' },
  {
    id: 'claude.regex.model',
    re: /issue with the selected model|not_found_error[^\n]{0,80}model|model[^\n]{0,40}(?:not found|does not exist)/i,
    category: 'model_unavailable',
  },
]

const EXPIRED = /OAuth token (?:has expired|(?:has been )?revoked)|Login expired|token[^\n]{0,20}expired/i
const ENV_KEY = /Invalid API key|API key is invalid|ANTHROPIC_API_KEY/i
const HIT_LIMIT = /hit your [^\n]*limit/i
const PROMPT_TOO_LONG = /prompt is too long/i

// ---- frame access -----------------------------------------------------------------------------------------

type Frame = Record<string, unknown>

const typeOf = (f: Frame): string | undefined => str(f['type'])
const subtypeOf = (f: Frame): string | undefined => str(f['subtype'])
const isMainThread = (f: Frame): boolean =>
  f['parent_tool_use_id'] === null || f['parent_tool_use_id'] === undefined

function frames(list: readonly unknown[]): Frame[] {
  const out: Frame[] = []
  for (const v of list) {
    const f = asRecord(v)
    if (f) out.push(f)
  }
  return out
}

function last<T>(list: readonly T[], pred: (v: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i]!)) return list[i]
  return undefined
}

const isResult = (f: Frame): boolean => typeOf(f) === 'result'
const isErrorResult = (f: Frame): boolean =>
  isResult(f) && (f['is_error'] === true || (subtypeOf(f) !== undefined && subtypeOf(f) !== 'success'))
const isAssistantError = (f: Frame): boolean =>
  typeOf(f) === 'assistant' && isMainThread(f) && typeof f['error'] === 'string'
const rateLimitInfo = (f: Frame): Frame | undefined =>
  typeOf(f) === 'rate_limit_event' ? asRecord(f['rate_limit_info']) : undefined
/** A rejection that blocks requests: not covered by overage (paid extra usage keeps the session going). */
const isRejection = (f: Frame): boolean => {
  const info = rateLimitInfo(f)
  if (str(info?.['status']) !== 'rejected') return false
  const overage = str(info?.['overageStatus'])
  return info?.['isUsingOverage'] !== true && overage !== 'allowed' && overage !== 'allowed_warning'
}
const isRefusal = (f: Frame): boolean =>
  typeOf(f) === 'system' && subtypeOf(f) === 'model_refusal_no_fallback'
const isAuthStatusError = (f: Frame): boolean => typeOf(f) === 'auth_status' && typeof f['error'] === 'string'
const isApiRetry = (f: Frame): boolean => typeOf(f) === 'system' && subtypeOf(f) === 'api_retry'

function assistantText(f: Frame): string {
  const msg = asRecord(f['message'])
  const content = msg?.['content']
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => asRecord(b))
    .filter((b): b is Frame => b !== undefined && b['type'] === 'text')
    .map((b) => str(b['text']) ?? '')
    .join('\n')
}

function resultText(f: Frame): string {
  const parts: string[] = []
  const r = str(f['result'])
  if (r) parts.push(r)
  const errors = f['errors']
  if (Array.isArray(errors)) for (const e of errors) if (typeof e === 'string') parts.push(e)
  return parts.join('\n')
}

const firstLine = (s: string): string => {
  const line = s.trim().split('\n')[0] ?? ''
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

/** Claude reports `resetsAt` in epoch seconds; accept milliseconds too. */
export function resetsAtMs(v: unknown): number | undefined {
  const n = num(v)
  if (n === undefined || n <= 0) return undefined
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

const json = (f: Frame): string => JSON.stringify(f)

function withReset(m: SignalMatch, resetsAt: number | undefined, now: number): SignalMatch {
  if (resetsAt === undefined) return m
  return { ...m, resetsAt, retryAfterMs: Math.max(0, resetsAt - now) }
}

// ---- stages -----------------------------------------------------------------------------------------------

function assistantErrorMatch(f: Frame, rule: string): SignalMatch | undefined {
  const err = str(f['error']) as SDKAssistantMessageError | undefined
  if (!err) return undefined
  const text = typeOf(f) === 'assistant' ? assistantText(f) : ''
  const message = firstLine(text) || `Claude API error: ${err}`
  const hit = (category: FailureCategory, extra: Partial<SignalMatch> = {}): SignalMatch => ({
    category,
    rule: `${rule}.${err}`,
    message,
    raw: json(f),
    ...extra,
  })
  if (err === 'authentication_failed') {
    if (EXPIRED.test(text)) return hit('auth_expired')
    return hit('auth_required', ENV_KEY.test(text) ? { hints: ['claude-env-key'] } : {})
  }
  if (err === 'rate_limit' && HIT_LIMIT.test(text)) return hit('quota_exceeded')
  if (err === 'invalid_request') return PROMPT_TOO_LONG.test(text) ? hit('context_exceeded') : undefined
  const category = CLAUDE_ASSISTANT_ERRORS[err] as FailureCategory | null | undefined
  return category ? hit(category) : undefined
}

function apiStatusCategory(status: number): FailureCategory | undefined {
  if (status === 401 || status === 403) return 'auth_required'
  if (status === 402) return 'billing'
  if (status === 413) return 'context_exceeded'
  if (status === 429) return 'rate_limited'
  if (status === 529 || (status >= 500 && status <= 504)) return 'vendor_internal'
  return undefined
}

function structured(list: readonly unknown[], ctx: SignalContext): SignalMatch | undefined {
  const fs = frames(list)
  const result = last(fs, isResult)

  if (result) {
    const reason = str(result['startup_failure_reason']) as SDKStartupFailureReason | undefined
    const category = reason
      ? (CLAUDE_STARTUP_FAILURES[reason] as FailureCategory | null | undefined)
      : undefined
    if (reason && category) {
      return {
        category,
        rule: `claude.startup.${reason}`,
        message: firstLine(resultText(result)) || `Claude could not start: ${reason}`,
        raw: json(result),
      }
    }
    const sub = subtypeOf(result)
    if (sub === 'error_max_turns' || sub === 'error_max_budget_usd') {
      return {
        category: 'turn_limit',
        rule: `claude.result.${sub}`,
        message:
          firstLine(resultText(result)) ||
          (sub === 'error_max_turns' ? 'Turn limit reached' : 'Budget limit reached'),
        raw: json(result),
      }
    }
    // C18b, synthesized from the SDK's types: the answer never matched initialize's jsonSchema after the CLI's own
    // retries. stream_malformed ("zod failure on a known frame"): output Harpoon cannot use.
    if (sub === 'error_max_structured_output_retries') {
      return {
        category: 'stream_malformed',
        rule: `claude.result.${sub}`,
        message:
          firstLine(resultText(result)) ||
          'The answer did not match the requested format after several tries',
        raw: json(result),
      }
    }
  }

  const refusal = last(fs, isRefusal)
  if (refusal) {
    return {
      category: 'content_policy',
      rule: 'claude.system.model_refusal_no_fallback',
      message: firstLine(str(refusal['content']) ?? '') || 'The model refused the request',
      raw: json(refusal),
    }
  }

  const rejection = last(fs, isRejection)
  if (rejection) {
    const info = rateLimitInfo(rejection)!
    const type = str(info['rateLimitType']) as RateLimitType | undefined
    const quota = type !== undefined && CLAUDE_QUOTA_WINDOWS.includes(type)
    const resetsAt = resetsAtMs(info['resetsAt'])
    const when = resetsAt !== undefined ? ` until ${new Date(resetsAt).toISOString()}` : ''
    return withReset(
      {
        category: quota ? 'quota_exceeded' : 'rate_limited',
        rule: quota ? 'claude.rate_limit_event.quota' : 'claude.rate_limit_event.rejected',
        message: `Rate limited${type ? ` (${type})` : ''}${when}`,
        raw: json(rejection),
      },
      resetsAt,
      ctx.now,
    )
  }

  const aerr = last(fs, isAssistantError)
  if (aerr) {
    const m = assistantErrorMatch(aerr, 'claude.assistant.error')
    if (m) return m
  }

  if (result && isErrorResult(result)) {
    const tr = str(result['terminal_reason']) as TerminalReason | undefined
    const trCat = tr ? CLAUDE_TERMINAL_REASONS[tr] : undefined
    if (tr && trCat) {
      return {
        category: trCat,
        rule: `claude.result.terminal.${tr}`,
        message: firstLine(resultText(result)) || tr,
        raw: json(result),
      }
    }
    const status = num(result['api_error_status'])
    const stCat = status !== undefined ? apiStatusCategory(status) : undefined
    if (status !== undefined && stCat) {
      return {
        category: stCat,
        rule: `claude.result.api_error_status.${status}`,
        message: firstLine(resultText(result)) || `Claude API error ${status}`,
        raw: json(result),
      }
    }
  }

  const auth = last(fs, isAuthStatusError)
  if (auth) {
    return {
      category: 'auth_required',
      rule: 'claude.auth_status.error',
      message: firstLine(str(auth['error']) ?? ''),
      raw: json(auth),
    }
  }
  return undefined
}

function texts(list: readonly unknown[]): string[] {
  const out: string[] = []
  for (const f of frames(list)) {
    if (isErrorResult(f)) out.push(resultText(f))
    else if (isAssistantError(f)) out.push(assistantText(f))
    else if (isAuthStatusError(f)) out.push(str(f['error']) ?? '')
  }
  return out.filter((t) => t.trim() !== '')
}

function retryHint(list: readonly unknown[]): SignalMatch | undefined {
  const r = last(frames(list), isApiRetry)
  if (!r) return undefined
  const m = assistantErrorMatch(r, 'claude.api_retry')
  const status = num(r['error_status'])
  const fallback = status !== undefined ? apiStatusCategory(status) : undefined
  const category = m?.category ?? fallback
  if (!category) return undefined
  const attempt = num(r['attempt'])
  const max = num(r['max_retries'])
  return {
    category,
    rule: m?.rule ?? `claude.api_retry.status.${status}`,
    message: `Claude retried the API${attempt !== undefined ? ` (attempt ${attempt}${max !== undefined ? `/${max}` : ''})` : ''}: ${str(r['error']) ?? status}`,
    raw: json(r),
  }
}

function hasFailure(list: readonly unknown[]): boolean {
  return frames(list).some(
    (f) => isErrorResult(f) || isAssistantError(f) || isRejection(f) || isRefusal(f) || isAuthStatusError(f),
  )
}

export const CLAUDE_SIGNALS: SignalTable = {
  vendor: 'claude',
  hasFailure,
  structured,
  texts,
  isRetry: (frame) => {
    const f = asRecord(frame)
    return f !== undefined && isApiRetry(f)
  },
  retryHint: (list) => retryHint(list),
  regex: CLAUDE_REGEX,
}
