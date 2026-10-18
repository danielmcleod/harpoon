// Raw Claude stream-json lines → the six normalized events + adapter signals. No I/O: the run handle (run.ts),
// `harpoon normalize` and the fixture tests all drive the
// same state machine. Frames the CLI must receive (automatic answers, error replies) come back in `stdin`.
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AdapterSignal, AllowRule, AskDecision, NormalizedEvent, Usage } from '../../../shared/events.ts'
import type { Failure } from '../../../shared/failure.ts'
import type { ClassifyInput, HarpoonKill } from '../../heal/classify.ts'
import { classify, redactRaw } from '../../heal/classify.ts'
import { getEnv } from '../../proc/env.ts'
import { AllowCache } from '../allow-cache.ts'
import { FAILURE_HINTS_META, TailBuffer, classifyFailureDetailed, errorEvent } from '../errors.ts'
import {
  META_LATE_ALLOW_RULE,
  META_SESSION_MODEL,
  META_STRUCTURED_OUTPUT,
  META_USAGE,
  META_USAGE_APPROX,
} from '../types.ts'
import type { AskCancelReason } from '../types.ts'
import type { UsageDelta } from '../usage.ts'
import { UsageTracker, sumClaudeModelUsage } from '../usage.ts'
import { allowRuleFor, autoAnswerFor, askEvent, capturePlan, summarizeTool } from './asks.ts'
import {
  AUTH_RETRY_FAIL_FAST_ATTEMPT,
  CLAUDE_VENDOR,
  DENY_MESSAGE,
  EMPTY_MODEL_USAGE_IS_UNKNOWN,
  PLAN_CAPTURE_IS_SUCCESS,
  PLAN_CAPTURED_MESSAGE,
  PLAN_EMPTY_MESSAGE,
  READONLY_DENY_MESSAGE,
  UNSUPPORTED_ASK_MESSAGE,
} from './capabilities.ts'
import type { PlanCapture } from './plan-hygiene.ts'
import type {
  CanUseToolRequest,
  ControlResponseBody,
  JsonObject,
  ResultFrame,
  ResultUsage,
  StdinFrame,
} from './protocol.ts'
import {
  allowResponse,
  asCanUseTool,
  denyResponse,
  errorResponse,
  num,
  obj,
  parseFrame,
  sessionPermissions,
  str,
} from './protocol.ts'

/** plan = native plan + host; readonly = read-only route (no host); edit = implement / fix (host). */
export type ClaudeRoute = 'plan' | 'readonly' | 'edit'

export interface NormalizerOptions {
  route: ClaudeRoute
  /** The process continues an existing session (`--resume`). */
  resumed?: boolean
  /** The session's cumulative totals before this pass; usage is reported as a delta against them. */
  priorUsage?: Usage | undefined
  askTimeoutMs: number
  now?: () => number
  allowRules?: readonly AllowRule[]
  cwd?: string
  home?: string
  /** `${CLAUDE_CONFIG_DIR ?? ~/.claude}`; ExitPlanMode's planFilePath must lie under its `plans/`. */
  configDir?: string
  readPlanFile?: (path: string) => string | undefined
  /**
   * ANTHROPIC_API_KEY is set in the environment the CLI runs with (the adapter learns it from its own spawn
   * env, {@link ClaudeNormalizer.noteSpawnEnv}; a replay from the recording header's `envKeys`). Only then, or with
   * init's apiKeySource naming it, does an auth failure name the variable.
   */
  apiKeyEnv?: boolean
}

export interface ControlReply {
  requestId: string
  ok: boolean
  response?: JsonObject
  error?: string
}

/** Consumers emit `signals` before `events` (a plan-captured signal precedes the `done` it explains). */
export interface NormalizeStep {
  events: NormalizedEvent[]
  signals: AdapterSignal[]
  /** Frames to write to the CLI, in order. */
  stdin: StdinFrame[]
  /** A reply to one of Harpoon's own control requests (initialize, interrupt). */
  reply?: ControlReply
  /** The first `result` arrived in this step. */
  result?: boolean
  /** ExitPlanMode was captured in this step (arm the 10 s result timer). */
  planCaptured?: boolean
  /** The pass already failed; the adapter should stop the process (e.g. an invalid API key being retried). */
  abort?: boolean
}

export interface EndInput {
  code: number | null
  signal: string | null
  ranMs?: number
  stderrTail?: readonly string[]
}

interface PendingAsk {
  req: CanUseToolRequest
}

interface ToolInfo {
  name: string
  summary: string
  ended: boolean
}

const STATUS_FRAMES_MAX = 60
const STDOUT_TAIL_MAX = 20

