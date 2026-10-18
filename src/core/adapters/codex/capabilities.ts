// Codex adapter constants, capabilities and the honest mode copy (mode mapping and honest copy,
// "Codex (codex/)", "Probe"). Values that a fixture decides carry its id; the X fixtures are SYNTHESIZED from the
// 0.160.1 schema until they are recorded live (tests/fixtures/codex/README.md).
import type { Mode } from '../../../shared/run.ts'
import type { Capabilities, ReadinessNeed, Route, Support } from '../../../shared/vendors.ts'
import type { AccountModels } from './default-model.ts'

export const CODEX_VENDOR = 'codex'
export const CODEX_DISPLAY_NAME = 'Codex'

/**
 * Probe: floor 0.147.0 (`--full-auto` removed), recommended 0.160.1 (prerelease suffixes ignored). Every live X and E
 * fixture was re-recorded with 0.160.1 (the recommendation was 0.160.0, the protocol folder's name).
 */
export const VERSION_FLOOR = '0.147.0'
export const VERSION_RECOMMENDED = '0.160.1'
/** The protocol types and the synthesized X fixtures come from codex-cli 0.160.1 (protocol/v0.160.0/). */
export const TESTED_UP_TO = '0.160.1'

export const CLIENT_NAME = 'harpoon'
export const CLIENT_VERSION = '0.1.0'

/** initialize must answer within this, else the CLI drifted (flag_drift, as Claude's 15 s handshake). */
export const INITIALIZE_TIMEOUT_MS = 15_000
/** thread/start, thread/resume, turn/start (they start MCP servers and load rollouts; no model call). */
export const REQUEST_TIMEOUT_MS = 60_000
/** Stop: turn/interrupt, then wait this long for turn/completed(interrupted) before closing stdin. */
export const STOP_TURN_WAIT_MS = 5_000
export const STOP_STDIN_WAIT_MS = 2_000
/** After the terminal event the app-server is told to exit (stdin closed); kill it if it lingers. */
export const EXIT_AFTER_TERMINAL_MS = 5_000
/** The session id is persisted (onSession) before turn/start; a hook that never answers does not hold the turn. */
export const SESSION_PERSIST_TIMEOUT_MS = 10_000
/** error{willRetry:false} is terminal once turn/completed(failed) follows; without one, the pass ends after this. */
export const FATAL_ERROR_WAIT_MS = 10_000
/** vendorSetup: windowsSandbox/setupStart → windowsSandbox/setupCompleted. Elevated setup waits on UAC. */
export const SETUP_TIMEOUT_MS = 10 * 60_000

/**
 * X11 (fixture-gated default): full mode without a Windows sandbox is "supported if X11 confirms", and X11
 * is still SYNTHESIZED (the source reading: codex-rs config_toml.rs downgrades only workspace-write), so until the live
 * X11a recording confirms it, full is unsupported while the sandbox is not ready. Flip this, and note it in
 * tests/fixtures/codex/README.md, once X11a shows danger-full-access running without the sandbox.
 */
export const FULL_WITHOUT_WIN_SANDBOX = false
/**
 * X12 (fixture-gated default, SYNTHESIZED): native plan = turn/start `collaborationMode:{mode:'plan'}` whenever the
 * schema has the field. A rejection (-32602) falls back to an emulated plan in the same thread at no budget cost.
 */
export const NATIVE_PLAN_DEFAULT = true
/**
 * X13 (fixture-gated default, SYNTHESIZED): how the local provider is defined. `inline` = one table under a dotted
 * key (`model_providers.harpoon_local = {name, base_url, wire_api, env_key?}`), the form codex-rs overrides.rs
 * parses (parses_inline_table); `dotted` = one key per field.
 */
export const LOCAL_PROVIDER_FORM: 'inline' | 'dotted' = 'inline'
export const LOCAL_PROVIDER_ID = 'harpoon_local'

// ---- mode copy (the ONLY source of mode text; the mode table, no em dashes in UI text) -----------------------------

/**
 * Codex has no `--strict-mcp-config`; a read-only pass still loads the MCP servers of the user's Codex
 * settings, and their tools run outside Codex's sandbox (a known follow-up). Every read-only copy ends with
 * it (written out in full there, so the renderer's fixtures can match core's words as text).
 */
