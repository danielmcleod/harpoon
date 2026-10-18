// probe(): vendor.codex.{bin,version,auth,protocol,plan,winSandbox} (the probe checks).
// Spends no tokens: `--version` (the resolver), `codex login status`, `app-server generate-json-schema`
// into a temp folder (required methods → the app-server route, else the exec fallback; optional ones downgrade a
// capability), and one private app-server handshake: initialize, windowsSandbox/readiness (win32) and model/list
// (only when logged in). It never starts a thread or a turn, and never reads auth.json.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { RecoveryAction } from '../../../shared/failure.ts'
import type { CheckResult, CheckStatus, VendorCheck } from '../../../shared/preflight.ts'
import { vendorCheckId } from '../../../shared/preflight.ts'
import { redactText } from '../../../shared/redact.ts'
import type { ModelInfo, ProbeAccount } from '../../../shared/vendors.ts'
import { commandFor, docsUrlFor, osFamily } from '../../heal/commands.ts'
import { JsonRpcError } from '../../proc/jsonrpc.ts'
import type { CandidateRejection, ResolvedCli } from '../../proc/resolve-cli.ts'
import { compareVersions } from '../../proc/resolve-cli.ts'
import { SpawnError, execCapture } from '../../proc/spawn.ts'
import type { CaptureResult } from '../../proc/spawn.ts'
import type { CodexFacts, WinSandboxState } from './capabilities.ts'
import { accountModelsOf, listDecides } from './default-model.ts'
import {
  CODEX_VENDOR,
  INITIALIZE_TIMEOUT_MS,
  TESTED_UP_TO,
  VERSION_FLOOR,
  VERSION_RECOMMENDED,
} from './capabilities.ts'
import { checkProtocol, SCHEMA_BUNDLE_FILE, SCHEMA_PROBE_ARGS } from './protocol.ts'
import type { ProtocolCheck } from './protocol.ts'
import { AppServer, isUnknownMethod } from './rpc.ts'
import { arr, rec, str } from './wire.ts'

export const PROBE_TTL_MS = 60 * 60 * 1000
export const AUTH_TIMEOUT_MS = 15_000
export const SCHEMA_TIMEOUT_MS = 30_000
const MODEL_PAGES = 3

type CheckExtra = Partial<Pick<CheckResult, 'category' | 'blocking'>> & { recovery?: RecoveryAction[] }

export function vendorCheck(
  check: VendorCheck,
  status: CheckStatus,
  title: string,
  detail: string,
  at: number,
  extra: CheckExtra = {},
): CheckResult {
  const out: CheckResult = {
    id: vendorCheckId(CODEX_VENDOR, check),
    scope: 'vendor',
    status,
    blocking: extra.blocking ?? status === 'fail',
    title,
    detail,
    recovery: extra.recovery ?? [],
    at,
    ttlMs: PROBE_TTL_MS,
  }
  if (extra.category !== undefined) out.category = extra.category
  return out
}

// ---- recovery actions ---------------------------------------------------------------------------------------

function shellCopy(
  id: string,
  label: string,
  kind: 'install' | 'login' | 'update' | 'pin' | 'sandboxSetup',
  reason: string,
  recheck: VendorCheck,
  version?: string,
): RecoveryAction | undefined {
  const cmd = commandFor(kind, CODEX_VENDOR, osFamily(), version)
  if (cmd === null) return undefined
  return {
    id,
    label,
    kind: 'shell_copy',
    command: cmd.command,
    shell: cmd.shell,
    reason,
    recheck: vendorCheckId(CODEX_VENDOR, recheck),
    ...(cmd.elevated === true ? { elevated: true } : {}),
  }
}

const defined = (list: (RecoveryAction | undefined)[]): RecoveryAction[] =>
  list.filter((a): a is RecoveryAction => a !== undefined)