/** Recovery hint (auth_required): offer `shell_copy` unset ANTHROPIC_API_KEY. */
export const ENV_KEY_HINT = 'claude-env-key'

/** C09c: an auth failure while ANTHROPIC_API_KEY is in play, in Harpoon's words (`status`: the HTTP status). */
export function envKeyMessage(status: number | undefined): string {
  const tag = status !== undefined ? ` (${status})` : ''
  return `API key is invalid${tag}. ANTHROPIC_API_KEY is set and takes precedence over your Claude login.`
}

/**
 * An auth failure where the CLI only said that "ANTHROPIC_API_KEY or another auth source is set and takes
 * precedence" (its stderr), while neither init's apiKeySource nor the spawn env shows ANTHROPIC_API_KEY: an
 * apiKeyHelper or an auth token may be the credential, so the variable is named only as the CLI names it.
 */
export function otherCredentialMessage(status: number | undefined): string {
  const tag = status !== undefined ? ` (${status})` : ''
  return `API key is invalid${tag}. A key or other credential set for Claude Code (ANTHROPIC_API_KEY or another auth source) takes precedence over your Claude login.`
}

/** Meta signal: the pass's usage is an estimate (`value`: {reason, fields?, costUnknown?}). */
export const USAGE_APPROX_META = META_USAGE_APPROX
const ENV_KEY_RE = /ANTHROPIC_API_KEY/

const emptyStep = (): NormalizeStep => ({ events: [], signals: [], stdin: [] })

/**
 * What a Harpoon-ended turn's `raw` keeps of the result frame: status fields and which tools were denied. Never
 * the final text, tool inputs (file bodies, commands) or ids (C04d).
 */
function resultSummary(r: ResultFrame): string {
  const out: Record<string, unknown> = { type: 'result', subtype: r.subtype }
  for (const k of ['is_error', 'terminal_reason', 'stop_reason', 'api_error_status', 'num_turns'] as const) {
    if (r[k] !== undefined && r[k] !== null) out[k] = r[k]
  }
  if (Array.isArray(r.errors)) out['errors'] = r.errors.filter((e) => typeof e === 'string').slice(0, 5)
  const denied = (r.permission_denials ?? []).flatMap((d) =>
    typeof d?.tool_name === 'string' ? [d.tool_name] : [],
  )
  if (denied.length > 0) out['permission_denials'] = denied
  return JSON.stringify(out)
}

/** `result.usage` as Usage, or undefined when it carries no token counts. */
function turnUsage(u: ResultUsage | undefined): Usage | undefined {
  if (u === undefined || u === null || typeof u !== 'object') return undefined
  const input = num(u.input_tokens)
  const output = num(u.output_tokens)
  if (input === undefined && output === undefined) return undefined
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(u.cache_read_input_tokens) ?? 0,
    cacheWrite: num(u.cache_creation_input_tokens) ?? 0,
  }
}

const isMain = (f: JsonObject): boolean =>
  f['parent_tool_use_id'] === null || f['parent_tool_use_id'] === undefined

/** Frames kept for the classifier: everything except content (stream deltas, assistant/user messages). */
function isStatusFrame(f: JsonObject): boolean {
  const t = f['type']
  if (t === 'stream_event' || t === 'user' || t === 'control_request' || t === 'control_response')
    return false
  if (t === 'assistant') return typeof f['error'] === 'string'
  if (t === 'system') return f['subtype'] !== 'thinking_tokens' && f['subtype'] !== 'init'
  return true
}

export class ClaudeNormalizer {
  readonly route: ClaudeRoute
  readonly #o: NormalizerOptions
  readonly #now: () => number
  readonly #cache: AllowCache
  readonly #usage: UsageTracker
  readonly #pending = new Map<string, PendingAsk>()
  readonly #tools = new Map<string, ToolInfo>()
  readonly #declined = new Set<string>()
  readonly #status: unknown[] = []
  readonly #stdoutTail = new TailBuffer(STDOUT_TAIL_MAX, 300)
  readonly #stderrTail = new TailBuffer(40, 2000)
  #sessionId: string | undefined
  #finalMsg = ''
  #terminal = false
  #sawResult = false
  #plan: string | undefined
  #capture: PlanCapture | undefined
  #killedBy: HarpoonKill | undefined
  #malformed = 0
  #maxMalformed = 0
  #reported: Usage | undefined
  #apiKeySource: string | undefined
  #apiKeyEnv: boolean

