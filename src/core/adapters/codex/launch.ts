// Codex argv, env and the extraArgs / flagMap rules (app-server and exec fallback; extraArgs are root `-c` only).
// Prompts never go in argv: JSON-RPC turn/start, or exec's stdin.
import type { LocalPreset } from '../../../shared/vendors.ts'
import type { EnvInput } from '../../proc/env.ts'
import { sanitizeEnv } from '../../proc/env.ts'
import type { StartStep } from '../types.ts'
import {
  CLI_FLAGS,
  FORBIDDEN_CONFIG_KEYS,
  FORBIDDEN_FLAGS,
  LOCAL_PROVIDER_FORM,
  LOCAL_PROVIDER_ID,
  MANAGED_FLAGS,
} from './capabilities.ts'
import type { SandboxMode } from './wire.ts'
import type { Approvals } from '../../../shared/run.ts'

/** Codex's built-in server for the apps connected to the account (it is not in config.toml). */
export const CODEX_APPS = 'codex_apps'

// ---- extraArgs / flagMap ----------------------------------------------------------------------------------------

const flagName = (arg: string): string =>
  arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
/** Spelling-insensitive identity of a flag (`--skip-git-repo-check` ≡ `--skip_git_repo_check`). */
const flagKey = (arg: string): string => flagName(arg).replace(/^-+/, '').toLowerCase().replace(/[-_]/g, '')
const MANAGED_KEYS = new Set(MANAGED_FLAGS.map(flagKey))
const FORBIDDEN_KEYS = new Set(FORBIDDEN_FLAGS.map(flagKey))
const CLI_FLAG_KEYS = new Set(CLI_FLAGS.map(flagKey))
const isManaged = (arg: string): boolean => (MANAGED_FLAGS as readonly string[]).includes(flagName(arg))

const CONFIG_KEY = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/

/** A `-c key=value` override extraArgs may carry: a plain dotted key that leaves the sandbox and approvals alone. */
export function configOverrideProblem(kv: string): string | undefined {
  const eq = kv.indexOf('=')
  if (eq <= 0) return `"${kv.slice(0, 40)}" is not key=value`
  const key = kv.slice(0, eq).trim()
  if (!CONFIG_KEY.test(key)) return `"${key.slice(0, 40)}" is not a plain dotted config key`
  const head = (key.split('.')[0] ?? '').toLowerCase()
  if ((FORBIDDEN_CONFIG_KEYS as readonly string[]).includes(head)) {
    return `extraArgs may not set ${key}; Harpoon sets the sandbox, approvals, provider and tools per pass`
  }
  return undefined
}

/**
 * Codex extraArgs are root `-c` overrides only: `-c key=value` / `--config key=value` / `--config=key=value`
 * pairs, never a flag, and never a key that changes the sandbox, approvals, provider or tools.
 */
export function extraArgsProblem(extraArgs: readonly string[] | undefined): string | undefined {
  const list = extraArgs ?? []
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!
    if (/[\r\n\0]/.test(a)) return `extraArgs entry ${JSON.stringify(a.slice(0, 40))} contains a newline`
    let kv: string | undefined
    if (a === '-c' || a === '--config') {
      kv = list[++i]
      if (kv === undefined) return `extraArgs ends with ${a} and no key=value`
      if (/[\r\n\0]/.test(kv)) return `extraArgs entry ${JSON.stringify(kv.slice(0, 40))} contains a newline`
    } else if (a.startsWith('--config=')) kv = a.slice('--config='.length)
    else if (a.startsWith('-')) {
      const name = flagName(a)
      if (MANAGED_KEYS.has(flagKey(a))) return `extraArgs may not set ${name}; Harpoon manages it`
      if (FORBIDDEN_KEYS.has(flagKey(a)) || /^dangerously/.test(flagKey(a)))
        return `extraArgs may not set ${name}; it widens what a pass may do`
      return `extraArgs for Codex are -c key=value overrides only (got ${name})`
    } else
      return `extraArgs for Codex are -c key=value overrides only (got ${JSON.stringify(a.slice(0, 40))})`
    const problem = configOverrideProblem(kv)
    if (problem !== undefined) return problem
  }
  return undefined
}

const LONG_FLAG = /^--[A-Za-z][\w-]*$/

/** flagMap may rename a managed flag only to a long flag the CLI does not already define. */
export function flagMapProblem(flagMap: Readonly<Record<string, string>> | undefined): string | undefined {
  const targets = new Set<string>()
  for (const [from, to] of Object.entries(flagMap ?? {})) {
    if (!isManaged(from)) return `flagMap key ${from} is not a flag Harpoon manages`
    if (!LONG_FLAG.test(to)) return `flagMap value ${JSON.stringify(to)} is not a long flag name (--name)`
    const key = flagKey(to)
    if (FORBIDDEN_KEYS.has(key) || /^dangerously/.test(key))
      return `flagMap may not rename ${from} to ${to}; that flag widens what a pass may do`
    if (key !== flagKey(from) && MANAGED_KEYS.has(key))
      return `flagMap may not rename ${from} to ${to}; Harpoon manages ${to} itself`
    if (key !== flagKey(from) && CLI_FLAG_KEYS.has(key))
      return `flagMap may not rename ${from} to ${to}; Codex already uses ${to} for something else`
    if (targets.has(key)) return `flagMap renames two flags to ${to}`
    targets.add(key)
  }
  return undefined
}