/** Last resort for a Codex that cannot run here: every pass on Claude (disabled while Claude is not ready). */
function switchToClaude(): RecoveryAction {
  return {
    id: 'codex.switch-vendor',
    label: 'Use Claude instead',
    kind: 'switch_vendor',
    pass: 'all',
    to: 'claude',
    model: null,
  }
}

function installActions(): RecoveryAction[] {
  const docs = docsUrlFor(CODEX_VENDOR)
  return defined([
    shellCopy('codex.install', 'Copy the install command', 'install', 'Codex is not installed', 'bin'),
    {
      id: 'codex.set-path',
      label: 'Set the Codex path',
      kind: 'settings_link',
      route: 'settings/vendors',
      pointer: '/vendors/codex/path',
    },
    switchToClaude(),
    docs !== null
      ? { id: 'codex.docs', label: 'Open the setup guide', kind: 'open_docs', url: docs }
      : undefined,
  ])
}

/**
 * The mode table's "fix: vendor_setup unelevated → elevated shell_copy": the setup Harpoon runs on a click
 * (windowsSandbox/setupStart{unelevated}), then the elevated command to copy (a UAC prompt; never run by Harpoon);
 * sandbox_unavailable's last resort, switch_vendor, after them. The vendor check, the readiness `mode` check
 * and core's `pass.<p>.mode` checks all carry these same actions, so the composer shows the sandbox fix once.
 */
export function sandboxActions(): RecoveryAction[] {
  if (osFamily() !== 'win32') return []
  return defined([
    {
      id: 'codex.sandbox-setup',
      label: 'Set up the Codex sandbox',
      kind: 'vendor_setup',
      vendor: CODEX_VENDOR,
      call: 'windowsSandbox/setupStart',
      params: { mode: 'unelevated' },
    },
    shellCopy(
      'codex.sandbox-elevated',
      'Copy the elevated setup command',
      'sandboxSetup',
      'If the setup above does not work, run this in a terminal (Windows asks for administrator rights).',
      'winSandbox',
    ),
    switchToClaude(),
  ])
}

// ---- bin / version ----------------------------------------------------------------------------------------

const SOURCE_LABEL: Record<ResolvedCli['source'], string> = {
  config: 'configured path',
  'well-known': 'standalone install',
  path: 'PATH',
  'npm-prefix': 'npm global prefix',
  'desktop-bundle': 'Codex Desktop bundle',
}

export function binCheck(
  cli: ResolvedCli | undefined,
  rejected: readonly CandidateRejection[],
  at: number,
): CheckResult {
  if (cli === undefined) {
    const why = rejected.map((r) => `${r.path}: ${r.detail}`).join('\n')
    return vendorCheck(
      'bin',
      'fail',
      'Codex is not installed',
      why !== '' ? `No usable Codex CLI was found.\n${why}` : 'No Codex CLI was found on this computer.',
      at,
      { category: 'cli_missing', recovery: installActions() },
    )
  }
  const via = cli.kind === 'node-entry' ? `; runs with ${cli.command}` : ''
  const native = cli.command !== cli.path && cli.kind === 'native' ? `; runs ${cli.command}` : ''
  const where = `${cli.path} (${SOURCE_LABEL[cli.source]}${via}${native})`
  if (cli.source === 'desktop-bundle' || cli.warnings.length > 0) {
    return vendorCheck('bin', 'warn', 'Codex found (bundled copy)', [where, ...cli.warnings].join('\n'), at, {
      recovery: defined([
        shellCopy(
          'codex.install',
          'Copy the install command',
          'install',
          'Install the standalone Codex CLI',
          'bin',
        ),
      ]),
    })
  }
  return vendorCheck('bin', 'pass', 'Codex found', where, at)
}

