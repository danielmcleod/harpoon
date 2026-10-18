// Child environment sanitizer (env.sanitizeEnv).

export type EnvPurpose = 'vendor' | 'git' | 'verify'

export type EnvInput = Readonly<Record<string, string | undefined>>

export interface SanitizeEnvOptions {
  purpose: EnvPurpose
  vendor?: string
  /** Resolved PATH (path-env); falls back to the base env's PATH. */
  path?: string
  /** Directories placed before `path` (e.g. Codex `codex-path`). */
  pathPrepend?: readonly string[]
  /** `vendors.<id>.env` from user config (E2E injects fakes this way). */
  vendorEnv?: EnvInput
  /** Adapter additions, applied last (e.g. `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1`). */
  extra?: EnvInput
  /** Harpoon itself runs inside a Claude Code session. Default: `CLAUDECODE === '1'` in `base`. */
  launchedFromClaude?: boolean
  platform?: NodeJS.Platform
}

const ALWAYS_EXACT = new Set([
  'NODE_OPTIONS',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'GEMINI_CLI',
])
const ALWAYS_PREFIX = ['ELECTRON_', 'npm_', 'CODEX_SANDBOX']

/** Host-session leakage removed when Harpoon was itself launched from inside Claude Code. */
const NESTED_CLAUDE_EXACT = new Set(['CLAUDE_PID'])
const NESTED_CLAUDE_PREFIX = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_', 'CLAUDE_PREVIEW_']

/** GIT_* kept for vendor CLIs and verify commands: SSH, askpass and identity. */
const GIT_KEEP_EXACT = new Set(['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS'])
const GIT_KEEP_PREFIX = ['GIT_AUTHOR_', 'GIT_COMMITTER_']

function matcher(win: boolean): {
  is: (key: string, name: string) => boolean
  starts: (key: string, prefix: string) => boolean
} {
  return win
    ? {
        is: (key, name) => key.toUpperCase() === name.toUpperCase(),
        starts: (key, prefix) => key.toUpperCase().startsWith(prefix.toUpperCase()),
      }
    : { is: (key, name) => key === name, starts: (key, prefix) => key.startsWith(prefix) }
}

export function shouldRemoveEnvKey(
  key: string,
  purpose: EnvPurpose,
  launchedFromClaude: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const m = matcher(platform === 'win32')
  const inSet = (set: Set<string>): boolean => [...set].some((n) => m.is(key, n))
  const hasPrefix = (prefixes: readonly string[]): boolean => prefixes.some((p) => m.starts(key, p))

  if (inSet(ALWAYS_EXACT) || hasPrefix(ALWAYS_PREFIX)) return true
  if (launchedFromClaude && (inSet(NESTED_CLAUDE_EXACT) || hasPrefix(NESTED_CLAUDE_PREFIX))) return true
  if (m.starts(key, 'GIT_')) {
    if (purpose === 'git') return true
    return !(inSet(GIT_KEEP_EXACT) || hasPrefix(GIT_KEEP_PREFIX))
  }
  return false
}

/** Case-insensitive (win32) or case-sensitive env map that remembers each key's original spelling. */
class EnvMap {
  private readonly map = new Map<string, [string, string]>()
  private readonly win: boolean

  constructor(win: boolean) {
    this.win = win
  }

  private norm(key: string): string {
    return this.win ? key.toUpperCase() : key
  }

  get(key: string): string | undefined {
    return this.map.get(this.norm(key))?.[1]
  }

  set(key: string, value: string): void {
    this.map.set(this.norm(key), [key, value])
  }

  delete(key: string): void {
    this.map.delete(this.norm(key))
  }

  keys(): string[] {
    return [...this.map.values()].map(([k]) => k)
  }

  toObject(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of this.map.values()) out[k] = v
    return out
  }
}

export function sanitizeEnv(base: EnvInput, opts: SanitizeEnvOptions): Record<string, string> {
  const platform = opts.platform ?? process.platform
  const win = platform === 'win32'
  const env = new EnvMap(win)
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env.set(k, v)

  const launchedFromClaude = opts.launchedFromClaude ?? env.get('CLAUDECODE') === '1'
  for (const key of env.keys()) {
    if (shouldRemoveEnvKey(key, opts.purpose, launchedFromClaude, platform)) env.delete(key)
  }

  const sep = win ? ';' : ':'
  const basePath = opts.path ?? env.get('PATH') ?? ''
  const fullPath = [...(opts.pathPrepend ?? []), ...(basePath === '' ? [] : [basePath])].join(sep)
  env.delete('PATH')
  if (fullPath !== '') env.set(win ? 'Path' : 'PATH', fullPath)

  env.set('NO_COLOR', '1')
  env.set('TERM', 'dumb')
  if (opts.purpose === 'git') {
    env.set('GIT_TERMINAL_PROMPT', '0')
    env.set('LC_ALL', 'C')
  }
  for (const layer of [opts.vendorEnv, opts.extra]) {
    if (layer === undefined) continue
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue
      if (win && k.toUpperCase() === 'PATH') {
        env.delete('PATH')
        env.set('Path', v)
      } else env.set(k, v)
    }
  }
  return env.toObject()
}

/** Look up a variable the way the OS does (case-insensitive on win32). */
export function getEnv(
  env: EnvInput,
  key: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return env[key]
  const upper = key.toUpperCase()
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === upper && v !== undefined) return v
  return undefined
}