export const MCP_NOTE = 'MCP servers from your Codex settings still load, outside the sandbox.'

export const APP_SERVER_COPY: Readonly<Record<Mode, string>> = {
  readonly:
    'Read-only sandbox: reads files and runs commands that do not write; nothing asks you. ' +
    'MCP servers from your Codex settings still load, outside the sandbox.',
  autoedit:
    'Sandbox-gated: edits and in-sandbox commands run unprompted; network, outside writes and escalations ask you.',
  full: 'No sandbox and no questions: every command and edit runs without asking.',
}

export const EXEC_COPY: Readonly<Record<Mode, string>> = {
  readonly: APP_SERVER_COPY.readonly,
  autoedit:
    'Sandbox-gated: edits and in-sandbox commands run; escalations are auto-denied (no relay on this route).',
  full: APP_SERVER_COPY.full,
}

export const PLAN_NATIVE_COPY = `Codex's own plan mode: reads in a read-only sandbox, never edits, and Harpoon captures the proposed plan. ${MCP_NOTE}`
export const CATALOG_COPY = `Read-only sandbox with live web search; cannot change files. ${MCP_NOTE}`

export const WIN_SANDBOX_READONLY_COPY =
  'Cannot run shell reads: the Codex Windows sandbox is not set up, so it reviews from the diff. ' +
  'MCP servers from your Codex settings still load, outside the sandbox.'
export const WIN_SANDBOX_AUTOEDIT_COPY =
  'Needs the Codex Windows sandbox, which is not set up: without it Codex silently runs read-only. ' +
  'Set it up from the Codex sandbox check.'
export const WIN_SANDBOX_UPDATE_COPY =
  'Needs the Codex Windows sandbox, which needs an update: without it Codex silently runs read-only. ' +
  'Set it up again from the Codex sandbox check.'
/** The sandbox could not be checked (no answer, an answer Harpoon does not know, or not probed yet). */
export const WIN_SANDBOX_UNCHECKED_READONLY_COPY =
  'May not run shell reads: Harpoon could not check the Codex Windows sandbox, so it may review from the diff. ' +
  'MCP servers from your Codex settings still load, outside the sandbox.'
export const WIN_SANDBOX_UNCHECKED_COPY =
  'Needs the Codex Windows sandbox, which Harpoon could not check: without it Codex silently runs read-only. ' +
  'Check Codex again, or set the sandbox up from the Codex sandbox check.'
/** Full mode while the sandbox is not ready, until the live X11a recording confirms it works without one. */
export const WIN_SANDBOX_FULL_COPY =
  'Full access without the Codex Windows sandbox is not confirmed yet, so Harpoon does not run it. ' +
  'Set the sandbox up from the Codex sandbox check.'
export const NO_RELAY_COPY = 'Asks are auto-denied, not prompted: this Codex route has no approval relay.'

// ---- facts from the probe ---------------------------------------------------------------------------------------

/**
 * `windowsSandbox/readiness` (win32); `unavailable` = the method is missing; `unchecked` = a probe asked and got no
 * answer Harpoon knows (an error, a timeout, a status it does not know, or no handshake); `unknown` = not probed
 * yet; `n/a` off win32.
 */
export type WinSandboxState =
  'ready' | 'notConfigured' | 'updateRequired' | 'unavailable' | 'unchecked' | 'unknown' | 'n/a'

export interface CodexFacts {
  route: Extract<Route, 'app-server' | 'exec'>
  /** turn/start has `collaborationMode` (experimental field) on the app-server route. */
  planNative: boolean
  /** model/list exists. */
  modelList: boolean
  /** thread/tokenUsage/updated exists (else usage comes from nowhere on app-server: approximate). */
  tokenUsage: boolean
  winSandbox: WinSandboxState
  /**
   * Live balanced run: the probe's model/list (the picker's, hidden models left out) when it names a default and the
   * login is ChatGPT's (default-model.ts listDecides), the first look of a pass with no model of its own: a model it
   * lists runs as the CLI resolved it, and only a model it lacks makes the pass read the whole list before overriding.
   * Absent: no list (logged out, not probed), or another login (an API key, an access token, OPENAI_BASE_URL set),
   * so such a pass leaves its model to the CLI.
   */
  accountModels?: AccountModels
}