export function versionCheck(version: string, at: number): CheckResult {
  const update = (): RecoveryAction[] =>
    defined([shellCopy('codex.update', 'Copy the update command', 'update', 'Update Codex', 'version')])
  if (compareVersions(version, VERSION_FLOOR) < 0) {
    return vendorCheck(
      'version',
      'fail',
      `Codex ${version} is too old`,
      `Harpoon needs ${VERSION_FLOOR} or newer (${VERSION_RECOMMENDED} recommended).`,
      at,
      { category: 'cli_version', recovery: update() },
    )
  }
  if (compareVersions(version, VERSION_RECOMMENDED) < 0) {
    return vendorCheck(
      'version',
      'warn',
      `Codex ${version} works; ${VERSION_RECOMMENDED} is recommended`,
      'Update Codex when convenient.',
      at,
      { recovery: update() },
    )
  }
  if (compareVersions(version, TESTED_UP_TO) > 0) {
    return vendorCheck(
      'version',
      'warn',
      `Codex ${version} is newer than tested (${TESTED_UP_TO})`,
      `If a flag fails, apply the suggested flagMap patch or install ${TESTED_UP_TO}.`,
      at,
      {
        recovery: defined([
          shellCopy(
            'codex.pin',
            `Copy the install command for ${TESTED_UP_TO}`,
            'pin',
            'Install the tested version',
            'version',
            TESTED_UP_TO,
          ),
        ]),
      },
    )
  }
  return vendorCheck('version', 'pass', `Codex ${version}`, `Tested up to ${TESTED_UP_TO}.`, at)
}

// ---- auth (`codex login status`) ---------------------------------------------------------------------------

export interface LoginStatus {
  loggedIn: boolean
  /** `chatgpt` | `api_key` | `access_token` | `unknown`; the key itself is never kept. */
  method?: string
}

/**
 * `codex login status` (exit 0 "Logged in using ChatGPT" / "Logged in using an API key - sk-…"; exit 1 "Not logged
 * in"). Only the method is read: the key fragment the CLI prints is never kept or shown.
 */
export function parseLoginStatus(
  r: Pick<CaptureResult, 'code' | 'stdout' | 'stderr'>,
): LoginStatus | undefined {
  const text = `${r.stdout}\n${r.stderr}`
  if (/\bNot logged in\b/i.test(text)) return { loggedIn: false }
  const m = /\bLogged in using (?:an? )?(ChatGPT|API key|access token)/i.exec(text)
  if (m !== null && r.code === 0) {
    const how = (m[1] ?? '').toLowerCase()
    return {
      loggedIn: true,
      method: how === 'chatgpt' ? 'chatgpt' : how === 'api key' ? 'api_key' : 'access_token',
    }
  }
  if (r.code === 0 && /\bLogged in\b/i.test(text)) return { loggedIn: true, method: 'unknown' }
  if (r.code === 1) return { loggedIn: false }
  return undefined
}

/** The first output line that names no account or key, redacted and capped. */
function safeLine(s: string): string {
  const line = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !/sk-|e-?mail|@|WARNING: proceeding/i.test(l))
  return line === undefined ? '' : redactText(line, { mode: 'diagnostics' }).text.slice(0, 200)
}

export function authCheck(
  r: Pick<CaptureResult, 'code' | 'stdout' | 'stderr' | 'timedOut'> & { error?: SpawnError | undefined },
  at: number,
): { check: CheckResult; account?: ProbeAccount; loggedIn: boolean } {
  const login = shellCopy('codex.login', 'Copy the login command', 'login', 'Codex is not logged in', 'auth')
  const status = r.error === undefined && !r.timedOut ? parseLoginStatus(r) : undefined
  if (status === undefined) {
    const why =
      r.error?.message ??
      (r.timedOut
        ? 'timed out'
        : [`exit ${r.code ?? '?'}`, safeLine(r.stderr) || safeLine(r.stdout)]
            .filter((s) => s !== '')
            .join('; '))
    return {
      check: vendorCheck(
        'auth',
        'warn',
        'Could not read the Codex login status',
        `codex login status: ${why}`,
        at,
        {
          recovery: defined([login]),
        },
      ),
      loggedIn: false,
    }
  }
  if (!status.loggedIn) {
    return {
      check: vendorCheck(
        'auth',
        'fail',
        'Codex is not logged in',
        'Run the login command in a terminal, then re-check.',
        at,
        { category: 'auth_required', recovery: defined([login]) },
      ),
      loggedIn: false,
    }
  }
  const method = status.method ?? 'unknown'
  const label = method === 'chatgpt' ? 'ChatGPT' : method === 'api_key' ? 'API key' : method
  return {
    check: vendorCheck('auth', 'pass', 'Logged in', `Codex signs in with ${label}.`, at),
    account: { method },
    loggedIn: true,
  }
}

