// Resolved PATH for CLI search and every child.
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { getEnv } from './env.ts'
import type { EnvInput } from './env.ts'
import { execCapture } from './spawn.ts'
import type { CaptureResult } from './spawn.ts'

export const PATH_MARKER = '__CP__'
export const LOGIN_SHELL_TIMEOUT_MS = 4000
export const LOGIN_SHELL_FALLBACK_TIMEOUT_MS = 2000

export type PathSource = 'process' | 'login-shell' | 'login-shell-fallback' | 'registry'

export interface PathEnv {
  /** Joined with the platform delimiter. */
  path: string
  entries: string[]
  source: PathSource
  /** Login shell used on POSIX. */
  shell?: string
  warnings: string[]
}

export type CaptureFn = (
  command: string,
  args: readonly string[],
  opts: { env?: EnvInput; timeoutMs?: number },
) => Promise<CaptureResult>

export interface ResolvePathEnvOptions {
  /** Recompute instead of returning the per-launch cache (forced re-probe). */
  force?: boolean
  platform?: NodeJS.Platform
  env?: EnvInput
  home?: string
  /** POSIX: probe the login shell. Default: only when not launched from a terminal. */
  loginShell?: boolean
  /** win32: read HKCU/HKLM Path with reg.exe. Default: only when `force`. */
  registry?: boolean
  /** Test seam for running the shell / reg.exe. */
  capture?: CaptureFn
  exists?: (p: string) => boolean
}

const delimiter = (platform: NodeJS.Platform): string => (platform === 'win32' ? ';' : ':')

/** The PATH printed between the last pair of `__CP__` markers; rc-file noise around it is ignored. */
export function extractMarkedPath(stdout: string): string | null {
  const end = stdout.lastIndexOf(PATH_MARKER)
  if (end <= 0) return null
  const start = stdout.lastIndexOf(PATH_MARKER, end - 1)
  if (start === -1) return null
  const value = stdout.slice(start + PATH_MARKER.length, end).trim()
  return value === '' ? null : value
}

export function splitPathList(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (value === undefined) return []
  return value
    .split(delimiter(platform))
    .map((p) => p.trim().replace(/^"(.*)"$/, '$1'))
    .filter((p) => p !== '')
}

function normEntry(p: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const n = win32.normalize(p).replace(/\\+$/, '')
    return (/^[A-Za-z]:$/.test(n) ? `${n}\\` : n).toLowerCase()
  }
  const n = posix.normalize(p).replace(/\/+$/, '')
  return n === '' ? '/' : n
}

/** Concatenate PATH lists in order, dropping duplicates (case-insensitive and slash-insensitive on win32). */
export function mergePathLists(
  lists: readonly (readonly string[])[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const p of list) {
      const key = normEntry(p, platform)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(p)
    }
  }
  return out
}

function newestVersionDir(parent: string): string | null {
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return null
  }
  const parse = (n: string): number[] => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(n)?.slice(1) ?? []).map(Number)
  const versions = names.filter((n) => parse(n).length === 3)
  versions.sort((a, b) => {
    const [x, y] = [parse(a), parse(b)]
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0)
    return 0
  })
  return versions[0] === undefined ? null : posix.join(parent, versions[0])
}

/** Well-known POSIX bin directories that exist on this machine. */
export function posixExtraDirs(home: string, exists: (p: string) => boolean = existsSync): string[] {
  const j = (...parts: string[]): string => posix.join(...parts)
  const nvm = newestVersionDir(j(home, '.nvm', 'versions', 'node'))
  const candidates = [
    j(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    j(home, '.npm-global', 'bin'),
    j(home, '.volta', 'bin'),
    j(home, '.bun', 'bin'),
    j(home, '.cargo', 'bin'),
    ...(nvm === null ? [] : [j(nvm, 'bin')]),
    j(home, '.local', 'share', 'mise', 'shims'),
    j(home, '.asdf', 'shims'),
    '/snap/bin',
  ]
  return candidates.filter((d) => exists(d))
}

/** Parse `reg.exe query <key> /v Path` output. */
export function parseRegQuery(stdout: string): { type: 'REG_SZ' | 'REG_EXPAND_SZ'; value: string } | null {
  const m = /^\s+Path\s+(REG_EXPAND_SZ|REG_SZ)\s+(.*?)\s*$/im.exec(stdout)
  if (m === null) return null
  return { type: m[1] === 'REG_EXPAND_SZ' ? 'REG_EXPAND_SZ' : 'REG_SZ', value: m[2] ?? '' }
}

/** Expand `%VAR%` references (case-insensitive); unknown variables are left as-is. */
export function expandWindowsEnv(value: string, env: EnvInput): string {
  return value.replace(/%([^%;\\]+)%/g, (all, name: string) => getEnv(env, name, 'win32') ?? all)
}

const REG_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
]

