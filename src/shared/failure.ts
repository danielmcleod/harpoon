// Failure taxonomy and recovery actions. Values are snake_case and stable: they are persisted in events.jsonl and
// runs/index.jsonl.
import type { ConfigScope } from './config-schema.ts'
import type { PassName, StepKey } from './run.ts'

export const FAILURE_CATEGORIES = [
  'cli_missing',
  'cli_version',
  'flag_drift',
  'auth_required',
  'auth_expired',
  'rate_limited',
  'quota_exceeded',
  'billing',
  'model_unavailable',
  'network',
  'sandbox_unavailable',
  'trust_required',
  'capability_missing',
  'resume_failed',
  'stream_malformed',
  'config_invalid',
  'git_missing',
  'git_state',
  'folder_guard',
  'snapshot_failed',
  'worktree_failed',
  'deps_missing',
  'local_server',
  'verify_failed',
  'verify_untrusted',
  'timeout_stall',
  'timeout_hard',
  'ask_timeout',
  'permission_denied',
  'turn_limit',
  'context_exceeded',
  'content_policy',
  'vendor_internal',
  'process_crash',
  'disk_full',
  'user_cancelled',
  'unknown',
] as const
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number]

export function isFailureCategory(v: unknown): v is FailureCategory {
  return typeof v === 'string' && (FAILURE_CATEGORIES as readonly string[]).includes(v)
}

/** Classifier precedence, highest first. */
export const CLASSIFIED_BY = ['harpoon', 'errno', 'structured', 'exit', 'regex', 'heuristic'] as const
export type ClassifiedBy = (typeof CLASSIFIED_BY)[number]

export type Failure = {
  category: FailureCategory
  message: string
  raw: string
  step?: StepKey
  classifiedBy: ClassifiedBy
  resetsAt?: number
  retryAfterMs?: number
}

/** RFC 6902 subset used by `config_patch`, `config.patch` and `resolved.json.patches[]`. */
export type JsonPatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'test'; path: string; value: unknown }

export const JSON_PATCH_OPS = [
  'add',
  'replace',
  'remove',
  'test',
] as const satisfies readonly JsonPatchOp['op'][]

export const RETRY_STRATEGIES = ['auto', 'resume', 'fresh', 'revert-then-fresh', 'keep-changes'] as const
export type RetryStrategy = (typeof RETRY_STRATEGIES)[number]

export const GRANT_KINDS = ['vendorFolder', 'largeFolder', 'projectAuto', 'command'] as const
export type GrantKind = (typeof GRANT_KINDS)[number]

export type ShellKind = 'powershell' | 'sh'

/**
 * The command a `command` grant trusts (trust.json: hashed with its kind, argv, cwdRel and script body,
 * so a changed body needs a new grant).
 */
export interface GrantCommand {
  kind: 'verify' | 'deps'
  argv: string[]
  /** Relative to the scope root, `/` separators (`.` for the root). */
  cwdRel: string
  body?: string
}

/**
 * Every action carries an `id` and executes through `recovery.execute{actionId, runId?, folder?}`.
 * `shell_copy` is never executed (clipboard only); `vendor_setup` runs on click; `open_docs` is https + host allowlist.
 * `disabledReason`: the action is shown but cannot run now (e.g. `switch_vendor` while no other vendor is ready);
 * the UI renders it disabled with this text, and core refuses it with the same reason.
 */
export type RecoveryAction = { id: string; label: string; disabledReason?: string } & (
  | { kind: 'retry'; strategy?: RetryStrategy }
  | { kind: 'resume'; continuation: string }
  | {
      kind: 'config_patch'
      target: 'runOverrides' | 'resolved'
      ops: JsonPatchOp[]
      preview: string
      persist?: { scope: ConfigScope }
    }
  | { kind: 'settings_link'; route: string; pointer: string; suggested?: unknown }
  | {
      kind: 'shell_copy'
      command: string
      shell: ShellKind
      reason: string
      elevated?: boolean
      recheck: string
    }
  | {
      kind: 'vendor_setup'
      vendor: string
      call: 'windowsSandbox/setupStart'
      params: Record<string, unknown>
    }
  | { kind: 'switch_vendor'; pass: PassName | 'all'; to: string; model: string | null }
  /**
   * projectAuto: `projectSha` is the file version the check showed; the grant is refused once the file changed.
   * command: `command` is what the grant trusts.
   */
  | {
      kind: 'grant'
      grant: GrantKind
      vendor?: string
      projectSha?: string
      detail: string
      command?: GrantCommand
    }
  | { kind: 'wait_until'; until: number; armed: boolean }
  | { kind: 'skip_pass'; pass: PassName }
  | { kind: 'close_run' }
  | { kind: 'open_docs'; url: string }
  | { kind: 'heal' }
)

export type RecoveryActionKind = RecoveryAction['kind']
export type RecoveryActionOf<K extends RecoveryActionKind> = Extract<RecoveryAction, { kind: K }>

export const RECOVERY_ACTION_KINDS = [
  'retry',
  'resume',
  'config_patch',
  'settings_link',
  'shell_copy',
  'vendor_setup',
  'switch_vendor',
  'grant',
  'wait_until',
  'skip_pass',
  'close_run',
  'open_docs',
  'heal',
] as const satisfies readonly RecoveryActionKind[]

// ---- self-heal -------------------------------------------------------------------------------------------------

/** `running` while the healer works; then the healer's answer (`cached`: a 24 h cache hit). */
export const HEAL_STATUSES = ['running', 'ok', 'cached', 'failed', 'disabled'] as const
export type HealStatus = (typeof HEAL_STATUSES)[number]

export const HEAL_CONFIDENCES = ['high', 'medium', 'low'] as const
export type HealConfidence = (typeof HEAL_CONFIDENCES)[number]

/**
 * A failed step's AI diagnosis (StepView.heal; persisted with the run in run.json). Core announces every change
 * with an `output` body for `heal` (the renderer then reads the snapshot again). While the step's snag is open, the
 * `actions` execute through `recovery.execute{actionId, runId}` like the snag's own actions; the snag card lists them
 * after its own. `auto` = P17 ran it (unknown or heuristic failure, selfHeal.enabled); `user` = "Diagnose with AI".
 */
export interface HealView {
  status: HealStatus
  trigger: 'auto' | 'user'
  /** When this heal started (while `running`) or finished. */
  at: number
  /** One sentence (at most 300 characters). */
  diagnosis?: string
  confidence?: HealConfidence
  category?: FailureCategory
  /** Safe suggestions only (core checks them again). */
  actions: RecoveryAction[]
  /** Unsafe suggestions Harpoon dropped: shown as {@link hiddenSuggestionsText}. */
  hidden: number
  /** Why the healer failed (its raw error); the actions then hold the vendor's docs link. */
  error?: string
  /** `selfHeal.autoApplyConfigPatches` applied this action (its id) and retried the pass. */
  autoApplied?: string
}

/** "Harpoon hid N unsafe suggestions" (from parsing the heal answer); '' for none. */
export function hiddenSuggestionsText(n: number): string {
  if (n <= 0) return ''
  return `Harpoon hid ${n} unsafe suggestion${n === 1 ? '' : 's'}`
}