export function applyFlagMap(
  argv: readonly string[],
  flagMap: Readonly<Record<string, string>> | undefined,
): string[] {
  if (flagMap === undefined || Object.keys(flagMap).length === 0) return [...argv]
  return argv.map((arg) => {
    const name = flagName(arg)
    const to = flagMap[name]
    if (to === undefined || !isManaged(name)) return arg
    return name === arg ? to : `${to}${arg.slice(name.length)}`
  })
}

// ---- passes -----------------------------------------------------------------------------------------------------

/** Steps that run read-only and ephemeral (read-only passes = read-only sandbox, approvals never, ephemeral). */
export const READ_ONLY_STEPS: readonly StartStep[] = ['plan', 'review', 'critic', 'heal', 'catalog', 'design']

export const isReadOnlyStep = (step: StartStep): boolean => READ_ONLY_STEPS.includes(step)

/** The mode table: sandbox + approval policy per pass. Full mode comes only from Auto (the engine's rule). */
export function sandboxFor(
  step: StartStep,
  mode: 'readonly' | 'autoedit' | 'full',
  approvals?: Approvals,
): {
  sandbox: SandboxMode
  approvalPolicy: 'never' | 'on-request' | 'untrusted'
  /** Who answers the pass's approval requests: the user, or Codex's own reviewer (Harpoon's Auto). */
  reviewer: 'user' | 'auto_review'
} {
  if (isReadOnlyStep(step) || mode === 'readonly') return { sandbox: 'read-only', approvalPolicy: 'never', reviewer: 'user' }
  // Harpoon's Implement: never full access; manual asks before anything not known safe, auto lets Codex review.
  if (approvals === 'manual') return { sandbox: 'workspace-write', approvalPolicy: 'untrusted', reviewer: 'user' }
  if (approvals === 'auto') return { sandbox: 'workspace-write', approvalPolicy: 'on-request', reviewer: 'auto_review' }
  if (approvals === 'acceptEdits') return { sandbox: 'workspace-write', approvalPolicy: 'on-request', reviewer: 'user' }
  if (mode === 'full') return { sandbox: 'danger-full-access', approvalPolicy: 'never', reviewer: 'user' }
  return { sandbox: 'workspace-write', approvalPolicy: 'on-request', reviewer: 'user' }
}

/** Ephemeral threads cannot be resumed: only read-only steps, never Implement or Fix. */
export const ephemeralFor = (step: StartStep): boolean => isReadOnlyStep(step) && step !== 'design'

// ---- local preset ------------------------------------------------------------------------------------------------

export interface ProviderTable {
  name: string
  base_url: string
  wire_api: 'responses'
  env_key?: string
}

export function providerTable(p: LocalPreset): ProviderTable {
  return {
    name: p.label,
    base_url: p.baseUrl,
    wire_api: 'responses',
    ...(p.apiKeyEnv !== undefined ? { env_key: p.apiKeyEnv } : {}),
  }
}

/** thread/start `config` entries for the preset (X13 decides inline table vs dotted keys). */
export function localProviderConfig(p: LocalPreset): Record<string, string | ProviderTable> {
  const t = providerTable(p)
  if (LOCAL_PROVIDER_FORM === 'inline') return { [`model_providers.${LOCAL_PROVIDER_ID}`]: t }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(t) as [string, string][])
    out[`model_providers.${LOCAL_PROVIDER_ID}.${k}`] = v
  return out
}

/** A TOML basic string (JSON's escapes are valid TOML; no raw newline ever reaches argv). */
export const tomlString = (s: string): string => JSON.stringify(s)

function tomlInline(t: object): string {
  return `{${Object.entries(t)
    .map(([k, v]) => `${k}=${tomlString(String(v))}`)
    .join(',')}}`
}

/** exec: the same provider as `-c` overrides (never `--oss` / `--local-provider`). */
export function localProviderArgs(p: LocalPreset): string[] {
  const t = providerTable(p)
  const def =
    LOCAL_PROVIDER_FORM === 'inline'
      ? ['-c', `model_providers.${LOCAL_PROVIDER_ID}=${tomlInline(t)}`]
      : Object.entries(t).flatMap(([k, v]) => [
          '-c',
          `model_providers.${LOCAL_PROVIDER_ID}.${k}=${tomlString(String(v))}`,
        ])
  return [...def, '-c', `model_provider=${tomlString(LOCAL_PROVIDER_ID)}`]
}

// ---- argv -------------------------------------------------------------------------------------------------------

