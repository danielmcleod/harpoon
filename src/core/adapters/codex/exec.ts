// One Codex pass on the no-relay fallback, `codex exec --json` (chosen by the probe
// when the app-server schema lacks a required method; the "Codex exec (fallback)" mode row). All root flags go
// before `resume`, the prompt is stdin (`-`, then stdin is closed), the final message comes from the `-o` file, and
// asks never reach the user (exec answers them itself: escalations are auto-denied, which the preflight relay check
// and support() copy say). Never `--full-auto`, `--approve-for-me`, `--oss` or `--local-provider`; never
// `--ephemeral` on Implement or Fix.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskDecision } from '../../../shared/events.ts'
import { stopChild } from '../../proc/kill.ts'
import { spawnChild } from '../../proc/spawn.ts'
import type { ChildHandle } from '../../proc/spawn.ts'
import { makeFailure } from '../errors.ts'
import type { AskCancelReason, StartOptions, StopReason } from '../types.ts'
import { execArgv } from './launch.ts'
import type { NormalizeStep } from './normalize.ts'
import { strictOutputSchema } from './params.ts'
import { KILL_FOR_REASON, CodexRunBase } from './run-base.ts'
import type { RunDeps } from './run-base.ts'
import { rec, str } from './wire.ts'

/** The thread id of an exec `thread.started` line, else undefined. */
function threadStartedId(frame: unknown): string | undefined {
  const f = rec(frame)
  return str(f?.['type']) === 'thread.started' ? str(f?.['thread_id']) : undefined
}

/** exec has no developer-instructions channel Harpoon uses on argv: the extra context leads the prompt. */
export function execPrompt(o: Pick<StartOptions, 'prompt' | 'systemAppend'>, resumed: boolean): string {
  const append = resumed ? undefined : o.systemAppend?.trim()
  return append !== undefined && append !== '' ? `${append}\n\n${o.prompt}` : o.prompt
}

export class CodexExecRun extends CodexRunBase {
  readonly route = 'exec' as const
  #dir: string | undefined
  #stopping: Promise<void> | undefined

  constructor(o: StartOptions, deps: RunDeps) {
    // exec has no collaborationMode: a Plan pass is always emulated (read-only + the plan template).
    super(o, deps, 'codex-exec', false)
    this.#launch().catch((err: unknown) => this.internalFailure(err))
  }

  /** exec relays nothing: there is never an ask to answer. */
  answer(_requestId: string, _decision: AskDecision, _why?: AskCancelReason): void {}

