// Secret/PII redaction shared by diagnostics, fixture recording and the healer.
// Pure TS (no Node built-ins) so the renderer, core and `node scripts/*.mjs` can all use it.

export type RedactMode = 'fixture' | 'diagnostics' | 'heal'

export interface RedactOptions {
  mode: RedactMode
  /** Absolute home directory to replace with `~`. */
  home?: string
  /** OS user name to replace in paths. */
  username?: string
  /** Machine host name. */
  hostname?: string
  /** Working directory to replace with `<CWD>` (fixture mode). */
  cwd?: string
}

export interface RedactResult {
  text: string
  /** Number of replacements per rule id. */
  counts: Record<string, number>
}

interface Rule {
  id: string
  re: RegExp
  replace: (mode: RedactMode, match: string, ...groups: string[]) => string
}

const token = (mode: RedactMode): string => (mode === 'fixture' ? '<TOKEN>' : '[REDACTED]')

// Order matters: specific token shapes first, generic patterns last. A rule that starts at a word
// boundary bounds its repeats (an email's local part at 64, a URL scheme at 32, a login at 256), so a long run of name
// characters (`a-b-c-…`, one vendor line of hundreds of kilobytes) is redacted in linear time; unbounded, a 200 KB
// such line took close to a minute and stalled the process writing the raw log.
const VALUE_RULES: Rule[] = [
  {
    id: 'pem',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: (m) => token(m),
  },
  // No letter before the prefix: "task-specific-…" / "risk-…" must not read as an `sk-` key.
  { id: 'anthropic-key', re: /(?<![A-Za-z])sk-ant-[A-Za-z0-9_-]{16,}/g, replace: (m) => token(m) },
  { id: 'openai-key', re: /(?<![A-Za-z])sk-[A-Za-z0-9_-]{16,}/g, replace: (m) => token(m) },
  { id: 'google-key', re: /AIza[0-9A-Za-z_-]{35}/g, replace: (m) => token(m) },
  { id: 'xai-key', re: /(?<![A-Za-z])xai-[A-Za-z0-9]{20,}/g, replace: (m) => token(m) },
  { id: 'aws-key', re: /AKIA[0-9A-Z]{16}/g, replace: (m) => token(m) },
  { id: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g, replace: (m) => token(m) },
  { id: 'github-pat', re: /github_pat_\w{20,}/g, replace: (m) => token(m) },
  // Harpoon publishes to Notion, so its tokens matter most; then common service keys known by their prefix.
  { id: 'notion-token', re: /(?<![A-Za-z0-9])(?:ntn_[A-Za-z0-9]{30,}|secret_[A-Za-z0-9]{40,})/g, replace: (m) => token(m) },
  { id: 'slack-token', re: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g, replace: (m) => token(m) },
  { id: 'stripe-key', re: /(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: (m) => token(m) },
  { id: 'sendgrid-key', re: /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, replace: (m) => token(m) },
  { id: 'npm-token', re: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{30,}/g, replace: (m) => token(m) },
  { id: 'gitlab-token', re: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g, replace: (m) => token(m) },
  { id: 'huggingface-token', re: /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}/g, replace: (m) => token(m) },
  {
    id: 'azure-key',
    re: /((?:AccountKey|SharedAccessKey)=)[A-Za-z0-9+/=]{20,}/g,
    replace: (m, _all, prefix) => `${prefix}${token(m)}`,
  },
  { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: (m) => token(m) },
  {
    id: 'bearer',
    re: /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g,
    replace: (m, _all, prefix) => `${prefix}${token(m)}`,
  },
  {
    id: 'basic-auth',
    re: /(\bAuthorization["']?[ \t]*[:=][ \t]*["']?Basic[ \t]+)[A-Za-z0-9+/=]{8,}/gi,
    replace: (m, _all, prefix) => `${prefix}${token(m)}`,
  },
  // A secret known by its name, not its shape (META_API_KEY=…, `api_key = "…"` in a TOML file, an
  // x-api-key header, `--token …` on a command line): a value of 12 or more characters with a letter and a digit
  // after a secret-named key. The secret word may sit anywhere in the name (AWS_SECRET_ACCESS_KEY,
  // SECRET_KEY, DB_PASSWORD_PROD and GITHUB_TOKEN_2 passed when the word had to end it). A value of digits only
  // (max_tokens=8192, input_tokens: 1234) is never one. Runs after the shape rules, so a value they replaced is left
  // as it is. Every repeat before the value is bounded, so a long run of name characters costs linear time.
  {
    id: 'named-secret',
    re: /(\b[A-Za-z0-9_.-]{0,40}(?:api[_-]?key|secret|token|passw(?:or)?d|credential|private[_-]?key)[A-Za-z0-9_.-]{0,40}["']?[ \t]{0,8}[:=][ \t]{0,8}["']?|(?<![\w-])--?[A-Za-z0-9-]{0,40}(?:api-?key|token|secret|password|credential|private-?key)[A-Za-z0-9-]{0,40}[ =])(?=[A-Za-z0-9._~+/=-]{0,512}\d)(?=[A-Za-z0-9._~+/=-]{0,512}[A-Za-z])[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: (m, _all, prefix) => `${prefix}${token(m)}`,
  },
  {
    id: 'url-credentials',
    re: /(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}@/gi,
    replace: (m, _all, scheme) => `${scheme}${token(m)}@`,
  },
  {
    id: 'email',
    re: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}\b/g,
    replace: (m, all) => {
      if (all.endsWith('@example.invalid')) return all
      return m === 'fixture' ? 'user@example.invalid' : '[email]'
    },
  },
]

/** Keys whose values are always secret, regardless of shape. */
export const SECRET_KEY_PATTERN =
  /(api[_-]?key|token|secret|passw(or)?d|authorization|cookie|credential|private[_-]?key)/i

/** Token-count keys are not secrets; a bare `token` key is. */
const TOKEN_COUNT_KEY = /^(max_?tokens?|tokens|input_?tokens|output_?tokens)$/i

/** A key whose string value is secret whatever it looks like (SECRET_KEY_PATTERN, token counts excepted). */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) && !TOKEN_COUNT_KEY.test(key)
}

/**
 * Account- and install-identifying keys stripped from vendor frames (Claude initialize, Codex account/read, rate
 * limits, workspace routing, remote-control status). Codex's `installationId` is stable per install, so a
 * diagnostics bundle, a heal prompt or a fixture never carries it either (seen in a live recording). Gemini: the
 * Google Cloud project an account is billed through (Code Assist's `cloudaicompanionProject`, a GCP or quota
 * project) names the account the same way.
 */
export const ACCOUNT_KEY_PATTERN =
  /^(email|organization|organization_name|org_name|account_uuid|uuid|user_?id|(chatgpt_?|previous_?)?account_?id|creator_?account_?user_?id|installation_?id|(forced_?)?chatgpt_?workspace_?id|cloudaicompanion_?project(_?id)?|(google_?cloud|gcp|quota)_?project(_?id)?)$/i

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function bump(counts: Record<string, number>, id: string, n = 1): void {
  counts[id] = (counts[id] ?? 0) + n
}

/** Path variants of an absolute path: as given, with `/`, with `\\`, and JSON-escaped backslashes. */
function pathVariants(p: string): string[] {
  const fwd = p.replace(/\\/g, '/')
  const back = p.replace(/\//g, '\\')
  const jsonBack = back.replace(/\\/g, '\\\\')
  return [...new Set([p, fwd, back, jsonBack])]
    .filter((v) => v.length > 0)
    .sort((a, b) => b.length - a.length)
}

/** Every match of a compiled global pattern replaced and counted under `id`. */
function replaceCounted(
  text: string,
  re: RegExp,
  replacement: string,
  counts: Record<string, number>,
  id: string,
): string {
  let n = 0
  const out = text.replace(re, () => {
    n++
    return replacement
  })
  if (n > 0) bump(counts, id, n)
  return out
}

/** The compiled cwd, home, user name and host patterns of one set of redaction options. */
export interface PathPatterns {
  cwd: readonly RegExp[]
  home: readonly RegExp[]
  user: RegExp | null
  host: RegExp | null
}

/** Option sets kept compiled (a process redacts with one or two: this machine's, a fixture's cwd). */
export const PATH_PATTERN_CACHE_MAX = 16
const pathPatternCache = new Map<string, PathPatterns>()

/**
 * The path, user name and host patterns for `opts`, compiled once per set of values (measured in a
 * soak: building them on every call was most of a raw-log line's redaction, about 7 µs of every string leaf). The
 * patterns are global and reused: String.prototype.replace starts a global pattern at 0 and leaves it there.
 */
export function pathPatternsFor(opts: RedactOptions): PathPatterns {
  const cwd = opts.cwd && opts.mode === 'fixture' ? opts.cwd : ''
  const key = JSON.stringify([cwd, opts.home ?? '', opts.username ?? '', opts.hostname ?? ''])
  const hit = pathPatternCache.get(key)
  if (hit !== undefined) return hit
  const literal = (needle: string): RegExp => new RegExp(escapeRegExp(needle), 'gi')
  const u = opts.username && opts.username.length > 1 ? escapeRegExp(opts.username) : null
  const patterns: PathPatterns = {
    cwd: cwd !== '' ? pathVariants(cwd).map(literal) : [],
    home: opts.home ? pathVariants(opts.home).map(literal) : [],
    // Only the user name as a path segment: after Users or home and a separator.
    user: u !== null ? new RegExp(`((?:Users|home)(?:\\\\\\\\|\\\\|/))${u}(?=$|[\\\\/"'\\s])`, 'gi') : null,
    host: opts.hostname && opts.hostname.length > 2 ? literal(opts.hostname) : null,
  }
  const oldest = pathPatternCache.keys().next()
  if (pathPatternCache.size >= PATH_PATTERN_CACHE_MAX && oldest.done !== true)
    pathPatternCache.delete(oldest.value)
  pathPatternCache.set(key, patterns)
  return patterns
}

/** Redact secrets, emails, and machine-identifying paths from free text. */
export function redactText(input: string, opts: RedactOptions): RedactResult {
  const counts: Record<string, number> = {}
  let text = input

  const applyValueRules = (): void => {
    for (const rule of VALUE_RULES) {
      text = text.replace(rule.re, (...args: unknown[]) => {
        const [match = '', ...groups] = args.filter((a): a is string => typeof a === 'string')
        const replaced = rule.replace(opts.mode, match, ...groups)
        if (replaced !== match) bump(counts, rule.id)
        return replaced
      })
    }
  }
  applyValueRules()

  // Paths: cwd first (more specific), then home, then bare user name segments.
  const paths = pathPatternsFor(opts)
  for (const re of paths.cwd) text = replaceCounted(text, re, '<CWD>', counts, 'cwd')
  for (const re of paths.home) text = replaceCounted(text, re, '~', counts, 'home')
  if (paths.user !== null) {
    const user = opts.mode === 'fixture' ? 'user' : '<user>'
    let n = 0
    text = text.replace(paths.user, (_m, prefix: string) => {
      n++
      return `${prefix}${user}`
    })
    if (n > 0) bump(counts, 'username', n)
  }
  if (paths.host !== null) {
    text = replaceCounted(text, paths.host, opts.mode === 'fixture' ? 'host' : '<host>', counts, 'hostname')
  }
  // A path/host replacement can expose a key that was glued to it (e.g. `HOSTsk-…`); keeps redaction idempotent.
  // Text nothing changed would pass through unchanged again (the common case, half of a clean line's cost).
  if (text !== input) applyValueRules()
  return { text, counts }
}

/** What a path under the recording machine's temp folder becomes in a fixture. */
export const TMP_PLACEHOLDER = '<TMP>'

export interface TempFolderOptions {
  /** The machine's temp folder (`os.tmpdir()`, and its real path where that differs). */
  tmp: string
  /** The home folder: a temp folder under it is matched in the `~` form the home rule leaves too. */
  home?: string
  /** Fold case (Windows and macOS file systems). */
  caseInsensitive?: boolean
}

// A path segment: anything but a separator, whitespace, a quote or a character a shell or JSON ends a path with.
const SEGMENT = String.raw`[^\s"'\x60\\/<>|*?:()\[\]{},;]`

/**
 * Fixture recordings (scripts/record-fixture.mjs): the temp folder and every path segment under it become `<TMP>`. A
 * scratch folder names the session that made it (a tool's session id, a project key), and a long path a shell cuts or
 * wraps in its tables (`…\scrat` + a new line + `chpad\…`, or `…\s...`) is never seen whole by the sandbox rule, but
 * it still starts with the temp folder (seen in a live recording). The folder is matched as given, with `/` or `\`,
 * JSON-escaped once or twice, and in the `~` form, so the rule also applies to a recording the home rule already
 * redacted and is idempotent. Run it after the sandbox rule: the sandbox is often under the temp folder.
 */
export function redactTempFolder(text: string, opts: TempFolderOptions): { text: string; count: number } {
  const bases = [opts.tmp]
  const fold = (p: string): string => {
    const f = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return opts.caseInsensitive === true ? f.toLowerCase() : f
  }
  if (opts.home !== undefined && opts.home.length > 1) {
    const home = fold(opts.home)
    const tmp = fold(opts.tmp)
    if (tmp.startsWith(`${home}/`)) bases.push(`~${opts.tmp.replace(/[\\/]+$/, '').slice(opts.home.length)}`)
  }
  const spellings: { path: string; sep: string }[] = []
  for (const base of bases) {
    const parts = base.replace(/[\\/]+$/, '').split(/[\\/]+/)
    const windows = /\\/.test(base) || /^[A-Za-z]:/.test(base)
    for (const sep of windows ? ['\\', '/', '\\\\', '\\\\\\\\'] : ['/'])
      spellings.push({ path: parts.join(sep), sep })
  }
  spellings.sort((a, b) => b.path.length - a.path.length)
  let out = text
  let count = 0
  for (const { path, sep } of spellings) {
    if (path.length < 2) continue
    // Not inside a longer name; a letter that ends an escape (`\n` in JSON text, a line of a shell table) is fine.
    const re = new RegExp(
      `(?<!(?<!\\\\)[\\w.~-])${escapeRegExp(path)}(?!${SEGMENT})(?:${escapeRegExp(sep)}${SEGMENT}+)*`,
      opts.caseInsensitive === true ? 'gi' : 'g',
    )
    out = out.replace(re, () => {
      count++
      return TMP_PLACEHOLDER
    })
  }
  return { text: out, count }
}

/**
 * Redact a parsed JSON value: secret-named keys and account-identifying keys are replaced wholesale;
 * string leaves go through {@link redactText}.
 */
export function redactJsonValue(
  value: unknown,
  opts: RedactOptions,
): { value: unknown; counts: Record<string, number> } {
  const counts: Record<string, number> = {}
  const merge = (c: Record<string, number>): void => {
    for (const [k, v] of Object.entries(c)) bump(counts, k, v)
  }
  const walk = (v: unknown, key?: string): unknown => {
    if (key !== undefined && typeof v === 'string') {
      if (isSecretKey(key)) {
        bump(counts, 'secret-key')
        return token(opts.mode)
      }
      if (ACCOUNT_KEY_PATTERN.test(key)) {
        bump(counts, 'account-key')
        return opts.mode === 'fixture'
          ? key.toLowerCase() === 'email'
            ? 'user@example.invalid'
            : '<REDACTED>'
          : '[REDACTED]'
      }
    }
    if (typeof v === 'string') {
      const r = redactText(v, opts)
      merge(r.counts)
      return r.text
    }
    if (Array.isArray(v)) return v.map((item) => walk(item))
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) out[k] = walk(child, k)
      return out
    }
    return v
  }
  return { value: walk(value), counts }
}

/**
 * Redact one raw JSONL line from a vendor stream. Parses JSON when possible so key-based rules apply;
 * falls back to text redaction for non-JSON lines. Never changes line structure.
 */
export function redactLine(line: string, opts: RedactOptions): RedactResult {
  const trimmed = line.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const r = redactJsonValue(parsed, opts)
      return { text: JSON.stringify(r.value), counts: r.counts }
    } catch {
      // not JSON — fall through
    }
  }
  return redactText(line, opts)
}