export function defaultFacts(platform: NodeJS.Platform = process.platform): CodexFacts {
  return {
    route: 'app-server',
    planNative: NATIVE_PLAN_DEFAULT,
    modelList: true,
    tokenUsage: true,
    winSandbox: platform === 'win32' ? 'unknown' : 'n/a',
  }
}

/**
 * The Windows sandbox is usable: off Windows (`n/a`), or a probe read it `ready`. Anything else on win32,
 * `unknown` (not probed yet) and `unchecked` (no answer) included, is not ready, so an edit pass never runs on a
 * sandbox nobody confirmed (it would silently run read-only).
 */
export const winSandboxReady = (f: Pick<CodexFacts, 'winSandbox'>): boolean =>
  f.winSandbox === 'ready' || f.winSandbox === 'n/a'
export const winSandboxNotReady = (f: Pick<CodexFacts, 'winSandbox'>): boolean => !winSandboxReady(f)
/** Not ready because nobody could tell (not probed, or the probe got no answer), rather than a known state. */
const winSandboxUnsure = (f: Pick<CodexFacts, 'winSandbox'>): boolean =>
  f.winSandbox === 'unknown' || f.winSandbox === 'unchecked'

/** A pass in this sandbox mode needs the Windows sandbox (autoedit always; full until X11 confirms otherwise). */
export function modeNeedsWinSandbox(mode: Mode): boolean {
  return mode === 'autoedit' || (mode === 'full' && !FULL_WITHOUT_WIN_SANDBOX)
}

/** Steps that always run in Codex's read-only sandbox, whatever their mode. */
const READ_ONLY_STEPS = new Set<string>(['plan', 'review', 'critic', 'heal', 'catalog'])

/** The sandbox mode a pass runs in: read-only steps (and `readonly` mode) read-only, else the pass's mode. */
export function effectiveMode(step: string, mode: Mode): Mode {
  return READ_ONLY_STEPS.has(step) ? 'readonly' : mode
}

/** The mode table for Codex, including the "Windows sandbox not ready" row. */
export function codexSupport(need: ReadinessNeed, facts: CodexFacts): Support {
  const mode = effectiveMode(need.pass, need.mode)
  const notReady = winSandboxNotReady(facts)
  const nativePlan =
    need.pass === 'plan' && need.planNative && facts.route === 'app-server' && facts.planNative
  const unsure = winSandboxUnsure(facts)
  if (notReady && mode === 'readonly') {
    return {
      status: 'degraded',
      copy: unsure ? WIN_SANDBOX_UNCHECKED_READONLY_COPY : WIN_SANDBOX_READONLY_COPY,
      reason: `winSandbox-${facts.winSandbox}`,
    }
  }
  if (notReady && mode === 'autoedit') {
    return {
      status: 'unsupported',
      copy:
        facts.winSandbox === 'updateRequired'
          ? WIN_SANDBOX_UPDATE_COPY
          : unsure
            ? WIN_SANDBOX_UNCHECKED_COPY
            : WIN_SANDBOX_AUTOEDIT_COPY,
      reason: `winSandbox-${facts.winSandbox}`,
    }
  }
  if (notReady && mode === 'full' && modeNeedsWinSandbox('full')) {
    return { status: 'unsupported', copy: WIN_SANDBOX_FULL_COPY, reason: `winSandbox-${facts.winSandbox}` }
  }
  if (nativePlan) return { status: 'supported', copy: PLAN_NATIVE_COPY }
  if (need.pass === 'catalog') return { status: 'supported', copy: CATALOG_COPY }
  if (facts.route === 'exec') {
    return mode === 'autoedit'
      ? { status: 'degraded', copy: EXEC_COPY.autoedit, reason: 'no-relay' }
      : { status: 'supported', copy: EXEC_COPY[mode] }
  }
  return { status: 'supported', copy: APP_SERVER_COPY[mode] }
}