  stop(reason: StopReason): Promise<void> {
    this.stoppedBy ??= reason
    this.n.markKilled(KILL_FOR_REASON[reason])
    if (this.#stopping !== undefined) return this.#stopping
    const child = this.child
    if (child === undefined) {
      this.#stopping = this.exited.then(() => undefined)
      return this.#stopping
    }
    // No graceful step on this route (an interrupted exec turn emits nothing and exits 1): stdin, then the tree.
    this.#stopping = stopChild(child, { stdinWaitMs: 1_000 }).then(() => this.exited.then(() => undefined))
    return this.#stopping
  }

  async #launch(): Promise<void> {
    const o = this.o
    const problem = this.preSpawnProblem()
    if (problem !== undefined) {
      this.failBeforeSpawn(problem)
      return
    }
    const r = await this.resolveCli()
    if (r === undefined) return
    let dir: string
    try {
      dir = mkdtempSync(join(this.deps.tmpDir ?? tmpdir(), 'harpoon-codex-'))
    } catch (err) {
      this.failBeforeSpawn(
        makeFailure('disk_full', `Harpoon could not create a temporary folder: ${String(err)}`, {
          classifiedBy: 'harpoon',
        }),
      )
      return
    }
    this.#dir = dir
    const outFile = join(dir, 'last-message.txt')
    let schemaFile: string | undefined
    if (o.outputSchema !== undefined) {
      schemaFile = join(dir, 'output-schema.json')
      // The strict form Codex applies (params.ts strictOutputSchema, live X17).
      writeFileSync(schemaFile, JSON.stringify(strictOutputSchema(o.outputSchema)))
    }
    this.argv = execArgv({
      step: o.step,
      mode: o.mode,
      cwd: o.cwd,
      model: o.model,
      effort: o.effort,
      approvals: o.approvals,
      outFile,
      schemaFile,
      resumeId: this.resumeId,
      local: o.local,
      extraArgs: o.extraArgs,
      flagMap: o.flagMap,
      mcp: o.mcp,
    })
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
      this.#cleanup()
      this.failBeforeSpawn(this.spawnFailure(err, r.cli.command))
      return
    }
    this.child = child
    const out = this.#readStdout(child).catch((err: unknown) => this.internalFailure(err))
    const err = this.#drainStderr(child)
    await this.afterSpawn(child)
    if (this.stoppedBy !== undefined) {
      // A stop that came while spawning only waited for the exit: now there is a process to stop.
      this.#stopping = undefined
      void this.stop(this.stoppedBy)
    } else {
      // The prompt is read to EOF (`-`): a piped stdin left open would hang exec.
      void child
        .writeRaw(`${execPrompt(o, this.resumeId !== undefined)}\n`)
        .then(() => child.closeStdin())
        .catch(() => child.closeStdin())
    }
    const exit = await child.exited
    await Promise.all([out, err])
    let outText: string | undefined
    try {
      outText = readFileSync(outFile, 'utf8')
    } catch {
      outText = undefined
    }
    this.#cleanup()
    this.finish(exit.code, exit.signal, exit.ms, () =>
      this.n.execExit({
        outText,
        code: exit.code,
        signal: exit.signal,
        ranMs: exit.ms,
        stderrTail: child.stderrTail(20),
      }),
    )
  }

  async #readStdout(child: ChildHandle): Promise<void> {
    for await (const line of child.lines('stdout')) {
      if (line.trim() === '') continue
      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch {
        continue // exec prints only JSONL on stdout; a stray line is the raw log's
      }
      // The resume echo is checked before the line reaches the normalizer, so a different thread is never
      // reported as this pass's session (the engine would record it as Fix's) before the pass fails.
      const echoed = threadStartedId(frame)
      if (echoed !== undefined && this.resumeId !== undefined && echoed !== this.resumeId) {
        this.#resumeMismatch(echoed, this.resumeId)
        continue
      }
      this.#apply(this.n.execLine(frame))
    }
  }

  /** exec resumed another thread than the one asked for: fail the pass and stop the process (no session event). */
  #resumeMismatch(echoed: string, requested: string): void {
    // exec silently starts a new thread when a resume misses: never on a UUID,
    // but the echoed id is checked anyway.
    this.emit(
      this.n.fail(
        makeFailure(
          'resume_failed',
          `Codex resumed a different thread (${echoed}) than Harpoon asked for (${requested}).`,
          { raw: JSON.stringify({ requested, echoed }), classifiedBy: 'structured' },
        ),
      ),
    )
    const child = this.child
    if (child !== undefined) void stopChild(child, { stdinWaitMs: 0 }).catch(() => undefined)
  }

  async #drainStderr(child: ChildHandle): Promise<void> {
    try {
      for await (const _ of child.lines('stderr')) {
        // tail kept by spawn.ts
      }
    } catch {
      // the stream ended with the process
    }
  }

  #apply(step: NormalizeStep): void {
    this.emit(step)
    const session = step.events.find((e) => e.type === 'session')
    if (session?.type === 'session' && this.o.onSession !== undefined) {
      // exec has already started its turn: the id is recorded as soon as it is known.
      void this.o.onSession(session.id).catch(() => undefined)
    }
  }

  #cleanup(): void {
    const dir = this.#dir
    this.#dir = undefined
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }

  protected onInternalFailure(): void {
    const child = this.child
    if (child !== undefined && child.exitInfo() === null)
      void stopChild(child, { stdinWaitMs: 0 }).catch(() => undefined)
    this.#cleanup()
  }
}
