// What both Codex routes share for one pass (the RunHandle contract): the handle's
// emitters, the exited promise, failures before any process exists, the guards that run before a spawn (flags, the
// Windows sandbox, the binary) and the stop classification. The app-server route (appserver.ts) and the exec fallback
// (exec.ts) add the process and the protocol.
import type { AdapterSignal, NormalizedEvent, Usage } from '../../../shared/events.ts'
import type { Failure } from '../../../shared/failure.ts'
import { isLoopbackHost } from '../../../shared/config-schema.ts'
import { newRequestId } from '../../../shared/ids.ts'
import type { Route } from '../../../shared/vendors.ts'
import type { HarpoonKill } from '../../heal/classify.ts'
import { classify } from '../../heal/classify.ts'
import type { EnvInput } from '../../proc/env.ts'
import type { ResolvedCli } from '../../proc/resolve-cli.ts'
import { SpawnError } from '../../proc/spawn.ts'
import type { ChildHandle } from '../../proc/spawn.ts'
import { AdapterError, BufferedEmitter, classifyFailure, errorEvent, makeFailure } from '../errors.ts'
import { META_RESUME_IGNORED } from '../types.ts'
import type { ExitInfo, RunHandle, StartOptions, StopReason, Unsubscribe } from '../types.ts'
import type { CodexFacts } from './capabilities.ts'
import {
  CODEX_VENDOR,
  EXIT_AFTER_TERMINAL_MS,
  FATAL_ERROR_WAIT_MS,
  INITIALIZE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  SESSION_PERSIST_TIMEOUT_MS,
  STOP_STDIN_WAIT_MS,
  STOP_TURN_WAIT_MS,
  effectiveMode,
  modeNeedsWinSandbox,
  winSandboxNotReady,
} from './capabilities.ts'
import { codexEnv, extraArgsProblem, flagMapProblem, isReadOnlyStep } from './launch.ts'
import { CodexNormalizer } from './normalize.ts'
import type { NormalizeStep } from './normalize.ts'

export type SpawnHook = (
  o: StartOptions,
  child: Pick<ChildHandle, 'pid' | 'pgid' | 'spawnAt' | 'command' | 'realCommand' | 'argv'>,
) => void | Promise<void>

export interface RunDeps {
  /** The CLI to spawn; rejects with an AdapterError (cli_missing, …) when there is none. */
  resolve(): Promise<ResolvedCli>
  baseEnv: EnvInput
  /** The resolved PATH for children (path-env); undefined = the base env's PATH. */
  pathEnv(): Promise<string | undefined>
  /** `vendors.codex.env` (user config); StartOptions.env is layered on top. */
  vendorEnv?: Record<string, string> | undefined
  now: () => number
  /** What the launch probe found (route, plan mode, token usage, the Windows sandbox), frozen at start. */
  facts: CodexFacts
  /** A directory for exec's `-o` / `--output-schema` files (default: the OS temp directory). */
  tmpDir?: string | undefined
  timing?: Partial<RunTiming> | undefined
  /** Called after spawn and before the first stdin write (the engine records procs.json here). */
  onSpawn?: SpawnHook | undefined
}

export interface RunTiming {
  /** initialize must answer within this (else flag_drift). */
  initializeMs: number
  /** thread/start, thread/resume, turn/start. */
  requestMs: number
  /** Stop: turn/interrupt, then wait this long for turn/completed. */
  stopTurnMs: number
  stopStdinMs: number
  /** After the terminal event the app-server is told to exit; it is killed if it lingers. */
  exitAfterTerminalMs: number
  /** onSession (the engine's run.json write) must answer within this before turn/start goes anyway. */
  sessionPersistMs: number
  /** error{willRetry:false} without a turn/completed within this ends the attempt. */
  fatalErrorWaitMs: number
  /** How long an answer waits on its sub-agents before the pass ends anyway. */
  backgroundMs: number
}

export const DEFAULT_TIMING: RunTiming = {
  initializeMs: INITIALIZE_TIMEOUT_MS,
  requestMs: REQUEST_TIMEOUT_MS,
  stopTurnMs: STOP_TURN_WAIT_MS,
  stopStdinMs: STOP_STDIN_WAIT_MS,
  exitAfterTerminalMs: EXIT_AFTER_TERMINAL_MS,
  sessionPersistMs: SESSION_PERSIST_TIMEOUT_MS,
  fatalErrorWaitMs: FATAL_ERROR_WAIT_MS,
  backgroundMs: 30 * 60_000,
}

export const KILL_FOR_REASON: Record<StopReason, HarpoonKill> = {
  user: 'stop',
  timeout: 'hard',
  shutdown: 'quit',
}

