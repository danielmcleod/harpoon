// What the Codex adapter reads off the wire. The shapes it sends are the generated
// protocol types (protocol/v0.160.0/, re-exported type-only by protocol.ts); every incoming frame is read
// defensively with the readers below: the generated shapes say what is expected, never what is trusted.
export type {
  ClientInfo,
  CollaborationMode,
  InitializeParams,
  SandboxMode,
  ThreadResumeParams,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
  WindowsSandboxReadiness,
  WindowsSandboxSetupMode,
} from './protocol.ts'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

/** Every CodexErrorInfo variant name (unit variants are strings, struct variants single-key objects). */
export const CODEX_ERROR_INFO_NAMES = [
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'usageLimitExceeded',
  'rateLimitExceeded',
  'flexUnavailable',
  'serverOverloaded',
  'cyberPolicy',
  'misalignmentPolicyViolation',
  'tooManyDenials',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'threadRollbackFailed',
  'sandboxError',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
  'activeTurnNotSteerable',
  'other',
] as const
export type CodexErrorInfoName = (typeof CODEX_ERROR_INFO_NAMES)[number]

// ---- defensive readers ----------------------------------------------------------------------------------------

export type Rec = Record<string, unknown>

export const rec = (v: unknown): Rec | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** The CodexErrorInfo variant name of `turn.error.codexErrorInfo` (a string or a single-key object). */
export function errorInfoName(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  const r = rec(v)
  return r !== undefined ? Object.keys(r)[0] : undefined
}
