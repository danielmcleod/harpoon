// Codex frames → normalized events and signals for one pass (event mapping, approvals, plan text; usage:
// cumulative thread totals → this pass's delta). Pure state, no I/O: the app-server and
// exec run handles feed it and apply what it returns, and the unit tests drive it directly.
import type { AdapterSignal, AllowRule, AskDecision, NormalizedEvent, Usage } from '../../../shared/events.ts'
import type { Failure } from '../../../shared/failure.ts'
import type { Mode } from '../../../shared/run.ts'
import type { HarpoonKill } from '../../heal/classify.ts'
import { classify } from '../../heal/classify.ts'
import { JsonRpcError } from '../../proc/jsonrpc.ts'
import { classifyFailure, errorEvent, makeFailure } from '../errors.ts'
import {
  META_LATE_ALLOW_RULE,
  META_MODEL_USED,
  META_PAGES_READ,
  META_PLAN_FALLBACK,
  META_PLAN_SOURCE,
  META_STRUCTURED_OUTPUT,
  META_USAGE,
  META_USAGE_APPROX,
} from '../types.ts'
import type { AskCancelReason, StartStep } from '../types.ts'
import { UsageTracker, isZeroUsage } from '../usage.ts'
import type { AskMethod, AskSpec } from './asks.ts'
import {
  ASK_METHODS,
  ELICITATION,
  PERMISSIONS_APPROVAL,
  REFUSED_CODE,
  REFUSED_MESSAGE,
  REFUSED_METHODS,
  askFor,
  matchingRule,
  replyFor,
  requestLabel,
  ruleFor,
} from './asks.ts'
import { CODEX_VENDOR } from './capabilities.ts'
import { execItemToThreadItem, execTodoSteps } from './exec-shim.ts'
import { changePaths, planSteps, todoEvent, toolEnd, toolStart, webPagesOf } from './map-item.ts'
import { ELICITATION_CANCEL } from './params.ts'
import { breakdownFromExecUsage, usageFromTokenBreakdown } from './protocol.ts'
import { choosePlan } from './plan.ts'
import type { Rec } from './wire.ts'
import { num, rec, str } from './wire.ts'

/** `meta` signals a native plan's fallback (X12) and the plan's source (adapters/types.ts; the engine reads both). */
export { META_PLAN_FALLBACK, META_PLAN_SOURCE }

/**
 * Codex token totals (app-server camelCase `ThreadTokenUsage.total`, or exec's snake_case `turn.completed.usage`) →
 * Usage by protocol.ts usageFromTokenBreakdown: cached input comes off `input`. Undefined when the frame has no totals.
 */
export function codexUsage(t: unknown): Usage | undefined {
  const r = rec(t)
  if (r === undefined) return undefined
  if (num(r['inputTokens']) !== undefined && num(r['outputTokens']) !== undefined) {
    return usageFromTokenBreakdown({
      inputTokens: num(r['inputTokens']) ?? 0,
      cachedInputTokens: num(r['cachedInputTokens']) ?? 0,
      cacheWriteInputTokens: num(r['cacheWriteInputTokens']) ?? 0,
      outputTokens: num(r['outputTokens']) ?? 0,
      reasoningOutputTokens: num(r['reasoningOutputTokens']) ?? 0,
    })
  }
  if (num(r['input_tokens']) !== undefined && num(r['output_tokens']) !== undefined) {
    return usageFromTokenBreakdown(breakdownFromExecUsage(r))
  }
  return undefined
}

export interface NormalizerOptions {
  step: StartStep
  mode: Mode
  cwd: string
  /** The Plan pass asked for native plan mode (collaborationMode). */
  planNative: boolean
  /** Continuing an existing thread; `priorUsage` is its last cumulative totals. */
  resumed: boolean
  priorUsage?: Usage | undefined
  askTimeoutMs: number
  allowRules: readonly AllowRule[]
  /** A structured answer is expected (outputSchema): the final message is JSON, reported as META_STRUCTURED_OUTPUT. */
  structured: boolean
  /** A loopback local preset (classifier: unreachable server → local_server). */
  loopback: boolean
  vendor?: string
  /**
   * Prefix of the ask ids this pass raises (the run handle's id): the app-server numbers its requests from 0 in every
   * process, and an ask id must not repeat within a run. Default none.
   */
  requestPrefix?: string
  now: () => number
}

