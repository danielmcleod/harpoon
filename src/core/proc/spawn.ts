// Child process spawning (spawn.spawnChild). No shell, hidden windows, piped stdio, LF-only
// NDJSON writes, UTF-8-safe line reads. The only module (with the rest of src/core/proc) allowed to spawn.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { DEFAULT_MAX_LINE_BYTES, LineSplitter } from './lines.ts'
import type { LineRecord } from './lines.ts'

export type TapDir = 'in' | 'out' | 'err'
/** Raw I/O tee (adapters route it through redactRawLine into runs/<id>/raw/). */
export type TapFn = (dir: TapDir, line: string) => void

export type SpawnPurpose =
  'pass' | 'probe' | 'heal' | 'verify' | 'catalog' | 'git' | 'resolve' | 'path-env' | 'ps'

export interface SpawnLabel {
  purpose: SpawnPurpose
  runId?: string
  step?: string
  attempt?: number
}

/** The spawnable part of a resolved CLI (resolve-cli's ResolvedCli satisfies it). */
export interface CliCommand {
  command: string
  prefixArgs: readonly string[]
}

export interface SpawnChildOptions {
  cli?: CliCommand
  /** Used when `cli` is absent. */
  command?: string
  args?: readonly string[]
  cwd: string
  /** Complete child env (build it with sanitizeEnv). */
  env: Readonly<Record<string, string>>
  label?: SpawnLabel | string
  maxLineBytes?: number
  tap?: TapFn
  /** Default: true on POSIX (own process group), false on win32 (the app's job object reaps the child). */
  detached?: boolean
  /** How long to wait for stdout/stderr to close after the process exits (a grandchild may hold the pipe). */
  stdioCloseGraceMs?: number
  /**
   * `ignore` gives the child no stdin (verify commands; a test runner then never waits for input). Writes answer
   * false. Default `pipe`.
   */
  stdin?: 'pipe' | 'ignore'
  /** win32: pass `args` to CreateProcess as they are (a batch invocation built by win-cmd.ts, already escaped). */
  windowsVerbatimArguments?: boolean
}

export interface ExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  /** Wall time from spawn to exit. */
  ms: number
}

export type StdStream = 'stdout' | 'stderr'

export interface ChildHandle {
  readonly pid: number
  /** POSIX process group id (the pid, since POSIX children are detached); undefined on win32. */
  readonly pgid: number | undefined
  readonly spawnAt: number
  readonly command: string
  /**
   * POSIX: `command` with symlinks resolved at spawn time (what /proc/<pid>/exe reports; the native Claude
   * installer links ~/.local/bin/claude → versions/<v>). Undefined on win32 or when it cannot be resolved.
   */
  readonly realCommand?: string | undefined
  readonly argv: readonly string[]
  readonly label: SpawnLabel | string | undefined
  /** Text lines of a stream (oversize records are skipped; see records()). Each stream can be consumed once. */
  lines(stream?: StdStream): AsyncIterable<string>
  records(stream?: StdStream): AsyncIterable<LineRecord>
  /** JSON.stringify(value) + '\n'. Resolves false when stdin is closed or broken (EPIPE folds into the exit). */
  writeLine(value: unknown): Promise<boolean>
  /** A single line of text + '\n' (rejects embedded newlines). */
  writeText(line: string): Promise<boolean>
  /**
   * Text as it is (a prompt read to EOF, e.g. `codex exec … -`); each line is tapped as `in`. Resolves false when
   * stdin is closed or broken.
   */
  writeRaw(text: string): Promise<boolean>
  closeStdin(): void
  readonly stdinOpen: boolean
  readonly exited: Promise<ExitInfo>
  exitInfo(): ExitInfo | null
  /** Last stderr lines (kept even when stderr is not consumed). */
  stderrTail(max?: number): string[]
  /** Raw signal to the direct child only (kill.ts does tree kills). */
  signal(sig?: NodeJS.Signals): boolean
}

/** ECWD: the working folder is missing (Node would report ENOENT on the binary, which reads as "not installed"). */
export type SpawnErrorCode = 'EARGV' | 'ESHIM' | 'ECWD' | (string & {})

