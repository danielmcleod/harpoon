// One Codex pass over a private `codex app-server --listen stdio://`: process and protocol, threads and turns,
// event mapping, approvals, plan text. The thread id is persisted from thread/start before turn/start; kill is
// turn/interrupt, then close stdin, then the tree.
//
// initialize{clientInfo:{name:'harpoon'}, capabilities:{experimentalApi: planNative}} → initialized →
// thread/start (or thread/resume{threadId, excludeTurns:true}, its echoed id asserted) with the pass's whole safety
// set → onSession(thread id) → (a pass with no model of its own: the model the thread answered checked against the
// account's list, model/list{includeHidden:true} when the picker's list lacks it; default-model.ts) →
// turn/start{input:[text], model? (that check's override), collaborationMode? (native Plan), outputSchema? (X17)}.
// The prompt only ever travels inside turn/start. Never the shared daemon.
import { setTimeout as delay } from 'node:timers/promises'
import type { AskDecision } from '../../../shared/events.ts'
import type { Failure } from '../../../shared/failure.ts'
import { redactRaw } from '../../heal/classify.ts'
import { stopChild } from '../../proc/kill.ts'
import { JsonRpcError, JsonRpcPeer } from '../../proc/jsonrpc.ts'
import type { RpcStreamError } from '../../proc/jsonrpc.ts'
import { spawnChild } from '../../proc/spawn.ts'
import type { ChildHandle } from '../../proc/spawn.ts'
import { makeFailure } from '../errors.ts'
import { META_MODEL_USED } from '../types.ts'
import type { AskCancelReason, SessionRecorded, StartOptions, StopReason } from '../types.ts'
import { ASK_METHODS, ELICITATION, REFUSED_METHODS } from './asks.ts'
import { KILL_FOR_REASON, CodexRunBase } from './run-base.ts'
import type { RunDeps } from './run-base.ts'
import { decideModel, fetchAccountModels, threadModelOf } from './default-model.ts'
import type { CodexModelDecision } from './default-model.ts'
import { appServerArgv, sandboxFor } from './launch.ts'
import type { NormalizeStep } from './normalize.ts'
import {
  initializeParams,
  modelOf,
  planCollaboration,
  threadResumeParams,
  threadStartParams,
  turnStartParams,
} from './params.ts'
import type { ThreadInput } from './params.ts'
import { REQUIRED_METHODS } from './protocol.ts'
import { isCollaborationRejected, isPeerClosed, isPeerTimeout } from './rpc.ts'
import type { Rec } from './wire.ts'
import { rec, str } from './wire.ts'

/** The SandboxPolicy tag thread/start answers for each SandboxMode Harpoon asks for. */
const POLICY_OF: Readonly<Record<string, string>> = {
  'read-only': 'readOnly',
  'workspace-write': 'workspaceWrite',
  'danger-full-access': 'dangerFullAccess',
}
const POLICY_RANK: Readonly<Record<string, number>> = { readOnly: 0, workspaceWrite: 1, dangerFullAccess: 2 }
/** A SandboxPolicy tag in words (protocol names stay in `raw`). */
const POLICY_WORDS: Readonly<Record<string, string>> = {
  readOnly: 'read-only',
  workspaceWrite: 'edits in the folder',
  dangerFullAccess: 'full access',
}

/**
 * What thread/start (or thread/resume) says the pass will actually run with, against what Harpoon asked for: a
 * narrower sandbox for an edit pass is the Windows downgrade (never silent); a wider one, or questions routed to
 * anyone but the user on a pass that asks, is refused. Unknown policies (an external sandbox) are not judged.
 */