/** A local preset whose server is on this computer (the classifier reads an unreachable server as local_server). */
export function loopbackPreset(o: Pick<StartOptions, 'local'>): boolean {
  if (o.local === undefined) return false
  try {
    const host = new URL(o.local.baseUrl).hostname
    return isLoopbackHost(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host)
  } catch {
    return false
  }
}

/** Only edit passes continue a thread: read-only steps run ephemeral threads, which cannot be resumed. */
export function resumeIdFor(o: Pick<StartOptions, 'step' | 'resume'>): string | undefined {
  return isReadOnlyStep(o.step) && o.step !== 'design' ? undefined : o.resume?.sessionId
}

export abstract class CodexRunBase implements RunHandle {
  readonly id: string
  readonly vendor = CODEX_VENDOR
  abstract readonly route: Route
  readonly exited: Promise<ExitInfo>
  /** The argv after the binary's prefix args (set once the launch plan is built). */
  argv: string[] = []

  protected readonly o: StartOptions
  protected readonly deps: RunDeps
  protected readonly timing: RunTiming
  protected readonly n: CodexNormalizer
  /** The thread a resume continues (undefined: a new thread). */
  protected readonly resumeId: string | undefined
  protected readonly events = new BufferedEmitter<NormalizedEvent>()
  protected readonly signals = new BufferedEmitter<AdapterSignal>()
  protected child: ChildHandle | undefined
  protected stoppedBy: StopReason | undefined
  protected readonly startedAt: number
  #resolveExited: (e: ExitInfo) => void = () => undefined
  #finished = false
  #preSpawnTerminal = false

  constructor(o: StartOptions, deps: RunDeps, prefix: string, planNative: boolean) {
    this.id = newRequestId(prefix)
    this.o = o
    this.deps = deps
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
    this.startedAt = deps.now()
    this.resumeId = resumeIdFor(o)
    if (o.resume !== undefined && this.resumeId === undefined) {
      this.signals.emit({
        type: 'meta',
        key: META_RESUME_IGNORED,
        value: {
          route: 'readonly',
          reason: 'Read-only Codex passes run in a new thread; this one starts fresh.',
        },
      })
    }
    const prior: Usage | undefined = this.resumeId !== undefined ? o.resume?.priorUsage : undefined
    this.n = new CodexNormalizer({
      step: o.step,
      mode: o.mode,
      cwd: o.cwd,
      planNative,
      resumed: this.resumeId !== undefined,
      ...(prior !== undefined ? { priorUsage: prior } : {}),
      askTimeoutMs: o.askTimeoutMs,
      allowRules: o.allowRules,
      structured: o.outputSchema !== undefined,
      loopback: loopbackPreset(o),
      requestPrefix: `${this.id}:`,
      now: deps.now,
    })
    this.exited = new Promise((resolve) => {
      this.#resolveExited = resolve
    })
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  onEvent(cb: (e: NormalizedEvent) => void): Unsubscribe {
    return this.events.subscribe(cb)
  }

  onSignal(cb: (s: AdapterSignal) => void): Unsubscribe {
    return this.signals.subscribe(cb)
  }

  sessionId(): string | undefined {
    return this.n.sessionId() ?? this.resumeId
  }

  cumulativeUsage(): Usage | undefined {
    return this.n.cumulativeUsage()
  }

  pendingAsks(): string[] {
    return this.n.pendingAsks()
  }

  get finished(): boolean {
    return this.#finished
  }

  /** Emits what the normalizer returned: signals first (consumers read them before the events they explain). */
  protected emit(step: NormalizeStep): void {
    for (const s of step.signals) this.signals.emit(s)
    for (const e of step.events) this.events.emit(e)
  }

  /**
   * The guards before anything is spawned: the user's extraArgs / flagMap, and the Windows sandbox (an edit pass on
   * Windows without it would silently run read-only; never a silent downgrade). Returns the
   * failure, or undefined to go on.
   */
  protected preSpawnProblem(): Failure | undefined {
    const o = this.o
    const problem = extraArgsProblem(o.extraArgs) ?? flagMapProblem(o.flagMap)
    if (problem !== undefined) return makeFailure('config_invalid', problem, { classifiedBy: 'harpoon' })
    // Only a probe that read the sandbox `ready` lets an edit pass start (not probed yet, or no answer, is not
    // ready); full mode too until the live X11 recording confirms it needs no sandbox.
    if (winSandboxNotReady(this.deps.facts) && modeNeedsWinSandbox(effectiveMode(o.step, o.mode))) {
      const state = this.deps.facts.winSandbox
      const why =
        state === 'unknown' || state === 'unchecked'
          ? 'Harpoon could not check the Codex Windows sandbox'
          : 'The Codex Windows sandbox is not set up'
      return makeFailure(
        'sandbox_unavailable',
        `${why}, so Codex would silently run this edit pass read-only. Set up the sandbox, or check Codex again.`,
        { raw: `windowsSandbox/readiness: ${state}`, classifiedBy: 'harpoon' },
      )
    }
    return undefined
  }

  /** The CLI and the PATH, or the failure that ended the attempt (already emitted). */
  protected async resolveCli(): Promise<{ cli: ResolvedCli; path: string | undefined } | undefined> {
    try {
      const [cli, path] = await Promise.all([this.deps.resolve(), this.deps.pathEnv()])
      if (this.stoppedBy !== undefined) {
        this.failBeforeSpawn(this.stopFailure())
        return undefined
      }
      return { cli, path }
    } catch (err) {
      this.failBeforeSpawn(
        err instanceof AdapterError
          ? err.failure
          : makeFailure('cli_missing', err instanceof Error ? err.message : String(err), {
              classifiedBy: 'harpoon',
            }),
      )
      return undefined
    }
  }

  protected childEnv(cli: ResolvedCli, path: string | undefined): Record<string, string> {
    return codexEnv(this.deps.baseEnv, {
      path,
      pathPrepend: cli.pathPrepend,
      vendorEnv: { ...this.deps.vendorEnv, ...this.o.env },
    })
  }

  protected spawnFailure(err: unknown, command: string): Failure {
    const e = SpawnError.from(err, command)
    return classifyFailure({
      vendor: CODEX_VENDOR,
      errno: { code: e.code, message: e.message, ...(e.path !== undefined ? { path: e.path } : {}) },
      ...(loopbackPreset(this.o) ? { loopback: true } : {}),
      now: this.deps.now(),
    })
  }

  protected spawnLabel(): { purpose: 'pass' | 'heal' | 'catalog'; runId: string; step: string } {
    const s = this.o.step
    return {
      purpose: s === 'heal' ? 'heal' : s === 'catalog' ? 'catalog' : 'pass',
      runId: this.o.runId,
      step: s,
    }
  }

  /** The engine's bookkeeping (procs.json) before the first stdin write; it never fails the pass. */
  protected async afterSpawn(child: ChildHandle): Promise<void> {
    const hook = this.deps.onSpawn
    if (hook === undefined) return
    const { pid, pgid, spawnAt, command, realCommand, argv } = child
    try {
      await hook(this.o, { pid, pgid, spawnAt, command, realCommand, argv })
    } catch {
      // Bookkeeping must not fail the pass.
    }
  }

  protected stopFailure(): Failure {
    const kind = KILL_FOR_REASON[this.stoppedBy ?? 'user']
    return (
      classify({ vendor: CODEX_VENDOR, harpoonInitiated: { kind }, now: this.deps.now() }) ??
      makeFailure('user_cancelled', 'Harpoon is shutting down.', { classifiedBy: 'harpoon' })
    )
  }

  /** One fatal error and an exit with no process (flags, sandbox, binary, spawn). */
  protected failBeforeSpawn(failure: Failure): void {
    if (this.#finished) return
    this.#preSpawnTerminal = true
    this.#finished = true
    this.emit(this.n.fail(failure))
    if (!this.n.terminal) this.events.emit(errorEvent(failure, true))
    this.#resolveExited({
      code: null,
      signal: null,
      ...(this.stoppedBy !== undefined ? { stoppedBy: this.stoppedBy } : {}),
      sawTerminal: true,
      ranMs: this.deps.now() - this.startedAt,
    })
  }

