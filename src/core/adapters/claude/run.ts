// One Claude Code process for one step attempt: spawn, initialize, user message, normalize, answer, stop
// (stdin frames, kill), then plan-file hygiene.
import { isClaudeAiConnector } from './launch.ts'
import { join } from 'node:path'
import type { AdapterSignal, AskDecision, NormalizedEvent, Usage } from '../../../shared/events.ts'
import type { Failure } from '../../../shared/failure.ts'
import { newRequestId, newUuid } from '../../../shared/ids.ts'
import type { Route } from '../../../shared/vendors.ts'
import type { HarpoonKill } from '../../heal/classify.ts'
import { classify, redactRaw } from '../../heal/classify.ts'
import type { EnvInput } from '../../proc/env.ts'
import { stopChild } from '../../proc/kill.ts'
import type { ResolvedCli } from '../../proc/resolve-cli.ts'
import { SpawnError, spawnChild } from '../../proc/spawn.ts'
import type { ChildHandle } from '../../proc/spawn.ts'
import { AdapterError, BufferedEmitter, classifyFailure, errorEvent, makeFailure } from '../errors.ts'
import { META_RESUME_IGNORED } from '../types.ts'
import type { AskCancelReason, ExitInfo, RunHandle, StartOptions, StopReason, Unsubscribe } from '../types.ts'
import {
  CLAUDE_VENDOR,
  INITIALIZE_TIMEOUT_MS,
  PLAN_RESULT_TIMEOUT_MS,
  SEND_INITIALIZE,
  STOP_RESULT_WAIT_MS,
  STOP_STDIN_WAIT_MS,
} from './capabilities.ts'
import {
  buildArgv,
  claudeConfigDir,
  claudeEnv,
  extraArgsProblem,
  flagMapProblem,
  routeFor,
} from './launch.ts'
import type { ClaudeRoute, ControlReply, NormalizeStep } from './normalize.ts'
import { ClaudeNormalizer } from './normalize.ts'
import type { PlanFileOps } from './plan-hygiene.ts'
import { cleanPlanFiles, planFilesNote } from './plan-hygiene.ts'
import type { StdinFrame } from './protocol.ts'
import { initializeRequest, interruptRequest, userMessage } from './protocol.ts'
import { scanShellAllowRules } from './settings-scan.ts'

export interface RunDeps {
  /** The CLI to spawn; rejects with an AdapterError (cli_missing, …) when there is none. */
  resolve(): Promise<ResolvedCli>
  baseEnv: EnvInput
  /** The resolved PATH for children (path-env); undefined = the base env's PATH. */
  pathEnv(): Promise<string | undefined>
  /** `vendors.claude.env` (user config); StartOptions.env is layered on top. */
  vendorEnv?: Record<string, string> | undefined
  home: string
  now: () => number
  readPlanFile?: (path: string) => string | undefined
  /** Plan-file hygiene file operations (default node:fs). */
  planFiles?: PlanFileOps | undefined
  timing?: Partial<RunTiming>
  /** Called after spawn and before the first stdin write (the engine records procs.json here). */
  onSpawn?: SpawnHook | undefined
}

export type SpawnHook = (
  o: StartOptions,
  child: Pick<ChildHandle, 'pid' | 'pgid' | 'spawnAt' | 'command' | 'realCommand' | 'argv'>,
) => void | Promise<void>

export interface RunTiming {
  initializeMs: number
  planResultMs: number
  stopResultMs: number
  stopStdinMs: number
}

const DEFAULT_TIMING: RunTiming = {
  initializeMs: INITIALIZE_TIMEOUT_MS,
  planResultMs: PLAN_RESULT_TIMEOUT_MS,
  stopResultMs: STOP_RESULT_WAIT_MS,
  stopStdinMs: STOP_STDIN_WAIT_MS,
}

const KILL_FOR_REASON: Record<StopReason, HarpoonKill> = { user: 'stop', timeout: 'hard', shutdown: 'quit' }

type Waiter = () => void

export class ClaudeRun implements RunHandle {
  readonly id: string
  readonly vendor = CLAUDE_VENDOR
  readonly route: Route = 'stdio'
  readonly exited: Promise<ExitInfo>
  /** The argv after the binary's prefix args (set once the launch plan is built). */
  argv: string[] = []
  readonly claudeRoute: ClaudeRoute

