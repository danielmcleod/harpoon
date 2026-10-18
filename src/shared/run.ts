// Run-level contracts: primitives, statuses, phases, core-derived views and persisted event bodies.
// The renderer only formats these; core derives them.
import type { AllowRule, AskDecision, AskKind, AutoAnswerReason, NormalizedEvent, Usage } from './events.ts'
import type { CostBasis, Percentiles } from './estimates.ts'
import type { Failure, FailureCategory, HealView, RecoveryAction } from './failure.ts'
import type { Finding } from './findings.ts'
import type { Support } from './vendors.ts'

// ---- primitives ----------------------------------------------------------

export const PASS_NAMES = ['plan', 'implement', 'review', 'critic', 'fix'] as const
export type PassName = (typeof PASS_NAMES)[number]

/** Passes that may change files ("mutating"). */
export const MUTATING_PASSES = ['implement', 'fix'] as const satisfies readonly PassName[]
/** Passes that must always run read-only (a semantic config rule). */
export const READONLY_PASSES = ['plan', 'review', 'critic'] as const satisfies readonly PassName[]

export const MODES = ['readonly', 'autoedit', 'full'] as const
export type Mode = (typeof MODES)[number]

/** Execution order. `:` in a key must go through `fileSafe()` before it reaches a path. */
export const STEP_KEYS = [
  'preflight',
  'prepare',
  'verify:0',
  'plan',
  'implement',
  'verify:1',
  'review',
  'critic',
  'fix',
  'verify:2',
  'finalize',
] as const
export type StepKey = (typeof STEP_KEYS)[number]

/** Steps run by Harpoon itself (no vendor CLI). They never become `stalled`. */
export const RUNNER_STEPS = [
  'preflight',
  'prepare',
  'verify:0',
  'verify:1',
  'verify:2',
  'finalize',
] as const satisfies readonly StepKey[]
export type RunnerStep = (typeof RUNNER_STEPS)[number]
export type VerifyStep = Extract<StepKey, `verify:${number}`>

export const PASS_STATUSES = [
  'queued',
  'running',
  'waiting',
  'stalled',
  'paused',
  'done',
  'skipped',
  'failed',
  'cancelled',
] as const
export type PassStatus = (typeof PASS_STATUSES)[number]
export const TERMINAL_PASS_STATUSES = [
  'done',
  'skipped',
  'cancelled',
] as const satisfies readonly PassStatus[]

export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
/** Statuses that hold the folder lock (except while step `preflight` is failed). */
export const LOCK_HOLDING_RUN_STATUSES = [
  'running',
  'waiting',
  'paused',
  'failed',
] as const satisfies readonly RunStatus[]

export const RUN_PHASES = [
  'queued',
  'preflight',
  'preparing',
  'planning',
  'plan-review',
  'implementing',
  'verifying',
  'reviewing',
  'findings-review',
  'fixing',
  'final-verify',
  'ready-to-apply',
  'needs-attention',
  'stopping',
  'done',
] as const
export type RunPhase = (typeof RUN_PHASES)[number]

/** `verify-failed` renders as "Completed with failures". */
export const RUN_OUTCOMES = [
  'fixed',
  'clean',
  'no-changes',
  'findings-open',
  'verify-failed',
  'failed',
] as const
export type RunOutcome = (typeof RUN_OUTCOMES)[number]

export const PAUSE_REASONS = ['ask-timeout', 'denied', 'interrupted', 'interrupted-by-quit'] as const
export type PauseReason = (typeof PAUSE_REASONS)[number]

export const FRESH_REASONS = [
  'vendor-differs',
  'no-session',
  'cannot-resume',
  'cwd-changed',
  'model-differs',
  'override-fresh',
  'override-other-vendor',
  'resume-failed',
  'implement-skipped',
] as const
export type FreshReason = (typeof FRESH_REASONS)[number]

