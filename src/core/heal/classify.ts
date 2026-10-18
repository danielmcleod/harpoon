// Deterministic failure classifier. Precedence, highest first:
//   1 Harpoon-initiated (stop, timers, quit) and Harpoon-detected (guard, grants, git, snapshot, verify, …)
//   2 spawn errno · 3 structured vendor fields · 4 exit-code table · 5 regex · 6 heuristic · 7 unknown
// Retry frames (Claude api_retry, `willRetry:true`) are never a failure on their own; they are consulted as
// supporting evidence after the regex stage. Vendor tables (claude, codex, gemini) plug in through
// registerSignalTable(); the codex and gemini tables are synthesized until their fixtures are recorded live.
import type { ClassifiedBy, Failure, FailureCategory } from '../../shared/failure.ts'
import type { RedactOptions } from '../../shared/redact.ts'
import { redactLine, redactText } from '../../shared/redact.ts'
import type { Mode, StepKey } from '../../shared/run.ts'
import { localPresetIdOf } from '../../shared/vendors.ts'
import { GEMINI_SIGNALS } from './signals/acp-gemini.ts'
import { CLAUDE_SIGNALS } from './signals/claude.ts'
import { CODEX_SIGNALS } from './signals/codex.ts'
import type { HarpoonCheck } from './signals/harpoon.ts'
import { harpoonMatch } from './signals/harpoon.ts'
import type { RpcErrorLike, SignalContext, SignalMatch, SignalTable } from './signals/generic.ts'
import {
  GENERIC_SIGNALS,
  errnoCategory,
  heuristicMatch,
  matchedLine,
  rpcErrorMatch,
} from './signals/generic.ts'

/**
 * Who/what made Harpoon end the process. `handshake` = the 15 s initialize timer (→ flag_drift); `ask` = the
 * ask timer cancelled a question (P10); `deny` = a user deny under `ask.denyPauses` (P9b).
 */
export type HarpoonKill = 'stop' | 'stall' | 'hard' | 'ask' | 'deny' | 'quit' | 'handshake'

export interface ErrnoLike {
  code: string
  syscall?: string
  path?: string
  message?: string
}

export interface ProtocolFlags {
  /** Consecutive unparseable stdout lines (≥ 3 → stream_malformed). */
  malformedLines?: number
  /** The process ended without a terminal event (`done` / fatal `error`). */
  noTerminal?: boolean
  /** A terminal frame carried no result. */
  emptyResult?: boolean
  /** A known frame failed schema validation (message). */
  schemaError?: string
  /** A JSON-RPC response arrived for an id Harpoon never sent. */
  unknownRpcId?: boolean
}

export interface ClassifyInput {
  vendor: string
  step?: StepKey
  /** `raw`: evidence for the kill (e.g. a summary of the vendor's last frame); redacted and capped like any raw. */
  harpoonInitiated?: { kind: HarpoonKill; raw?: string }
  /**
   * A failure Harpoon itself detected (signals/harpoon.ts). `detail` is the message (default: the check's
   * own); errno, exitCode and the tails are the failed command's evidence (ENOSPC → disk_full, 127 → deps_missing).
   */
  harpoonDetected?: { check: HarpoonCheck; detail?: string; raw?: string }
  errno?: string | ErrnoLike
  /** Vendor frames (parsed objects or raw JSON lines), oldest first. */
  structured?: readonly unknown[]
  exitCode?: number | null
  signal?: string | null
  /** Last stderr lines. */
  stderrTail?: string | readonly string[]
  /** Last non-content stdout lines (non-JSON lines, status frames). */
  stdoutTail?: string | readonly string[]
  rpcError?: RpcErrorLike
  ranMs?: number
  protocol?: ProtocolFlags
  /** The target is a loopback local-model server (ECONNREFUSED → local_server). */
  loopback?: boolean
  /** The mode the pass asked for (Codex reporting `sandbox: read-only` under autoedit → sandbox_unavailable). */
  mode?: Mode
  /** The caller knows the attempt failed: never returns null (except a quit), `unknown` at worst. */
  failed?: boolean
  now?: number
  /** Redaction for `raw` (default: diagnostics mode). */
  redact?: RedactOptions
}

export interface Classification {
  failure: Failure
  /** Matching rule id, e.g. `claude.regex.not-logged-in` (heal cache key, tests). */
  rule: string
  /** Recovery conditions surfaced by the rule (e.g. `claude-env-key`). */
  hints: string[]
}

const RAW_MAX = 4000

const TABLES = new Map<string, SignalTable>(
  [CLAUDE_SIGNALS, CODEX_SIGNALS, GEMINI_SIGNALS].map((t) => [t.vendor, t]),
)

/** Plug in a vendor table (codex, acp-gemini, …). Replaces an existing one for the same vendor. */
export function registerSignalTable(table: SignalTable): void {
  TABLES.set(table.vendor, table)
}

