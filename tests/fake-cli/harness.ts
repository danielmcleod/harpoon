// Test-side helpers for driving the fake CLI through each launcher (node entry, .cmd shim, shebang copy).
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { FakeCliBuild, FakeVendor } from '../../scripts/build-fake-cli.mjs'

export type LauncherKind = 'node' | 'cmd' | 'sh'

export interface FakeLauncher {
  kind: LauncherKind
  vendor: FakeVendor
  /** Executable for `node`/`sh`; the `.cmd` path for `cmd`. */
  path: string
  /** Leading args (the entry for `node`). */
  prefix: string[]
}

/** Every launcher this OS supports: node always, `.cmd` on win32, shebang copies on POSIX. */
export function launchersFor(build: FakeCliBuild, vendor: FakeVendor = 'claude'): FakeLauncher[] {
  const [command, ...prefix] = build.launchers.node[vendor]
  const out: FakeLauncher[] = [{ kind: 'node', vendor, path: command, prefix }]
  const cmd = build.launchers.cmd?.[vendor]
  if (cmd !== undefined) out.push({ kind: 'cmd', vendor, path: cmd, prefix: [] })
  const sh = build.launchers.sh?.[vendor]
  if (sh !== undefined) out.push({ kind: 'sh', vendor, path: sh, prefix: [] })
  return out
}

const quoteForCmd = (arg: string): string =>
  /^[\w.:=/\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`

/**
 * spawn() arguments for a launcher. `.cmd` files need a shell, so they go through `cmd.exe /d /s /c` here;
 * the shell-less shim resolver arrives with the process layer.
 */
export function spawnArgs(
  launcher: FakeLauncher,
  args: readonly string[],
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (launcher.kind === 'cmd') {
    const line = [`"${launcher.path}"`, ...args.map(quoteForCmd)].join(' ')
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
  }
  return { command: launcher.path, args: [...launcher.prefix, ...args], windowsVerbatimArguments: false }
}

/** process.env minus variables that would leak test-runner behaviour into the fake. */
export function fakeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['NODE_OPTIONS']
  for (const key of Object.keys(env)) {
    if (key.startsWith('FAKE_CLI_') || key.startsWith('FAKE_VAR_') || key.startsWith('REPLAY_'))
      delete env[key]
  }
  return { ...env, ...extra }
}

export interface FakeExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface StartOptions {
  args?: readonly string[]
  env?: Record<string, string>
  cwd?: string
}

export class FakeProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly stdoutLines: string[] = []
  stdout = ''
  stderr = ''
  readonly exited: Promise<FakeExit>
  private partial = ''
  private closed = false
  private readonly listeners = new Set<() => void>()

  constructor(launcher: FakeLauncher, options: StartOptions = {}) {
    const spec = spawnArgs(launcher, options.args ?? [])
    this.child = spawn(spec.command, spec.args, {
      cwd: options.cwd ?? process.cwd(),
      env: fakeEnv(options.env),
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.stdout += chunk
      this.partial += chunk
      let nl = this.partial.indexOf('\n')
      while (nl !== -1) {
        this.stdoutLines.push(this.partial.slice(0, nl).replace(/\r$/, ''))
        this.partial = this.partial.slice(nl + 1)
        nl = this.partial.indexOf('\n')
      }
      for (const fn of [...this.listeners]) fn()
    })
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk
    })
    // The fake may exit before the host stops writing; EPIPE on stdin is expected then.
    this.child.stdin.on('error', () => {})
    this.exited = new Promise((resolve, reject) => {
      this.child.on('error', reject)
      this.child.on('close', (code, signal) => {
        if (this.partial !== '') this.stdoutLines.push(this.partial)
        this.partial = ''
        this.closed = true
        for (const fn of [...this.listeners]) fn()
        resolve({ code, signal })
      })
    })
  }

  /** Write one frame (objects are JSON-encoded) followed by `eol`. */
  send(frame: unknown, eol = '\n'): void {
    const text = typeof frame === 'string' ? frame : JSON.stringify(frame)
    this.child.stdin.write(`${text}${eol}`)
  }

  end(): void {
    this.child.stdin.end()
  }

  /** stdout lines parsed as JSON where possible. */
  json(): unknown[] {
    return this.stdoutLines.flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown]
      } catch {
        return []
      }
    })
  }

  /** Resolve with the first stdout line (at or after `from`) satisfying `predicate`. */
  waitForLine(predicate: (line: string) => boolean, timeoutMs = 10_000, from = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const hit = this.stdoutLines.slice(from).find(predicate)
        if (hit === undefined) return false
        cleanup()
        resolve(hit)
        return true
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`timed out waiting for stdout line; got:\n${this.stdout}\nstderr:\n${this.stderr}`))
      }, timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        this.listeners.delete(listener)
      }
      const listener = (): void => {
        if (check()) return
        if (this.closed) {
          cleanup()
          reject(
            new Error(
              `fake exited before the expected line; stdout:\n${this.stdout}\nstderr:\n${this.stderr}`,
            ),
          )
        }
      }
      this.listeners.add(listener)
      check()
    })
  }

  /** Wait for a JSON stdout frame whose `type` (or a custom predicate) matches. */
  async waitForJson(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    const line = await this.waitForLine((l) => {
      const parsed = parseObject(l)
      return parsed !== undefined && predicate(parsed)
    }, timeoutMs)
    return parseObject(line) ?? {}
  }
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export function startFake(launcher: FakeLauncher, options: StartOptions = {}): FakeProcess {
  return new FakeProcess(launcher, options)
}

export interface FakeRun extends FakeExit {
  stdout: string
  stderr: string
  stdoutLines: string[]
}

/** Run to completion: write `stdin` frames up front, then close stdin unless `keepStdinOpen`. */
export async function runFake(
  launcher: FakeLauncher,
  options: StartOptions & { stdin?: readonly unknown[]; eol?: string; keepStdinOpen?: boolean } = {},
): Promise<FakeRun> {
  const proc = startFake(launcher, options)
  for (const frame of options.stdin ?? []) proc.send(frame, options.eol)
  if (options.keepStdinOpen !== true) proc.end()
  const exit = await proc.exited
  return { ...exit, stdout: proc.stdout, stderr: proc.stderr, stdoutLines: proc.stdoutLines }
}

export interface FakeLogEntry {
  pid: number
  kind: string
  [key: string]: unknown
}

export function readFakeLog(path: string): FakeLogEntry[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as FakeLogEntry)
}