/**
 * What a fresh start's FreshReason alone does not say, for the session line's "Why?" (core sets it; the
 * renderer only words it). Absent: the reason's usual case.
 *  - `vendor-cannot-resume` (with cannot-resume): the vendor cannot continue any session (its capabilities say
 *    resume 'none'), rather than canResume finding the session gone.
 *  - `new-attempt` (with resume-failed): this fresh start began a new attempt (the retry budget, or Retry), rather
 *    than being the free fallback that keeps the attempt.
 */
export const FRESH_DETAILS = ['vendor-cannot-resume', 'new-attempt'] as const
export type FreshDetail = (typeof FRESH_DETAILS)[number]

/** The FreshReason each FreshDetail goes with. */
export const FRESH_DETAIL_REASON: Readonly<Record<FreshDetail, FreshReason>> = {
  'vendor-cannot-resume': 'cannot-resume',
  'new-attempt': 'resume-failed',
}

export const PLAN_MODES = ['native', 'emulated'] as const
export type PlanMode = (typeof PLAN_MODES)[number]

export const ISOLATION_MODES = ['inPlace', 'worktree'] as const
export type IsolationMode = (typeof ISOLATION_MODES)[number]

export function isPassName(v: unknown): v is PassName {
  return typeof v === 'string' && (PASS_NAMES as readonly string[]).includes(v)
}

export function isStepKey(v: unknown): v is StepKey {
  return typeof v === 'string' && (STEP_KEYS as readonly string[]).includes(v)
}

// ---- cards -----------------------------------------------------------------

export const GATE_KINDS = ['gate:afterPlan', 'gate:beforeFix'] as const
export type GateKind = (typeof GATE_KINDS)[number]

export const CARD_KINDS = [
  ...GATE_KINDS,
  'insufficientContext',
  'planMutated',
  'preflight',
  'reconcile',
  'trust',
  'depsConsent',
  'depsFailed',
  'verifyEnv',
  'emptyFindings',
  'retryPartial',
  'finalize',
  'finalizeConflicts',
  'interruptedApply',
  'stall',
] as const
export type CardKind = (typeof CARD_KINDS)[number]

/**
 * What a choice takes with `cards.resolve`: text (`plan`, `task`, `command`) or a list (`findings`: finding ids;
 * `paths`: the files a finalizeConflicts choice applies to, every conflicting file when absent).
 */
export type CardChoiceInput = 'plan' | 'task' | 'findings' | 'command' | 'paths'

export interface CardChoice {
  id: string
  label: string
  primary?: boolean
  danger?: boolean
  input?: CardChoiceInput
}

/**
 * Value sent with `cards.resolve` for a choice with `input`: text for plan/task/command, finding ids for findings,
 * relative file paths for paths.
 */
export type CardChoiceValue = string | string[]

/**
 * One protocol for gates and runner prompts; core builds the choices. In Auto mode a card with a
 * `defaultChoice` is taken automatically and logged; blocking cards without a default always wait.
 */
export interface CardView {
  id: string
  kind: CardKind
  title: string
  body: string
  payload: unknown
  blocking: boolean
  defaultChoice?: string
  choices: CardChoice[]
}

// ---- views -----------------------------------------------------------------

export type AnswerVia = 'app' | 'notification' | 'cli'

export interface AskView {
  runId: string
  step: StepKey
  attempt: number
  requestId: string
  vendor: string
  kind: AskKind
  detail: string
  reason?: string
  expiresAt: number
  allowSession: boolean
  defaultToNo?: boolean
  /** Position in the step's FIFO ask queue (1-based index). */
  queue: { index: number; total: number }
  /** Set while a Deny sits in its undo grace; the vendor has not been answered yet. */
  pendingDenyUntil?: number
}

export interface StepCost {
  usd: number | null
  basis: CostBasis
  apiEquivalent: boolean
  /**
   * `catalog` basis only: the prices the figure was priced at (the run's pricingRef), as of the pass's end:
   * when they were fetched, their confidence, and whether they were older than 2× the refresh interval then. The cost
   * labels read these instead of today's catalog.
   */
  pricing?: StepCostPricing
}