/** One private app-server per pass, never the shared daemon. Root `-c` extraArgs come first. */
export function appServerArgv(o: {
  extraArgs?: readonly string[] | undefined
  flagMap?: Readonly<Record<string, string>> | undefined
}): string[] {
  return applyFlagMap([...(o.extraArgs ?? []), 'app-server', '--listen', 'stdio://'], o.flagMap)
}

export interface ExecArgvInput {
  step: StartStep
  mode: 'readonly' | 'autoedit' | 'full'
  approvals?: Approvals | undefined
  cwd: string
  model?: string | null | undefined
  effort?: string | null | undefined
  /** `-o` target (the final message; written only when the turn completes). */
  outFile: string
  /** `--output-schema` file (X17 catalog). */
  schemaFile?: string | undefined
  /** `resume <UUID>` (Fix reuse, P19 resume). */
  resumeId?: string | undefined
  local?: LocalPreset | undefined
  extraArgs?: readonly string[] | undefined
  flagMap?: Readonly<Record<string, string>> | undefined
  /** Harpoon design passes: the MCP server to attach. */
  mcp?: { name: string; url: string; tokenEnv: string; disable?: string[] | undefined; allow?: string[] | undefined } | undefined
}

/**
 * Exec fallback:
 * `codex exec --json --color never --skip-git-repo-check --sandbox <m> --cd <cwd> -c approvals_reviewer="user" [-m]
 * -o <out> [resume <UUID>] -`. Every flag goes before `resume`; the prompt is stdin (`-`). Never `--full-auto`,
 * `--approve-for-me`, `--oss` or `--local-provider`, and never `--ephemeral` on Implement or Fix.
 */
export function execArgv(i: ExecArgvInput): string[] {
  const { sandbox, reviewer } = sandboxFor(i.step, i.mode, i.approvals)
  // The pass's own model first, else the local preset's (params.ts modelOf).
  const model = i.model !== undefined && i.model !== null && i.model.trim() !== '' ? i.model : i.local?.model
  const a = [
    ...(i.extraArgs ?? []),
    'exec',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--sandbox',
    sandbox,
    '--cd',
    i.cwd,
    '-c',
    `approvals_reviewer=${tomlString(reviewer)}`,
  ]
  if (model !== undefined) a.push('-m', model)
  if (i.effort !== undefined && i.effort !== null && /^[a-z]+$/.test(i.effort)) a.push('-c', `model_reasoning_effort=${tomlString(i.effort)}`)
  if (i.local !== undefined) a.push(...localProviderArgs(i.local))
  // X17: the catalog refresh searches the web (Codex cannot limit hosts; the answer's sources are validated after).
  if (i.step === 'catalog') a.push('-c', `web_search=${tomlString('live')}`)
  if (i.mcp !== undefined) {
    const k = `mcp_servers.${i.mcp.name}`
    a.push('-c', `${k}.url=${tomlString(i.mcp.url)}`)
    a.push('-c', `${k}.bearer_token_env_var=${tomlString(i.mcp.tokenEnv)}`)
    a.push('-c', `${k}.default_tools_approval_mode=${tomlString('approve')}`)
    for (const other of i.mcp.disable ?? []) if (other !== i.mcp.name && !(i.mcp.allow ?? []).includes(other) && /^[A-Za-z0-9_-]+$/.test(other)) a.push('-c', `mcp_servers.${other}.enabled=false`)
    for (const s of i.mcp.allow ?? []) if (s !== CODEX_APPS && /^[A-Za-z0-9_-]+$/.test(s)) a.push('-c', `mcp_servers.${s}.default_tools_approval_mode=${tomlString('approve')}`)
    if (!(i.mcp.allow ?? []).includes(CODEX_APPS)) a.push('-c', 'features.apps=false')
  }
  if (i.schemaFile !== undefined) a.push('--output-schema', i.schemaFile)
  if (ephemeralFor(i.step) && i.resumeId === undefined) a.push('--ephemeral')
  a.push('-o', i.outFile)
  if (i.resumeId !== undefined) a.push('resume', i.resumeId)
  a.push('-')
  return applyFlagMap(a, i.flagMap)
}

// ---- env --------------------------------------------------------------------------------------------------------

export interface CodexEnvOptions {
  path?: string | undefined
  pathPrepend?: readonly string[] | undefined
  /** `vendors.codex.env` plus StartOptions.env, applied after everything Harpoon sets. */
  vendorEnv?: EnvInput | undefined
  platform?: NodeJS.Platform
}

/** sanitizeEnv for a Codex child: CODEX_SANDBOX* and the rest of the sanitized list removed, `codex-path` first. */
export function codexEnv(base: EnvInput, o: CodexEnvOptions = {}): Record<string, string> {
  return sanitizeEnv(base, {
    purpose: 'vendor',
    vendor: 'codex',
    ...(o.path !== undefined ? { path: o.path } : {}),
    ...(o.pathPrepend !== undefined ? { pathPrepend: o.pathPrepend } : {}),
    ...(o.vendorEnv !== undefined ? { vendorEnv: o.vendorEnv } : {}),
    ...(o.platform !== undefined ? { platform: o.platform } : {}),
  })
}
