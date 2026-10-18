// Harpoon-detected failures (classifier precedence 1; the failure rows whose detection is Harpoon's own:
// config, guard, grants, support(), resolve/probe, git state, snapshots, worktrees, deps, verify). The failed
// command's own output may name a more specific cause (ENOSPC → disk_full, 127/9009 → deps_missing).
import type { ClassifiedBy, FailureCategory } from '../../../shared/failure.ts'
import type { SignalMatch } from './generic.ts'
import { matchedLine } from './generic.ts'

export const HARPOON_CHECKS = [
  /** A Harpoon config schema, semantic or template error. */
  'config',
  /** The folder guard refused the folder (system, home or drive root). */
  'folder-guard',
  'folder-missing',
  /** The folder is over the snapshot size guard (grant largeFolder). */
  'folder-size',
  /** A trust.json grant the run needs is missing (projectAuto). */
  'grant-missing',
  /** `support()` says unsupported at a pass boundary. */
  'unsupported',
  /** resolve-cli found an npm placeholder stub instead of the CLI. */
  'cli-placeholder',
  /** The probe found a version below the floor. */
  'cli-below-floor',
  /** The session to resume has no transcript. */
  'transcript-missing',
  /** Codex `windowsSandbox/readiness` is not ready. */
  'sandbox-not-ready',
  /** An operation in progress (merge, rebase, cherry-pick, revert, bisect) or unmerged paths. */
  'git-op',
  /** Unborn HEAD: the repository has no commits. */
  'git-unborn',
  /** A shadow add / write-tree / commit-tree / update-ref failed. */
  'snapshot',
  /** The shadow refused a folder over the size guard. */
  'snapshot-size',
  /** `git worktree add` failed (branch exists, path too long, LFS smudge). */
  'worktree',
  /** Dependency install: the install tool is missing or it exited non-zero. */
  'install',
  /** A verify command exited non-zero. */
  'verify',
  /** The verify command's hash is not granted. */
  'verify-untrusted',
  /** The local model server does not have the model. */
  'local-model',
] as const
export type HarpoonCheck = (typeof HARPOON_CHECKS)[number]

interface CheckRow {
  category: FailureCategory
  /** Default message (UI text) when the caller gives no detail. */
  message: string
  hints?: string[]
}

export const HARPOON_CHECK_TABLE: Readonly<Record<HarpoonCheck, CheckRow>> = {
  config: { category: 'config_invalid', message: 'The Harpoon configuration is not valid.' },
  'folder-guard': { category: 'folder_guard', message: "Harpoon can't work in this folder." },
  'folder-missing': { category: 'folder_guard', message: 'The folder no longer exists.' },
  'folder-size': {
    category: 'folder_guard',
    message: 'The folder is larger than the snapshot size limit.',
    hints: ['size-guard'],
  },
  'grant-missing': {
    category: 'trust_required',
    message: "This project's Auto setting is not approved yet.",
  },
  unsupported: { category: 'capability_missing', message: 'The vendor does not support this pass here.' },
  'cli-placeholder': {
    category: 'cli_missing',
    message: 'The CLI found is an install placeholder, not the program.',
  },
  'cli-below-floor': {
    category: 'cli_version',
    message: 'The installed CLI is older than Harpoon supports.',
  },
  'transcript-missing': {
    category: 'resume_failed',
    message: 'The session to resume has no saved transcript.',
  },
  'sandbox-not-ready': { category: 'sandbox_unavailable', message: 'The vendor sandbox is not set up.' },
  'git-op': {
    category: 'git_state',
    message: 'A git operation is in progress in this repository.',
    hints: ['git-op'],
  },
  'git-unborn': { category: 'git_state', message: 'The repository has no commits yet.' },
  snapshot: { category: 'snapshot_failed', message: 'Harpoon could not snapshot the folder.' },
  'snapshot-size': {
    category: 'snapshot_failed',
    message: 'The folder is too large to snapshot.',
    hints: ['size-guard'],
  },
  worktree: { category: 'worktree_failed', message: 'Harpoon could not create the isolated worktree.' },
  install: { category: 'deps_missing', message: 'Installing dependencies failed.' },
  verify: { category: 'verify_failed', message: 'A verify command failed.' },
  'verify-untrusted': { category: 'verify_untrusted', message: 'The verify command is not trusted yet.' },
  'local-model': {
    category: 'local_server',
    message: 'The local model server does not have this model.',
  },
}