/** `local-<preset>` vendors run on the Codex adapter and share its table. */
export function signalTableFor(vendor: string): SignalTable | undefined {
  return TABLES.get(localPresetIdOf(vendor) !== null ? 'codex' : vendor)
}

const HARPOON: Record<Exclude<HarpoonKill, 'quit'>, { category: FailureCategory; message: string }> = {
  stop: { category: 'user_cancelled', message: 'Stopped by you.' },
  stall: { category: 'timeout_stall', message: 'No output for a while.' },
  hard: { category: 'timeout_hard', message: 'No output for too long; Harpoon stopped the pass.' },
  ask: { category: 'ask_timeout', message: 'A question went unanswered; Harpoon paused the pass.' },
  deny: { category: 'permission_denied', message: 'You denied a request; Harpoon paused the pass.' },
  handshake: { category: 'flag_drift', message: 'The CLI did not answer the startup handshake.' },
}

const joinTail = (t: string | readonly string[] | undefined): string =>
  t === undefined ? '' : typeof t === 'string' ? t : t.join('\n')

function tail(s: string, max = RAW_MAX): string {
  return s.length > max ? s.slice(s.length - max) : s
}

/** Redact line by line (JSON lines key-aware: uuid, account and secret-named keys), then keep the last RAW_MAX. */
export function redactRaw(raw: string, redact: RedactOptions = { mode: 'diagnostics' }): string {
  return tail(
    raw
      .split('\n')
      .map((l) => redactLine(l, redact).text)
      .join('\n'),
  )
}

/**
 * Classify one failed attempt. Returns null when there is nothing to classify: a quit/relaunch (the engine
 * pauses with `interrupted-by-quit`, not a failure), or no failure evidence at all (clean exit, no error
 * frames, only vendor retries) unless `failed` is set.
 */