export class SpawnError extends Error {
  readonly code: SpawnErrorCode
  readonly syscall: string | undefined
  readonly path: string | undefined

  constructor(code: SpawnErrorCode, message: string, extra: { syscall?: string; path?: string } = {}) {
    super(message)
    this.name = 'SpawnError'
    this.code = code
    this.syscall = extra.syscall
    this.path = extra.path
  }

  static from(err: unknown, command: string): SpawnError {
    if (err instanceof SpawnError) return err
    const e = err as NodeJS.ErrnoException
    const code = typeof e?.code === 'string' ? e.code : 'UNKNOWN'
    const message = e instanceof Error ? e.message : String(err)
    return new SpawnError(code, message, { syscall: e?.syscall ?? 'spawn', path: command })
  }
}

export const MAX_WIN_COMMAND_LINE = 32_000
const STDERR_TAIL_LINES = 200
const UNCLAIMED_CAP = 10_000

/** Length of the command line libuv builds on win32 (quoting approximated generously). */
export function windowsCommandLineLength(command: string, args: readonly string[]): number {
  let total = command.length + 3
  for (const a of args) {
    const quotes = (a.match(/["\\]/g) ?? []).length
    total += a.length + quotes + 3
  }
  return total
}

/** argv guard: no NUL/CR/LF anywhere; total under 32,000 chars on win32; never a .cmd/.bat without a shell. */
export function validateArgv(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  for (const [i, value] of [command, ...args].entries()) {
    if (/[\0\r\n]/.test(value)) {
      const what = i === 0 ? 'command' : `argv[${i - 1}]`
      throw new SpawnError('EARGV', `${what} contains a NUL or newline character`)
    }
  }
  if (platform === 'win32') {
    if (/\.(?:cmd|bat)$/i.test(command)) {
      throw new SpawnError('ESHIM', `refusing to spawn ${command} without a shell; resolve the shim first`, {
        path: command,
      })
    }
    const len = windowsCommandLineLength(command, args)
    if (len >= MAX_WIN_COMMAND_LINE) {
      throw new SpawnError('EARGV', `command line is ${len} chars; the limit is ${MAX_WIN_COMMAND_LINE}`)
    }
  }
}

class RecordQueue {
  private readonly items: LineRecord[] = []
  private readonly waiters: ((r: IteratorResult<LineRecord>) => void)[] = []
  private done = false
  private claimed = false

  push(rec: LineRecord): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter({ value: rec, done: false })
      return
    }
    this.items.push(rec)
    if (!this.claimed && this.items.length > UNCLAIMED_CAP) this.items.shift()
  }

  end(): void {
    this.done = true
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true })
  }

  claim(what: string): AsyncIterable<LineRecord> {
    if (this.claimed) throw new Error(`${what} is already being consumed`)
    this.claimed = true
    const next = (): Promise<IteratorResult<LineRecord>> => {
      const item = this.items.shift()
      if (item !== undefined) return Promise.resolve({ value: item, done: false })
      if (this.done) return Promise.resolve({ value: undefined, done: true })
      return new Promise((resolve) => this.waiters.push(resolve))
    }
    return { [Symbol.asyncIterator]: () => ({ next }) }
  }
}

async function* textOnly(records: AsyncIterable<LineRecord>): AsyncGenerator<string> {
  for await (const rec of records) if (rec.kind === 'line') yield rec.line
}

/**
 * Line records of one stdio stream. While `yieldBetweenChunks()` holds, the stream pauses after each chunk and
 * resumes on the next event-loop turn: on Windows libuv keeps reading a pipe for as long as data is waiting, so a
 * child writing faster than its lines are handled would starve the host's timers and IPC for the whole burst
 * (E26: seconds for a 5 MB stream). Callers stop yielding once the child exited, so its backlog is read at full
 * speed and the stdio close grace never cuts it short.
 */