  constructor(o: NormalizerOptions) {
    this.route = o.route
    this.#o = o
    this.#now = o.now ?? Date.now
    this.#cache = new AllowCache(
      (o.allowRules ?? []).filter((r) => r.vendor === CLAUDE_VENDOR),
      o.cwd !== undefined ? { cwd: o.cwd } : {},
    )
    this.#usage = new UsageTracker({ base: o.priorUsage, resumed: o.resumed === true })
    this.#apiKeyEnv = o.apiKeyEnv === true
  }

  /** The environment the adapter spawned the CLI with ({@link NormalizerOptions.apiKeyEnv}). */
  noteSpawnEnv(env: Readonly<Record<string, string | undefined>>): void {
    this.#apiKeyEnv = (getEnv(env, 'ANTHROPIC_API_KEY') ?? '').trim() !== ''
  }

  sessionId(): string | undefined {
    return this.#sessionId
  }

  /** The session's cumulative totals as last reported (the prior totals until this process reports). */
  cumulativeUsage(): Usage | undefined {
    return this.#reported ?? this.#o.priorUsage
  }

  pendingAsks(): string[] {
    return [...this.#pending.keys()]
  }

  get terminal(): boolean {
    return this.#terminal
  }

  get sawResult(): boolean {
    return this.#sawResult
  }

  get planCaptured(): boolean {
    return this.#plan !== undefined
  }

  /** The plan this pass captured (ExitPlanMode or, on a plan route, the final message), for plan-file hygiene. */
  planCapture(): PlanCapture | undefined {
    return this.#capture
  }

  /**
   * Harpoon ended (or is ending) the turn; the terminal error is classified as this kill. An ask cancel
   * (`ask` / `deny`) never replaces a stop, timer or quit.
   */
  markKilled(kind: HarpoonKill): void {
    const askKill = kind === 'ask' || kind === 'deny'
    if (this.#killedBy === undefined || !askKill) this.#killedBy = kind
  }

  /** End the pass with this failure (e.g. a rejected initialize); no-op once a terminal event exists. */
  fail(failure: Failure, hints: readonly string[] = []): NormalizeStep {
    const step = emptyStep()
    if (!this.#terminal) this.#failWith(step, failure, hints)
    return step
  }

  stderr(line: string): void {
    this.#stderrTail.push(line)
  }

  line(raw: string): NormalizeStep {
    const step = emptyStep()
    const f = parseFrame(raw)
    if (f === undefined) {
      if (raw.trim() !== '') {
        this.#stdoutTail.push(raw)
        this.#malformed++
        this.#maxMalformed = Math.max(this.#maxMalformed, this.#malformed)
      }
      return step
    }
    this.#malformed = 0
    const wasTerminal = this.#terminal
    if (isStatusFrame(f)) {
      this.#status.push(f)
      if (this.#status.length > STATUS_FRAMES_MAX) this.#status.shift()
    }
    switch (f['type']) {
      case 'stream_event':
        this.#streamEvent(f, step)
        break
      case 'assistant':
        this.#assistant(f, step)
        break
      case 'user':
        this.#user(f, step)
        break
      case 'system':
        this.#system(f, step)
        break
      case 'conversation_reset': {
        const id = str(f['new_conversation_id'])
        if (id !== undefined) this.#session(id, step)
        break
      }
      case 'control_request':
        this.#controlRequest(f, step)
        break
      case 'control_cancel_request': {
        const id = str(f['request_id'])
        if (id !== undefined && this.#pending.delete(id))
          step.signals.push({ type: 'ask-withdrawn', requestId: id })
        break
      }
      case 'control_response':
        this.#controlResponse(f, step)
        break
      case 'result':
        this.#result(f as unknown as ResultFrame, step)
        break
      default:
        break
    }
    // After the terminal event nothing else is rendered (the adapter is already stopping the process).
    if (wasTerminal) step.events = []
    if (step.events.length === 0 && step.signals.length === 0) step.signals.push({ type: 'liveness' })
    return step
  }

  /**
   * The user's (or the engine's) answer to an ask raised by this normalizer. `why` says why a `cancel` ends the
   * turn: the ask timer (default, ask_timeout) or a deny under `ask.denyPauses` (permission_denied).
   */
  answer(requestId: string, decision: AskDecision, why?: AskCancelReason): NormalizeStep {
    const step = emptyStep()
    const p = this.#pending.get(requestId)
    if (p === undefined) return step
    this.#pending.delete(requestId)
    const req = p.req
    switch (decision) {
      case 'allow':
        step.stdin.push(allowResponse(requestId, req.input))
        break
      case 'allow-session': {
        const suggestions = req.permission_suggestions ?? []
        step.stdin.push(allowResponse(requestId, req.input, sessionPermissions(suggestions)))
        const rule = allowRuleFor(req, suggestions, this.#pathOpts())
        if (rule !== undefined && this.#cache.add(rule)) step.signals.push({ type: 'allow-rule', rule })
        break
      }
      case 'deny':
        step.stdin.push(denyResponse(requestId, DENY_MESSAGE))
        this.#declined.add(req.tool_use_id)
        break
      case 'cancel': {
        step.stdin.push(denyResponse(requestId, DENY_MESSAGE, true))
        this.#declined.add(req.tool_use_id)
        this.markKilled(why === 'denied' ? 'deny' : 'ask')
        if (why !== 'denied') {
          // P19 "Allow & resume": the exact rule a late Allow adds (no vendor suggestion is widened).
          const rule = allowRuleFor(req, [], this.#pathOpts())
          if (rule !== undefined)
            step.signals.push({ type: 'meta', key: META_LATE_ALLOW_RULE, value: { requestId, rule } })
        }
        break
      }
    }
    return step
  }

  /** Process exit: the terminal event when none was emitted (crash, kill, missing result). */
  end(exit: EndInput): NormalizeStep {
    const step = emptyStep()
    for (const l of exit.stderrTail ?? []) this.#stderrTail.push(l)
    this.#pending.clear()
    if (this.#terminal) return step
    if (this.#plan !== undefined) {
      this.#done(this.#plan, undefined, step)
      return step
    }
    if (this.#killedBy !== undefined) {
      this.#harpoonError(step)
      return step
    }
    this.#classified(step, {
      exitCode: exit.code,
      signal: exit.signal,
      ...(exit.ranMs !== undefined ? { ranMs: exit.ranMs } : {}),
      protocol: {
        noTerminal: true,
        ...(this.#maxMalformed > 0 ? { malformedLines: this.#maxMalformed } : {}),
      },
    })
    return step
  }

  // ---- terminal events --------------------------------------------------------------------------------------

  /** Every terminal event goes through here: open tool calls end first (declined or failed), then the event. */
  #emitTerminal(step: NormalizeStep, ev: NormalizedEvent, signals: AdapterSignal[] = []): void {
    for (const [id, t] of [...this.#tools]) {
      if (!t.ended) this.#toolEnd(id, undefined, this.#declined.has(id) ? 'declined' : 'failed', step)
    }
    this.#terminal = true
    step.signals.push(...signals)
    step.events.push(ev)
  }

  #failWith(step: NormalizeStep, failure: Failure, hints: readonly string[]): void {
    const all = [...hints]
    if (failure.category === 'auth_required' && this.#envKeySuspected() && !all.includes(ENV_KEY_HINT))
      all.push(ENV_KEY_HINT)
    const signals: AdapterSignal[] =
      all.length > 0 ? [{ type: 'meta', key: FAILURE_HINTS_META, value: all }] : []
    this.#emitTerminal(step, errorEvent(failure, true), signals)
  }

  /**
   * Classify from the status frames and stream tails, and end the pass with the result. `status`: the result's
   * api_error_status. Live C09c: 2.1.289 now ends an invalid ANTHROPIC_API_KEY at once, without api_retry and in
   * its own words ("Invalid API key · Fix external API key"); an auth failure with a credential in play reads as the
   * api_retry path says it ({@link ClaudeNormalizer.#credentialMessage}).
   */
  #classified(step: NormalizeStep, extra: Partial<ClassifyInput> = {}, status?: number): void {
    const c = classifyFailureDetailed({
      vendor: CLAUDE_VENDOR,
      structured: this.#status,
      stderrTail: this.#stderrTail.lines(),
      stdoutTail: this.#stdoutTail.lines(),
      now: this.#now(),
      ...extra,
    })
    const message = c.failure.category === 'auth_required' ? this.#credentialMessage(status) : undefined
    this.#failWith(step, message !== undefined ? { ...c.failure, message } : c.failure, c.hints)
  }

  /** ANTHROPIC_API_KEY may be in play: init's apiKeySource, the spawn env, or the CLI's stderr (C09c). The hint. */
  #envKeySuspected(): boolean {
    return this.#envKeyKnown() || this.#stderrTail.lines().some((l) => ENV_KEY_RE.test(l))
  }

  /** ANTHROPIC_API_KEY is in play for certain: init's apiKeySource names it, or the spawn env holds it. */
  #envKeyKnown(): boolean {
    return this.#apiKeySource === 'ANTHROPIC_API_KEY' || this.#apiKeyEnv
  }

  /**
   * An auth failure's words when a credential other than the Claude login is in play: the variable by name only when it
   * is known to be set ({@link envKeyMessage}); the CLI's "ANTHROPIC_API_KEY or another auth source" alone names both
   * ({@link otherCredentialMessage}). Undefined when neither is in play.
   */
  #credentialMessage(status: number | undefined): string | undefined {
    if (this.#envKeyKnown()) return envKeyMessage(status)
    if (this.#envKeySuspected()) return otherCredentialMessage(status)
    return undefined
  }

  // ---- frames ---------------------------------------------------------------------------------------------

  #session(id: string, step: NormalizeStep): void {
    if (id === this.#sessionId) return
    this.#sessionId = id
    step.events.push({ type: 'session', id })
  }

  #streamEvent(f: JsonObject, step: NormalizeStep): void {
    if (!isMain(f)) return
    const ev = obj(f['event'])
    if (ev?.['type'] !== 'content_block_delta') return
    const delta = obj(ev['delta'])
    if (delta?.['type'] !== 'text_delta') return
    const text = str(delta['text'])
    if (text === undefined || text === '') return
    this.#finalMsg += text
    step.events.push({ type: 'text', delta: text })
  }

  #assistant(f: JsonObject, step: NormalizeStep): void {
    if (!isMain(f)) return
    const content = obj(f['message'])?.['content']
    if (!Array.isArray(content)) return
    for (const b of content) {
      const block = obj(b)
      if (block?.['type'] !== 'tool_use') continue
      const id = str(block['id'])
      const name = str(block['name']) ?? 'tool'
      const summary = summarizeTool(name, obj(block['input']) ?? {}, this.#o.cwd)
      if (id !== undefined) {
        if (this.#tools.has(id)) continue
        this.#tools.set(id, { name, summary, ended: false })
      }
      this.#finalMsg = ''
      step.events.push({ type: 'tool', ...(id !== undefined ? { id } : {}), name, summary, phase: 'start' })
    }
  }

  #user(f: JsonObject, step: NormalizeStep): void {
    if (!isMain(f)) return
    const content = obj(f['message'])?.['content']
    // Live C18c: a user turn on the main thread that is not a tool result (the CLI's own nudge, such as
    // "[structured-output-enforce] You MUST call the StructuredOutput tool…") starts the final message again: what the
    // model wrote before it is not the answer the result reports.
    if (
      typeof content === 'string' ||
      (Array.isArray(content) && content.some((b) => obj(b)?.['type'] === 'text'))
    )
      this.#finalMsg = ''
    if (!Array.isArray(content)) return
    for (const b of content) {
      const block = obj(b)
      if (block?.['type'] !== 'tool_result') continue
      const id = str(block['tool_use_id'])
      if (id === undefined) continue
      const status = this.#declined.has(id) ? 'declined' : block['is_error'] === true ? 'failed' : 'ok'
      this.#toolEnd(id, undefined, status, step)
    }
  }

  #toolEnd(
    id: string,
    fallbackName: string | undefined,
    status: 'ok' | 'failed' | 'declined',
    step: NormalizeStep,
  ): void {
    const t = this.#tools.get(id)
    if (t?.ended === true) return
    const name = t?.name ?? fallbackName ?? 'tool'
    const summary = t?.summary ?? ''
    this.#tools.set(id, { name, summary, ended: true })
    this.#finalMsg = ''
    step.events.push({ type: 'tool', id, name, summary, phase: 'end', status })
  }

  #system(f: JsonObject, step: NormalizeStep): void {
    const sub = str(f['subtype'])
    if (sub === 'init') {
      const id = str(f['session_id'])
      if (id !== undefined) this.#session(id, step)
      this.#apiKeySource = str(f['apiKeySource'])
      const meta: [string, unknown][] = [
        [META_SESSION_MODEL, f['model']],
        ['permissionMode', f['permissionMode']],
        ['claude_code_version', f['claude_code_version']],
        ['apiKeySource', f['apiKeySource']],
        ['mcp_server_errors', f['mcp_server_errors']],
        // Harpoon: which MCP servers connected (a failed one still lets the CLI exit 0).
        ['mcp_servers', f['mcp_servers']],
      ]
      for (const [key, value] of meta)
        if (value !== undefined) step.signals.push({ type: 'meta', key, value })
      return
    }
    if (sub === 'permission_denied') {
      const id = str(f['tool_use_id'])
      if (id !== undefined) this.#declined.add(id)
      return
    }
    if (sub === 'api_retry' && !this.#terminal && this.#isAuthRetry(f)) {
      // C09c: the CLI would retry a 401 ten times over ~3 min; fail now with the CLI's own wording.
      const c = classifyFailureDetailed({
        vendor: CLAUDE_VENDOR,
        structured: this.#status,
        stderrTail: this.#stderrTail.lines(),
        now: this.#now(),
      })
      const code = num(f['error_status'])
      const tag = code !== undefined ? ` (${code})` : ''
      const message = this.#credentialMessage(code) ?? `Claude Code could not authenticate${tag}.`
      this.#failWith(step, { ...c.failure, message }, c.hints)
      step.abort = true
    }
  }

  #isAuthRetry(f: JsonObject): boolean {
    const attempt = num(f['attempt']) ?? 1
    const auth = f['error'] === 'authentication_failed' || num(f['error_status']) === 401
    return auth && attempt >= AUTH_RETRY_FAIL_FAST_ATTEMPT
  }

  #controlRequest(f: JsonObject, step: NormalizeStep): void {
    const requestId = str(f['request_id'])
    const request = obj(f['request'])
    if (requestId === undefined || request === undefined) return
    const req = asCanUseTool(request)
    if (req !== undefined && this.#terminal) {
      step.stdin.push(denyResponse(requestId, UNSUPPORTED_ASK_MESSAGE, true))
      return
    }
    if (req === undefined) {
      step.stdin.push(
        errorResponse(requestId, `Unsupported by Harpoon: ${str(request['subtype']) ?? 'unknown'}`),
      )
      return
    }
    const auto = autoAnswerFor(req, {
      planPass: this.route === 'plan',
      readOnly: this.route === 'readonly',
      cache: this.#cache,
      cwd: this.#o.cwd,
    })
    const signal = (
      decision: AskDecision,
      why: 'readonly' | 'allow-cache' | 'plan-capture' | 'unsupported',
    ): void => {
      step.signals.push({ type: 'auto-answered', requestId, decision, tool: req.tool_name, why })
    }
    if (auto === undefined) {
      this.#pending.set(requestId, { req })
      step.events.push(askEvent(requestId, req, this.#now() + this.#o.askTimeoutMs))
      return
    }
    switch (auto.kind) {
      case 'plan-capture': {
        const plan = capturePlan(req.input, this.#plansDir(), this.#o.readPlanFile, this.#home())
        this.#declined.add(req.tool_use_id)
        if (plan === undefined) {
          step.stdin.push(denyResponse(requestId, PLAN_EMPTY_MESSAGE))
          signal('deny', 'plan-capture')
          return
        }
        this.#plan = plan
        const planFilePath = str(req.input['planFilePath'])
        this.#capture = {
          markdown: plan,
          source: 'exitPlanMode',
          ...(planFilePath !== undefined ? { planFilePath } : {}),
        }
        step.signals.push({ type: 'plan-captured', markdown: plan, source: 'exitPlanMode' })
        step.stdin.push(denyResponse(requestId, PLAN_CAPTURED_MESSAGE, true))
        signal('deny', 'plan-capture')
        step.planCaptured = true
        return
      }
      case 'readonly':
        this.#declined.add(req.tool_use_id)
        step.stdin.push(denyResponse(requestId, READONLY_DENY_MESSAGE))
        signal('deny', 'readonly')
        return
      case 'unsupported':
        this.#declined.add(req.tool_use_id)
        step.stdin.push(denyResponse(requestId, UNSUPPORTED_ASK_MESSAGE))
        signal('deny', 'unsupported')
        return
      case 'allow-cache':
        step.stdin.push(allowResponse(requestId, req.input))
        signal('allow', 'allow-cache')
        return
    }
  }

  #controlResponse(f: JsonObject, step: NormalizeStep): void {
    const body = obj(f['response']) as ControlResponseBody | undefined
    const requestId = str(body?.request_id)
    if (body === undefined || requestId === undefined) return
    step.reply =
      body.subtype === 'success'
        ? { requestId, ok: true, ...(body.response !== undefined ? { response: body.response } : {}) }
        : { requestId, ok: false, error: str(body.error) ?? 'error' }
  }

  #result(r: ResultFrame, step: NormalizeStep): void {
    const first = !this.#sawResult
    this.#sawResult = true
    if (first) step.result = true
    const usage = this.#reportUsage(r, step)
    for (const d of r.permission_denials ?? []) {
      if (typeof d?.tool_use_id === 'string') this.#toolEnd(d.tool_use_id, d.tool_name, 'declined', step)
    }
    if (this.#terminal) return
    if (PLAN_CAPTURE_IS_SUCCESS && this.#plan !== undefined) {
      this.#done(this.#plan, usage, step)
      return
    }
    const failed = r.is_error === true || r.subtype !== 'success'
    if (!failed) {
      const text = this.#finalMsg !== '' ? this.#finalMsg : (r.result ?? '')
      if (this.route === 'plan' && text.trim() !== '') {
        this.#capture = { markdown: text.trim(), source: 'final-message' }
        step.signals.push({ type: 'plan-captured', markdown: text.trim(), source: 'final-message' })
      }
      // C17: the answer to initialize's jsonSchema, ahead of the `done` it belongs to.
      if (r.structured_output !== undefined && r.structured_output !== null)
        step.signals.push({ type: 'meta', key: META_STRUCTURED_OUTPUT, value: r.structured_output })
      this.#done(text, usage, step)
      return
    }
    if (usage !== undefined) step.signals.push({ type: 'meta', key: META_USAGE, value: usage })
    if (this.#killedBy !== undefined) {
      this.#harpoonError(step, resultSummary(r))
      return
    }
    this.#classified(step, {}, num(r.api_error_status))
  }

  #done(result: string, usage: Usage | undefined, step: NormalizeStep): void {
    this.#emitTerminal(step, usage !== undefined ? { type: 'done', result, usage } : { type: 'done', result })
  }

  /** `raw` is evidence (a result summary); classify() redacts and caps it like every other raw. */
  #harpoonError(step: NormalizeStep, raw?: string): void {
    const kind = this.#killedBy!
    const failure = classify({
      vendor: CLAUDE_VENDOR,
      harpoonInitiated: { kind, ...(raw !== undefined ? { raw } : {}) },
      now: this.#now(),
    })
    if (failure === null) {
      const quitRaw = raw !== undefined ? redactRaw(raw) : ''
      this.#emitTerminal(step, {
        type: 'error',
        message: 'Harpoon is shutting down.',
        raw: quitRaw,
        fatal: true,
      })
      return
    }
    this.#emitTerminal(step, errorEvent(failure, true))
  }

  /** Per-pass delta; undefined when the result carries no usage (C04d: interrupted turns report `{}`). */
  #reportUsage(r: ResultFrame, step: NormalizeStep): Usage | undefined {
    const mu = r.modelUsage
    if (mu === undefined || mu === null || typeof mu !== 'object') return undefined
    if (EMPTY_MODEL_USAGE_IS_UNKNOWN && Object.keys(mu).length === 0) return undefined
    const totals = sumClaudeModelUsage(mu)
    const cost = num(r.total_cost_usd)
    if (cost !== undefined) totals.costUsd = cost
    const delta = this.#usage.report(totals)
    this.#reported = this.#usage.cumulative()
    return this.#passUsage(delta, r, step)
  }

  /**
   * A resumed session without a known base cannot subtract: report this turn's `result.usage` tokens (C08a/C08b:
   * equal to the Δ modelUsage), with the cost unknown, and say so in a meta signal. A counter that went
   * backwards is flagged the same way.
   */
  #passUsage(delta: UsageDelta, r: ResultFrame, step: NormalizeStep): Usage {
    if (this.#usage.resumed && this.#usage.base === undefined) {
      const turn = turnUsage(r.usage)
      step.signals.push({
        type: 'meta',
        key: USAGE_APPROX_META,
        value: { reason: 'resumed-without-base', source: turn !== undefined ? 'result.usage' : 'cumulative' },
      })
      return turn ?? delta.usage
    }
    if (delta.approx) {
      step.signals.push({
        type: 'meta',
        key: USAGE_APPROX_META,
        value: { reason: 'counter-reset', fields: delta.resetFields },
      })
    }
    return delta.usage
  }

  #pathOpts(): { cwd?: string; home?: string } {
    const out: { cwd?: string; home?: string } = {}
    if (this.#o.cwd !== undefined) out.cwd = this.#o.cwd
    if (this.#o.home !== undefined) out.home = this.#o.home
    return out
  }

  #home(): string {
    return this.#o.home ?? homedir()
  }

  #plansDir(): string {
    return join(this.#o.configDir ?? join(this.#home(), '.claude'), 'plans')
  }
}