/** `codex login status` with the pass env (token-free; the auth re-check before a pass runs it too). */
export function runLoginStatus(
  cli: Pick<ResolvedCli, 'command' | 'prefixArgs'>,
  env: Record<string, string>,
  cwd: string,
  timeoutMs = AUTH_TIMEOUT_MS,
): Promise<CaptureResult> {
  return execCapture(cli.command, [...cli.prefixArgs, 'login', 'status'], { env, cwd, timeoutMs })
}

// ---- protocol: generate-json-schema --------------------------------------------------------------------------

export interface SchemaProbe {
  check?: ProtocolCheck
  error?: string
}

/** `codex app-server generate-json-schema --experimental --out <temp>` → the method check. */
export async function runSchemaProbe(o: {
  cli: Pick<ResolvedCli, 'command' | 'prefixArgs'>
  env: Record<string, string>
  cwd: string
  /** Leading root `-c` overrides (the user's extraArgs), as a pass passes them. */
  rootArgs?: readonly string[]
  tmpDir?: string
  timeoutMs?: number
}): Promise<SchemaProbe> {
  let dir: string
  try {
    dir = mkdtempSync(join(o.tmpDir ?? tmpdir(), 'harpoon-codex-schema-'))
  } catch (err) {
    return { error: `could not create a temp folder: ${String(err)}` }
  }
  try {
    const r = await execCapture(
      o.cli.command,
      [...o.cli.prefixArgs, ...(o.rootArgs ?? []), ...SCHEMA_PROBE_ARGS, dir],
      {
        env: o.env,
        cwd: o.cwd,
        timeoutMs: o.timeoutMs ?? SCHEMA_TIMEOUT_MS,
      },
    )
    if (r.error !== undefined) return { error: `${r.error.code}: ${r.error.message}` }
    if (r.timedOut) return { error: 'generate-json-schema timed out' }
    let bundle: unknown
    try {
      bundle = JSON.parse(readFileSync(join(dir, SCHEMA_BUNDLE_FILE), 'utf8'))
    } catch {
      const why = safeLine(r.stderr) || safeLine(r.stdout)
      return {
        error: `generate-json-schema wrote no ${SCHEMA_BUNDLE_FILE} (exit ${r.code ?? '?'})${why ? `: ${why}` : ''}`,
      }
    }
    return { check: checkProtocol(bundle) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- the app-server handshake ----------------------------------------------------------------------------------

export interface HandshakeResult {
  ok: boolean
  ms: number
  error?: string
  /** windowsSandbox/readiness (win32): its status, `unavailable` when the method is missing, else undefined. */
  winSandbox?: WinSandboxState
  models: ModelInfo[]
  /** Server notifications other than status chatter (a model call would show up here). */
  unexpected: string[]
  stderr: string[]
}

/** A model/list entry → the picker's ModelInfo (hidden models are left out). */
export function toModelInfo(m: unknown): ModelInfo | undefined {
  const r = rec(m)
  const id = str(r?.['model']) ?? str(r?.['id'])
  if (r === undefined || id === undefined || id === '' || r['hidden'] === true) return undefined
  const out: ModelInfo = { id, source: 'cli' }
  const label = str(r['displayName'])
  if (label !== undefined && label !== '' && label !== id) out.label = label
  if (r['isDefault'] === true) out.isDefault = true
  const efforts = arr(r['supportedReasoningEfforts'])
    .map((e) => str(rec(e)?.['reasoningEffort']))
    .filter((e): e is string => e !== undefined)
  if (efforts.length > 0) out.efforts = efforts
  const alias = str(r['id'])
  if (alias !== undefined && alias !== id) out.aliases = [alias]
  return out
}

/** Notifications the handshake expects (status, never a model call). */
const QUIET = /^(remoteControl\/|account\/|mcpServer\/|configWarning|warning|skills\/|app\/|thread\/started)/

/**
 * One private app-server: initialize → initialized → windowsSandbox/readiness (win32) → model/list (logged in only)
 * → stdin closed. No thread, no turn: no tokens.
 */
export async function probeHandshake(o: {
  cli: Pick<ResolvedCli, 'command' | 'prefixArgs'>
  env: Record<string, string>
  cwd: string
  args: readonly string[]
  /** model/list only once the login check passed (a logged-out CLI has no list to give). */
  listModels: Promise<boolean>
  platform?: NodeJS.Platform
  timeoutMs?: number
}): Promise<HandshakeResult> {
  const start = Date.now()
  const timeoutMs = o.timeoutMs ?? INITIALIZE_TIMEOUT_MS
  let server: AppServer
  try {
    server = await AppServer.spawn({
      cli: o.cli,
      args: o.args,
      cwd: o.cwd,
      env: o.env,
      label: { purpose: 'probe' },
    })
  } catch (err) {
    const e = SpawnError.from(err, o.cli.command)
    return {
      ok: false,
      ms: Date.now() - start,
      error: `${e.code}: ${e.message}`,
      models: [],
      unexpected: [],
      stderr: [],
    }
  }
  const unexpected: string[] = []
  server.peer.onNotification('*', (_p, method) => {
    if (!QUIET.test(method)) unexpected.push(method)
  })
  const out: HandshakeResult = { ok: false, ms: 0, models: [], unexpected, stderr: [] }
  try {
    await server.initialize(false, timeoutMs)
    out.ok = true
    if ((o.platform ?? process.platform) === 'win32') {
      try {
        const r = rec(await server.peer.request('windowsSandbox/readiness', undefined, { timeoutMs }))
        const status = str(r?.['status'])
        // A status Harpoon does not know is "could not check", never "ready".
        out.winSandbox =
          status === 'ready' || status === 'notConfigured' || status === 'updateRequired'
            ? status
            : 'unchecked'
      } catch (err) {
        out.winSandbox = isUnknownMethod(err) ? 'unavailable' : 'unchecked'
      }
    }
    if (await o.listModels) {
      let cursor: string | null = null
      for (let page = 0; page < MODEL_PAGES; page++) {
        try {
          const r = rec(
            await server.peer.request(
              'model/list',
              { includeHidden: false, ...(cursor !== null ? { cursor } : {}) },
              { timeoutMs },
            ),
          )
          for (const m of arr(r?.['data'])) {
            const info = toModelInfo(m)
            if (info !== undefined && !out.models.some((x) => x.id === info.id)) out.models.push(info)
          }
          cursor = str(r?.['nextCursor']) ?? null
          if (cursor === null) break
        } catch {
          break // no list: the picker takes free text
        }
      }
    }
  } catch (err) {
    out.error =
      err instanceof JsonRpcError
        ? `initialize was refused: ${err.message.slice(0, 200)}`
        : err instanceof Error
          ? err.message
          : String(err)
  } finally {
    await Promise.race([server.shutdown(3_000), delay(10_000, undefined, { ref: false })])
    out.stderr = server.child.stderrTail(20).filter((l) => !/WARNING: proceeding/.test(l))
    out.ms = Date.now() - start
  }
  return out
}

export function protocolCheck(schema: SchemaProbe, h: HandshakeResult | undefined, at: number): CheckResult {
  const update = (): RecoveryAction[] =>
    defined([
      { id: 'codex.heal', label: 'Diagnose with AI', kind: 'heal' },
      shellCopy('codex.update', 'Copy the update command', 'update', 'Update Codex', 'protocol'),
    ])
  const p = schema.check
  if (p === undefined) {
    return vendorCheck(
      'protocol',
      'fail',
      'Codex could not describe its protocol',
      `codex app-server generate-json-schema: ${schema.error ?? 'failed'}`,
      at,
      { category: 'flag_drift', recovery: update() },
    )
  }
  if (p.transport === 'codex-exec') {
    return vendorCheck(
      'protocol',
      'warn',
      'Codex runs without a question relay',
      `This Codex app-server lacks ${p.missingRequired.join(', ')}, so Harpoon uses codex exec: anything Codex would ask is denied automatically.`,
      at,
      { recovery: update() },
    )
  }
  if (h !== undefined && !h.ok) {
    const detail = [h.error ?? 'initialize failed', ...h.stderr.slice(-5)].join('\n')
    return vendorCheck('protocol', 'fail', 'Codex did not answer the startup handshake', detail, at, {
      category: 'flag_drift',
      recovery: update(),
    })
  }
  const notes: string[] = []
  if (h !== undefined) notes.push(`initialize answered in ${h.ms} ms; no tokens spent.`)
  if (p.missingOptional.length > 0) notes.push(`Missing optional parts: ${p.missingOptional.join(', ')}.`)
  if (p.shapeProblems.length > 0) notes.push(`Changed shapes: ${p.shapeProblems.slice(0, 5).join('; ')}.`)
  if (h !== undefined && h.unexpected.length > 0)
    notes.push(`Unexpected frames: ${h.unexpected.slice(0, 5).join(', ')}.`)
  return vendorCheck(
    'protocol',
    p.shapeProblems.length > 0 ? 'warn' : 'pass',
    p.shapeProblems.length > 0 ? 'JSON-RPC works; some shapes changed' : 'JSON-RPC protocol works',
    notes.join(' '),
    at,
    p.shapeProblems.length > 0 ? { recovery: update() } : {},
  )
}

/** A protocol check for `vendors.codex.{extraArgs,flagMap}` Harpoon refuses (every pass would refuse to start). */
export function protocolConfigCheck(problem: string, at: number): CheckResult {
  return vendorCheck('protocol', 'fail', 'Codex flags in your settings are not allowed', problem, at, {
    category: 'config_invalid',
    recovery: [
      {
        id: 'codex.flags',
        label: 'Edit the Codex flags',
        kind: 'settings_link',
        route: 'settings/vendors',
        pointer: '/vendors/codex',
      },
    ],
  })
}

export function planCheck(facts: Pick<CodexFacts, 'route' | 'planNative'>, at: number): CheckResult {
  if (facts.route === 'app-server' && facts.planNative) {
    return vendorCheck(
      'plan',
      'pass',
      'Native plan mode',
      "Plan runs in Codex's own plan mode; Harpoon captures the proposed plan.",
      at,
    )
  }
  return vendorCheck(
    'plan',
    'skip',
    'Plan runs read-only with the plan template',
    facts.route === 'exec'
      ? 'This Codex runs without its app server here, which has no plan mode.'
      : 'This Codex does not offer its plan mode to Harpoon.',
    at,
  )
}

/** vendor.codex.winSandbox (win32 only; Codex Windows sandbox readiness is reported only here). */
export function winSandboxCheck(state: WinSandboxState, at: number): CheckResult | undefined {
  switch (state) {
    case 'n/a':
      return undefined
    case 'ready':
      return vendorCheck(
        'winSandbox',
        'pass',
        'Codex Windows sandbox ready',
        'Codex can edit and run commands inside its Windows sandbox.',
        at,
      )
    case 'notConfigured':
    case 'updateRequired':
      // Not blocking: read-only passes still run (degraded); edit passes are unsupported until it is set up. The
      // protocol's own words stay out of the text (a tester sets it up from in-app text alone).
      return vendorCheck(
        'winSandbox',
        'fail',
        state === 'notConfigured'
          ? 'Codex Windows sandbox not set up'
          : 'Codex Windows sandbox needs an update',
        `${
          state === 'notConfigured'
            ? 'The Codex Windows sandbox is not set up.'
            : 'The Codex Windows sandbox needs an update.'
        } Without it Codex cannot edit (it would silently run read-only) and cannot run shell reads.`,
        at,
        { blocking: false, category: 'sandbox_unavailable', recovery: sandboxActions() },
      )
    case 'unavailable':
      return vendorCheck(
        'winSandbox',
        'fail',
        'Codex cannot report its Windows sandbox',
        'This Codex cannot say whether its Windows sandbox is set up, so Harpoon cannot tell whether edits would run. Update Codex.',
        at,
        {
          blocking: false,
          category: 'sandbox_unavailable',
          recovery: defined([
            shellCopy('codex.update', 'Copy the update command', 'update', 'Update Codex', 'winSandbox'),
          ]),
        },
      )
    case 'unchecked':
      // No answer is not "ready": edit passes stay off until a check reads it ready.
      return vendorCheck(
        'winSandbox',
        'fail',
        'Codex Windows sandbox could not be checked',
        'Codex did not answer when Harpoon asked about its Windows sandbox, so edit passes stay off until a check says it is ready. Check again, or set the sandbox up.',
        at,
        { blocking: false, category: 'sandbox_unavailable', recovery: sandboxActions() },
      )
    case 'unknown':
      return vendorCheck(
        'winSandbox',
        'warn',
        'Codex Windows sandbox not checked yet',
        'Harpoon has not asked Codex about its Windows sandbox yet; edit passes wait until it has.',
        at,
      )
  }
}

/** The facts support() and start() read, from what the probe found. */
export function factsFrom(o: {
  schema: SchemaProbe
  handshake: HandshakeResult | undefined
  platform: NodeJS.Platform
  /** `codex login status`'s method (LoginStatus.method), when logged in. */
  login?: string | undefined
  /** OPENAI_BASE_URL in Codex's environment (the probe's, which the passes share). */
  openaiBaseUrl?: string | undefined
}): CodexFacts {
  const caps = o.schema.check?.capabilities
  const route = o.schema.check?.transport === 'codex-exec' ? 'exec' : 'app-server'
  let winSandbox: WinSandboxState = 'n/a'
  if (o.platform === 'win32') {
    const answered = o.handshake?.winSandbox
    if (caps?.windowsSandbox === false) winSandbox = 'unavailable'
    else if (route === 'exec') {
      // exec has no readiness call of its own, but it runs in the same sandbox (CODEX_HOME) the app-server handshake
      // reported on: a definite answer stands (ready → exec's autoedit is degraded, not unsupported); none → unavailable.
      winSandbox =
        answered === 'ready' || answered === 'notConfigured' || answered === 'updateRequired'
          ? answered
          : 'unavailable'
    } else {
      // A probe that did not get a definite answer (no handshake, an error, a timeout) could not check it;
      // `unknown` is kept for "not probed yet". Neither lets an edit pass run.
      winSandbox = answered === undefined || answered === 'unknown' ? 'unchecked' : answered
    }
  }
  const facts: CodexFacts = {
    route,
    planNative: route === 'app-server' && caps?.collaborationMode !== false,
    modelList: route === 'app-server' && caps?.modelList !== false,
    tokenUsage: caps?.tokenUsage !== false,
    winSandbox,
  }
  // Live balanced run: the picker's list is a pass's first look when it names no model (default-model.ts), for a
  // ChatGPT login only (listDecides): with any other login the list does not say what the account is refused.
  if (listDecides({ login: o.login, openaiBaseUrl: o.openaiBaseUrl })) {
    const accountModels = accountModelsOf(o.handshake?.models ?? [])
    if (accountModels !== undefined) facts.accountModels = accountModels
  }
  return facts
}