export interface StepCostPricing {
  fetchedAt: number
  confidence: 'verified' | 'unverified' | 'user'
  stale: boolean
}

/**
 * "AUTO approved N": asks the adapter answered itself (`auto-answered` bodies: allow-cache hits,
 * read-only and unsupported denials), over every attempt. The plan capture's deny is not counted.
 */
export interface AutoAnsweredCounts {
  approved: number
  denied: number
}

export interface StepView {
  key: StepKey
  status: PassStatus
  reason?: string
  pause?: PauseReason
  attempt: number
  startedAt?: number
  endedAt?: number
  /** The current attempt's running + stalled time (waits on the user excluded). */
  activeMs: number
  eta?: Percentiles
  vendor?: string
  model?: string | null
  /**
   * Live balanced run: the model a pass that names none ran, as its vendor said when it started (Codex's app-server:
   * the model its thread answered with for the folder, or the account's default Harpoon ran in its place). Absent
   * when the pass names a model, or the vendor did not say (Codex's exec route, a thread answer without a model,
   * Claude, Gemini). With modelOverrideIgnored, the model the vendor ran in place of the default Harpoon sent.
   */
  modelUsed?: string
  /**
   * Live balanced run: with modelUsed, the model the vendor's own settings named for this pass, which the account
   * is not offered, so Harpoon ran modelUsed (the account's default) instead. Absent when it ran what they named.
   */
  modelReplaced?: string
  /**
   * Model wording: with modelReplaced (and no modelUsed), the account's default Harpoon asked the
   * vendor to run on turn/start in place of modelReplaced, which the vendor has not confirmed running (yet: Codex says
   * so with a thread/settings/updated naming it or the turn's first usage total, and modelUsed then names it). Absent
   * once confirmed, and when nothing was asked for.
   */
  modelAsked?: string
  /**
   * With modelUsed, the model the vendor moved this pass's turn away from (Codex's `model/rerouted`, for a
   * request it flags): modelUsed ran in its place. Absent otherwise.
   */
  modelRerouted?: string
  /**
   * Live balanced run: the account's default Harpoon sent (on turn/start) in place of the model the vendor's
   * settings named, which the vendor did not run: the pass failed `model_unavailable` naming that model (modelUsed
   * here), not the default (shared/vendors.ts modelOverrideIgnored). Absent otherwise.
   */
  modelOverrideIgnored?: string
  /**
   * Live balanced run: for a pass that names no model, the model core expects it to run (the one its estimate is
   * priced at: the vendor probe's default for the account, frozen when the run first needs it), while the pass is
   * queued, and once it runs until its vendor says which model it runs (only on a route that says so before its turn,
   * shared/vendors.ts MODEL_REPORT_ROUTES). Absent when the pass names a model, runs a local preset, has started where
   * its vendor never says (Codex exec, Gemini), has ended, or none is known: its card then reads "default model"
   * unless modelUsed names what ran.
   */
  expectedModel?: string
  mode?: Mode
  modeCopy?: Support
  planMode?: PlanMode
  planFallbackReason?: string
  sessionNote?: string
  /** With a "fresh session: …" note, the fact behind it its FreshReason does not carry. */
  freshDetail?: FreshDetail
  route?: string
  usage?: Usage
  /** The token figures are approximate (resumed without a known base, or a vendor counter went backwards). */
  usageApprox?: boolean
  cost?: StepCost
  failure?: Failure
  /** The step's auto-answered asks; absent while there are none. */
  autoAnswered?: AutoAnsweredCounts
  /**
   * A short fact core states about how the step started, shown beside it (Implement: "3 files changed during
   * planning", from reconciliation). Absent when there is none.
   */
  chip?: string
  /**
   * What the step's launch waits on before it spawns, where that wait can be long. `run-start`: Plan waits for
   * the run-start snapshot (R2), about a second normally but up to minutes for the cold first snapshot of
   * a large folder (bounded by the snapshot timeout). Absent otherwise, and once the step has spawned.
   */
  launchWait?: 'run-start'
  /** The failed step's AI diagnosis (running or done); absent when none was asked for. */
  heal?: HealView
  /** The `wait_until` retry of a failed step (countdown while armed); absent without one. */
  wait?: WaitView
  /**
   * The Verify step: verify:1 / verify:2 only, once the round has its commands. The round's output
   * streams through `output` bodies for the file `verify:<n>` (runs.output).
   */
  verify?: VerifyStepView
  /**
   * UI standard, nothing moves on its own: verify:1 / verify:2 while queued and not yet begun, when the run's
   * config runs that round (verify on, `runAfter` ∋ its pass). The timeline shows such a node from the start instead
   * of inserting it mid-row when the round begins. Absent otherwise. Also verify:0 (the baseline) and finalize of
   * an isolated run, from its start.
   */
  planned?: true
  /** Isolated run: the `prepare` step of an isolated run, its rows from the start. */
  prepare?: PrepareView
  /** Finalize (R12): the `finalize` step of an isolated run once it began. */
  finalize?: FinalizeView
}

