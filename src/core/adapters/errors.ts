// Adapter-side failure helpers: Failure → `error` events, legacy kebab aliases → FailureCategory, stderr tails,
// and a pre-failed RunHandle for failures before any process exists. Classification itself lives in
// heal/classify.ts.
import type { NormalizedEvent } from '../../shared/events.ts'
import type { ClassifiedBy, Failure, FailureCategory } from '../../shared/failure.ts'
import { isFailureCategory } from '../../shared/failure.ts'
import type { StepKey } from '../../shared/run.ts'
import type { Route, VendorId } from '../../shared/vendors.ts'
import type { ClassifyInput } from '../heal/classify.ts'
import { classifyDetailed } from '../heal/classify.ts'
import type { ExitInfo, RunHandle, Unsubscribe } from './types.ts'

/**
 * Legacy kebab names for failure categories, mapped once to the canonical snake_case union.
 */
export const ADAPTER_ERROR_ALIASES: Readonly<Record<string, FailureCategory>> = {
  'protocol-drift': 'flag_drift',
  'flag-drift': 'flag_drift',
  'binary-missing': 'cli_missing',
  'binary-invalid': 'cli_missing',
  'unsupported-shim': 'cli_missing',
  'node-missing': 'cli_missing',
  'env-missing': 'cli_missing',
  'version-too-old': 'cli_version',
  'auth-missing': 'auth_required',
  'auth-invalid': 'auth_required',
  'auth-expired': 'auth_expired',
  'rate-limited': 'rate_limited',
  'quota-exhausted': 'quota_exceeded',
  overloaded: 'vendor_internal',
  'vendor-server': 'vendor_internal',
  'model-invalid': 'model_unavailable',
  budget: 'turn_limit',
  'turn-limit': 'turn_limit',
  'policy-refusal': 'content_policy',
  'too-many-denials': 'permission_denied',
  'spawn-failed': 'process_crash',
  stopped: 'user_cancelled',
  'cwd-missing': 'folder_guard',
  'root-refused': 'config_invalid',
  'session-busy': 'resume_failed',
  'resume-failed': 'resume_failed',
  'stall-timeout': 'timeout_hard',
  snapshot: 'snapshot_failed',
  'stream-malformed': 'stream_malformed',
  'context-exceeded': 'context_exceeded',
  'sandbox-unavailable': 'sandbox_unavailable',
  'trust-required': 'trust_required',
  'capability-missing': 'capability_missing',
  'local-server': 'local_server',
}

/** A canonical category passes through; a known alias maps; anything else is `unknown`. */
export function toFailureCategory(name: string): FailureCategory {
  if (isFailureCategory(name)) return name
  return ADAPTER_ERROR_ALIASES[name] ?? 'unknown'
}

export function makeFailure(
  category: FailureCategory,
  message: string,
  o: {
    raw?: string
    step?: StepKey
    classifiedBy?: ClassifiedBy
    resetsAt?: number
    retryAfterMs?: number
  } = {},
): Failure {
  const f: Failure = { category, message, raw: o.raw ?? '', classifiedBy: o.classifiedBy ?? 'harpoon' }
  if (o.step !== undefined) f.step = o.step
  if (o.resetsAt !== undefined) f.resetsAt = o.resetsAt
  if (o.retryAfterMs !== undefined) f.retryAfterMs = o.retryAfterMs
  return f
}

/** The normalized `error` event for a classified failure. Non-fatal = transient (the vendor continues). */
export function errorEvent(failure: Failure, fatal = true): Extract<NormalizedEvent, { type: 'error' }> {
  const ev: Extract<NormalizedEvent, { type: 'error' }> = {
    type: 'error',
    message: failure.message,
    raw: failure.raw,
    fatal,
    category: failure.category,
  }
  // What the engine needs beyond the category (P17 heals a heuristic verdict; wait_until uses the reset).
  if (failure.classifiedBy === 'heuristic' && failure.category !== 'unknown') ev.classifiedBy = 'heuristic'
  if (failure.resetsAt !== undefined) ev.resetsAt = failure.resetsAt
  if (failure.retryAfterMs !== undefined) ev.retryAfterMs = failure.retryAfterMs
  return ev
}