// ---- recordings -------------------------------------------------------------------------------------------

export interface RecordingHeader {
  kind: 'header'
  argv?: string[]
  scenario?: string
  [k: string]: unknown
}

export interface RecordingFrame {
  t?: number
  dir: 'in' | 'out' | 'err' | 'exit'
  line?: string
  code?: number | null
  signal?: string | null
  /** `"tree"` when the recorder killed the process tree (C10b). */
  killed?: string
}

export function parseRecording(text: string): {
  header: RecordingHeader | undefined
  frames: RecordingFrame[]
} {
  let header: RecordingHeader | undefined
  const frames: RecordingFrame[] = []
  for (const raw of text.split(/\r?\n/)) {
    const v = parseFrame(raw)
    if (v === undefined) continue
    if (v['kind'] === 'header') header = v as RecordingHeader
    else if (typeof v['dir'] === 'string') frames.push(v as unknown as RecordingFrame)
  }
  return { header, frames }
}

const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === flag) return argv[i + 1]
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1)
  }
  return undefined
}

/** The normalizer route a recorded argv implies (plan mode → plan; dontAsk → readonly; else edit). */
export function routeFromArgv(argv: readonly string[]): { route: ClaudeRoute; resumed: boolean } {
  const mode = flagValue(argv, '--permission-mode')
  const route: ClaudeRoute = mode === 'plan' ? 'plan' : mode === 'dontAsk' ? 'readonly' : 'edit'
  return { route, resumed: flagValue(argv, '--resume') !== undefined }
}