// ---- isolated runs (R2/R5/R12) ---------------------------------------------------------------------------------

/** The PrepareCard's rows, in order (Prepare steps 1 to 5). */
export const PREPARE_STEP_IDS = ['worktree', 'copy', 'deps', 'baseline', 'ready'] as const
export type PrepareStepId = (typeof PREPARE_STEP_IDS)[number]

/** One prepare row (core-derived). `skipped` rows say why in `detail`. */
export interface PrepareStepView {
  id: PrepareStepId
  status: PassStatus
  /** One line of UI copy: what the row did or why it waits, was skipped or failed. */
  detail?: string
}

/** The install the deps row runs (depsConsent / depsFailed show it too). */
export interface DepsCommandView {
  /** The package manager (pnpm, npm, uv, …; `custom` for a configured command). */
  manager: string
  argv: string[]
  /** Relative to the worktree's root, `/` separators (`.` for the root). */
  cwdRel: string
  lockfile?: string
  /** `detected` (the lockfile table), `config` (`isolation.worktree.installCommand`) or `edited` ([Edit command]). */
  source: 'detected' | 'config' | 'edited'
}

/** StepView.prepare. The install's output streams through `output` bodies for the file `prepare` (runs.output). */
export interface PrepareView {
  steps: PrepareStepView[]
  /** The worktree once made: `<home>/worktrees/<runId>` on its own branch from HEAD (`base`). */
  worktree?: { path: string; branch: string; base: string }
  /** Uncommitted changes in the folder the worktree does not include (it starts from HEAD). */
  uncommitted?: number
  deps?: DepsCommandView
}

/**
 * StepView.finalize `state`: `preview` (reading what Apply would do) · `pending` (the finalize card waits for a choice)
 * · `waiting` (Apply waits for the folder: another run holds it) · `applying` · `conflicts` (finalizeConflicts open) ·
 * `interrupted` (Harpoon closed while applying: interruptedApply open) · `applied` · `kept` (Keep for later, or the run
 * stopped with its worktree) · `undoing` (Undo of an apply) · `discarding` (deferred deletion; undoable until
 * `deleteAt`) · `discarded`.
 */
export const FINALIZE_STATES = [
  'preview',
  'pending',
  'waiting',
  'applying',
  'conflicts',
  'interrupted',
  'applied',
  'kept',
  'undoing',
  'discarding',
  'discarded',
] as const
export type FinalizeState = (typeof FINALIZE_STATES)[number]

