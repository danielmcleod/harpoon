// Per-run "Allow for this run" cache (AllowRule).
// Matching: same vendor + tool + kind. Scoped criteria (argvPrefix, pathGlob, host wildcards, a whole tool)
// apply only when the vendor's own suggestion supplied them (`source:'vendor-suggestion'`); an `exact` rule
// matches exact argv, a literal path or an exact host. Harpoon never generalizes a rule.
import type { AllowRule, AllowRuleMatch, AskKind } from '../../shared/events.ts'

export interface AllowQuery {
  vendor: string
  kind: AskKind
  tool: string
  /** Shell command as argv. */
  argv?: readonly string[]
  /** Edit target(s); every path must match. */
  path?: string
  paths?: readonly string[]
  /** Network target; `host` is derived from `url` when absent. */
  host?: string
  url?: string
}

export interface PathBase {
  /** Anchor for relative globs/paths (the pass cwd). */
  cwd?: string
  /** Expands a leading `~`. */
  home?: string
}

export interface AllowMatchOptions extends PathBase {
  /** Fold path case (Windows). Default: true on win32. Hosts always fold. */
  caseInsensitivePaths?: boolean
}

const defaultCaseInsensitive = (): boolean => process.platform === 'win32'

// ---- paths ------------------------------------------------------------------------------------------------

const isWinAbs = (p: string): boolean => /^[A-Za-z]:\//.test(p)
const isAbs = (p: string): boolean => p.startsWith('/') || isWinAbs(p)

/**
 * Lexical normalization: `\` → `/`, duplicate slashes collapsed (a UNC `//` prefix is kept), `.` and `..`
 * resolved without climbing above the root, no trailing slash. A leading `~` expands to `home` and relative
 * paths are anchored at `cwd`, when given.
 */
export function normalizePath(p: string, base: PathBase = {}): string {
  let s = p.replace(/\\/g, '/')
  if (base.home !== undefined && (s === '~' || s.startsWith('~/'))) {
    s = base.home.replace(/\\/g, '/') + s.slice(1)
  }
  if (base.cwd !== undefined && !isAbs(s) && !s.startsWith('~')) s = `${base.cwd.replace(/\\/g, '/')}/${s}`
  let prefix = ''
  if (s.startsWith('//')) {
    prefix = '//'
    s = s.slice(2)
  } else if (isWinAbs(s)) {
    prefix = `${s.slice(0, 2)}/`
    s = s.slice(3)
  } else if (s.startsWith('/')) {
    prefix = '/'
    s = s.slice(1)
  }
  const out: string[] = []
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!prefix) out.push('..')
      continue
    }
    out.push(seg)
  }
  const joined = prefix + out.join('/')
  return joined === '' ? '.' : joined
}

function samePath(a: string, b: string, ci: boolean): boolean {
  return ci ? a.toLowerCase() === b.toLowerCase() : a === b
}

// ---- globs ------------------------------------------------------------------------------------------------

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g

/** Segment-level glob body (no `**` handling) → regex source. */
function segmentToRegex(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      while (glob[i + 1] === '*') i++
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 2)
      if (end === -1) {
        out += '\\['
        continue
      }
      let body = glob.slice(i + 1, end)
      const negate = body.startsWith('!') || body.startsWith('^')
      if (negate) body = body.slice(1)
      body = body.replace(/[\\\]^]/g, '\\$&').replace(/\//g, '')
      out += negate ? `[^/${body}]` : body ? `[${body}]` : '(?!)'
      i = end
    } else if (c === '{') {
      const end = glob.indexOf('}', i + 1)
      if (end === -1) {
        out += '\\{'
        continue
      }
      const alts = glob.slice(i + 1, end).split(',')
      out += `(?:${alts.map(segmentToRegex).join('|')})`
      i = end
    } else {
      out += c.replace(REGEX_SPECIAL, '\\$&')
    }
  }
  return out
}

/**
 * Glob → anchored RegExp over normalized `/` paths. `*` and `?` stay inside one segment; a whole-segment `**`
 * spans segments (zero or more directories in the middle, one or more segments at the end, so `src/**` does
 * not match `src` itself); `[..]`/`[!..]` classes and `{a,b}` alternation (within one segment). The glob is
 * normalized like a path first, so `..` cannot escape it.
 */