/** classify() for an attempt known to have failed; never null. Not for a quit, which is not a failure. */
export function classifyFailure(input: ClassifyInput): Failure {
  return classifyFailureDetailed(input).failure
}

/** {@link classifyFailure} plus the rule's recovery hints (e.g. `claude-env-key`). */
export function classifyFailureDetailed(input: ClassifyInput): { failure: Failure; hints: string[] } {
  const c = classifyDetailed({ ...input, failed: true })
  if (c !== null) return { failure: c.failure, hints: c.hints }
  return {
    failure: makeFailure('unknown', `${input.vendor} failed`, { classifiedBy: 'heuristic' }),
    hints: [],
  }
}

/** Meta signal key carrying a failure's recovery hints next to its `error` event. */
export const FAILURE_HINTS_META = 'failureHints'

export class AdapterError extends Error {
  readonly failure: Failure

  constructor(failure: Failure) {
    super(failure.message)
    this.name = 'AdapterError'
    this.failure = failure
  }
}

/** Last N lines of a stream (stderr ring for the classifier and the heal tail). */
export class TailBuffer {
  readonly maxLines: number
  readonly maxLineChars: number
  #lines: string[] = []

  constructor(maxLines = 40, maxLineChars = 2000) {
    this.maxLines = maxLines
    this.maxLineChars = maxLineChars
  }

  push(line: string): void {
    this.#lines.push(line.length > this.maxLineChars ? `${line.slice(0, this.maxLineChars)}…` : line)
    if (this.#lines.length > this.maxLines) this.#lines.splice(0, this.#lines.length - this.maxLines)
  }

  lines(): string[] {
    return [...this.#lines]
  }

  text(): string {
    return this.#lines.join('\n')
  }

  clear(): void {
    this.#lines = []
  }

  get size(): number {
    return this.#lines.length
  }
}

/**
 * Fan-out with replay: items emitted before the first subscriber are queued and delivered to it (on a
 * microtask, after `subscribe` returns). Used by RunHandle implementations.
 */
export class BufferedEmitter<T> {
  #subs = new Set<(v: T) => void>()
  #queue: T[] = []

  emit(v: T): void {
    if (this.#subs.size === 0) {
      this.#queue.push(v)
      return
    }
    for (const s of [...this.#subs]) s(v)
  }

  subscribe(cb: (v: T) => void): Unsubscribe {
    this.#subs.add(cb)
    if (this.#queue.length > 0) {
      const pending = this.#queue
      this.#queue = []
      queueMicrotask(() => {
        for (const v of pending) cb(v)
      })
    }
    return () => {
      this.#subs.delete(cb)
    }
  }
}

let failedSeq = 0

/** A RunHandle that failed before a process existed (spawn errno, unbuilt vendor): one fatal error, then exit. */
export function failedRunHandle(o: {
  vendor: VendorId
  route: Route
  failure: Failure
  id?: string
  sessionId?: string
}): RunHandle {
  const events = new BufferedEmitter<NormalizedEvent>()
  events.emit(errorEvent(o.failure, true))
  const exit: ExitInfo = { code: null, signal: null, sawTerminal: true, ranMs: 0 }
  return {
    id: o.id ?? `failed-${++failedSeq}`,
    vendor: o.vendor,
    route: o.route,
    pid: undefined,
    onEvent: (cb) => events.subscribe(cb),
    onSignal: () => () => {},
    sessionId: () => o.sessionId,
    cumulativeUsage: () => undefined,
    pendingAsks: () => [],
    exited: Promise.resolve(exit),
  }
}
