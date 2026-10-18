// The Codex adapter (app-server, exec fallback, local preset, probe): `codex app-server`
// over JSON-RPC (one private process per pass), the `codex exec --json` fallback when the probe finds a required
// method missing, the local-model preset (`local-<id>` → this adapter with StartOptions.local), the catalog refresh
// route (X17) and the Windows sandbox setup (vendor_setup). Registered in place of the registry's Codex stub.
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CheckResult } from '../../../shared/preflight.ts'
import type { ModelInfo, ProbeResult, ReadinessNeed, Support } from '../../../shared/vendors.ts'
import type { EnvInput } from '../../proc/env.ts'
import { getEnv } from '../../proc/env.ts'
import { resolvePathEnv } from '../../proc/path-env.ts'
import type { ResolveResult, ResolvedCli } from '../../proc/resolve-cli.ts'
import { resolveCli, toResolvedBinary } from '../../proc/resolve-cli.ts'
import { AdapterError, makeFailure } from '../errors.ts'
import { registerAdapter } from '../registry.ts'
import type {
  Adapter,
  CanResumeResult,
  ListModelsOptions,
  ProbeOptions,
  RunHandle,
  StartOptions,
  StopReason,
} from '../types.ts'
import { CodexAppServerRun } from './appserver.ts'
import type { CodexFacts } from './capabilities.ts'
import {
  CLI_FLAGS,
  CODEX_DISPLAY_NAME,
  CODEX_VENDOR,
  FORBIDDEN_FLAGS,
  MANAGED_FLAGS,
  SETUP_TIMEOUT_MS,
  TESTED_UP_TO,
  VERSION_FLOOR,
  VERSION_RECOMMENDED,
  codexCapabilities,
  codexSupport,
  defaultFacts,
} from './capabilities.ts'
import { codexCliSpec } from './cli-spec.ts'
import { OPENAI_BASE_URL_ENV } from './default-model.ts'
import { CodexExecRun } from './exec.ts'
import { appServerArgv, codexEnv, extraArgsProblem, flagMapProblem } from './launch.ts'
import { listLocalModels, localReadiness } from './local.ts'
import type { FetchFn } from './local.ts'
import {
  authCheck,
  binCheck,
  factsFrom,
  planCheck,
  probeHandshake,
  protocolCheck,
  protocolConfigCheck,
  runLoginStatus,
  runSchemaProbe,
  sandboxActions,
  versionCheck,
  winSandboxCheck,
} from './probe.ts'
import type { HandshakeResult, SchemaProbe } from './probe.ts'
import type { RunDeps, RunTiming, SpawnHook } from './run-base.ts'
import { codexHome, findRollout } from './session.ts'
import { runSandboxSetup } from './setup.ts'

export { CodexAppServerRun } from './appserver.ts'
export { CodexExecRun } from './exec.ts'
export { CodexNormalizer } from './normalize.ts'

export interface CodexAdapterOptions {
  /** `vendors.codex.path`. */
  configuredPath?: string | null
  /** `vendors.codex.env` (user config). */
  vendorEnv?: Record<string, string>
  /** `vendors.codex.{extraArgs,flagMap}`: the probe's app-server uses them like a pass does. */
  extraArgs?: string[]
  flagMap?: Record<string, string>
  /** Harpoon's own env (default process.env). */
  env?: EnvInput
  home?: string
  /** A fixed PATH for search and children (tests); default: path-env. */
  pathEnv?: string
  /** Working directory for the probe and the sandbox setup (default `<HARPOON_HOME>/tmp/probe-cwd`). */
  probeCwd?: string
  /** Where exec's `-o` files and the schema probe go (default the OS temp directory). */
  tmpDir?: string
  platform?: NodeJS.Platform
  now?: () => number
  timing?: Partial<RunTiming>
  /** Test seam: replaces binary resolution. */
  resolve?: (force: boolean) => Promise<ResolveResult>
  /** `configured`: look only at `configuredPath` (E2E hosts, never a real install); default the full search. */
  search?: 'all' | 'configured'
  /** Test seam: the local preset's HTTP (loopback only). */
  fetch?: FetchFn
  /** Test seam: what a probe would have found (route, the Windows sandbox) before any probe ran. */
  initialFacts?: Partial<CodexFacts>
  /** After spawn, before the first stdin write (procs.json). */
  onSpawn?: SpawnHook
}