export function globToRegExp(glob: string, opts: PathBase & { caseInsensitive?: boolean } = {}): RegExp {
  const g = normalizePath(glob, opts)
  let prefix = ''
  let rest = g
  if (rest.startsWith('//')) {
    prefix = '//'
    rest = rest.slice(2)
  } else if (/^[A-Za-z]:\//.test(rest)) {
    prefix = rest.slice(0, 3)
    rest = rest.slice(3)
  } else if (rest.startsWith('/')) {
    prefix = '/'
    rest = rest.slice(1)
  }
  const segs = rest.split('/')
  let src = prefix.replace(REGEX_SPECIAL, '\\$&')
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!
    const last = i === segs.length - 1
    if (seg === '**') {
      src += last ? '.+' : '(?:[^/]+/)*'
      continue
    }
    src += segmentToRegex(seg)
    if (!last) src += '/'
  }
  return new RegExp(`^${src}$`, opts.caseInsensitive ? 'i' : '')
}

export function globMatches(
  glob: string,
  path: string,
  opts: PathBase & { caseInsensitive?: boolean } = {},
): boolean {
  return globToRegExp(glob, opts).test(normalizePath(path, opts))
}

// ---- hosts / argv -----------------------------------------------------------------------------------------

/** Lower-cased host[:port] of a URL, or undefined. */
export function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url)
    return u.host ? u.host.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

function splitHost(h: string): { name: string; port: string | undefined } {
  const s = h.trim().toLowerCase().replace(/\.$/, '')
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(s)
  return m ? { name: m[1]!, port: m[2] } : { name: s, port: undefined }
}

/** `example.com` matches exactly; `*.example.com` (suggestion scope) matches subdomains, not the apex. */
function hostMatches(ruleHost: string, queryHost: string, allowWildcard: boolean): boolean {
  const r = splitHost(ruleHost)
  const q = splitHost(queryHost)
  if (r.port !== undefined && r.port !== q.port) return false
  if (r.name.startsWith('*.')) {
    if (!allowWildcard) return false
    const apex = r.name.slice(2)
    return q.name.endsWith(`.${apex}`) && q.name.length > apex.length + 1
  }
  return r.name === q.name
}