export function pipeLines(
  stream: Readable,
  maxLineBytes: number,
  onRecord: (rec: LineRecord) => void,
  yieldBetweenChunks: () => boolean = () => false,
): { flush: () => void } {
  const splitter = new LineSplitter(maxLineBytes)
  let flushed = false
  stream.on('data', (chunk: Buffer) => {
    for (const rec of splitter.push(chunk)) onRecord(rec)
    if (!yieldBetweenChunks() || stream.destroyed) return
    stream.pause()
    setImmediate(() => {
      if (!stream.destroyed) stream.resume()
    })
  })
  stream.on('error', () => undefined)
  const flush = (): void => {
    if (flushed) return
    flushed = true
    for (const rec of splitter.end()) onRecord(rec)
  }
  stream.on('end', flush)
  return { flush }
}

/** Rejects with ECWD when the working folder is missing or not a directory. */
async function assertCwd(cwd: string): Promise<void> {
  const ok = await stat(cwd).then(
    (s) => s.isDirectory(),
    () => false,
  )
  if (!ok) throw new SpawnError('ECWD', `The working folder ${cwd} does not exist`, { path: cwd })
}

function writeWithCallback(stdin: Writable, data: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      stdin.write(data, (err) => resolve(err === null || err === undefined))
    } catch {
      resolve(false)
    }
  })
}

export async function spawnChild(opts: SpawnChildOptions): Promise<ChildHandle> {
  const command = opts.cli?.command ?? opts.command
  if (command === undefined || command === '')
    throw new SpawnError('EARGV', 'spawnChild needs cli or command')
  const argv = [...(opts.cli?.prefixArgs ?? []), ...(opts.args ?? [])]
  validateArgv(command, argv)
  await assertCwd(opts.cwd)

  const win = process.platform === 'win32'
  let realCommand: string | undefined
  if (!win && posix.isAbsolute(command)) {
    try {
      realCommand = await realpath(command)
    } catch {
      // gone or unreadable: the spawn below reports it
    }
  }
  const detached = opts.detached ?? !win
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
  const graceMs = opts.stdioCloseGraceMs ?? 2000
  const tap = opts.tap

  const stdinMode = opts.stdin ?? 'pipe'
  let child: ChildProcess
  try {
    child = spawn(command, argv, {
      cwd: opts.cwd,
      env: { ...opts.env },
      shell: false,
      windowsHide: true,
      detached,
      stdio: [stdinMode, 'pipe', 'pipe'],
      ...(opts.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    })
  } catch (err) {
    throw SpawnError.from(err, command)
  }
  const spawnAt = Date.now()
  const stdin = child.stdin
  const stdout = child.stdout
  const stderr = child.stderr
  if ((stdin === null && stdinMode === 'pipe') || stdout === null || stderr === null) {
    child.kill()
    throw new SpawnError('EPIPE', 'child stdio was not piped', { path: command })
  }

  const queues: Record<StdStream, RecordQueue> = { stdout: new RecordQueue(), stderr: new RecordQueue() }
  const errTail: string[] = []
  let alive = true
  const outPipe = pipeLines(
    stdout,
    maxLineBytes,
    (rec) => {
      if (tap !== undefined)
        tap('out', rec.kind === 'line' ? rec.line : `${rec.head}…[oversize ${rec.bytes} bytes]`)
      queues.stdout.push(rec)
    },
    () => alive,
  )
  const errPipe = pipeLines(
    stderr,
    maxLineBytes,
    (rec) => {
      const text = rec.kind === 'line' ? rec.line : `${rec.head}…[oversize ${rec.bytes} bytes]`
      if (tap !== undefined) tap('err', text)
      errTail.push(text)
      if (errTail.length > STDERR_TAIL_LINES) errTail.shift()
      queues.stderr.push(rec)
    },
    () => alive,
  )

  let stdinOpen = stdin !== null
  stdin?.on('error', () => {
    stdinOpen = false
  })
  stdin?.on('close', () => {
    stdinOpen = false
  })

  let exitInfo: ExitInfo | null = null
  let resolveExited: (e: ExitInfo) => void = () => undefined
  const exited = new Promise<ExitInfo>((resolve) => {
    resolveExited = resolve
  })
  let finalized = false
  const finalize = (): void => {
    if (finalized || exitInfo === null) return
    finalized = true
    outPipe.flush()
    errPipe.flush()
    queues.stdout.end()
    queues.stderr.end()
    stdinOpen = false
    resolveExited(exitInfo)
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      child.off('spawn', onSpawn)
      reject(SpawnError.from(err, command))
    }
    const onSpawn = (): void => {
      child.off('error', onError)
      resolve()
    }
    child.once('error', onError)
    child.once('spawn', onSpawn)
  })
  child.on('error', () => undefined)
  child.on('exit', (code, signal) => {
    alive = false
    exitInfo = { code, signal, ms: Date.now() - spawnAt }
    const timer = setTimeout(() => {
      stdout.destroy()
      stderr.destroy()
      finalize()
    }, graceMs)
    timer.unref()
  })
  child.on('close', () => finalize())

  const pid = child.pid ?? -1
  const writeText = async (line: string): Promise<boolean> => {
    if (line.includes('\n')) throw new Error('writeText: embedded newline')
    if (stdin === null || !stdinOpen || stdin.destroyed || stdin.writableEnded) return false
    tap?.('in', line)
    return writeWithCallback(stdin, `${line}\n`)
  }
  const writeRaw = async (text: string): Promise<boolean> => {
    if (stdin === null || !stdinOpen || stdin.destroyed || stdin.writableEnded) return false
    if (tap !== undefined) for (const l of text.replace(/\n$/, '').split('\n')) tap('in', l)
    return writeWithCallback(stdin, text)
  }

  return {
    pid,
    pgid: detached && !win ? pid : undefined,
    spawnAt,
    command,
    realCommand,
    argv,
    label: opts.label,
    lines: (stream = 'stdout') => textOnly(queues[stream].claim(stream)),
    records: (stream = 'stdout') => queues[stream].claim(stream),
    writeLine: (value) => writeText(JSON.stringify(value)),
    writeText,
    writeRaw,
    closeStdin: () => {
      if (stdin !== null && !stdin.writableEnded) stdin.end()
    },
    get stdinOpen() {
      return stdin !== null && stdinOpen && !stdin.writableEnded
    },
    exited,
    exitInfo: () => (finalized ? exitInfo : null),
    stderrTail: (max = STDERR_TAIL_LINES) => errTail.slice(-max),
    signal: (sig = 'SIGTERM') => {
      try {
        return child.kill(sig)
      } catch {
        return false
      }
    },
  }
}