const READINESS_TTL_MS = 60_000

/** The registry's Codex adapter plus what the executor and the tests reach for. */
export interface CodexAdapter extends Adapter {
  resolveBinary(force?: boolean): Promise<ResolveResult>
  /** What the last probe found (route, plan mode, the Windows sandbox): support() and start() read it. */
  facts(): CodexFacts
  /**
   * Authoritative preflight: `vendor.codex.auth` again (`codex login status`, token-free) within the
   * engine's budget; [] when the binary is gone or the check timed out (the probe's result stands).
   */
  recheckAuth(o: { timeoutMs: number }): Promise<CheckResult[]>
  /**
   * vendor_setup: windowsSandbox/setupStart{mode:'unelevated'} over a private app-server, waiting for
   * setupCompleted. Only `recovery.execute` (a user's click) calls it; the caller probes again afterwards.
   */
  vendorSetup(
    call: 'windowsSandbox/setupStart',
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; detail: string }>
}

export function createCodexAdapter(opts: CodexAdapterOptions = {}): CodexAdapter {
  const baseEnv: EnvInput = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const now = opts.now ?? Date.now
  const platform = opts.platform ?? process.platform
  let facts: CodexFacts = { ...defaultFacts(platform), ...opts.initialFacts }
  let resolved: Promise<ResolveResult> | undefined
  let probed: Promise<ProbeResult> | undefined

  const pathEnv = async (): Promise<string | undefined> =>
    opts.pathEnv ?? (await resolvePathEnv({ env: baseEnv })).path

  const resolveBinary = (force = false): Promise<ResolveResult> => {
    if (resolved === undefined || force) {
      const p = opts.resolve
        ? opts.resolve(force)
        : pathEnv().then((path) =>
            resolveCli(codexCliSpec, {
              configuredPath: opts.configuredPath ?? null,
              env: baseEnv,
              home,
              ...(path !== undefined ? { pathEnv: path } : {}),
              ...(opts.vendorEnv !== undefined ? { vendorEnv: opts.vendorEnv } : {}),
              ...(opts.search === 'configured' ? { candidates: 'configured' as const } : {}),
            }),
          )
      resolved = p
      p.catch(() => {
        if (resolved === p) resolved = undefined
      })
    }
    return resolved
  }

  const cliForRun = async (): Promise<ResolvedCli> => {
    const r = await resolveBinary()
    if (r.ok) return r.cli
    const raw = r.rejected.map((x) => `${x.path}: ${x.detail}`).join('\n')
    throw new AdapterError(
      makeFailure('cli_missing', 'Codex is not installed or could not be started.', {
        raw,
        classifiedBy: 'harpoon',
      }),
    )
  }

  const probeCwd = (): string => {
    const dir =
      opts.probeCwd ?? join(getEnv(baseEnv, 'HARPOON_HOME') ?? join(home, '.harpoon'), 'tmp', 'probe-cwd')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  const envFor = async (cli: ResolvedCli): Promise<Record<string, string>> =>
    codexEnv(baseEnv, {
      path: await pathEnv(),
      pathPrepend: cli.pathPrepend,
      vendorEnv: opts.vendorEnv,
      platform,
    })

  const runProbe = async (force: boolean): Promise<ProbeResult> => {
    const at = now()
    const r = await resolveBinary(force)
    const base = { vendor: CODEX_VENDOR, at }
    if (!r.ok) {
      facts = defaultFacts(platform)
      return {
        ...base,
        route: 'app-server',
        transport: 'codex-app-server',
        ok: false,
        checks: [binCheck(undefined, r.rejected, at)],
        capabilities: codexCapabilities(facts),
        models: [],
      }
    }
    const cli = r.cli
    const env = await envFor(cli)
    const cwd = probeCwd()
    const flagProblem = extraArgsProblem(opts.extraArgs) ?? flagMapProblem(opts.flagMap)
    const authP = runLoginStatus(cli, env, cwd).then((x) => authCheck(x, at))
    const schemaP: Promise<SchemaProbe> =
      flagProblem === undefined
        ? runSchemaProbe({
            cli,
            env,
            cwd,
            rootArgs: opts.extraArgs ?? [],
            ...(opts.tmpDir !== undefined ? { tmpDir: opts.tmpDir } : {}),
          })
        : Promise.resolve({ error: flagProblem })
    const handshakeP: Promise<HandshakeResult | undefined> =
      flagProblem === undefined
        ? probeHandshake({
            cli,
            env,
            cwd,
            args: appServerArgv({ extraArgs: opts.extraArgs, flagMap: opts.flagMap }),
            listModels: authP.then((a) => a.loggedIn),
            platform,
          })
        : Promise.resolve(undefined)
    const [auth, schema, handshake] = await Promise.all([authP, schemaP, handshakeP])
    facts = factsFrom({
      schema,
      handshake,
      platform,
      login: auth.account?.method,
      openaiBaseUrl: getEnv(env, OPENAI_BASE_URL_ENV, platform),
    })
    const sandbox = winSandboxCheck(facts.winSandbox, at)
    const checks: CheckResult[] = [
      binCheck(cli, r.rejected, at),
      versionCheck(cli.version, at),
      auth.check,
      flagProblem !== undefined ? protocolConfigCheck(flagProblem, at) : protocolCheck(schema, handshake, at),
      planCheck(facts, at),
      ...(sandbox !== undefined ? [sandbox] : []),
    ]
    const transport = facts.route === 'exec' ? 'codex-exec' : 'codex-app-server'
    const result: ProbeResult = {
      ...base,
      route: facts.route,
      transport,
      ok: !checks.some((c) => c.status === 'fail' && c.blocking),
      binary: toResolvedBinary(cli),
      version: cli.version,
      checks,
      capabilities: codexCapabilities(facts),
      models: handshake?.models ?? [],
    }
    if (auth.account !== undefined) result.account = auth.account
    return result
  }

  const support = (need: ReadinessNeed): Support => codexSupport(need, facts)

  const runDeps = (): RunDeps => ({
    resolve: cliForRun,
    baseEnv,
    pathEnv,
    vendorEnv: opts.vendorEnv,
    now,
    facts: { ...facts },
    tmpDir: opts.tmpDir,
    timing: opts.timing,
    onSpawn: opts.onSpawn,
  })

  const isCodexRun = (h: RunHandle): h is CodexAppServerRun | CodexExecRun =>
    h instanceof CodexAppServerRun || h instanceof CodexExecRun

  const adapter: CodexAdapter = {
    id: CODEX_VENDOR,
    displayName: CODEX_DISPLAY_NAME,
    // The probe picks the route; the registry reports the app-server transport until it says otherwise.
    get transport() {
      return facts.route === 'exec' ? 'codex-exec' : 'codex-app-server'
    },
    managedFlags: MANAGED_FLAGS,
    forbiddenFlags: FORBIDDEN_FLAGS,
    cliFlags: CLI_FLAGS,
    testedUpTo: TESTED_UP_TO,
    versionFloor: VERSION_FLOOR,
    versionRecommended: VERSION_RECOMMENDED,
    resolveBinary,
    facts: () => ({ ...facts }),

    probe(o: ProbeOptions = {}): Promise<ProbeResult> {
      if (probed === undefined || o.force === true) {
        const p = runProbe(o.force === true)
        probed = p
        p.catch(() => {
          if (probed === p) probed = undefined
        })
      }
      return probed
    },

    async readiness(cwd: string, need: ReadinessNeed): Promise<CheckResult[]> {
      const at = now()
      const check = (
        id: string,
        status: CheckResult['status'],
        title: string,
        detail: string,
        extra: Partial<CheckResult> = {},
      ): CheckResult => ({
        id: `pass.${need.pass}.readiness.${id}`,
        scope: 'pass',
        status,
        blocking: status === 'fail',
        title,
        detail,
        recovery: [],
        at,
        ttlMs: READINESS_TTL_MS,
        ...extra,
      })
      const out: CheckResult[] = []
      const s = support(need)
      const sandboxReason = s.reason?.startsWith('winSandbox-') === true
      if (s.status === 'unsupported') {
        out.push(
          check('mode', 'fail', 'Mode not available for Codex', s.copy, {
            category: sandboxReason ? 'sandbox_unavailable' : 'capability_missing',
            recovery: sandboxReason ? sandboxActions() : [],
          }),
        )
      } else {
        // Degraded passes like Claude's: core's pass.<p>.mode already warns with this copy (and pass.<p>.relay for a
        // route without a question relay; vendor.codex.winSandbox offers the sandbox setup), so the readiness check does
        // not say it a second time.
        out.push(check('mode', 'pass', 'Mode', s.copy))
      }
      if (need.resumeSessionId !== undefined) {
        const r = await adapter.canResume(need.resumeSessionId, cwd)
        out.push(
          r.ok
            ? check('resume', 'pass', 'Thread can be resumed', `Codex thread ${need.resumeSessionId}`)
            : check('resume', 'skip', 'Fix will start a fresh session', 'The Codex thread was not found.'),
        )
      }
      if (need.pass === 'catalog' || need.web === true) {
        out.push(check('web', 'pass', 'Web search', 'Codex searches the web live for this pass.'))
      }
      if (need.local !== undefined) {
        out.push(
          ...(await localReadiness({
            pass: need.pass,
            preset: need.local,
            at,
            ...(opts.fetch !== undefined ? { fetchFn: opts.fetch } : {}),
          })),
        )
      }
      return out
    },

    support,

    canResume(sessionId: string, _cwd: string): Promise<CanResumeResult> {
      // A rollout lookup under CODEX_HOME (session.ts): no process, no tokens. thread/resume takes the pass's cwd,
      // so the folder the thread started in does not decide (the engine's own cwd rule does).
      const file = findRollout(codexHome({ ...baseEnv, ...opts.vendorEnv }, home), sessionId)
      return Promise.resolve(file !== undefined ? { ok: true } : { ok: false, reason: 'cannot-resume' })
    },

    start(o: StartOptions): RunHandle {
      const deps = runDeps()
      return deps.facts.route === 'exec' ? new CodexExecRun(o, deps) : new CodexAppServerRun(o, deps)
    },

    answer(h: RunHandle, requestId, d, why): void {
      if (isCodexRun(h)) h.answer(requestId, d, why)
    },

    stop(h: RunHandle, reason: StopReason): Promise<void> {
      return isCodexRun(h) ? h.stop(reason) : Promise.resolve()
    },

    async recheckAuth(o: { timeoutMs: number }): Promise<CheckResult[]> {
      const r = await resolveBinary()
      if (!r.ok) return []
      const res = await runLoginStatus(r.cli, await envFor(r.cli), probeCwd(), o.timeoutMs)
      if (res.timedOut) return []
      return [authCheck(res, now()).check]
    },

    async listModels(o: ListModelsOptions = {}): Promise<ModelInfo[]> {
      if (o.local !== undefined) return listLocalModels(o.local, opts.fetch)
      return (await adapter.probe(o.force === true ? { force: true } : {})).models
    },

    async vendorSetup(call, params, signal) {
      if (call !== 'windowsSandbox/setupStart')
        return { ok: false, detail: `Harpoon does not run "${String(call)}".` }
      const mode = params['mode'] ?? 'unelevated'
      if (mode !== 'unelevated' || Object.keys(params).some((k) => k !== 'mode')) {
        return { ok: false, detail: 'Harpoon only runs the setup that needs no administrator rights.' }
      }
      const problem = extraArgsProblem(opts.extraArgs) ?? flagMapProblem(opts.flagMap)
      if (problem !== undefined) return { ok: false, detail: problem }
      const cli = await cliForRun()
      return runSandboxSetup({
        cli,
        args: appServerArgv({ extraArgs: opts.extraArgs, flagMap: opts.flagMap }),
        env: await envFor(cli),
        cwd: probeCwd(),
        signal,
        platform,
        timeoutMs: SETUP_TIMEOUT_MS,
      })
    },
  }
  return adapter
}

export const codexAdapter: CodexAdapter = createCodexAdapter()
registerAdapter(codexAdapter)