/** StepView.finalize (core-derived; the finalize, finalizeConflicts and interruptedApply cards read it too). */
export interface FinalizeView {
  state: FinalizeState
  /** Files the run changed in its worktree (the preview's writes and deletes, conflicts included). */
  files?: number
  /** Files whose folder content no longer equals the run's base (Keep mine / Take run's). */
  conflicts?: string[]
  /** Files the last apply wrote or deleted. */
  applied?: number
  /** worktree.undoApply's token for the last apply, while it can be undone. */
  undoToken?: string
  /** `discarding`: when the worktree is deleted, and worktree.undoDiscard's token. */
  deleteAt?: number
  discardToken?: string
  /** UI copy: why the last apply, undo or deletion did not finish. */
  error?: string
}

/**
 * An isolated run's worktree on the Dashboard and in history. `notApplied` drives the chip "Isolated: not applied"
 * (an unfinalized worktree is never deleted automatically): the worktree exists and the run's changes are not
 * in the folder (the finalize card waits, Keep for later, a stopped run, an apply undone). Never while an apply
 * Harpoon's close interrupted waits for [Finish apply] (`state: 'interrupted'`): part of the changes may be in the
 * folder, and the chip reads "Isolated: apply interrupted" instead.
 */
export interface RunWorktreeSummary {
  state: FinalizeState | 'preparing' | 'working'
  notApplied: boolean
}

/**
 * A verify command's state in a round. `queued` / `running` while the round runs (core's live view); then the
 * round's result: `pass`, `fail` (a `[must]` finding), `env` (the environment could not run it: never a finding),
 * `skipped-untrusted` (Auto skipped it because it is not trusted: a `[should]` finding) or `skipped` (the user
 * skipped it, failFast stopped the round, or it cannot run as configured; `reason` says which).
 */
export const VERIFY_COMMAND_STATUSES = [
  'queued',
  'running',
  'pass',
  'fail',
  'env',
  'skipped-untrusted',
  'skipped',
] as const
export type VerifyCommandStatus = (typeof VERIFY_COMMAND_STATUSES)[number]

/** One command of a verify round (StepView.verify). */
export interface VerifyCommandView {
  name: string
  argv: string[]
  status: VerifyCommandStatus
  /** Exit code of a finished command (null: killed or never started). */
  exitCode?: number | null
  durationMs?: number
  /** The output excerpt (last lines plus error lines, at most 4 KB) of a failed or env command. */
  excerpt?: string
  /** Why it was skipped or could not run, as UI copy. */
  reason?: string
}

/** StepView.verify (core-derived; the renderer only formats it). */
export interface VerifyStepView {
  commands: VerifyCommandView[]
  /** failFast stopped the round after a failure; the remaining commands read `skipped`. */
  aborted?: boolean
}

/**
 * `wait_until` (rate_limited / quota_exceeded): the retry a failed step waits for.
 * While `armed`, core retries the pass at `until` (its clock); executing the action (`actionId`) arms or disarms it.
 * An armed wait loads disarmed after Harpoon restarts (crash relaunch), offering Retry now and Re-arm.
 */
export interface WaitView {
  actionId: string
  until: number
  armed: boolean
  /**
   * Why it is not armed: `user` disarmed it, `relaunch` = Harpoon restarted, `offered` = Harpoon does not arm it on
   * its own here (a usage limit, or the pass's automatic retry is spent).
   */
  disarmed?: 'user' | 'relaunch' | 'offered'
}

/** Prompt/diff size bucket used by estimates: <10 KB, <50 KB, <150 KB, ≥150 KB. */
export type InputBytesBucket = 0 | 1 | 2 | 3

/** Final attempt only. Feeds estimates and the Dashboard via runs/index.jsonl. */
export interface RunSummaryStep {
  key: StepKey
  vendor?: string
  model?: string | null
  mode?: Mode
  planMode?: PlanMode
  status: PassStatus
  activeMs: number
  usage?: Usage
  /** See StepView.usageApprox; the cost basis is then `none`. */
  usageApprox?: boolean
  costBasis?: CostBasis
  inBytesBucket?: InputBytesBucket
  failureCategory?: FailureCategory
}