export function codexCapabilities(facts: CodexFacts): Capabilities {
  const pass = (mode: Mode): Support =>
    codexSupport({ pass: 'implement', mode, planNative: false, trustFolder: false }, facts)
  return {
    planMode: facts.route === 'app-server' && facts.planNative ? 'native' : 'emulated',
    askRelay: facts.route === 'app-server',
    resume: 'id',
    // The thread id comes from the thread/start response (exec: thread.started), never chosen up front.
    preassignSessionId: false,
    modelList: facts.route === 'app-server' && facts.modelList ? 'cli' : 'static',
    // thread/tokenUsage/updated (exec: turn.completed.usage) reports the thread's running total.
    usageCumulative: true,
    allowSession: facts.route === 'app-server' ? 'native' : 'harpoon',
    web: true,
    // thread/resume (exec: `-m` before `resume`) takes the model of this pass.
    resumeModelSwitch: true,
    // OpenAI output_tokens include the reasoning tokens.
    reasoningIncludedInOutput: true,
    modes: { readonly: pass('readonly'), autoedit: pass('autoedit'), full: pass('full') },
  }
}

// ---- flags ------------------------------------------------------------------------------------------------------

/**
 * Flags the adapter owns (app-server and exec argv). extraArgs may not repeat them and flagMap may only rename them.
 * `-c` is not managed: it is how extraArgs reach Codex (Codex extraArgs are root `-c` only).
 */
export const MANAGED_FLAGS = [
  '--listen',
  '--json',
  '--color',
  '--skip-git-repo-check',
  '--sandbox',
  '-s',
  '--cd',
  '-C',
  '--model',
  '-m',
  '--output-last-message',
  '-o',
  '--output-schema',
  '--ephemeral',
] as const

/**
 * Flags Harpoon never passes and extraArgs may never carry (exec fallback: never `--full-auto`,
 * `--approve-for-me`, `--oss`, `--local-provider`), plus everything else that widens a pass or swaps its profile.
 */
export const FORBIDDEN_FLAGS = [
  '--full-auto',
  '--approve-for-me',
  '--not-so-yolo',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--dangerously-bypass-hook-trust',
  '--oss',
  '--local-provider',
  '--profile',
  '-p',
  '--add-dir',
  '--worktree',
  '--enable',
  '--disable',
  '--ignore-rules',
] as const

/** Every flag the 0.160.1 CLI defines for the root, `exec` and `app-server` (`--help`), managed or not. */
export const CLI_FLAGS = [
  '-c',
  '--config',
  '--enable',
  '--disable',
  '--strict-config',
  '-i',
  '--image',
  '-m',
  '--model',
  '--oss',
  '--local-provider',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '--approve-for-me',
  '--not-so-yolo',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--dangerously-bypass-hook-trust',
  '-C',
  '--cd',
  '--worktree',
  '--add-dir',
  '--thread-source',
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--output-schema',
  '--color',
  '--json',
  '--experimental-json',
  '-o',
  '--output-last-message',
  '--listen',
  '--stdio',
  '--code-mode-host',
  '--analytics-default-enabled',
  '--remote',
  '--ws-auth',
  '--ws-token-file',
  '--ws-token-sha256',
  '--ws-shared-secret-file',
  '--ws-issuer',
  '--ws-audience',
  '--ws-max-clock-skew-seconds',
  '--last',
  '--all',
  '-h',
  '--help',
  '-V',
  '--version',
] as const

/**
 * `-c` keys extraArgs may not set: the sandbox, approvals, the provider and anything that adds tools or swaps the
 * profile (Harpoon sets these per pass, as it hardens Claude's read-only passes). Matched on the dotted key's
 * first segment.
 */
export const FORBIDDEN_CONFIG_KEYS = [
  'sandbox_mode',
  'sandbox_workspace_write',
  'approval_policy',
  'approvals_reviewer',
  'model_provider',
  'model_providers',
  'permissions',
  'default_permissions',
  'windows',
  'profile',
  'profiles',
  'mcp_servers',
  'features',
  'shell_environment_policy',
  'developer_instructions',
  'experimental_instructions_file',
  'web_search',
  'tools',
  'oss_provider',
] as const
