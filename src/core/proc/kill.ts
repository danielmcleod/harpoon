// Stop and tree-kill: graceful step (adapter-supplied) → close stdin → hard kill.
// Classifying the stop (user_cancelled / timeout_hard / paused) is the engine's job; this reports what happened.
import { win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { systemRoot } from './path-env.ts'
import { findDescendants, isAlive, snapshotProcesses } from './ps.ts'
import type { ProcInfo, ProcSnapshot } from './ps.ts'
import { execCapture } from './spawn.ts'
import type { ChildHandle, ExitInfo } from './spawn.ts'

export const DEFAULT_GRACEFUL_WAIT_MS = 3000
export const DEFAULT_STDIN_WAIT_MS = 2000
export const DEFAULT_TERM_WAIT_MS = 2000
/** Processes started this long before the recorded spawn still count as ours (clock skew). */
export const START_SLACK_MS = 2000

export type StopHow = 'already-exited' | 'graceful' | 'stdin-closed' | 'killed'

export interface StopResult {
  how: StopHow
  exit: ExitInfo
  /** Descendants the hard kill found. win32: those the sweep after taskkill still saw (taskkill /T ends most first). */
  killed: number[]
}

export interface StopOptions {
  /** Adapter step: Claude `interrupt`, Codex `turn/interrupt`, ACP `session/cancel`. */
  graceful?: () => Promise<unknown>
  /** Budget for the graceful step plus the wait for exit. */
  gracefulWaitMs?: number
  stdinWaitMs?: number
  termWaitMs?: number
  platform?: NodeJS.Platform
  snapshot?: () => Promise<ProcSnapshot>
}

export type StoppableChild = Pick<
  ChildHandle,
  'pid' | 'pgid' | 'spawnAt' | 'exited' | 'exitInfo' | 'closeStdin'
>

async function waitExit(child: StoppableChild, ms: number): Promise<boolean> {
  if (child.exitInfo() !== null) return true
  if (ms <= 0) return false
  const timer = delay(ms, false, { ref: false })
  return Promise.race([child.exited.then(() => true), timer])
}

export async function stopChild(child: StoppableChild, opts: StopOptions = {}): Promise<StopResult> {
  const done = child.exitInfo()
  if (done !== null) return { how: 'already-exited', exit: done, killed: [] }
  const platform = opts.platform ?? process.platform

  // win32: the tree as it is now. The graceful step may end intermediate processes (a tool's shell) whose
  // children then hang off a dead ppid, invisible to taskkill /T and to a later ppid walk.
  const before =
    platform === 'win32' && (opts.graceful !== undefined || (opts.stdinWaitMs ?? DEFAULT_STDIN_WAIT_MS) > 0)
      ? treeOf(child.pid, child.spawnAt, opts)
      : Promise.resolve([])

  if (opts.graceful !== undefined) {
    const budget = opts.gracefulWaitMs ?? DEFAULT_GRACEFUL_WAIT_MS
    const start = Date.now()
    const step = opts.graceful().catch(() => undefined)
    await Promise.race([step, delay(budget, undefined, { ref: false }), child.exited])
    if (await waitExit(child, budget - (Date.now() - start))) {
      return { how: 'graceful', exit: await child.exited, killed: [] }
    }
  }

  child.closeStdin()
  if (await waitExit(child, opts.stdinWaitMs ?? DEFAULT_STDIN_WAIT_MS)) {
    return { how: 'stdin-closed', exit: await child.exited, killed: [] }
  }

  // `before` is not awaited here: under load a snapshot takes seconds, and the kill must not wait for it.
  const killOpts: KillTreeOptions = { spawnAt: child.spawnAt, platform, known: before }
  if (child.pgid !== undefined) killOpts.pgid = child.pgid
  if (opts.termWaitMs !== undefined) killOpts.termWaitMs = opts.termWaitMs
  if (opts.snapshot !== undefined) killOpts.snapshot = opts.snapshot
  const { killed } = await killTree(child.pid, killOpts)
  return { how: 'killed', exit: await child.exited, killed }
}

export interface KillTreeOptions {
  /** POSIX process group to signal (children spawned detached lead their own group). */
  pgid?: number
  /** Descendants started before spawnAt − 2 s are never touched (pid reuse guard). */
  spawnAt?: number
  termWaitMs?: number
  platform?: NodeJS.Platform
  snapshot?: () => Promise<ProcSnapshot>
  /**
   * Descendants seen earlier (stopChild: before the graceful step). Each is killed, with its live subtree, if the
   * same process (pid and start time) is still running, even when its parent has exited since.
   */
  known?: readonly ProcInfo[] | Promise<readonly ProcInfo[]>
}

/** A process counts as ours only if it started within [spawnAt − 2 s, spawnAt + 10 s]. */
export const START_WINDOW_AFTER_MS = 10_000

/** The descendants of `pid` now (never throws; [] when no snapshot can be taken). */
async function treeOf(
  pid: number,
  spawnAt: number,
  opts: { platform?: NodeJS.Platform; snapshot?: () => Promise<ProcSnapshot> },
): Promise<ProcInfo[]> {
  try {
    const snap = await (opts.snapshot ?? (() => snapshotProcesses(opts.platform)))()
    return findDescendants(snap.procs, [pid], { minStartMs: spawnAt - START_SLACK_MS })
  } catch {
    return []
  }
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig)
    return true
  } catch {
    return false
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function descendantsOf(pid: number, opts: KillTreeOptions): Promise<number[]> {
  try {
    const [snap, known] = await Promise.all([
      (opts.snapshot ?? (() => snapshotProcesses(opts.platform)))(),
      Promise.resolve(opts.known ?? []).catch(() => []),
    ])
    const minStartMs = opts.spawnAt === undefined ? undefined : opts.spawnAt - START_SLACK_MS
    const current = new Map(snap.procs.map((p) => [p.pid, p]))
    const stillRunning = known.filter((k) => {
      const now = current.get(k.pid)
      return now !== undefined && k.startMs !== null && now.startMs === k.startMs
    })
    // The root pid may already belong to another process (win32 sweeps after taskkill ended the root). Its
    // children all started after it did; the root's own children started before.
    const rootNow = current.get(pid)
    const reusedAt =
      opts.spawnAt !== undefined &&
      rootNow?.startMs != null &&
      (rootNow.startMs < opts.spawnAt - START_SLACK_MS ||
        rootNow.startMs > opts.spawnAt + START_WINDOW_AFTER_MS)
        ? rootNow.startMs
        : undefined
    const roots = [pid, ...stillRunning.map((k) => k.pid)]
    const found = findDescendants(snap.procs, roots, {
      ...(minStartMs === undefined ? {} : { minStartMs }),
      ...(reusedAt === undefined ? {} : { maxChildStartMs: reusedAt }),
    })
    const pids = new Set([...stillRunning.map((k) => k.pid), ...found.map((p) => p.pid)])
    pids.delete(pid)
    pids.delete(process.pid)
    return [...pids]
  } catch {
    return []
  }
}

export function taskkillPath(): string {
  return win32.join(systemRoot(), 'System32', 'taskkill.exe')
}

/**
 * Hard-kill a process tree. win32: `taskkill /PID <pid> /T /F` first, then a snapshot sweep that terminates the
 * descendants a ppid walk finds plus the `known` ones still running. The sweep runs after the root is gone, so it
 * also catches a child the root spawned while taskkill was walking the tree (Windows never reparents: its ppid
 * still names the root). Neither sees a process whose parent had already exited before the earliest snapshot
 * (its ppid names a pid that no longer exists); only a per-run Job Object would. POSIX: SIGTERM the group and the
 * descendants, SIGKILL whatever is left after `termWaitMs`.
 */
export async function killTree(pid: number, opts: KillTreeOptions = {}): Promise<{ killed: number[] }> {
  if (pid === process.pid || pid <= 0) return { killed: [] }
  const platform = opts.platform ?? process.platform

  if (platform === 'win32') {
    // taskkill walks the live tree itself, so the kill never waits on a snapshot (seconds under load).
    await execCapture(taskkillPath(), ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10_000 })
    if (isAlive(pid)) signal(pid, 'SIGKILL')
    const descendants = await descendantsOf(pid, opts)
    for (const d of descendants) if (isAlive(d)) signal(d, 'SIGKILL')
    return { killed: descendants }
  }

  const descendants = await descendantsOf(pid, opts)

  const termAll = (sig: NodeJS.Signals): void => {
    if (opts.pgid !== undefined) signal(-opts.pgid, sig)
    signal(pid, sig)
    for (const d of descendants) signal(d, sig)
  }
  const anyAlive = (): boolean =>
    (opts.pgid !== undefined && groupAlive(opts.pgid)) || isAlive(pid) || descendants.some(isAlive)

  termAll('SIGTERM')
  const deadline = Date.now() + (opts.termWaitMs ?? DEFAULT_TERM_WAIT_MS)
  while (anyAlive() && Date.now() < deadline) await delay(50)
  if (anyAlive()) termAll('SIGKILL')
  return { killed: descendants }
}