export interface CaptureOptions {
  cwd?: string
  env?: Readonly<Record<string, string | undefined>>
  timeoutMs?: number
  /** Per-stream cap; further output is dropped. */
  maxBytes?: number
  input?: string
  /** POSIX: run in its own process group and kill the group on timeout. Default true on POSIX. */
  detached?: boolean
  /**
   * win32: kill the whole tree on timeout (`taskkill /T /F`), not just the child. For launchers that run the real
   * program as a grandchild (Git for Windows' `cmd/git.exe`): a killed launcher would leave it running, holding
   * its lock files. POSIX already kills the process group.
   */
  killTree?: boolean
  /**
   * Keep stdout as bytes (`stdoutBytes`; `stdout` is then ''), for output that is not text, such as a blob
   * `git cat-file` prints for the Diff tab's image preview.
   */
  binary?: boolean
}

export interface CaptureResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  ms: number
  /** Spawn failure (ENOENT, EACCES, …); code/signal are null then. */
  error?: SpawnError
  /** Stdout's bytes when the capture asked for `binary`. */
  stdoutBytes?: Buffer
}

/** Run a short command to completion and capture its output (probes, ps, taskkill, reg, login shell). */
export async function execCapture(
  command: string,
  args: readonly string[],
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  const start = Date.now()
  const fail = (error: SpawnError): CaptureResult => ({
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ms: Date.now() - start,
    error,
  })
  try {
    validateArgv(command, args)
  } catch (err) {
    return fail(SpawnError.from(err, command))
  }
  const win = process.platform === 'win32'
  const detached = opts.detached ?? !win
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024
  let child: ChildProcess
  try {
    child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: opts.env === undefined ? process.env : { ...opts.env },
      shell: false,
      windowsHide: true,
      detached,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    return fail(SpawnError.from(err, command))
  }

  return new Promise<CaptureResult>((resolve) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let timedOut = false
    let done = false
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
    // Set while a Windows tree kill runs. The capture must not resolve before it completes: the direct child
    // (e.g. cmd\git.exe) can exit while its real worker still holds locks the caller is about to clean up.
    let treeKill: Promise<void> | undefined
    const collect = (chunk: Buffer, into: Buffer[], isOut: boolean): void => {
      const used = isOut ? outBytes : errBytes
      if (used >= maxBytes) return
      const piece = chunk.subarray(0, maxBytes - used)
      into.push(piece)
      if (isOut) outBytes += piece.length
      else errBytes += piece.length
    }
    child.stdout?.on('data', (c: Buffer) => collect(c, out, true))
    child.stderr?.on('data', (c: Buffer) => collect(c, err, false))
    child.stdout?.on('error', () => undefined)
    child.stderr?.on('error', () => undefined)
    child.stdin?.on('error', () => undefined)

    const finish = (error?: SpawnError): void => {
      if (done) return
      if (treeKill !== undefined) {
        const pending = treeKill
        treeKill = undefined
        void pending.then(() => finish(error))
        return
      }
      done = true
      clearTimeout(timer)
      const outBuf = Buffer.concat(out)
      const result: CaptureResult = {
        code: exit?.code ?? null,
        signal: exit?.signal ?? null,
        stdout: opts.binary === true ? '' : outBuf.toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        ms: Date.now() - start,
      }
      if (opts.binary === true) result.stdoutBytes = outBuf
      if (error !== undefined) result.error = error
      resolve(result)
    }
    const hardKill = (): void => {
      try {
        if (detached && !win && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    const kill = (): void => {
      if (!win || opts.killTree !== true || child.pid === undefined) {
        hardKill()
        return
      }
      // Tree first (taskkill /T needs the parent alive to find its children), then the child as a fallback.
      try {
        const root = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows'
        const tk = spawn(
          win32.join(root, 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
          },
        )
        // The fallback is for a hung taskkill only: killing the launcher while taskkill still walks the tree
        // orphans its children, and under load taskkill alone can take several seconds.
        treeKill = new Promise<void>((settle) => {
          const fallback = setTimeout(() => {
            hardKill()
            settle()
          }, 15_000)
          fallback.unref()
          const done = (): void => {
            clearTimeout(fallback)
            hardKill()
            settle()
          }
          tk.once('error', done)
          tk.once('exit', done)
        })
      } catch {
        hardKill()
      }
    }
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            kill()
          }, opts.timeoutMs)
    child.once('error', (e) => {
      if (exit === null) finish(SpawnError.from(e, command))
    })
    child.on('exit', (code, signal) => {
      exit = { code, signal }
      const grace = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish()
      }, 500)
      grace.unref()
    })
    child.on('close', () => finish())
    if (opts.input !== undefined && child.stdin !== null) child.stdin.end(opts.input)
  })
}

export interface InteractiveResult {
  code: number | null
  signal: NodeJS.Signals | null
  error?: SpawnError
}

/**
 * Run a program attached to this terminal (stdio inherited, no shell) and wait for it: the CLI's `$EDITOR` for
 * plan-gate edits. Never throws; spawn failures (ENOENT, a `.cmd` without a shell) come back as `error`.
 */
export function spawnInteractive(
  command: string,
  args: readonly string[],
  opts: { cwd?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<InteractiveResult> {
  try {
    validateArgv(command, args)
  } catch (err) {
    return Promise.resolve({ code: null, signal: null, error: SpawnError.from(err, command) })
  }
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command, [...args], {
        cwd: opts.cwd,
        env: opts.env === undefined ? process.env : { ...opts.env },
        shell: false,
        stdio: 'inherit',
      })
    } catch (err) {
      resolve({ code: null, signal: null, error: SpawnError.from(err, command) })
      return
    }
    child.once('error', (err) => resolve({ code: null, signal: null, error: SpawnError.from(err, command) }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}
