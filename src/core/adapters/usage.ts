// Usage arithmetic for adapters. Vendors that report cumulative session totals
// (Claude modelUsage / total_cost_usd, Codex tokenUsage) are turned into per-pass deltas here; the engine never
// subtracts.
import type { Usage } from '../../shared/events.ts'
import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk'

export const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'costUsd'] as const
export type UsageField = (typeof USAGE_FIELDS)[number]
const OPTIONAL_FIELDS = ['cacheRead', 'cacheWrite', 'reasoning', 'costUsd'] as const

export interface UsageDelta {
  usage: Usage
  /** The delta is an estimate: a counter went backwards, or a resumed session had no known base. */
  approx: boolean
  /** Fields reported as-is because `reported < base` (counter reset, e.g. `/clear` or a new session). */
  resetFields: UsageField[]
}

export function zeroUsage(): Usage {
  return { input: 0, output: 0 }
}

const finite = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

/** Clamp NaN/negative/non-finite values to 0 and drop absent optional fields. */
export function normalizeUsage(u: Usage): Usage {
  const out: Usage = { input: Math.max(0, finite(u.input)), output: Math.max(0, finite(u.output)) }
  for (const f of OPTIONAL_FIELDS) {
    const v = u[f]
    if (v !== undefined) out[f] = Math.max(0, finite(v))
  }
  return out
}

/** Field-wise sum. An optional field is present when any operand has it. */
export function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = { input: finite(a.input) + finite(b.input), output: finite(a.output) + finite(b.output) }
  for (const f of OPTIONAL_FIELDS) {
    if (a[f] !== undefined || b[f] !== undefined) out[f] = finite(a[f]) + finite(b[f])
  }
  return out
}

export function sumUsage(list: readonly (Usage | undefined)[]): Usage {
  let acc = zeroUsage()
  for (const u of list) if (u) acc = addUsage(acc, u)
  return acc
}

/** Same as {@link sumUsage}; kept as the name the engine uses when folding attempts. */
export const mergeUsage = sumUsage

/** Tokens counted toward progress. `reasoning` is added only when the vendor reports it outside `output`. */
export function totalTokens(u: Usage, reasoningIncludedInOutput = true): number {
  return (
    finite(u.input) +
    finite(u.output) +
    finite(u.cacheRead) +
    finite(u.cacheWrite) +
    (reasoningIncludedInOutput ? 0 : finite(u.reasoning))
  )
}

export function isZeroUsage(u: Usage): boolean {
  return USAGE_FIELDS.every((f) => finite(u[f]) === 0)
}

export interface PerPassInput {
  /** Cumulative totals the vendor reported at the end of (or during) this pass. */
  reported: Usage
  /** The session's totals before this pass (`resume.priorUsage`). */
  base?: Usage | undefined
  /** The pass continued an existing session (resume). */
  resumed: boolean
}

/**
 * Per-pass delta from cumulative totals: `max(0, reported − base)` per field. A field that went backwards is
 * reported as-is with `approx`. A resumed session without a known base reports the totals with `approx`; a
 * fresh session's totals are its delta.
 */
export function perPassUsage({ reported, base, resumed }: PerPassInput): UsageDelta {
  const r = normalizeUsage(reported)
  if (!base) return { usage: r, approx: resumed, resetFields: [] }
  const b = normalizeUsage(base)
  const resetFields: UsageField[] = []
  const field = (f: UsageField): number => {
    const rv = finite(r[f])
    const d = rv - finite(b[f])
    if (d < 0) {
      resetFields.push(f)
      return rv
    }
    return f === 'costUsd' ? roundCost(d) : d
  }
  const usage: Usage = { input: field('input'), output: field('output') }
  for (const f of OPTIONAL_FIELDS) if (r[f] !== undefined) usage[f] = field(f)
  return { usage, approx: resetFields.length > 0, resetFields }
}

/** Float noise from subtracting costs (0.3 − 0.1) is rounded at 1e-10 USD. */
function roundCost(n: number): number {
  return Math.round(n * 1e10) / 1e10
}

export type ClaudeModelUsageEntry = Partial<
  Pick<
    ModelUsage,
    'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens' | 'costUSD'
  >
>

/**
 * Claude `result.modelUsage` → one Usage, summed across models. Cumulative for the session (resumed sessions
 * continue from the transcript's saved totals), so feed it to {@link perPassUsage}. Zeroed startup-error
 * results sum to zero.
 */
export function sumClaudeModelUsage(
  modelUsage: Readonly<Record<string, ClaudeModelUsageEntry>> | null | undefined,
): Usage {
  const out: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
  if (!modelUsage || typeof modelUsage !== 'object') return out
  for (const m of Object.values(modelUsage)) {
    if (!m || typeof m !== 'object') continue
    out.input += finite(m.inputTokens)
    out.output += finite(m.outputTokens)
    out.cacheRead = finite(out.cacheRead) + finite(m.cacheReadInputTokens)
    out.cacheWrite = finite(out.cacheWrite) + finite(m.cacheCreationInputTokens)
    out.costUsd = finite(out.costUsd) + finite(m.costUSD)
  }
  out.costUsd = roundCost(finite(out.costUsd))
  return out
}

/**
 * Tracks one process's cumulative reports against the pass base. `delta()` is the pass's usage so far; with
 * several results in one process (streaming input), each report replaces the previous cumulative value.
 */
export class UsageTracker {
  readonly base: Usage | undefined
  readonly resumed: boolean
  #last: Usage | undefined

  constructor(opts: { base?: Usage | undefined; resumed: boolean }) {
    this.base = opts.base ? normalizeUsage(opts.base) : undefined
    this.resumed = opts.resumed
  }

  report(cumulative: Usage): UsageDelta {
    this.#last = normalizeUsage(cumulative)
    return this.delta()
  }

  /** Last cumulative totals reported (what `RunHandle.cumulativeUsage()` returns). */
  cumulative(): Usage | undefined {
    return this.#last
  }

  delta(): UsageDelta {
    if (!this.#last) return { usage: zeroUsage(), approx: false, resetFields: [] }
    return perPassUsage({ reported: this.#last, base: this.base, resumed: this.resumed })
  }
}