  /** A bug in the adapter itself: end the attempt with one terminal error instead of hanging. */
  protected internalFailure(err: unknown): void {
    if (this.#finished) return
    const message = err instanceof Error ? err.message : String(err)
    if (!this.n.terminal && !this.#preSpawnTerminal) {
      this.#preSpawnTerminal = true
      this.emit(
        this.n.fail(makeFailure('unknown', `Codex adapter error: ${message}`, { classifiedBy: 'heuristic' })),
      )
    }
    this.onInternalFailure()
    this.#finished = true
    const child = this.child
    this.#resolveExited({
      code: child?.exitInfo()?.code ?? null,
      signal: child?.exitInfo()?.signal ?? null,
      ...(this.stoppedBy !== undefined ? { stoppedBy: this.stoppedBy } : {}),
      sawTerminal: true,
      ranMs: this.deps.now() - this.startedAt,
    })
  }

  /** The route's cleanup when the adapter itself failed (kill the process). */
  protected abstract onInternalFailure(): void

  /** The process is gone: the terminal event when none was emitted (`end`), then `exited`. */
  protected finish(code: number | null, signal: string | null, ms: number, end: () => NormalizeStep): void {
    if (this.#finished) return
    this.#finished = true
    const sawTerminal = this.n.terminal || this.#preSpawnTerminal
    this.emit(end())
    this.#resolveExited({
      code,
      signal,
      ...(this.stoppedBy !== undefined ? { stoppedBy: this.stoppedBy } : {}),
      sawTerminal,
      ranMs: ms,
    })
  }
}