/** What a recorded host reply to can_use_tool means as an AskDecision. */
export function decisionFromReply(
  frame: JsonObject,
): { requestId: string; decision: AskDecision } | undefined {
  if (frame['type'] !== 'control_response') return undefined
  const body = obj(frame['response'])
  const requestId = str(body?.['request_id'])
  const res = obj(body?.['response'])
  if (requestId === undefined || res === undefined) return undefined
  if (res['behavior'] === 'allow') {
    const perms = res['updatedPermissions']
    return { requestId, decision: Array.isArray(perms) && perms.length > 0 ? 'allow-session' : 'allow' }
  }
  if (res['behavior'] === 'deny')
    return { requestId, decision: res['interrupt'] === true ? 'cancel' : 'deny' }
  return undefined
}

export type RecordingEntry = NormalizedEvent | AdapterSignal | { type: 'stdin'; frame: StdinFrame }

export interface NormalizeRecordingOptions extends Partial<Omit<NormalizerOptions, 'route'>> {
  route?: ClaudeRoute
  /** Apply the recorded host answers to raised asks (default true). */
  applyAnswers?: boolean
}

/**
 * Feed a recording through a fresh normalizer: every `out`/`err` frame, the recorded host answers to raised
 * asks, the recorded interrupt (as a user stop), then the exit. Returns events, signals and the stdin frames
 * the adapter itself would write, in order.
 */