export function systemRoot(env: EnvInput = process.env): string {
  return getEnv(env, 'SystemRoot', 'win32') ?? 'C:\\Windows'
}

const defaultCapture: CaptureFn = (command, args, opts) => {
  const o: Parameters<typeof execCapture>[2] = {}
  if (opts.env !== undefined) o.env = opts.env
  if (opts.timeoutMs !== undefined) o.timeoutMs = opts.timeoutMs
  return execCapture(command, args, o)
}

async function readRegistryPath(env: EnvInput, capture: CaptureFn, warnings: string[]): Promise<string[]> {
  const reg = win32.join(systemRoot(env), 'System32', 'reg.exe')
  const lists: string[][] = []
  for (const key of REG_KEYS) {
    const r = await capture(reg, ['query', key, '/v', 'Path'], { timeoutMs: 5000 })
    const parsed = r.code === 0 ? parseRegQuery(r.stdout) : null
    if (parsed === null) {
      warnings.push(`registry PATH unreadable at ${key}`)
      continue
    }
    const value = parsed.type === 'REG_EXPAND_SZ' ? expandWindowsEnv(parsed.value, env) : parsed.value
    lists.push(splitPathList(value, 'win32'))
  }
  return lists.flat()
}

async function probeLoginShell(
  shell: string,
  env: EnvInput,
  capture: CaptureFn,
): Promise<{ path: string; fallback: boolean } | null> {
  const script = `printf "\\n${PATH_MARKER}%s${PATH_MARKER}\\n" "$PATH"`
  const shellEnv: Record<string, string> = { TERM: 'dumb' }
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR']) {
    const v = env[k]
    if (v !== undefined) shellEnv[k] = v
  }
  for (const [flag, timeoutMs, fallback] of [
    ['-ilc', LOGIN_SHELL_TIMEOUT_MS, false],
    ['-lc', LOGIN_SHELL_FALLBACK_TIMEOUT_MS, true],
  ] as const) {
    const r = await capture(shell, [flag, script], { env: shellEnv, timeoutMs })
    const path = r.timedOut || r.error !== undefined ? null : extractMarkedPath(r.stdout)
    if (path !== null) return { path, fallback }
  }
  return null
}

function launchedFromTerminal(env: EnvInput): boolean {
  return env['TERM_PROGRAM'] !== undefined || process.stdin.isTTY === true
}

/** Compute the resolved PATH without caching. */
export async function computePathEnv(opts: ResolvePathEnvOptions = {}): Promise<PathEnv> {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const capture = opts.capture ?? defaultCapture
  const warnings: string[] = []
  const processEntries = splitPathList(getEnv(env, 'PATH', platform), platform)

  if (platform === 'win32') {
    const useRegistry = opts.registry ?? opts.force === true
    const registryEntries = useRegistry ? await readRegistryPath(env, capture, warnings) : []
    const entries = mergePathLists([processEntries, registryEntries], platform)
    return {
      path: entries.join(';'),
      entries,
      source: registryEntries.length > 0 ? 'registry' : 'process',
      warnings,
    }
  }

  const home = opts.home ?? env['HOME'] ?? homedir()
  const shell = env['SHELL'] ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const useShell = opts.loginShell ?? !launchedFromTerminal(env)
  let loginEntries: string[] = []
  let source: PathSource = 'process'
  if (useShell) {
    const probed = await probeLoginShell(shell, env, capture)
    if (probed === null) warnings.push(`login shell ${shell} did not report PATH; using the process PATH`)
    else {
      loginEntries = splitPathList(probed.path, platform)
      source = probed.fallback ? 'login-shell-fallback' : 'login-shell'
    }
  }
  const extras = posixExtraDirs(home, opts.exists)
  const entries = mergePathLists([loginEntries, processEntries, extras], platform)
  const result: PathEnv = { path: entries.join(':'), entries, source, warnings }
  if (useShell) result.shell = shell
  return result
}

let cached: Promise<PathEnv> | null = null

/** The resolved PATH, computed once per launch; `force` recomputes (and on win32 re-reads the registry). */
export function resolvePathEnv(opts: ResolvePathEnvOptions = {}): Promise<PathEnv> {
  if (cached === null || opts.force === true) {
    const p = computePathEnv(opts)
    cached = p
    p.catch(() => {
      if (cached === p) cached = null
    })
  }
  return cached
}

export function resetPathEnvCache(): void {
  cached = null
}

/** "PATH source: login shell (zsh) · 23 entries" */
export function describePathEnv(p: PathEnv): string {
  const src =
    p.source === 'login-shell' || p.source === 'login-shell-fallback'
      ? `login shell (${posix.basename(p.shell ?? 'sh')})`
      : p.source === 'registry'
        ? 'process + registry'
        : 'process'
  return `PATH source: ${src} · ${p.entries.length} entries`
}