export interface NormalizeStep {
  events: NormalizedEvent[]
  signals: AdapterSignal[]
  /** The run handle interrupts the turn (a permissions ask timed out: that reply cannot cancel the turn itself). */
  interrupt?: boolean
  /**
   * An `error{willRetry:false}` arrived: turn/completed(failed) normally follows; the run handle ends the attempt
   * with {@link CodexNormalizer.failNow} if it does not.
   */
  fatalPending?: boolean
}

const emptyStep = (): NormalizeStep => ({ events: [], signals: [] })

interface Pending {
  method: AskMethod
  params: Rec
  spec: AskSpec
  resolve: (reply: unknown) => void
}

/** What a server request gets: a reply now (auto-answered / refused), or an ask whose reply comes from answer(). */
export type RequestOutcome = { reply: Promise<unknown>; step: NormalizeStep }

/** The last frames that can explain a failure (status and error frames only; no content). */
const EVIDENCE_MAX = 40

export class CodexNormalizer {
  readonly #o: NormalizerOptions
  #usage: UsageTracker
  readonly #pending = new Map<string, Pending>()
  readonly #changes = new Map<string, string[]>()
  readonly #msgText = new Map<string, string>()
  readonly #msgDelta = new Set<string>()
  readonly #toolsOpen = new Map<string, { name: string; summary: string }>()
  readonly #evidence: unknown[] = []
  readonly #cacheRules: AllowRule[]
  #sessionId: string | undefined
  #turnId: string | undefined
  #lastMessage = ''
  #currentMsg: string | undefined
  #anyText = false
  #planItem: string | undefined
  #terminal = false
  #killedBy: HarpoonKill | undefined
  #planFallback: string | undefined
  #usageSeen = false
  #execCompleted = false
  /** The account's default Harpoon asked for on turn/start (default-model.ts), until Codex confirms it runs. */
  #modelAsked: { model: string; replaced?: string | undefined } | undefined
  /** The model the thread named, which the default asked for replaced (kept after the confirmation). */
  #modelReplaced: string | undefined
  /** The pass names no model: its step records the model that runs (META_MODEL_USED), a rerouted one too. */
  #modelTracked = false

  constructor(o: NormalizerOptions) {
    this.#o = o
    this.#usage = new UsageTracker({ base: o.resumed ? o.priorUsage : undefined, resumed: o.resumed })
    this.#cacheRules = [...o.allowRules]
  }

  get terminal(): boolean {
    return this.#terminal
  }

  get turnId(): string | undefined {
    return this.#turnId
  }

  sessionId(): string | undefined {
    return this.#sessionId
  }

  cumulativeUsage(): Usage | undefined {
    return this.#usage.cumulative()
  }