/** Shell control operators: a prefix rule never covers a compound command. */
const SHELL_CONTROL = /[;&|<>`\n\r]|\$\(/

function argvEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function argvStartsWith(argv: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length === 0 || argv.length < prefix.length) return false
  if (!prefix.every((v, i) => v === argv[i])) return false
  return argv.slice(prefix.length).every((a) => !SHELL_CONTROL.test(a))
}

// ---- matching ---------------------------------------------------------------------------------------------

const hasAny = (m: AllowRuleMatch): boolean =>
  m.argv !== undefined || m.argvPrefix !== undefined || m.pathGlob !== undefined || m.host !== undefined

function queryPaths(q: AllowQuery): string[] {
  return [...(q.path !== undefined ? [q.path] : []), ...(q.paths ?? [])]
}

/** A network ask without argv is identified by its URL (that is what an exact network rule stores). */
function queryArgv(q: AllowQuery): readonly string[] | undefined {
  return q.argv ?? (q.url !== undefined ? [q.url] : undefined)
}

/**
 * Whether `rule` allows `q`. Every criterion present in `rule.match` must hold. A vendor suggestion with an
 * empty match is tool-wide (the vendor offered the whole tool); an exact rule with no usable criterion never
 * matches.
 */
export function ruleMatches(rule: AllowRule, q: AllowQuery, opts: AllowMatchOptions = {}): boolean {
  if (rule.vendor !== q.vendor || rule.tool !== q.tool || rule.kind !== q.kind) return false
  const m = rule.match
  const suggested = rule.source === 'vendor-suggestion'
  const ci = opts.caseInsensitivePaths ?? defaultCaseInsensitive()

  if (!hasAny(m)) return suggested
  if (!suggested && m.argv === undefined && m.pathGlob === undefined && m.host === undefined) return false

  const argv = queryArgv(q)
  if (m.argv !== undefined && !(argv !== undefined && argvEquals(argv, m.argv))) return false
  if (m.argvPrefix !== undefined) {
    if (!suggested) return false
    if (!(q.argv !== undefined && argvStartsWith(q.argv, m.argvPrefix))) return false
  }
  if (m.pathGlob !== undefined) {
    const paths = queryPaths(q)
    if (paths.length === 0) return false
    if (suggested) {
      const re = globToRegExp(m.pathGlob, { ...opts, caseInsensitive: ci })
      if (!paths.every((p) => re.test(normalizePath(p, opts)))) return false
    } else {
      const lit = normalizePath(m.pathGlob, opts)
      if (!paths.every((p) => samePath(normalizePath(p, opts), lit, ci))) return false
    }
  }
  if (m.host !== undefined) {
    const host = q.host ?? (q.url !== undefined ? hostOf(q.url) : undefined)
    if (host === undefined || !hostMatches(m.host, host, suggested)) return false
  }
  return true
}

/** An `exact` rule for exactly this query (used when the vendor offered no suggestion). */
export function exactRuleFor(q: AllowQuery): AllowRule | undefined {
  const match: AllowRuleMatch = {}
  const paths = queryPaths(q)
  if (q.argv !== undefined && q.argv.length > 0) match.argv = [...q.argv]
  else if (paths.length === 1) match.pathGlob = normalizePath(paths[0]!)
  else if (q.url !== undefined) match.argv = [q.url]
  else if (q.host !== undefined) match.host = q.host.toLowerCase()
  else return undefined
  return { vendor: q.vendor, kind: q.kind, tool: q.tool, match, source: 'exact' }
}

function ruleKey(r: AllowRule): string {
  const m = r.match
  return JSON.stringify([
    r.vendor,
    r.kind,
    r.tool,
    r.source,
    m.argv ?? null,
    m.argvPrefix ?? null,
    m.pathGlob ?? null,
    m.host ?? null,
  ])
}

function isValidRule(r: AllowRule): boolean {
  if (!r.vendor || !r.tool) return false
  const m = r.match
  if (m.argv !== undefined && m.argv.length === 0) return false
  if (m.argvPrefix !== undefined && m.argvPrefix.length === 0) return false
  if (m.pathGlob !== undefined && m.pathGlob.trim() === '') return false
  if (m.host !== undefined && m.host.trim() === '') return false
  if (r.source === 'exact') {
    // Harpoon-made rules carry only exact criteria.
    if (m.argvPrefix !== undefined) return false
    if (m.argv === undefined && m.pathGlob === undefined && m.host === undefined) return false
    if (m.host?.includes('*')) return false
  }
  return true
}

/** One run's allow rules. Rules never leave the run; the engine persists them to `run.allowRules`. */
export class AllowCache {
  readonly #rules: AllowRule[] = []
  readonly #keys = new Map<string, number>()
  readonly #opts: AllowMatchOptions

  constructor(rules: readonly AllowRule[] = [], opts: AllowMatchOptions = {}) {
    this.#opts = opts
    for (const r of rules) this.add(r)
  }

  /**
   * Adds a rule; a duplicate only merges its `nativeRules`. Returns whether the cache changed (false for an
   * invalid or generalizing rule, or a plain duplicate).
   */
  add(rule: AllowRule): boolean {
    if (!isValidRule(rule)) return false
    const key = ruleKey(rule)
    const at = this.#keys.get(key)
    if (at !== undefined) {
      const prev = this.#rules[at]!
      const before = prev.nativeRules?.length ?? 0
      const native = [...new Set([...(prev.nativeRules ?? []), ...(rule.nativeRules ?? [])])]
      if (native.length === before) return false
      this.#rules[at] = { ...prev, nativeRules: native }
      return true
    }
    this.#keys.set(key, this.#rules.length)
    this.#rules.push(structuredClone(rule))
    return true
  }

  /** The first rule allowing `q`, else undefined. `opts` overrides the cache defaults (e.g. the pass cwd). */
  match(q: AllowQuery, opts: AllowMatchOptions = {}): AllowRule | undefined {
    const o = { ...this.#opts, ...opts }
    return this.#rules.find((r) => ruleMatches(r, q, o))
  }

  list(vendor?: string): AllowRule[] {
    return this.#rules
      .filter((r) => vendor === undefined || r.vendor === vendor)
      .map((r) => structuredClone(r))
  }

  /** Deduped native rule strings (Claude `--allowedTools`), in insertion order. */
  nativeRules(vendor?: string): string[] {
    const out = new Set<string>()
    for (const r of this.#rules) {
      if (vendor !== undefined && r.vendor !== vendor) continue
      for (const n of r.nativeRules ?? []) out.add(n)
    }
    return [...out]
  }

  get size(): number {
    return this.#rules.length
  }
}

/** Allow caches keyed by run id. */
export class RunAllowCaches {
  readonly #byRun = new Map<string, AllowCache>()

  forRun(runId: string, seed: readonly AllowRule[] = [], opts: AllowMatchOptions = {}): AllowCache {
    let c = this.#byRun.get(runId)
    if (!c) {
      c = new AllowCache(seed, opts)
      this.#byRun.set(runId, c)
    }
    return c
  }

  drop(runId: string): void {
    this.#byRun.delete(runId)
  }
}