export function normalizeRecording(text: string, o: NormalizeRecordingOptions = {}): RecordingEntry[] {
  const { header, frames } = parseRecording(text)
  const fromArgv = routeFromArgv(header?.argv ?? [])
  // The recorder gave the CLI ANTHROPIC_API_KEY (C09c): the adapter would have spawned it with that key.
  const envKeys = Array.isArray(header?.['envKeys']) ? (header['envKeys'] as unknown[]) : []
  const n = new ClaudeNormalizer({
    askTimeoutMs: 600_000,
    now: () => 0,
    apiKeyEnv: envKeys.includes('ANTHROPIC_API_KEY'),
    ...o,
    route: o.route ?? fromArgv.route,
    resumed: o.resumed ?? fromArgv.resumed,
  })
  const out: RecordingEntry[] = []
  const take = (s: NormalizeStep): void => {
    out.push(...s.signals, ...s.events)
    for (const frame of s.stdin) out.push({ type: 'stdin', frame })
  }
  let lastExit: RecordingFrame | undefined
  for (const fr of frames) {
    if (fr.dir === 'out' && typeof fr.line === 'string') take(n.line(fr.line))
    else if (fr.dir === 'err' && typeof fr.line === 'string') n.stderr(fr.line)
    else if (fr.dir === 'in' && typeof fr.line === 'string' && o.applyAnswers !== false) {
      const v = parseFrame(fr.line)
      if (v === undefined) continue
      const d = decisionFromReply(v)
      // A recorded cancel is the host's (the user's) deny + interrupt: P9b, not the ask timer.
      if (d !== undefined && n.pendingAsks().includes(d.requestId))
        take(n.answer(d.requestId, d.decision, d.decision === 'cancel' ? 'denied' : undefined))
      else if (v['type'] === 'control_request' && obj(v['request'])?.['subtype'] === 'interrupt')
        n.markKilled('stop')
    } else if (fr.dir === 'exit') lastExit = fr
  }
  if (lastExit !== undefined) {
    if (lastExit.killed !== undefined) n.markKilled('stop')
    take(
      n.end({
        code: lastExit.code ?? null,
        signal: lastExit.signal ?? null,
        ...(lastExit.t !== undefined ? { ranMs: lastExit.t } : {}),
      }),
    )
  }
  return out
}