  pendingAsks(): string[] {
    return [...this.#pending.keys()]
  }

  get killedBy(): HarpoonKill | undefined {
    return this.#killedBy
  }

  markKilled(kind: HarpoonKill): void {
    this.#killedBy ??= kind
  }

  /** The thread id the start/resume response reported (the engine persists it before turn/start). */
  session(id: string): NormalizeStep {
    const step = emptyStep()
    if (this.#sessionId === id) return step
    this.#sessionId = id
    step.events.push({ type: 'session', id })
    return step
  }

  turnStarted(turnId: string): void {
    this.#turnId = turnId
  }

  /**
   * Live X18a/b: turn/start carries `model` (the account's default, in place of
   * `replaced`, the model the thread named), and the step records it as the model that runs only once Codex says so
   * (META_MODEL_USED `{model, replaced}`): thread/settings/updated naming it (a native Plan's, X18b), or the first usage
   * total of this turn, a model call Codex ran (X18a: no frame seen live names a plain turn's model; X09h: the model the
   * account refuses fails at the first call, before any usage). Never confirmed by a refusal, nor by another turn's
   * total; a `model/rerouted` of this turn names another model and ends the wait.
   */
  expectModel(model: string, replaced?: string): void {
    this.#modelTracked = true
    this.#modelAsked = { model, ...(replaced !== undefined ? { replaced } : {}) }
    this.#modelReplaced = replaced
  }

  /**
   * The pass names no model, so the adapter signals the model that runs (META_MODEL_USED), and a
   * `model/rerouted` of this turn names it too. A pass that names its model records none (it is priced at its own).
   */
  tracksModel(): void {
    this.#modelTracked = true
  }

  /**
   * The vendored 0.160 schema's ModelReroutedNotification (not seen live): Codex moved this turn from
   * `fromModel` to `toModel` (for a `reason` such as a request it flags). `toModel` is the model that runs: the wait for
   * the default asked for ends (no later usage total confirms it), and the step records `{model, rerouted, replaced?}`.
   * Another turn's reroute, or one on a pass that names its model, records nothing.
   */
  #rerouted(p: Rec, step: NormalizeStep): void {
    const to = str(p['toModel'])?.trim()
    if (!this.#modelTracked || to === undefined || to === '') return
    if (this.#turnId === undefined || str(p['turnId']) !== this.#turnId) return
    this.#modelAsked = undefined
    const from = str(p['fromModel'])?.trim()
    const value = {
      model: to,
      ...(from !== undefined && from !== '' && from !== to ? { rerouted: from } : {}),
      ...(this.#modelReplaced !== undefined && this.#modelReplaced !== to
        ? { replaced: this.#modelReplaced }
        : {}),
    }
    step.signals.push({ type: 'meta', key: META_MODEL_USED, value })
  }

  #confirmModel(step: NormalizeStep): void {
    const asked = this.#modelAsked
    if (asked === undefined) return
    this.#modelAsked = undefined
    const value =
      asked.replaced !== undefined ? { model: asked.model, replaced: asked.replaced } : { model: asked.model }
    step.signals.push({ type: 'meta', key: META_MODEL_USED, value })
  }

  /**
   * turn/start refused collaborationMode: the plan runs emulated in the same thread. `reason` is the plain sentence
   * the Plan card shows; `detail` the vendor's own words (kept in the signal, never shown as the reason).
   */
  planFellBack(reason: string, detail?: string): NormalizeStep {
    this.#planFallback = reason
    const value = detail !== undefined && detail !== '' ? { reason, detail } : { reason }
    return { events: [], signals: [{ type: 'meta', key: META_PLAN_FALLBACK, value }] }
  }

  // ---- app-server notifications ---------------------------------------------------------------------------------

  notification(method: string, params: unknown): NormalizeStep {
    const step = emptyStep()
    if (this.#terminal) return step
    const p = rec(params) ?? {}
    switch (method) {
      case 'item/agentMessage/delta': {
        const itemId = str(p['itemId']) ?? ''
        const delta = str(p['delta']) ?? ''
        if (delta === '') return step
        this.#msgDelta.add(itemId)
        this.#msgText.set(itemId, (this.#msgText.get(itemId) ?? '') + delta)
        // item/completed replaces it with the whole text; a message it never completes still ends the pass.
        this.#lastMessage = this.#msgText.get(itemId) ?? ''
        this.#text(itemId, delta, step)
        return step
      }
      case 'item/plan/delta': {
        // Native plan mode streams the plan item; item/completed(plan) carries the whole text.
        const delta = str(p['delta']) ?? ''
        this.#planItem = (this.#planItem ?? '') + delta
        step.signals.push({ type: 'liveness' })
        return step
      }
      case 'item/started':
        this.#itemStarted(rec(p['item']), step)
        return step
      case 'item/completed':
        this.#itemCompleted(rec(p['item']), step)
        return step
      case 'turn/plan/updated':
        step.events.push(todoEvent(planSteps(p['plan']), `todo-${str(p['turnId']) ?? 'turn'}`))
        return step
      case 'thread/tokenUsage/updated': {
        const total = codexUsage(rec(p['tokenUsage'])?.['total'])
        if (total !== undefined && this.#restoredBase(total)) {
          // thread/resume restores the thread's saved totals before the turn: with no known prior they are the base.
          step.signals.push({ type: 'liveness' })
          return step
        }
        if (total !== undefined) {
          this.#usage.report(total)
          this.#usageSeen = true
          // A model call of this turn ran: the model Harpoon asked for is the one that ran (live X18a).
          if (this.#turnId !== undefined && str(p['turnId']) === this.#turnId) this.#confirmModel(step)
        }
        step.signals.push({ type: 'liveness' })
        return step
      }
      case 'thread/settings/updated': {
        // Codex names the turn's model (a native Plan's collaboration mode, X12a, X18b).
        const model = str(rec(p['threadSettings'])?.['model'])
        if (model !== undefined && model === this.#modelAsked?.model) this.#confirmModel(step)
        // Codex names another model than the one asked for: no later usage total confirms the one asked for.
        else if (model !== undefined) this.#modelAsked = undefined
        step.signals.push({ type: 'liveness' })
        return step
      }
      case 'model/rerouted':
        this.#rerouted(p, step)
        step.signals.push({ type: 'liveness' })
        return step
      case 'turn/started': {
        const id = str(rec(p['turn'])?.['id'])
        if (id !== undefined) this.#turnId ??= id
        step.signals.push({ type: 'liveness' })
        return step
      }
      case 'serverRequest/resolved': {
        const id = p['requestId']
        const key = typeof id === 'number' || typeof id === 'string' ? this.askId(id) : undefined
        const pending = key !== undefined ? this.#pending.get(key) : undefined
        if (key !== undefined && pending !== undefined) {
          this.#pending.delete(key)
          pending.resolve(replyFor(pending.method, 'cancel', pending.params))
          step.signals.push({ type: 'ask-withdrawn', requestId: key })
        }
        step.signals.push({ type: 'liveness' })
        return step
      }
      case 'error':
        this.#remember({ method, params: p })
        // willRetry:true is a transient stream retry: liveness only. willRetry:false is terminal once
        // turn/completed(failed) follows; the run handle waits a moment for it.
        if (p['willRetry'] === false) step.fatalPending = true
        step.signals.push({ type: 'liveness' })
        return step
      case 'turn/completed':
        this.#remember({ method, params: p })
        this.#turnCompleted(rec(p['turn']) ?? {}, { method, params: p }, step)
        return step
      default:
        step.signals.push({ type: 'liveness' })
        return step
    }
  }

  #restoredBase(total: Usage): boolean {
    if (!this.#o.resumed || this.#o.priorUsage !== undefined || this.#turnId !== undefined || this.#usageSeen)
      return false
    this.#usage = new UsageTracker({ base: total, resumed: true })
    return true
  }

  #text(itemId: string, delta: string, step: NormalizeStep): void {
    if (this.#currentMsg !== itemId) {
      if (this.#anyText) step.events.push({ type: 'text', delta: '\n\n' })
      this.#currentMsg = itemId
    }
    this.#anyText = true
    step.events.push({ type: 'text', delta })
  }

  #itemStarted(item: Rec | undefined, step: NormalizeStep): void {
    if (item === undefined) return
    const type = str(item['type'])
    const id = str(item['id']) ?? ''
    if (type === 'fileChange') this.#changes.set(id, changePaths(item))
    const ev = toolStart(item, this.#o.cwd)
    if (ev !== undefined && !this.#toolsOpen.has(id)) {
      this.#toolsOpen.set(id, { name: ev.name, summary: ev.summary })
      this.#currentMsg = undefined
      step.events.push(ev)
    }
  }

  #itemCompleted(item: Rec | undefined, step: NormalizeStep): void {
    if (item === undefined) return
    const type = str(item['type'])
    const id = str(item['id']) ?? ''
    if (type === 'agentMessage') {
      const text = str(item['text']) ?? this.#msgText.get(id) ?? ''
      if (!this.#msgDelta.has(id) && text !== '') this.#text(id, text, step)
      this.#lastMessage = text
      return
    }
    if (type === 'plan') {
      const text = str(item['text'])
      if (text !== undefined && text.trim() !== '') this.#planItem = text
      return
    }
    if (type === 'fileChange') this.#changes.set(id, changePaths(item))
    const ev = toolEnd(item, this.#o.cwd)
    if (ev === undefined) return
    if (type === 'webSearch') {
      // Live X17: the pages an opened-page item read are in its results; the tool line names only the first.
      const urls = webPagesOf(item)
      if (urls.length > 0) step.signals.push({ type: 'meta', key: META_PAGES_READ, value: { id, urls } })
    }
    if (!this.#toolsOpen.has(id)) {
      // An item reported only once completed (exec's file_change): start and end it.
      step.events.push({ type: 'tool', id, name: ev.name, summary: ev.summary, phase: 'start' })
    }
    this.#toolsOpen.delete(id)
    this.#currentMsg = undefined
    step.events.push(ev)
  }

  #remember(frame: unknown): void {
    this.#evidence.push(frame)
    if (this.#evidence.length > EVIDENCE_MAX) this.#evidence.shift()
  }

  // ---- turn end -----------------------------------------------------------------------------------------------

  #turnCompleted(turn: Rec, frame: unknown, step: NormalizeStep): void {
    const status = str(turn['status'])
    if (status === 'completed') {
      this.#done(step)
      return
    }
    if (status === 'interrupted' && this.#killedBy !== undefined) {
      this.#harpoonError(step)
      return
    }
    this.#failed(step, { structured: [frame] })
  }

  #closeTools(step: NormalizeStep, status: 'failed' | 'declined'): void {
    for (const [id, t] of this.#toolsOpen) {
      step.events.push({ type: 'tool', id, name: t.name, summary: t.summary, phase: 'end', status })
    }
    this.#toolsOpen.clear()
  }

  /** This pass's delta and whether it is approximate (a resumed thread without a known base, or no usage at all). */
  #delta(step: NormalizeStep): Usage | undefined {
    if (!this.#usageSeen) {
      step.signals.push({ type: 'meta', key: META_USAGE_APPROX, value: { reason: 'no-usage-reported' } })
      return undefined
    }
    const d = this.#usage.delta()
    if (d.approx) {
      step.signals.push({
        type: 'meta',
        key: META_USAGE_APPROX,
        value:
          d.resetFields.length > 0
            ? { reason: 'counter-reset', fields: d.resetFields }
            : { reason: 'resumed-without-base' },
      })
    }
    return d.usage
  }

  #done(step: NormalizeStep): void {
    this.#terminal = true
    this.#closeTools(step, 'failed')
    this.#rejectPending(step)
    let result = this.#lastMessage
    if (this.#o.step === 'plan') {
      const native = this.#o.planNative && this.#planFallback === undefined
      const plan = choosePlan({ planItem: this.#planItem, finalMessage: this.#lastMessage })
      if (plan !== undefined && (native || plan.source === 'proposed_plan')) {
        step.signals.push({ type: 'plan-captured', markdown: plan.markdown, source: plan.source })
        step.signals.push({
          type: 'meta',
          key: META_PLAN_SOURCE,
          value:
            plan.warning !== undefined
              ? { source: plan.source, warning: plan.warning }
              : { source: plan.source },
        })
        result = plan.markdown
      }
    }
    if (this.#o.structured) {
      try {
        const value: unknown = JSON.parse(this.#lastMessage)
        step.signals.push({ type: 'meta', key: META_STRUCTURED_OUTPUT, value })
      } catch {
        // Not JSON: the caller falls back to the final message (as for Claude's C18).
      }
    }
    const usage = this.#delta(step)
    step.events.push(usage !== undefined ? { type: 'done', result, usage } : { type: 'done', result })
  }

  /** A failed attempt still bills: its usage goes in META_USAGE (never with `done`). */
  #billFailed(step: NormalizeStep): void {
    if (!this.#usageSeen) return
    const d = this.#usage.delta()
    if (!isZeroUsage(d.usage)) step.signals.push({ type: 'meta', key: META_USAGE, value: d.usage })
  }

  #error(step: NormalizeStep, failure: Failure): void {
    this.#terminal = true
    this.#closeTools(step, this.#killedBy !== undefined ? 'declined' : 'failed')
    this.#rejectPending(step)
    this.#billFailed(step)
    step.events.push(errorEvent(failure, true))
  }

  /** `{step}` for the classifier when the pass is a run step (heal and catalog have none). */
  #stepField(): { step?: Exclude<StartStep, 'heal' | 'catalog' | 'design'> } {
    const s = this.#runStep()
    return s !== undefined ? { step: s } : {}
  }

  #harpoonError(step: NormalizeStep): void {
    const f =
      classify({
        vendor: this.#vendor(),
        ...this.#stepField(),
        harpoonInitiated: { kind: this.#killedBy ?? 'stop' },
        now: this.#o.now(),
      }) ?? makeFailure('user_cancelled', 'Harpoon is shutting down.', { classifiedBy: 'harpoon' })
    this.#error(step, f)
  }

  #failed(
    step: NormalizeStep,
    o: {
      structured?: unknown[]
      stderrTail?: readonly string[]
      exitCode?: number | null
      signal?: string | null
      ranMs?: number
      noTerminal?: boolean
    },
  ): void {
    const f = classifyFailure({
      vendor: this.#vendor(),
      ...this.#stepField(),
      structured: [...this.#evidence, ...(o.structured ?? [])],
      ...(o.stderrTail !== undefined ? { stderrTail: o.stderrTail } : {}),
      ...(o.exitCode !== undefined ? { exitCode: o.exitCode } : {}),
      ...(o.signal !== undefined ? { signal: o.signal } : {}),
      ...(o.ranMs !== undefined ? { ranMs: o.ranMs } : {}),
      ...(o.noTerminal === true ? { protocol: { noTerminal: true } } : {}),
      mode: this.#o.mode,
      ...(this.#o.loopback ? { loopback: true } : {}),
      now: this.#o.now(),
    })
    this.#error(step, f)
  }

  #vendor(): string {
    return this.#o.vendor ?? CODEX_VENDOR
  }

  #runStep(): Exclude<StartStep, 'heal' | 'catalog' | 'design'> | undefined {
    const s = this.#o.step
    return s === 'heal' || s === 'catalog' || s === 'design' ? undefined : s
  }

  /** A failure found by the run handle itself (spawn, handshake, resume echo, a refused request). */
  fail(failure: Failure): NormalizeStep {
    const step = emptyStep()
    if (this.#terminal) return step
    this.#error(step, failure)
    return step
  }

  /**
   * A failure the run handle classifies from what it saw (a JSON-RPC error on thread/start or turn/start, an
   * `error{willRetry:false}` no turn/completed followed): the evidence frames, plus the RPC error and stderr.
   */
  failNow(o: {
    rpcError?: { method: string; code: number; message: string; required?: boolean }
    stderrTail?: readonly string[]
    structured?: unknown[]
  }): NormalizeStep {
    const step = emptyStep()
    if (this.#terminal) return step
    if (this.#killedBy !== undefined) {
      this.#harpoonError(step)
      return step
    }
    const f = classifyFailure({
      vendor: this.#vendor(),
      ...this.#stepField(),
      structured: [...this.#evidence, ...(o.structured ?? [])],
      ...(o.rpcError !== undefined ? { rpcError: o.rpcError } : {}),
      ...(o.stderrTail !== undefined ? { stderrTail: o.stderrTail } : {}),
      mode: this.#o.mode,
      ...(this.#o.loopback ? { loopback: true } : {}),
      now: this.#o.now(),
    })
    this.#error(step, f)
    return step
  }

  /** The process ended: the terminal event when none was emitted (crash, kill, a lost turn/completed). */
  end(exit: {
    code: number | null
    signal: string | null
    ranMs: number
    stderrTail: readonly string[]
  }): NormalizeStep {
    const step = emptyStep()
    this.#rejectPending(step)
    if (this.#terminal) return step
    if (this.#killedBy !== undefined) {
      this.#harpoonError(step)
      return step
    }
    this.#failed(step, {
      stderrTail: exit.stderrTail,
      exitCode: exit.code,
      signal: exit.signal,
      ranMs: exit.ranMs,
      noTerminal: true,
    })
    return step
  }

  // ---- server requests (app-server) ---------------------------------------------------------------------------

  /** The ask id of a server request id (the run handle's prefix + the JSON-RPC id). */
  askId(rpcId: number | string): string {
    return `${this.#o.requestPrefix ?? ''}${String(rpcId)}`
  }

  /** A server → client request. Asks wait for answer(); everything else is answered here. */
  request(method: string, params: unknown, rpcId: number | string): RequestOutcome {
    const step = emptyStep()
    const id = this.askId(rpcId)
    const p = rec(params) ?? {}
    if ((ASK_METHODS as readonly string[]).includes(method)) {
      const m = method as AskMethod
      const spec = askFor(m, p, {
        requestId: id,
        expiresAt: this.#o.now() + this.#o.askTimeoutMs,
        cwd: this.#o.cwd,
        changesOf: (itemId) => this.#changes.get(itemId) ?? [],
      })
      // Read-only passes never ask (approvalPolicy never); one that does anyway is declined, not shown.
      if (this.#readOnly() || this.#terminal) {
        step.signals.push({
          type: 'auto-answered',
          requestId: id,
          decision: 'deny',
          tool: spec.tool,
          why: 'readonly',
        })
        return { reply: Promise.resolve(replyFor(m, 'deny', p)), step }
      }
      const rule = matchingRule(this.#cacheRules, spec.query, this.#o.cwd)
      if (rule !== undefined) {
        step.signals.push({
          type: 'auto-answered',
          requestId: id,
          decision: 'allow',
          tool: spec.tool,
          why: 'allow-cache',
        })
        return { reply: Promise.resolve(replyFor(m, 'allow', p)), step }
      }
      let resolve: (v: unknown) => void = () => undefined
      const reply = new Promise<unknown>((r) => {
        resolve = r
      })
      this.#pending.set(id, { method: m, params: p, spec, resolve })
      this.#currentMsg = undefined
      step.events.push(spec.event)
      return { reply, step }
    }
    if (method === ELICITATION) {
      step.signals.push({
        type: 'auto-answered',
        requestId: id,
        decision: 'cancel',
        tool: requestLabel(method, p),
        why: 'unsupported',
      })
      return { reply: Promise.resolve(ELICITATION_CANCEL), step }
    }
    if ((REFUSED_METHODS as readonly string[]).includes(method)) {
      step.signals.push({
        type: 'auto-answered',
        requestId: id,
        decision: 'deny',
        tool: requestLabel(method, p),
        why: 'unsupported',
      })
    }
    // The refused requests (and anything else routed here): a JSON-RPC error, so the turn goes on without them.
    return { reply: Promise.reject(new JsonRpcError(REFUSED_CODE, REFUSED_MESSAGE, undefined, method)), step }
  }

  #readOnly(): boolean {
    const s = this.#o.step
    return (
      s === 'plan' ||
      s === 'review' ||
      s === 'critic' ||
      s === 'heal' ||
      s === 'catalog' ||
      this.#o.mode === 'readonly'
    )
  }

  /** The user's (or the engine's) answer to an ask. `cancel` = the ask timer (or a deny that pauses, P9b). */
  answer(requestId: string, decision: AskDecision, why?: AskCancelReason): NormalizeStep {
    const step = emptyStep()
    const p = this.#pending.get(requestId)
    if (p === undefined) return step
    this.#pending.delete(requestId)
    p.resolve(replyFor(p.method, decision, p.params))
    if (decision === 'allow-session') {
      const rule = ruleFor(p.spec.query)
      if (rule !== undefined) {
        this.#cacheRules.push(rule)
        step.signals.push({ type: 'allow-rule', rule })
      }
    }
    if (decision === 'cancel') {
      this.markKilled(why === 'denied' ? 'deny' : 'ask')
      if (p.method === PERMISSIONS_APPROVAL) step.interrupt = true
      if (why !== 'denied') {
        // P19 "Allow & resume": the exact rule a late Allow adds (never wider than the request).
        const rule = ruleFor(p.spec.query)
        if (rule !== undefined)
          step.signals.push({ type: 'meta', key: META_LATE_ALLOW_RULE, value: { requestId, rule } })
      }
    }
    return step
  }

  /**
   * Releases every waiting ask (turn over, process gone): the server gets `cancel` if it still listens, and the
   * engine an `ask-withdrawn` (nobody answered it; contract: every ask is answered or withdrawn).
   */
  #rejectPending(step: NormalizeStep): void {
    for (const [id, p] of this.#pending) {
      p.resolve(replyFor(p.method, 'cancel', p.params))
      step.signals.push({ type: 'ask-withdrawn', requestId: id })
    }
    this.#pending.clear()
  }

  // ---- exec JSONL (the no-relay fallback) ---------------------------------------------------------------------

  /** One stdout line of `codex exec --json`. */
  execLine(frame: unknown): NormalizeStep {
    const step = emptyStep()
    const f = rec(frame)
    if (f === undefined || this.#terminal) return step
    switch (str(f['type']) ?? '') {
      case 'thread.started': {
        const id = str(f['thread_id'])
        return id !== undefined ? this.session(id) : step
      }
      case 'turn.started':
        step.signals.push({ type: 'liveness' })
        return step
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = execItemToThreadItem(f['item'])
        if (item === undefined) return step
        const type = str(item['type'])
        if (type === 'todoList') {
          step.events.push(todoEvent(execTodoSteps(item['items']), 'todo'))
          return step
        }
        if (type === 'error') {
          // Warnings, deprecations, model reroutes: never terminal.
          step.signals.push({ type: 'liveness' })
          return step
        }
        if (str(f['type']) === 'item.completed') this.#itemCompleted(item, step)
        else if (str(f['type']) === 'item.started') this.#itemStarted(item, step)
        return step
      }
      case 'turn.completed': {
        // The `-o` file is written as exec shuts down: `done` waits for the exit (execExit).
        const total = codexUsage(f['usage'])
        if (total !== undefined) {
          this.#usage.report(total)
          this.#usageSeen = true
        }
        this.#execCompleted = true
        step.signals.push({ type: 'liveness' })
        return step
      }
      case 'turn.failed':
        this.#remember(f)
        this.#failed(step, {})
        return step
      case 'error':
        // May be a transient retry (exec does not expose willRetry): evidence only.
        this.#remember(f)
        step.signals.push({ type: 'liveness' })
        return step
      default:
        step.signals.push({ type: 'liveness' })
        return step
    }
  }

  /**
   * exec ended. After turn.completed: `done`, with the `-o` file's final message when it has one (written only for a
   * completed turn; Codex's own "last agent message, else the last plan text"). Otherwise the terminal error.
   */
  execExit(exit: {
    outText?: string | undefined
    code: number | null
    signal: string | null
    ranMs: number
    stderrTail: readonly string[]
  }): NormalizeStep {
    if (this.#execCompleted && !this.#terminal && this.#killedBy === undefined) {
      const step = emptyStep()
      const out = exit.outText?.replace(/\r?\n$/, '')
      if (out !== undefined && out.trim() !== '') this.#lastMessage = out
      this.#done(step)
      return step
    }
    return this.end(exit)
  }
}