export function classifyDetailed(input: ClassifyInput): Classification | null {
  const now = input.now ?? Date.now()
  const vendor = input.vendor
  const table = signalTableFor(vendor)
  const ctx: SignalContext = {
    vendor,
    exitCode: input.exitCode,
    signal: input.signal,
    ranMs: input.ranMs,
    now,
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.loopback === true ? { loopback: true } : {}),
  }
  const stderr = joinTail(input.stderrTail)
  const stdout = joinTail(input.stdoutTail)
  const redact = input.redact ?? { mode: 'diagnostics' }
  const fallbackRaw = [stderr, stdout].filter((s) => s.trim() !== '').join('\n')

  const build = (m: SignalMatch, by: ClassifiedBy): Classification => {
    const raw = redactRaw(m.raw ?? fallbackRaw, redact)
    const message = redactText(m.message, redact).text
    const failure: Failure = { category: m.category, message, raw, classifiedBy: by }
    if (input.step !== undefined) failure.step = input.step
    if (m.resetsAt !== undefined) failure.resetsAt = m.resetsAt
    if (m.retryAfterMs !== undefined) failure.retryAfterMs = m.retryAfterMs
    return { failure, rule: m.rule, hints: m.hints ?? [] }
  }

  // 1. Harpoon-initiated (a kill it made), then Harpoon-detected (a check it ran).
  const kill = input.harpoonInitiated?.kind
  if (kill === 'quit') return null
  if (kill !== undefined) {
    const c = HARPOON[kill]
    const raw = input.harpoonInitiated?.raw
    return build(
      {
        category: c.category,
        rule: `harpoon.${kill}`,
        message: c.message,
        ...(raw !== undefined ? { raw } : {}),
      },
      'harpoon',
    )
  }
  const detected = input.harpoonDetected
  if (detected !== undefined) {
    const errno =
      input.errno === undefined ? undefined : typeof input.errno === 'string' ? input.errno : input.errno.code
    const { match, by } = harpoonMatch(detected.check, detected.detail, {
      ...(errno !== undefined ? { errno } : {}),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      text: fallbackRaw,
    })
    return build(detected.raw !== undefined ? { ...match, raw: detected.raw } : match, by)
  }

  // 2. Spawn errno.
  if (input.errno !== undefined) {
    const e = typeof input.errno === 'string' ? { code: input.errno } : input.errno
    const category = errnoCategory(e.code, { vendor, ...(input.loopback ? { loopback: true } : {}) })
    if (category) {
      const where = e.path ? ` (${e.path})` : ''
      return build(
        {
          category,
          rule: `errno.${e.code.toUpperCase()}`,
          message: e.message ?? `Could not start ${vendor}: ${e.code}${where}`,
        },
        'errno',
      )
    }
  }

  const isRetry = (f: unknown): boolean =>
    table?.isRetry?.(f) === true || GENERIC_SIGNALS.isRetry?.(f) === true
  const all = input.structured ?? []
  const frames = all.filter((f) => !isRetry(f))
  const retryFrames = all.filter(isRetry)

  const exitFailed =
    (input.exitCode !== undefined && input.exitCode !== null && input.exitCode !== 0) ||
    (input.signal !== undefined && input.signal !== null)
  const p = input.protocol ?? {}
  const protocolBad =
    (p.malformedLines ?? 0) >= 3 ||
    p.noTerminal === true ||
    p.emptyResult === true ||
    p.schemaError !== undefined ||
    p.unknownRpcId === true
  const failureFrames = table?.hasFailure?.(frames) === true
  const evidence =
    input.failed === true ||
    exitFailed ||
    protocolBad ||
    input.rpcError !== undefined ||
    input.errno !== undefined ||
    failureFrames
  if (!evidence) return null

  // 3. Structured: protocol violations, JSON-RPC errors, vendor fields.
  if (
    (p.malformedLines ?? 0) >= 3 ||
    p.schemaError !== undefined ||
    p.unknownRpcId === true ||
    p.emptyResult
  ) {
    const message =
      p.schemaError !== undefined
        ? `Unexpected frame shape: ${p.schemaError}`
        : p.unknownRpcId
          ? 'Response for an unknown request id'
          : p.emptyResult
            ? 'The CLI returned an empty result'
            : `${p.malformedLines} unreadable lines in a row`
    return build({ category: 'stream_malformed', rule: 'protocol.malformed', message }, 'structured')
  }
  if (input.rpcError) {
    const m = table?.rpc?.(input.rpcError, ctx) ?? rpcErrorMatch(input.rpcError)
    if (m) return build(m, 'structured')
  }
  const s = table?.structured?.(frames, ctx)
  if (s) return build(s, 'structured')

  // 4. Exit-code table.
  if (p.noTerminal && input.exitCode === 0) {
    return build(
      {
        category: 'stream_malformed',
        rule: 'exit.zero-without-result',
        message: `${vendor} exited without a result`,
      },
      'exit',
    )
  }
  if (exitFailed) {
    for (const rule of [...(table?.exit ?? []), ...(GENERIC_SIGNALS.exit ?? [])]) {
      const codeHit = input.exitCode != null && rule.codes?.includes(input.exitCode) === true
      const sigHit = input.signal != null && rule.signals?.includes(input.signal) === true
      if (codeHit || sigHit) {
        const how = sigHit ? `was terminated by ${input.signal}` : `exited with code ${input.exitCode}`
        return build({ category: rule.category, rule: rule.id, message: `${vendor} ${how}` }, 'exit')
      }
    }
  }

  // 5. Regex over structured texts, the RPC message, stderr and stdout.
  const texts = [...(table?.texts?.(frames) ?? []), input.rpcError?.message ?? '', stderr, stdout].filter(
    (t) => t.trim() !== '',
  )
  for (const rule of [...(table?.regex ?? []), ...(GENERIC_SIGNALS.regex ?? [])]) {
    if (rule.when !== undefined && !rule.when(ctx)) continue
    for (const t of texts) {
      const line = matchedLine(t, rule.re)
      if (line !== undefined) {
        return build(
          {
            category: rule.category,
            rule: rule.id,
            message: line,
            raw: t,
            ...(rule.hints ? { hints: [...rule.hints] } : {}),
            ...rule.detail?.(t, ctx),
          },
          'regex',
        )
      }
    }
  }

  // Supporting evidence: what the vendor was retrying when the attempt failed.
  const hint = table?.retryHint?.(retryFrames, ctx) ?? GENERIC_SIGNALS.retryHint?.(retryFrames, ctx)
  if (hint) return build(hint, 'structured')

  // Non-zero exit and nothing at all to read: a crash (process_crash).
  if (exitFailed && texts.length === 0 && !failureFrames && input.rpcError === undefined) {
    const how = input.signal ? `was terminated by ${input.signal}` : `exited with code ${input.exitCode}`
    return build(
      { category: 'process_crash', rule: 'exit.silent-nonzero', message: `${vendor} ${how} without output` },
      'exit',
    )
  }

  // 6. Heuristics.
  const h = heuristicMatch([stderr, stdout].filter((t) => t.trim() !== ''))
  if (h) return build(h, 'heuristic')

  // 7. Unknown.
  const first = texts[0]?.trim().split('\n')[0] ?? ''
  const message =
    first !== ''
      ? first.slice(0, 300)
      : exitFailed
        ? `${vendor} ${input.signal ? `was terminated by ${input.signal}` : `exited with code ${input.exitCode}`}`
        : `${vendor} failed`
  return build({ category: 'unknown', rule: 'unknown', message, raw: texts.join('\n') }, 'heuristic')
}

/** {@link classifyDetailed} without the rule id. */
export function classify(input: ClassifyInput): Failure | null {
  return classifyDetailed(input)?.failure ?? null
}