/** What the failed command left behind (all optional). */
export interface CommandEvidence {
  errno?: string
  exitCode?: number | null
  /** stderr and non-content stdout, joined. */
  text: string
}

const DISK_FULL_ERRNOS = new Set(['ENOSPC', 'EDQUOT'])
const DISK_FULL =
  /No space left on device|\bENOSPC\b|not enough space on the disk|There is not enough space|Disk quota exceeded/i
const DUBIOUS = /detected dubious ownership|unsafe repository/i
const LOCK =
  /index\.lock'?:? File exists|Unable to create '[^']*\.lock'|Another git process seems to be running/i
/** "Environment failures are never findings": the command or a module it needs is missing. */
const ENV_EXIT_CODES = new Set([126, 127, 9009])
const ENV_ERRNOS = new Set(['ENOENT', 'EACCES', 'EINVAL', 'ENOEXEC'])
const ENV_TEXT =
  /is not recognized as an internal or external command|: command not found|cannot execute binary file|Cannot find module|No module named|ModuleNotFoundError/i

const COMMAND_CHECKS: ReadonlySet<HarpoonCheck> = new Set([
  'snapshot',
  'snapshot-size',
  'worktree',
  'install',
  'verify',
])
const GIT_CHECKS: ReadonlySet<HarpoonCheck> = new Set(['snapshot', 'snapshot-size', 'worktree'])

const firstLine = (s: string): string => {
  const line = s.trim().split('\n')[0]?.trim() ?? ''
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

/**
 * One Harpoon-detected failure. For command checks the command's evidence is read first: disk full beats the
 * check (snapshot_failed "ENOSPC → disk_full"); git refusing the folder owner is git_state, as is a lock in the
 * user's repository (a shadow lock stays snapshot_failed, which retries); a verify command that could not run is
 * deps_missing, never a finding.
 */
export function harpoonMatch(
  check: HarpoonCheck,
  detail: string | undefined,
  ev: CommandEvidence,
): { match: SignalMatch; by: ClassifiedBy } {
  const row = HARPOON_CHECK_TABLE[check]
  const own = detail !== undefined && detail.trim() !== '' ? firstLine(detail) : row.message
  const errno = ev.errno?.toUpperCase()
  const text = ev.text

  if (COMMAND_CHECKS.has(check)) {
    if (errno !== undefined && DISK_FULL_ERRNOS.has(errno)) {
      return {
        match: { category: 'disk_full', rule: `harpoon.${check}.disk-full`, message: own },
        by: 'errno',
      }
    }
    const full = matchedLine(text, DISK_FULL)
    if (full !== undefined) {
      return {
        match: { category: 'disk_full', rule: `harpoon.${check}.disk-full`, message: full },
        by: 'regex',
      }
    }
  }
  if (GIT_CHECKS.has(check)) {
    const dubious = matchedLine(text, DUBIOUS)
    if (dubious !== undefined) {
      return {
        match: {
          category: 'git_state',
          rule: `harpoon.${check}.git-dubious`,
          message: dubious,
          hints: ['git-dubious'],
        },
        by: 'regex',
      }
    }
    const lock = check === 'worktree' ? matchedLine(text, LOCK) : undefined
    if (lock !== undefined) {
      return {
        match: {
          category: 'git_state',
          rule: `harpoon.${check}.git-lock`,
          message: lock,
          hints: ['git-lock'],
        },
        by: 'regex',
      }
    }
  }
  if (check === 'verify') {
    const code = ev.exitCode
    if (errno !== undefined && ENV_ERRNOS.has(errno)) {
      return { match: { category: 'deps_missing', rule: 'harpoon.verify.env', message: own }, by: 'errno' }
    }
    if (code !== undefined && code !== null && ENV_EXIT_CODES.has(code)) {
      return { match: { category: 'deps_missing', rule: 'harpoon.verify.env', message: own }, by: 'exit' }
    }
    const env = matchedLine(text, ENV_TEXT)
    if (env !== undefined) {
      return { match: { category: 'deps_missing', rule: 'harpoon.verify.env', message: env }, by: 'regex' }
    }
  }
  return {
    match: {
      category: row.category,
      rule: `harpoon.check.${check}`,
      message: own,
      ...(row.hints ? { hints: [...row.hints] } : {}),
    },
    by: 'harpoon',
  }
}