export interface RunProgress {
  tokens: number
  costUsd: number | null
  filesChanged: number
  /** Remaining active time (live ETA), as of when core built the summary. */
  etaMs?: number
  /** 'longer-than-usual' once a live step is past its p80 (then no etaMs); absent without an estimate. */
  etaState?: 'ok' | 'longer-than-usual'
  /** While the remaining time runs down with the clock, when the run is expected to end (format it − now). */
  etaEndsAt?: number
}

export interface FindingCounts {
  must: number
  should: number
}

export interface RunSummary {
  runId: string
  /** Monotonic per home; shown as "#N". */
  displayNo: number
  folder: string
  folderKey: string
  /** First 80 characters of the task. */
  title: string
  status: RunStatus
  phase: RunPhase
  outcome?: RunOutcome
  failure?: { step: StepKey; category: FailureCategory }
  profile: string
  auto: boolean
  isolation: IsolationMode
  pinned: boolean
  createdAt: number
  endedAt?: number
  /** runId of the run holding the folder lock this run queues behind. */
  blockedBy?: string
  /**
   * The run's folder lock (the scheduler's): `held` = it owns its folder, `requested` = it queues for it;
   * absent once released. Core republishes the summary when the lock is released, so a reader that asks core about
   * the folder (the composer's folder.lock) knows when to ask again.
   */
  lock?: 'held' | 'requested'
  /** An isolated run's worktree (the Dashboard chip "Isolated: not applied"); absent for in-place runs. */
  worktree?: RunWorktreeSummary
  /** The run this one re-runs ("Re-run of #N", "Re-run from Fix of #N"); absent for a run started anew. */
  rerunOf?: RerunSource
  /**
   * What Re-run from Fix of this run would do (the Runs history row's action and tooltip), as
   * RunSnapshot.rerunFromFix says it. Absent in a summary an earlier build wrote.
   */
  rerunFromFix?: RerunFromFix
  progress: RunProgress
  findings: FindingCounts
  steps: RunSummaryStep[]
}

/**
 * Branch prep: the run branch Harpoon made at the pre-Implement boundary. `base` is the commit it
 * started at; `previous` is the branch HEAD named before (`refs/heads/<name>`) or `detached:<sha>`.
 */
export interface RunBranchInfo {
  name: string
  base: string
  previous: string
}

/**
 * The latest revert core made for a card choice (Revert Plan's changes, Restore run's version, Revert partial
 * then fresh) that `diff.undoRevert{runId, undoToken}` can still undo. A revert the user asked for through
 * `diff.revert` is not listed: its RevertResult carries its own token.
 */
export interface RevertUndoView {
  undoToken: string
  /**
   * What was reverted, as UI copy that reads after "Reverted": "Plan's changes", "Implement's partial changes", "your
   * edits outside the run" (Restore run's version puts the run's version back over them).
   */
  label: string
  /** Files restored or deleted. */
  files: number
  at: number
}

export interface RerunFromFix {
  available: boolean
  fresh: boolean
  reason?: FreshReason
  /** Why Re-run from Fix is not offered (UI copy, for the tooltip); absent while it is available. */
  unavailable?: string
  /**
   * The findings Fix gets when none are chosen (every must, plus the shoulds selected at the run's beforeFix gate),
   * in the run's list order; absent while Re-run from Fix is not available.
   */
  findingIds?: string[]
  /**
   * The findings Re-run from Fix offers (the picker's list), with the ids runs.rerun takes: the run's merged
   * list, or the done reviewers' findings when its Review/Critic join never ran (no findings.json then). In
   * RunSnapshot (runs.get) only, never in a RunSummary; absent while Re-run from Fix is not available.
   */
  findings?: Finding[]
}