export function threadPolicyProblem(
  requested: { sandbox: string; approvalPolicy: string },
  response: Rec | undefined,
): Failure | undefined {
  const got = str(rec(response?.['sandbox'])?.['type'])
  const want = POLICY_OF[requested.sandbox]
  if (got !== undefined && want !== undefined && got !== want) {
    const g = POLICY_RANK[got]
    const w = POLICY_RANK[want]
    if (g !== undefined && w !== undefined && g < w) {
      return makeFailure(
        'sandbox_unavailable',
        `Codex would run this pass ${POLICY_WORDS[got] ?? got} instead of ${POLICY_WORDS[want] ?? want}: without the Windows sandbox it cannot edit. Set up the Codex sandbox first.`,
        {
          raw: JSON.stringify({ requested: requested.sandbox, sandbox: response?.['sandbox'] }),
          classifiedBy: 'structured',
        },
      )
    }
    if (g !== undefined && w !== undefined && g > w) {
      return makeFailure(
        'config_invalid',
        `Codex would run this pass with more access (${POLICY_WORDS[got] ?? got}) than Harpoon asked for (${POLICY_WORDS[want] ?? want}). Check your Codex configuration.`,
        {
          raw: JSON.stringify({ requested: requested.sandbox, sandbox: response?.['sandbox'] }),
          classifiedBy: 'structured',
        },
      )
    }
  }
  const reviewer = str(response?.['approvalsReviewer'])
  if (requested.approvalPolicy !== 'never' && reviewer !== undefined && reviewer !== 'user') {
    return makeFailure(
      'config_invalid',
      `Codex would send this pass's questions to ${reviewer} instead of you. Check approvals_reviewer in your Codex configuration.`,
      { raw: JSON.stringify({ approvalsReviewer: reviewer }), classifiedBy: 'structured' },
    )
  }
  return undefined
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A method the app-server route cannot do without (the probe's required methods). */
export const isRequiredMethod = (method: string): boolean => REQUIRED_METHODS.some((r) => r.method === method)

export class CodexAppServerRun extends CodexRunBase {
  readonly route = 'app-server' as const
  /** The Plan pass runs Codex's native plan mode (collaborationMode), as the probe allows. */
  readonly planNative: boolean
  #peer: JsonRpcPeer | undefined
  #threadId: string | undefined
  /** turn/start was sent (a model call may be running). */
  #turnSent = false
  #stopping: Promise<void> | undefined
  #terminalWaiters: (() => void)[] = []
  #exitTimer: NodeJS.Timeout | undefined
  #fatalTimer: NodeJS.Timeout | undefined
  #stdinClosed = false

  constructor(o: StartOptions, deps: RunDeps) {
    const planNative =
      o.step === 'plan' && o.planNative && deps.facts.route === 'app-server' && deps.facts.planNative
    super(o, deps, 'codex', planNative)
    this.planNative = planNative
    this.#launch().catch((err: unknown) => this.internalFailure(err))
  }

  answer(requestId: string, decision: AskDecision, why?: AskCancelReason): void {
    const step = this.n.answer(requestId, decision, why)
    this.#apply(step)
    if (step.interrupt === true) void this.#interruptTurn()
  }

  stop(reason: StopReason): Promise<void> {
    this.stoppedBy ??= reason
    this.n.markKilled(KILL_FOR_REASON[reason])
    return this.#stop()
  }

  // ---- launch ---------------------------------------------------------------------------------------------

  async #launch(): Promise<void> {
    const o = this.o
    const problem = this.preSpawnProblem()
    if (problem !== undefined) {
      this.failBeforeSpawn(problem)
      return
    }
    const r = await this.resolveCli()
    if (r === undefined) return
    this.argv = appServerArgv({ extraArgs: o.extraArgs, flagMap: o.flagMap })
    let child: ChildHandle
    try {
      child = await spawnChild({
        cli: r.cli,
        args: this.argv,
        cwd: o.cwd,
        env: this.childEnv(r.cli, r.path),
        label: this.spawnLabel(),
        ...(o.tap !== undefined ? { tap: o.tap } : {}),
      })
    } catch (err) {
      this.failBeforeSpawn(this.spawnFailure(err, r.cli.command))
      return
    }
    this.child = child
    const peer = JsonRpcPeer.fromChild(child, { header: 'omit' })
    this.#peer = peer
    this.#wire(peer)
    const stderr = this.#drainStderr(child)
    await this.afterSpawn(child)
    if (this.stoppedBy !== undefined) {
      // A stop that came while spawning only waited for the exit: now there is a process to stop.
      this.#stopping = undefined
      void this.#stop()
    } else void this.#converse(peer).catch((err: unknown) => this.internalFailure(err))
    const exit = await child.exited
    await Promise.all([peer.done.catch(() => undefined), stderr])
    this.#clearTimers()
    this.#wakeTerminalWaiters()
    this.finish(exit.code, exit.signal, exit.ms, () =>
      this.n.end({ code: exit.code, signal: exit.signal, ranMs: exit.ms, stderrTail: child.stderrTail(20) }),
    )
  }

  /** stderr is kept as the child's tail (the classifier's evidence); it carries no protocol. */
  async #drainStderr(child: ChildHandle): Promise<void> {
    try {
      for await (const _ of child.lines('stderr')) {
        // tail kept by spawn.ts
      }
    } catch {
      // the stream ended with the process
    }
  }

  #wire(peer: JsonRpcPeer): void {
    for (const m of [...ASK_METHODS, ELICITATION, ...REFUSED_METHODS]) {
      peer.onRequest(m, (params, ctx) => {
        const out = this.n.request(m, params, ctx.id)
        this.#apply(out.step)
        return out.reply
      })
    }
    peer.onNotification('*', (params, method) => this.#notification(method, params))
    peer.onError((e) => this.#streamError(e))
  }

  #notification(method: string, params: unknown): void {
    const step = this.n.notification(method, params)
    this.#apply(step)
    if (step.fatalPending === true && this.#fatalTimer === undefined && !this.n.terminal) {
      this.#fatalTimer = setTimeout(() => {
        this.#fatalTimer = undefined
        if (this.n.terminal) return
        this.#apply(this.n.failNow({ stderrTail: this.child?.stderrTail(20) ?? [] }))
      }, this.timing.fatalErrorWaitMs)
      this.#fatalTimer.unref()
    }
  }

  #apply(step: NormalizeStep): void {
    this.emit(step)
    if (this.n.terminal) this.#afterTerminal()
  }

  #streamError(e: RpcStreamError): void {
    if (this.n.terminal) return
    if (e.reason === 'oversize') return // one dropped line (the raw log has its head); not a protocol break
    this.#apply(
      this.n.fail(
        makeFailure('stream_malformed', `Codex sent unreadable output (${e.message}).`, {
          raw: redactRaw(e.lines.join('\n')),
          classifiedBy: 'structured',
        }),
      ),
    )
    void this.#hardStop()
  }

  // ---- the conversation -------------------------------------------------------------------------------------

  async #converse(peer: JsonRpcPeer): Promise<void> {
    const o = this.o
    // 1. Handshake (bounded: a silent CLI has drifted).
    try {
      await peer.request('initialize', initializeParams(this.planNative), {
        timeoutMs: this.timing.initializeMs,
      })
      await peer.notify('initialized')
    } catch (err) {
      if (this.#over()) return
      if (isPeerTimeout(err)) {
        this.n.markKilled('handshake')
        void this.#hardStop()
        return
      }
      if (err instanceof JsonRpcError) {
        this.#apply(
          this.n.fail(
            makeFailure('flag_drift', `Codex rejected the startup handshake: ${err.message.slice(0, 300)}`, {
              raw: redactRaw(JSON.stringify({ method: 'initialize', code: err.code, message: err.message })),
              classifiedBy: 'structured',
            }),
          ),
        )
        void this.#hardStop()
      }
      return
    }
    if (this.#over()) return

    // 2. The thread: the whole safety set on every start and resume.
    const input: ThreadInput = {
      step: o.step,
      mode: o.mode,
      cwd: o.cwd,
      model: o.model,
      local: o.local,
      systemAppend: o.systemAppend,
      mcp: o.mcp,
    }
    const resumeId = this.resumeId
    const method = resumeId !== undefined ? 'thread/resume' : 'thread/start'
    let thread: Rec | undefined
    try {
      const result = await peer.request(
        method,
        resumeId !== undefined ? threadResumeParams(resumeId, input) : threadStartParams(input),
        { timeoutMs: this.timing.requestMs },
      )
      thread = rec(result)
    } catch (err) {
      this.#rpcFailed(method, err)
      return
    }
    if (this.#over()) return
    const threadId = str(rec(thread?.['thread'])?.['id'])
    if (threadId === undefined || threadId === '') {
      this.#failHard(
        makeFailure('stream_malformed', `Codex answered ${method} without a thread id.`, {
          raw: redactRaw(JSON.stringify(thread ?? null).slice(0, 2000)),
          classifiedBy: 'structured',
        }),
      )
      return
    }
    if (resumeId !== undefined && threadId !== resumeId) {
      this.#failHard(
        makeFailure(
          'resume_failed',
          `Codex resumed a different thread (${threadId}) than Harpoon asked for (${resumeId}).`,
          { raw: JSON.stringify({ requested: resumeId, echoed: threadId }), classifiedBy: 'structured' },
        ),
      )
      return
    }
    const policy = threadPolicyProblem(sandboxFor(o.step, o.mode), thread)
    if (policy !== undefined) {
      this.#failHard(policy)
      return
    }
    this.#threadId = threadId
    this.#apply(this.n.session(threadId))
    // The thread id is durable (run.json) before the first turn, strictly, so a failed write or a
    // wait the adapter gave up on ends the pass here, before any model call.
    const persisted = await this.#persistSession(threadId)
    if (this.#over()) return
    if (persisted !== undefined) {
      this.#failHard(persisted)
      return
    }

    // 3. A pass with no model of its own: the model the CLI resolved for this folder runs unless the account cannot use
    // it (live balanced run, default-model.ts); the step records the model that runs (META_MODEL_USED).
    let override: string | undefined
    if (modelOf(o) === undefined) {
      // A turn Codex reroutes to another model names the model that runs too (CodexNormalizer).
      this.n.tracksModel()
      const decision = await this.#decideModel(peer, thread)
      if (this.#over()) return
      override = decision.override
      // The model that runs, before the turn, as the thread named it; or that it named none (the card stops expecting
      // one). The default sent on turn/start in place of the thread's model is only
      // asked for (`{asked, replaced}`) until Codex confirms it runs (CodexNormalizer.expectModel).
      if (override !== undefined) this.n.expectModel(override, decision.replaced)
      this.signals.emit({
        type: 'meta',
        key: META_MODEL_USED,
        value:
          override !== undefined
            ? { asked: override, ...(decision.replaced !== undefined ? { replaced: decision.replaced } : {}) }
            : decision.runs !== undefined
              ? { model: decision.runs }
              : { model: null },
      })
    }

    // 4. The turn: the prompt travels only here. Native plan mode runs the model the turn runs (its settings name it).
    const model = override ?? str(thread?.['model'])
    let collaborationMode = this.planNative && model !== undefined ? planCollaboration(model) : undefined
    if (this.planNative && collaborationMode === undefined) {
      this.#apply(this.n.planFellBack('Codex did not name the model its plan mode needs'))
    }
    const turnParams = () =>
      turnStartParams({
        threadId,
        prompt: o.prompt,
        model: override,
        collaborationMode,
        outputSchema: o.outputSchema,
      })
    let turn: Rec | undefined
    try {
      this.#turnSent = true
      turn = rec(await peer.request('turn/start', turnParams(), { timeoutMs: this.timing.requestMs }))
    } catch (err) {
      if (collaborationMode !== undefined && isCollaborationRejected(err) && !this.#over()) {
        // X12: refused before any model call, so the emulated plan costs no retry (from the retry budget).
        this.#apply(this.n.planFellBack('Codex refused its plan mode', errorText(err).slice(0, 300)))
        collaborationMode = undefined
        try {
          turn = rec(await peer.request('turn/start', turnParams(), { timeoutMs: this.timing.requestMs }))
        } catch (err2) {
          this.#rpcFailed('turn/start', err2)
          return
        }
      } else {
        this.#turnSent = false
        this.#rpcFailed('turn/start', err)
        return
      }
    }
    const turnId = str(rec(turn?.['turn'])?.['id'])
    if (turnId !== undefined) this.n.turnStarted(turnId)
  }

  /**
   * Live balanced run: the model a pass with no model of its own runs (default-model.ts). The picker's list (the probe's)
   * is the first look; a model it lacks is checked against every model the account has (model/list with hidden ones,
   * token-free, asked here only) before Harpoon overrides it. No list, or one that cannot be read whole: the CLI's.
   */
  async #decideModel(peer: JsonRpcPeer, thread: Rec | undefined): Promise<CodexModelDecision> {
    const resolved = threadModelOf(thread)
    const first = decideModel(resolved, this.deps.facts.accountModels)
    if (first.why !== 'unlisted') return first
    const all = await fetchAccountModels((params) =>
      peer.request('model/list', params, { timeoutMs: this.timing.requestMs }),
    )
    return decideModel(resolved, all)
  }

  /**
   * onSession (the engine's run.json write), bounded: the failure that ends the pass when the id is not durable (the
   * write failed, the run no longer waits for this pass, or no answer within sessionPersistMs), else undefined. No
   * hook (outside a run): nothing to persist. Never races into turn/start.
   */
  async #persistSession(threadId: string): Promise<Failure | undefined> {
    const hook = this.o.onSession
    if (hook === undefined) return undefined
    const timedOut = Symbol('timeout')
    const r = await Promise.race([
      hook(threadId).catch((err: unknown): SessionRecorded => ({ ok: false, reason: errorText(err) })),
      delay(this.timing.sessionPersistMs, timedOut, { ref: false }),
    ])
    if (r !== timedOut && r.ok) return undefined
    const why =
      r === timedOut
        ? `Harpoon did not confirm within ${Math.round(this.timing.sessionPersistMs / 1000)} s that it saved the Codex thread id`
        : `Harpoon could not save the Codex thread id (${r.reason})`
    return makeFailure(
      r !== timedOut && r.code === 'ENOSPC' ? 'disk_full' : 'unknown',
      `${why}, so it did not start the turn. Nothing was sent to the model.`,
      {
        raw: JSON.stringify({ threadId, ...(r !== timedOut ? { reason: r.reason, code: r.code } : {}) }),
        classifiedBy: 'harpoon',
      },
    )
  }

  /** The pass is over or being stopped: no further request. */
  #over(): boolean {
    return this.n.terminal || this.finished || this.stoppedBy !== undefined
  }

  #rpcFailed(method: string, err: unknown): void {
    if (this.n.terminal || this.finished) return
    if (this.stoppedBy !== undefined) return // stop() ends the attempt
    if (isPeerClosed(err)) return // the process ended: end() classifies it with its stderr
    if (isPeerTimeout(err)) {
      this.#failHard(
        makeFailure(
          'unknown',
          `Codex did not answer ${method} within ${Math.round(this.timing.requestMs / 1000)} s.`,
          {
            classifiedBy: 'heuristic',
          },
        ),
      )
      return
    }
    if (err instanceof JsonRpcError) {
      this.#apply(
        this.n.failNow({
          // -32601 on a method the route requires is flag_drift (an optional one: capability_missing).
          rpcError: { method, code: err.code, message: err.message, required: isRequiredMethod(method) },
          stderrTail: this.child?.stderrTail(20) ?? [],
        }),
      )
      void this.#hardStop()
      return
    }
    this.internalFailure(err)
  }

  #failHard(f: Failure): void {
    this.#apply(this.n.fail(f))
    void this.#hardStop()
  }

  // ---- end of the turn, stop --------------------------------------------------------------------------------

  /** The terminal event is out: tell the app-server to exit (stdin closed) and kill it if it lingers. */
  #afterTerminal(): void {
    if (this.#fatalTimer !== undefined) {
      clearTimeout(this.#fatalTimer)
      this.#fatalTimer = undefined
    }
    this.#wakeTerminalWaiters()
    const child = this.child
    if (child === undefined || this.#exitTimer !== undefined || this.#stopping !== undefined) return
    // Let the replies to auto-cancelled requests go out first.
    setImmediate(() => this.#closeStdin())
    this.#exitTimer = setTimeout(() => {
      if (child.exitInfo() === null) void stopChild(child, { stdinWaitMs: 0 }).catch(() => undefined)
    }, this.timing.exitAfterTerminalMs)
    this.#exitTimer.unref()
  }

  #closeStdin(): void {
    if (this.#stdinClosed) return
    this.#stdinClosed = true
    this.child?.closeStdin()
  }

  #wakeTerminalWaiters(): void {
    const ws = this.#terminalWaiters
    this.#terminalWaiters = []
    for (const w of ws) w()
  }

  #waitTerminal(ms: number): Promise<void> {
    if (this.n.terminal || this.finished) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref()
      this.#terminalWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  async #interruptTurn(): Promise<void> {
    const peer = this.#peer
    const threadId = this.#threadId
    const turnId = this.n.turnId
    if (peer === undefined || threadId === undefined || turnId === undefined || peer.isClosed) return
    await peer
      .request('turn/interrupt', { threadId, turnId }, { timeoutMs: this.timing.stopTurnMs, retry: false })
      .catch(() => undefined)
  }

  #stop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping
    const child = this.child
    if (child === undefined) {
      // Still resolving or spawning: #launch sees stoppedBy and ends without a conversation.
      this.#stopping = this.exited.then(() => undefined)
      return this.#stopping
    }
    if (child.exitInfo() !== null) return this.exited.then(() => undefined)
    this.#stopping = (async () => {
      await stopChild(child, {
        graceful: async () => {
          if (this.#turnSent && !this.n.terminal) {
            await this.#interruptTurn()
            await this.#waitTerminal(this.timing.stopTurnMs)
          }
          this.#closeStdin()
        },
        gracefulWaitMs: this.timing.stopTurnMs + this.timing.stopStdinMs,
        stdinWaitMs: this.timing.stopStdinMs,
      })
      await this.exited
    })()
    return this.#stopping
  }

  /** Internal kill (handshake drift, a refused thread, unreadable output): close stdin, then the tree. */
  #hardStop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping
    const child = this.child
    if (child === undefined || child.exitInfo() !== null) return Promise.resolve()
    this.#closeStdin()
    this.#stopping = stopChild(child, { stdinWaitMs: 1_000 }).then(() => undefined)
    return this.#stopping
  }

  #clearTimers(): void {
    if (this.#exitTimer !== undefined) clearTimeout(this.#exitTimer)
    if (this.#fatalTimer !== undefined) clearTimeout(this.#fatalTimer)
    this.#exitTimer = undefined
    this.#fatalTimer = undefined
  }

  protected onInternalFailure(): void {
    this.#clearTimers()
    const child = this.child
    if (child !== undefined && child.exitInfo() === null)
      void stopChild(child, { stdinWaitMs: 0 }).catch(() => undefined)
  }
}
