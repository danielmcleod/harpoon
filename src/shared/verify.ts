// Verify step contracts (trust.json). Core discovers, trusts and runs the
// commands (src/core/verify); `verify.detect` answers VerifyCommand[] and the renderer only formats these.
import type { VerifyCommandStatus } from './run.ts'

/** Where a command came from (the discovery table; `config` = `verify.commands[]`). */
export const VERIFY_SOURCES = [
  'package.json',
  'Makefile',
  'pyproject',
  'cargo',
  'go',
  'dotnet',
  'maven',
  'gradle',
  'config',
] as const
export type VerifySource = (typeof VERIFY_SOURCES)[number]

/** What a command checks; discovered commands run in this order (typecheck → lint → test → build). */
export const VERIFY_KINDS = ['typecheck', 'lint', 'test', 'build', 'other'] as const
export type VerifyKind = (typeof VERIFY_KINDS)[number]

/** Each command's default timeout (then a tree kill). */
export const VERIFY_DEFAULT_TIMEOUT_MS = 600_000

/** A verify command as discovery (or the config) describes it. */
export interface DetectedCommand {
  /** Unique within a list (the log file and the baseline map are keyed by it). */
  name: string
  /**
   * argv; never a shell line (a configured string is tokenized quote-aware). Empty when the configured line could not
   * be read as argv (`error`).
   */
  run: string[]
  /** The working directory relative to the scope root, `/` separators (`.` for the root). */
  cwdRel: string
  source: VerifySource
  kind: VerifyKind
  enabledByDefault: boolean
  /**
   * The text the trust hash covers (what the program reads to decide what runs, whole): the package.json's
   * `scripts` map as JSON, every makefile make reads with the files they include, or null for a fixed tool command.
   */
  body: string | null
  /** A configured command's own timeout. */
  timeoutMs?: number
  /**
   * It cannot run as written (shell metacharacters, a cwd outside the project) or trust cannot cover what it runs
   * (another package's scripts, an include only make can name): UI copy.
   */
  error?: string
}

/**
 * How a command stands against trust.json: `trusted` (a grant's hash covers its argv, cwd and body), `untrusted`
 * (no grant for it), `changed` (a grant for the same argv and cwd exists, but for another body: show the diff),
 * `invalid` (it cannot run as configured; DetectedCommand.error says why).
 */
export const VERIFY_TRUST_STATES = ['trusted', 'untrusted', 'changed', 'invalid'] as const
export type VerifyTrustState = (typeof VERIFY_TRUST_STATES)[number]

/** A finished command's status (VerifyCommandStatus without the live `queued` / `running`). */
export type VerifyResultStatus = Exclude<VerifyCommandStatus, 'queued' | 'running'>

/** One command's result in a verify round (src/core/verify runVerifyRound). */
export interface VerifyCommandResult {
  name: string
  argv: string[]
  status: VerifyResultStatus
  /** The exit code; null when it never ran, was killed (timeout, Stop) or ended by a signal. */
  exitCode: number | null
  durationMs: number
  /** Last lines plus error lines with context, ANSI stripped, at most 4 KB; '' for a pass or a command not run. */
  excerpt: string
  /** The command's log (first 1 MB + last 4 MB); '' when it never ran. */
  logPath: string
  /** UI copy: why it was skipped, could not run, or failed without an exit code (a timeout). */
  reason?: string
  /** `fail` by the timeout (exitCode null). */
  timedOut?: boolean
  /** `skipped-untrusted`: no grant at all, or a grant for another body (`changed`). */
  trust?: 'untrusted' | 'changed'
}

/** `verify.detect`: a configured or detected command with its trust state (the config's own come first). */
export interface VerifyCommand extends DetectedCommand {
  /** Stable per command: `<source>:<cwdRel>:<name>`. */
  id: string
  /** Same as `run`. */
  argv: string[]
  /** The command's own timeout, else the default (600 s). */
  timeoutMs: number
  /** sha256(JSON{kind:'verify', argv, cwdRel, body}): the key of the grant that trusts it. */
  hash: string
  trust: VerifyTrustState
  trusted: boolean
  /** `changed`: the body the existing grant covers (null: that grant has no body). */
  grantedBody?: string | null
  /** Where argv[0] resolves now (PATH, node_modules/.bin, .venv, repo-root wrappers); null: not found. */
  resolved: string | null
  /** It is in `verify.commands` (source `config`); otherwise only detected (offered to add). */
  configured: boolean
  /**
   * Its working folder relative to the run folder, as `verify.commands[].cwd` takes it (`.` for the
   * folder itself). `cwdRel` is relative to the scope root (trust.json's), which differs below a repository's root.
   */
  cwd?: string
}