/** The run a re-run started from (R14): Re-run (`start`) or Re-run from Fix (`fix`). */
export interface RerunSource {
  runId: string
  displayNo: number
  from: 'start' | 'fix'
}

export interface RunSnapshot {
  summary: RunSummary
  steps: Record<StepKey, StepView>
  asks: AskView[]
  cards: CardView[]
  allowRules: AllowRule[]
  notes: string[]
  branch?: RunBranchInfo
  /** The card revert that can still be undone (see RevertUndoView); absent when there is none. */
  revertUndo?: RevertUndoView
  /** Isolated-run finalize (the finalize step's FinalizeView, as StepView.finalize carries it). */
  finalize?: unknown
  rerunFromFix: RerunFromFix
  lastSeq: number
  /** The run's auto-answered asks, summed over its steps ("AUTO approved N"); absent while there are none. */
  autoAnswered?: AutoAnsweredCounts
}

// ---- persisted event bodies (events.jsonl) -----------------------------------

export type AskResolvedBy = 'user' | 'timeout' | 'vendor-cancel' | 'stop'

export const RUN_OUTPUT_FILES = [
  'plan',
  'plan.original',
  'review',
  'critic',
  'findings',
  'resolved',
  'verify',
  'heal',
  /** A verify round's combined output (runs.output), announced by `output` bodies while the round runs. */
  'verify:1',
  'verify:2',
  /** The baseline round (isolated runs) and the dependency install's output (the PrepareCard). */
  'verify:0',
  'prepare',
] as const
export type RunOutputFile = (typeof RUN_OUTPUT_FILES)[number]

export const RUN_EVENT_TYPES = [
  'ev',
  'step-status',
  'run-status',
  'card',
  'ask-resolved',
  'ask-extended',
  'auto-answered',
  'snag',
  'usage',
  'diff-stats',
  'output',
] as const

export type RunEventBody =
  | { t: 'ev'; step: StepKey; attempt: number; ev: NormalizedEvent }
  | {
      t: 'step-status'
      step: StepKey
      attempt: number
      status: PassStatus
      reason?: string
      pause?: PauseReason
      sessionNote?: string
      /** StepView.freshDetail (with a "fresh session: …" note). */
      freshDetail?: FreshDetail
      route?: string
      argv?: string[]
      planMode?: PlanMode
      planFallbackReason?: string
      /**
       * Live balanced run: StepView.modelUsed and StepView.modelReplaced; also StepView.modelAsked and
       * StepView.modelRerouted.
       */
      modelUsed?: string
      modelReplaced?: string
      modelAsked?: string
      modelRerouted?: string
    }
  | { t: 'run-status'; status: RunStatus; phase: RunPhase; outcome?: RunOutcome }
  | { t: 'card'; card: CardView; state: 'open' | 'resolved'; choiceId?: string }
  | {
      t: 'ask-resolved'
      step: StepKey
      requestId: string
      by: AskResolvedBy
      via?: AnswerVia
      decision?: AskDecision
    }
  | { t: 'ask-extended'; step: StepKey; requestId: string; expiresAt: number }
  | {
      t: 'auto-answered'
      step: StepKey
      attempt: number
      requestId?: string
      tool: string
      decision: AskDecision
      why: AutoAnswerReason
    }
  | { t: 'snag'; step: StepKey; failure: Failure; actions: RecoveryAction[] }
  | { t: 'usage'; step: StepKey; attempt: number; usage: Usage; costBasis: CostBasis }
  | { t: 'diff-stats'; files: number; added: number; deleted: number; live: boolean }
  | { t: 'output'; file: RunOutputFile; version: number }

export type RunEventType = RunEventBody['t']
export type RunEventOf<T extends RunEventType> = Extract<RunEventBody, { t: T }>

/** `seq` is per run, monotonic from 1 (the events.jsonl header is seq 0) and owned by the bus. */
export interface RunEnvelope {
  runId: string
  seq: number
  ts: number
  body: RunEventBody
}
