// Normalized adapter events (the only stream the UI renders) and engine-internal adapter signals.
import type { FailureCategory } from './failure.ts'

export const ASK_DECISIONS = ['allow', 'allow-session', 'deny', 'cancel'] as const
/** `cancel` = supervisor timeout/stop: deny plus interrupt. */
export type AskDecision = (typeof ASK_DECISIONS)[number]

export const ASK_KINDS = ['edit', 'shell', 'network', 'other'] as const
export type AskKind = (typeof ASK_KINDS)[number]

export type ToolPhase = 'start' | 'end'
export type ToolStatus = 'ok' | 'failed' | 'declined'

/** Token usage. On `done` it is THIS pass's delta; adapters compute it, the engine never subtracts. */
export type Usage = {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  costUsd?: number
}

export const NORMALIZED_EVENT_TYPES = ['session', 'text', 'tool', 'ask', 'done', 'error'] as const

export type NormalizedEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; id?: string; name: string; summary: string; phase?: ToolPhase; status?: ToolStatus }
  | {
      type: 'ask'
      requestId: string
      kind: AskKind
      detail: string
      reason?: string
      expiresAt: number
      allowSession: boolean
      defaultToNo?: boolean
    }
  | { type: 'done'; result: string; usage?: Usage }
  | {
      type: 'error'
      message: string
      raw: string
      fatal: boolean
      category?: FailureCategory
      /**
       * `heuristic` when the classifier's heuristic stage named a known category (P17 heals such a failure; an
       * `unknown` one always comes from it); absent otherwise. `resetsAt` / `retryAfterMs`: a rate or usage limit's
       * reset (wait_until, P16's retry-after rule).
       */
      classifiedBy?: 'heuristic'
      resetsAt?: number
      retryAfterMs?: number
    }

export type NormalizedEventType = NormalizedEvent['type']
export type NormalizedEventOf<T extends NormalizedEventType> = Extract<NormalizedEvent, { type: T }>

export interface AllowRuleMatch {
  argv?: string[]
  argvPrefix?: string[]
  pathGlob?: string
  host?: string
}

/**
 * A per-run "Allow for this run" grant. Matching: same tool + kind; `argvPrefix`/`pathGlob`/`host` only when
 * the vendor's own suggestion supplied that scope, else exact argv/path. Harpoon never generalizes beyond
 * the vendor suggestion. Claude passes `nativeRules` to `--allowedTools`; other adapters match in allow-cache.
 */
export interface AllowRule {
  vendor: string
  kind: AskKind
  tool: string
  match: AllowRuleMatch
  nativeRules?: string[]
  source: 'vendor-suggestion' | 'exact'
}

export const PLAN_CAPTURE_SOURCES = [
  'exitPlanMode',
  'proposed_plan',
  'acp-exit-plan',
  'final-message',
] as const
export type PlanCaptureSource = (typeof PLAN_CAPTURE_SOURCES)[number]

export const AUTO_ANSWER_REASONS = ['readonly', 'allow-cache', 'plan-capture', 'unsupported'] as const
export type AutoAnswerReason = (typeof AUTO_ANSWER_REASONS)[number]

export const ADAPTER_SIGNAL_TYPES = [
  'liveness',
  'ask-withdrawn',
  'allow-rule',
  'plan-captured',
  'auto-answered',
  'meta',
  'waiting',
] as const

/** Engine-internal; never rendered directly. */
export type AdapterSignal =
  | { type: 'liveness' }
  | { type: 'ask-withdrawn'; requestId: string }
  | { type: 'allow-rule'; rule: AllowRule }
  | { type: 'plan-captured'; markdown: string; source: PlanCaptureSource }
  | { type: 'auto-answered'; requestId: string; decision: AskDecision; tool: string; why: AutoAnswerReason }
  | { type: 'meta'; key: string; value: unknown }
  /** The CLI answered but background work it started (shells, sub-agents) still runs; the pass waits for it. */
  | { type: 'waiting'; tasks: string[] }

export type AdapterSignalType = AdapterSignal['type']