  readonly #o: StartOptions
  readonly #deps: RunDeps
  readonly #timing: RunTiming
  readonly #n: ClaudeNormalizer
  /** `${CLAUDE_CONFIG_DIR ?? ~/.claude}` as the child sees it. */
  readonly #configDir: string
  /** `--resume` target: only the edit route can continue a session (the others run without persistence). */
  readonly #resumeId: string | undefined
  readonly #events = new BufferedEmitter<NormalizedEvent>()
  readonly #signals = new BufferedEmitter<AdapterSignal>()
  readonly #replyWaiters = new Map<string, (r: ControlReply | undefined) => void>()
  #resultWaiters: Waiter[] = []
  #child: ChildHandle | undefined
  #presetSession: string | undefined
  #stoppedBy: StopReason | undefined
  #stopping: Promise<void> | undefined
  #writeChain: Promise<unknown> = Promise.resolve()
  #stdinClosed = false
  #planTimer: NodeJS.Timeout | undefined
  #startedAt: number
  #resolveExited: (e: ExitInfo) => void = () => undefined
  #preSpawnTerminal = false
  #userSent = false
  #finished = false

  constructor(o: StartOptions, deps: RunDeps) {
    this.id = newRequestId('claude')
    this.#o = o
    this.#deps = deps
    this.#timing = { ...DEFAULT_TIMING, ...deps.timing }
    this.claudeRoute = routeFor(o)
    this.#startedAt = deps.now()
    this.#resumeId = this.claudeRoute === 'edit' || o.step === 'design' ? o.resume?.sessionId : undefined
    if (o.resume !== undefined && this.#resumeId === undefined) {
      this.#signals.emit({
        type: 'meta',
        key: META_RESUME_IGNORED,
        value: {
          route: this.claudeRoute,
          reason: 'Only edit passes can resume a Claude session; this one starts fresh.',
        },
      })
    }
    const configDir = claudeConfigDir({ ...deps.baseEnv, ...deps.vendorEnv, ...o.env }, deps.home)
    this.#configDir = configDir
    this.#n = new ClaudeNormalizer({
      route: this.claudeRoute,
      resumed: this.#resumeId !== undefined,
      priorUsage: this.#resumeId !== undefined ? o.resume?.priorUsage : undefined,
      askTimeoutMs: o.askTimeoutMs,
      now: deps.now,
      allowRules: o.allowRules,
      cwd: o.cwd,
      home: deps.home,
      configDir,
      ...(deps.readPlanFile !== undefined ? { readPlanFile: deps.readPlanFile } : {}),
    })
    this.exited = new Promise((resolve) => {
      this.#resolveExited = resolve
    })
    this.#launch(configDir).catch((err: unknown) => this.#internalFailure(err))
  }

  get pid(): number | undefined {
    return this.#child?.pid
  }

  onEvent(cb: (e: NormalizedEvent) => void): Unsubscribe {
    return this.#events.subscribe(cb)
  }

  onSignal(cb: (s: AdapterSignal) => void): Unsubscribe {
    return this.#signals.subscribe(cb)
  }

  sessionId(): string | undefined {
    return this.#n.sessionId() ?? this.#presetSession
  }

  cumulativeUsage(): Usage | undefined {
    return this.#n.cumulativeUsage()
  }

  pendingAsks(): string[] {
    return this.#n.pendingAsks()
  }

  answer(requestId: string, decision: AskDecision, why?: AskCancelReason): void {
    this.#apply(this.#n.answer(requestId, decision, why))
    this.#maybeCloseStdin()
  }

  stop(reason: StopReason): Promise<void> {
    this.#stoppedBy ??= reason
    this.#n.markKilled(KILL_FOR_REASON[reason])
    return this.#stop()
  }

  // ---- launch ---------------------------------------------------------------------------------------------

  async #launch(configDir: string): Promise<void> {
    const o = this.#o
    const problem = extraArgsProblem(o.extraArgs) ?? flagMapProblem(o.flagMap)
    if (problem !== undefined) {
      this.#failBeforeSpawn(makeFailure('config_invalid', problem, { classifiedBy: 'harpoon' }))
      return
    }
    let cli: ResolvedCli
    let path: string | undefined
    try {
      ;[cli, path] = await Promise.all([this.#deps.resolve(), this.#deps.pathEnv()])
    } catch (err) {
      this.#failBeforeSpawn(
        err instanceof AdapterError
          ? err.failure
          : makeFailure('cli_missing', err instanceof Error ? err.message : String(err), {
              classifiedBy: 'harpoon',
            }),
      )
      return
    }
    if (this.#stoppedBy !== undefined) {
      this.#failBeforeSpawn(this.#stopFailure())
      return
    }

    const route = this.claudeRoute
    const resumeId = this.#resumeId
    if ((route === 'edit' || o.step === 'design') && resumeId === undefined) this.#presetSession = o.sessionId ?? newUuid()
    if (resumeId !== undefined) this.#presetSession = resumeId
    const disallowShell = route !== 'edit' && scanShellAllowRules(o.cwd, configDir).length > 0
    this.argv = buildArgv({
      route,
      mode: o.mode,
      step: o.step,
      model: o.model,
      effort: o.effort,
      sessionId: this.#presetSession,
      resumeId,
      nativeRules: o.allowRules.filter((r) => r.vendor === CLAUDE_VENDOR).flatMap((r) => r.nativeRules ?? []),
      disallowShell,
      ephemeral: o.ephemeral,
      extraArgs: o.extraArgs,
      flagMap: o.flagMap,
      // Only the catalog step reads it (launch.ts); `true` is web search without page fetches.
      webDomains: typeof o.web === 'object' ? o.web.allowedDomains : undefined,
      mcp: o.mcp !== undefined ? { name: o.mcp.name, configFile: o.mcp.configFile, allow: o.mcp.allow, readCode: o.mcp.readCode } : undefined,
      readDirs: o.step === 'design' || o.step === 'plan' ? o.readDirs : undefined,
    })
    const env = claudeEnv(this.#deps.baseEnv, {
      route,
      path,
      pathPrepend: cli.pathPrepend,
      vendorEnv: { ...this.#deps.vendorEnv, ...o.env },
      // The catalog refresh's and Harpoon's design passes' allow lists are exactly their argv (no settings rules, no
      // preapproved hosts).
      confined: o.step === 'catalog' || o.step === 'design',
      // Design passes never see the account's connectors, unless publishing through one (claude.ai Notion).
      noClaudeAiServers: o.step === 'design' && !(o.mcp?.allow ?? []).some(isClaudeAiConnector),
    })
    // An auth failure names ANTHROPIC_API_KEY only when the CLI really runs with it.
    this.#n.noteSpawnEnv(env)

    let child: ChildHandle
    try {
      child = await spawnChild({
        cli,
        args: this.argv,
        cwd: o.cwd,
        env,
        label: {
          purpose: o.step === 'heal' ? 'heal' : o.step === 'catalog' ? 'catalog' : 'pass',
          runId: o.runId,
          step: o.step,
        },
        ...(o.tap !== undefined ? { tap: o.tap } : {}),
      })
    } catch (err) {
      const e = SpawnError.from(err, cli.command)
      this.#failBeforeSpawn(
        classifyFailure({
          vendor: CLAUDE_VENDOR,
          errno: { code: e.code, message: e.message, ...(e.path !== undefined ? { path: e.path } : {}) },
          now: this.#deps.now(),
        }),
      )
      return
    }
    this.#child = child
    const fail = (e: unknown): void => this.#internalFailure(e)
    const out = this.#readStdout(child).catch(fail)
    const err = this.#readStderr(child).catch(fail)
    if (this.#deps.onSpawn !== undefined) {
      const { pid, pgid, spawnAt, command, realCommand, argv } = child
      try {
        await this.#deps.onSpawn(o, { pid, pgid, spawnAt, command, realCommand, argv })
      } catch {
        // Bookkeeping must not fail the pass.
      }
    }
    if (this.#stoppedBy !== undefined) {
      this.#stopping = undefined
      void this.#stop()
    } else void this.#converse(child)
    const exit = await child.exited
    await Promise.all([out, err])
    this.#finish(exit.code, exit.signal, exit.ms)
  }

  async #converse(child: ChildHandle): Promise<void> {
    if (SEND_INITIALIZE) {
      const requestId = newRequestId('init')
      const append = this.#resumeId === undefined ? this.#o.systemAppend : undefined
      const schema = this.#o.outputSchema
      const reply = this.#awaitReply(requestId, this.#timing.initializeMs)
      this.#write(
        initializeRequest(requestId, {
          ...(append !== undefined ? { appendSystemPrompt: append } : {}),
          // C17: the answer comes back in result.structured_output (the normalizer's structuredOutput meta).
          ...(schema !== undefined ? { jsonSchema: schema } : {}),
        }),
      )
      const r = await reply
      if (child.exitInfo() !== null || this.#n.terminal || this.#stoppedBy !== undefined) return
      if (r === undefined) {
        // C08c: a CLI that fails at startup never answers; one that is alive and silent has drifted.
        if (child.exitInfo() !== null || this.#n.terminal) return
        this.#n.markKilled('handshake')
        void this.#hardStop()
        return
      }
      if (!r.ok) {
        // systemAppend travels only in initialize: never run the pass without it.
        const error = redactRaw(r.error ?? 'error').slice(0, 300)
        this.#apply(
          this.#n.fail(
            makeFailure('flag_drift', `Claude Code rejected the startup handshake: ${error}`, {
              raw: redactRaw(JSON.stringify({ subtype: 'error', error: r.error ?? 'error' })),
              classifiedBy: 'structured',
            }),
          ),
        )
        void this.#hardStop()
        return
      }
    }
    this.#userSent = true
    this.#write(userMessage(this.#o.prompt))
  }

  #awaitReply(requestId: string, timeoutMs: number): Promise<ControlReply | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#replyWaiters.delete(requestId)
        resolve(undefined)
      }, timeoutMs)
      this.#replyWaiters.set(requestId, (r) => {
        clearTimeout(timer)
        this.#replyWaiters.delete(requestId)
        resolve(r)
      })
    })
  }

  async #readStdout(child: ChildHandle): Promise<void> {
    for await (const line of child.lines('stdout')) this.#apply(this.#n.line(line))
  }

  async #readStderr(child: ChildHandle): Promise<void> {
    for await (const line of child.lines('stderr')) this.#n.stderr(line)
  }

  #apply(step: NormalizeStep): void {
    for (const s of step.signals) this.#signals.emit(s)
    for (const e of step.events) this.#events.emit(e)
    for (const f of step.stdin) this.#write(f)
    if (step.reply !== undefined) this.#replyWaiters.get(step.reply.requestId)?.(step.reply)
    if (step.planCaptured === true && this.#planTimer === undefined) {
      this.#planTimer = setTimeout(() => {
        if (!this.#n.sawResult) void this.#hardStop()
      }, this.#timing.planResultMs)
      this.#planTimer.unref()
    }
    if (step.result === true || this.#n.terminal) this.#wakeResultWaiters()
    if (step.abort === true) void this.#hardStop()
    this.#maybeCloseStdin()
  }

  #write(frame: StdinFrame): void {
    const child = this.#child
    if (child === undefined || this.#stdinClosed) return
    this.#writeChain = this.#writeChain.then(() => child.writeLine(frame)).catch(() => false)
  }

  #closeStdin(): void {
    const child = this.#child
    if (child === undefined || this.#stdinClosed) return
    this.#stdinClosed = true
    this.#writeChain = this.#writeChain.then(() => child.closeStdin()).catch(() => undefined)
  }

  /** Close stdin after the first result, once no asks are pending. */
  #maybeCloseStdin(): void {
    if ((this.#n.sawResult || this.#n.terminal) && this.#n.pendingAsks().length === 0) this.#closeStdin()
  }

  #wakeResultWaiters(): void {
    const ws = this.#resultWaiters
    this.#resultWaiters = []
    for (const w of ws) w()
  }

  #waitForResult(ms: number): Promise<void> {
    if (this.#n.sawResult || this.#n.terminal) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      this.#resultWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  // ---- stop / finish --------------------------------------------------------------------------------------

  #stop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping
    const child = this.#child
    if (child === undefined) {
      // Still resolving: #launch sees #stoppedBy and finishes without spawning.
      this.#stopping = this.exited.then(() => undefined)
      return this.#stopping
    }
    if (child.exitInfo() !== null) return this.exited.then(() => undefined)
    this.#stopping = (async () => {
      await stopChild(child, {
        graceful: async () => {
          if (this.#userSent && !this.#n.sawResult && !this.#n.terminal) {
            this.#write(interruptRequest(newRequestId('stop')))
            await this.#waitForResult(this.#timing.stopResultMs)
          }
          this.#closeStdin()
          await this.#writeChain
        },
        gracefulWaitMs: this.#timing.stopResultMs,
        stdinWaitMs: this.#timing.stopStdinMs,
      })
      await this.exited
    })()
    return this.#stopping
  }

  /** Internal kill (handshake drift, plan-result timeout, fail-fast): close stdin, then kill the tree. */
  #hardStop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping
    const child = this.#child
    if (child === undefined || child.exitInfo() !== null) return Promise.resolve()
    this.#closeStdin()
    this.#stopping = stopChild(child, { stdinWaitMs: 500 }).then(() => undefined)
    return this.#stopping
  }

  #stopFailure(): Failure {
    const kind = KILL_FOR_REASON[this.#stoppedBy ?? 'user']
    return (
      classify({ vendor: CLAUDE_VENDOR, harpoonInitiated: { kind }, now: this.#deps.now() }) ??
      makeFailure('user_cancelled', 'Harpoon is shutting down.', { classifiedBy: 'harpoon' })
    )
  }

  #failBeforeSpawn(failure: Failure): void {
    this.#preSpawnTerminal = true
    this.#finished = true
    this.#events.emit(errorEvent(failure, true))
    this.#resolveExited({
      code: null,
      signal: null,
      ...(this.#stoppedBy !== undefined ? { stoppedBy: this.#stoppedBy } : {}),
      sawTerminal: true,
      ranMs: this.#deps.now() - this.#startedAt,
    })
  }

  /** A bug in the adapter itself: end the attempt with one terminal error instead of hanging. */
  #internalFailure(err: unknown): void {
    if (this.#finished) return
    const message = err instanceof Error ? err.message : String(err)
    if (!this.#n.terminal && !this.#preSpawnTerminal) {
      this.#preSpawnTerminal = true
      this.#events.emit(
        errorEvent(
          makeFailure('unknown', `Claude adapter error: ${message}`, { classifiedBy: 'heuristic' }),
          true,
        ),
      )
    }
    const child = this.#child
    if (child !== undefined && child.exitInfo() === null)
      void stopChild(child, { stdinWaitMs: 0 }).catch(() => undefined)
    this.#finished = true
    this.#resolveExited({
      code: child?.exitInfo()?.code ?? null,
      signal: child?.exitInfo()?.signal ?? null,
      ...(this.#stoppedBy !== undefined ? { stoppedBy: this.#stoppedBy } : {}),
      sawTerminal: true,
      ranMs: this.#deps.now() - this.#startedAt,
    })
  }

  /**
   * Plan-file hygiene: once the process is gone, delete the plan file Claude wrote for the plan this
   * pass captured (only this pass's own copy of the same text); report anything left in a `planFiles` note.
   */
  #cleanPlanFiles(): void {
    const capture = this.#n.planCapture()
    const child = this.#child
    if (this.claudeRoute !== 'plan' || capture === undefined || child === undefined) return
    try {
      const result = cleanPlanFiles({
        capture,
        plansDir: join(this.#configDir, 'plans'),
        home: this.#deps.home,
        spawnAtMs: child.spawnAt,
        ...(this.#deps.planFiles !== undefined ? { ops: this.#deps.planFiles } : {}),
      })
      const note = planFilesNote(result, this.#deps.home)
      if (note !== undefined) this.#signals.emit(note)
    } catch {
      // Hygiene never fails a pass.
    }
  }

  #finish(code: number | null, signal: string | null, ms: number): void {
    if (this.#finished) return
    this.#finished = true
    if (this.#planTimer !== undefined) clearTimeout(this.#planTimer)
    for (const w of [...this.#replyWaiters.values()]) w(undefined)
    this.#wakeResultWaiters()
    const sawTerminal = this.#n.terminal || this.#preSpawnTerminal
    this.#apply(this.#n.end({ code, signal, ranMs: ms }))
    this.#cleanPlanFiles()
    this.#resolveExited({
      code,
      signal,
      ...(this.#stoppedBy !== undefined ? { stoppedBy: this.#stoppedBy } : {}),
      sawTerminal,
      ranMs: ms,
    })
  }
}
