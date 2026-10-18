#!/usr/bin/env node
// Scriptable fake vendor CLI (Claude stream-json, Codex app-server JSON-RPC, ACP) for Harpoon tests.
// Plain Node ESM, no dependencies, one self-contained file: scripts/build-fake-cli.mjs copies it next to the
// node / .cmd / shebang launchers. The matching helpers are exported for scripts/*.mjs.
//
// Environment
//   FAKE_CLI_SCRIPT      a script or recording (.jsonl), or a directory holding scenario.json:
//                        [{"match":{"argvIncludes":[..],"argvExcludes":[..]},"script":"a.script.jsonl","repeat":false}]
//                        (argv patterns ending in '*' match by prefix)
//   FAKE_CLI_STATE       directory; each invocation atomically claims the next unused matching entry
//                        (open 'wx' claim files; "repeat":true entries are never claimed). Unset: first match wins.
//   FAKE_CLI_LOG         JSONL log: start (argv) · script · every stdin line · stdin-eof · grandchild · error · exit
//   FAKE_CLI_TIMEOUT_MS  default wait for stdin (10000)
//   FAKE_CLI_LOG_ENV     comma-separated variable names: their values (null when unset) go into the start log entry
//   FAKE_VAR_<name>      pre-binds $<name>. Built-ins: $FAKE_CWD $FAKE_HOME $FAKE_PID
//   REPLAY_REALTIME=1    recording replay honours frame timing (REPLAY_SPEED=<factor> scales it); default is x0
//   FAKE_CLI_CLAUDE_TRANSCRIPTS=0  turn off the Claude session transcript below
//   FAKE_CLI_OUT_CWD=1   a JSON-RPC recording's <CWD> in server messages becomes the fake's cwd (the pass folder);
//                        also <GEMINI_CLI_HOME> (the fake's own GEMINI_CLI_HOME) and <PROJECT> (`project`), as in a
//                        `file` frame's `path`
//
// Claude sessions: like the real CLI, a `-p` run started with `--session-id=<id>` (or `--session-id <id>`) and
// without `--no-session-persistence` keeps a transcript at `$CLAUDE_CONFIG_DIR/projects/<cwd, every
// non-alphanumeric → '-'>/<id>.jsonl` (what the Claude adapter's canResume looks for), and one for
// the session a `system/init` frame it prints reports (a replayed recording reports its recorded id). Only under an
// explicit CLAUDE_CONFIG_DIR inside the OS temp dir (a test's private config dir; never ~/.claude). A `--resume=<id>`
// that the script rejects prints no `system/init`, so a bogus id stays bogus.
//
// Script ops (one JSON object per line; blank lines and lines starting with // or # are ignored)
//   expectArgs{includes?,excludes?}         argv must contain / must not contain these (partial)
//   stdout{line|json|raw} stderr{line|raw}  line and json get '\n'; known $var / ${var} are substituted
//   sleep{ms}
//   expectStdin{match?,matchRegex?,capture?:{var:'json.path'},timeoutMs?,onTimeout?}
//       match is a partial deep match: objects match a subset of keys, arrays element-wise, "$var" binds an
//       unbound var or must equal a bound one, "$_" matches anything, {"$regex":".."} tests a string,
//       {"$oneOf":[p,..]} takes any alternative, {"$not":p} fails when p matches, and as an object member
//       {"$absent":true} requires the key to be missing and {"$optional":p} lets it be missing ({"$not":p} too).
//       Actual strings also match after their cwd/home prefixes are mapped to <CWD> and ~.
//   label{name}  goto{label}
//   branch{on?:'stdin'|'last'|{stdinMatch:true}|{var:name}, cases:[{match?,matchRegex?,capture?,goto}], default?}
//   onStdinEof{goto|null}                   one-shot jump when stdin closes while input is expected
//   onSignal{goto|null,signals?}            jump on SIGTERM/SIGINT (POSIX); $signal holds the name
//   expectEof{timeoutMs?,ignoreLines?}      wait for the host to close stdin
//   readToEof{includes?,matchRegex?,capture?,timeoutMs?}  read every line until stdin closes (a prompt piped
//                                           to `codex exec -`); the text is the lines joined by '\n'
//   writeFile{path|argvPath,content,append?,substitute?} path relative to cwd and inside it; argvPath ('-o' or a
//                                           list of spellings) writes where that flag's argv value points
//                                           (host-chosen); substitute:true fills known $vars into the content;
//                                           under:"GEMINI_CLI_HOME" takes path inside the fake's own Gemini
//                                           home instead (Gemini's plan file)
//   copyFiles{from,argvPath}                copy a file or a directory tree (from: relative to this script) into
//                                           the directory an argv flag names (`generate-json-schema --out <dir>`)
//   spawnGrandchild{sleepMs?,stdout?}       long-sleeping node child; pid in $grandchildPid and the log
//   exit{code?,signal?}
//
// JSON-RPC ops (Codex app-server: NDJSON, no "jsonrpc" header). Client messages are read into an inbox, so an op
// takes the first message it accepts and leaves the others for later ops (order-tolerant across methods).
//   rpcExpect{method,kind?:'request'|'notification',params?,as?,capture?,timeoutMs?,onTimeout?}
//       a client request or notification; params is a partial match (above); `as` binds the request id to $<as>
//   rpcExpectResponse{id,result?,error?,capture?,timeoutMs?}
//       the client's answer to a server request this script wrote (id literal or "$var"); result/error partial
//   rpcResult{id,result}  rpcError{id,error}   reply to a captured request ("$<as>"); writes {"id","result"} /
//                                           {"error","id"} like codex-cli 0.160.1
//   rpcDrained{allow?:[method]}             fail when the inbox holds a message no op consumed (allowed
//                                           notifications are dropped)
//   Server notifications and server requests are plain stdout{json} ops.
// ACP (JSON-RPC 2.0: every message carries the header "jsonrpc":"2.0"):
//   rpcProtocol{jsonrpc:'2.0'}              from here on every message the script writes with an rpc op carries
//                                           "jsonrpc":"2.0", and every client message an rpc op takes must carry it
//                                           (a message without it is a mismatch, 99)
//   rpcNotify{method,params?}               an agent notification (session/update …)
//   rpcRequest{method,params?,id?,as?}      an agent request (session/request_permission …); id defaults to the
//                                           next agent id from 0; `as` binds it to $<as> for rpcExpectResponse
//
// Recording replay: when the first line is {"kind":"header",...} the file is a recording. 'out'/'err' frames
// are written; each 'in' frame reads one stdin line and deep-compares it with volatile fields masked
// (request_id/requestId/id/uuid, timestamps, <ID>/<TOKEN>/<REDACTED> placeholders). Recorded ids the host
// replaced are mapped onto later output, so echoed request ids stay consistent. 'exit' ends the replay.
// {"dir":"eof"} waits for the host to close stdin (exec reads its prompt to EOF); {"dir":"file","argvPath":"-o",
// "content":".."} writes what the CLI left in the file an argv flag names (exec -o); {"dir":"file","path":"..",
// "content":".."} writes a file the CLI wrote at that moment (Gemini's plan file; `path` may name <CWD>,
// <GEMINI_CLI_HOME> and <PROJECT>, and must end up absolute); {"dir":"hold"} idles until the host kills the process (a
// mismatch if it never does). {"dir":"promptFile","argvPath":"--prompt-file","content":".."} checks the prompt file the
// host wrote before the spawn (Muse exec), a mismatch (99) when it differs or is missing.
// A header with "protocol":"jsonrpc" (Codex app-server; an ACP agent such as Gemini, whose recorded messages carry
// "jsonrpc":"2.0" and are compared with it) replays by message instead of by line: a recorded request
// takes the next client request of that method (in any order across methods), a reply to a server request is taken
// by its id, the client's own request ids are mapped onto the recorded responses, and at the exit any client message
// the recording does not have is a mismatch (replayJsonRpc below).
//
// Exit codes: 99 mismatch or timeout · 98 stdin closed while input was expected · 97 bad setup or script.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXIT_MISMATCH = 99
export const EXIT_STDIN_CLOSED = 98
export const EXIT_SETUP = 97

const DEFAULT_TIMEOUT_MS = 10_000

class FakeError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const setupError = (message) => new FakeError(EXIT_SETUP, `fake-cli: ${message}`)

// ---------------------------------------------------------------------------------------------------------
// Matching and substitution helpers (exported)

const NAME = '[A-Za-z_][A-Za-z0-9_]*'
const VAR_ONLY_RE = new RegExp(`^\\$(${NAME})$`)
const TEXT_VAR_RE = new RegExp(`"\\$(${NAME})"|\\$\\{(${NAME})\\}|\\$(${NAME})`, 'g')
const INNER_VAR_RE = new RegExp(`\\$\\{(${NAME})\\}|\\$(${NAME})`, 'g')

/** Keys whose values are host- or run-generated ids. */
export const VOLATILE_KEYS = new Set(['request_id', 'requestId', 'id', 'uuid'])
/** Recorded values that match anything (redaction and masking placeholders). */
export const PLACEHOLDERS = new Set(['<ID>', '<UUID>', '<TS>', '<TOKEN>', '<REDACTED>', '[REDACTED]'])
export const TIMESTAMP_KEY_RE = /^(timestamp|ts|time|date|(created|updated|started|ended|completed)_?at)$/i
export const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v))
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const isPlaceholder = (v) => typeof v === 'string' && PLACEHOLDERS.has(v)

/** @returns {{ok:true, value:unknown} | {ok:false}} */
export function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

export function deepEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => hasOwn(b, k) && deepEqual(a[k], b[k]))
}

/** Dot path lookup (`request.subtype`, `params.items.0.id`); '' or '$' is the whole value. */
export function getPath(value, path) {
  const p = String(path).replace(/^\$\.?/, '')
  if (p === '') return value
  let cur = value
  for (const seg of p.split('.')) {
    if (Array.isArray(cur)) {
      const i = Number(seg)
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined
      cur = cur[i]
    } else if (isObject(cur) && hasOwn(cur, seg)) {
      cur = cur[seg]
    } else {
      return undefined
    }
  }
  return cur
}

const childPath = (path, key) =>
  typeof key === 'number'
    ? `${path}[${key}]`
    : /^[A-Za-z_][\w$]*$/.test(key)
      ? `${path}.${key}`
      : `${path}[${JSON.stringify(key)}]`

/**
 * Substitute known `$var` / `${var}` in a text template. When the template is JSON, a quoted `"$var"` becomes
 * the JSON value (keeping numbers and objects intact) and inner references are JSON-escaped.
 * Unknown names are left untouched (shell text like `$HOME` survives).
 */
export function substituteText(template, vars) {
  if (!template.includes('$')) return template
  const isJson = tryParseJson(template).ok
  return template.replace(TEXT_VAR_RE, (all, quoted, braced, bare) => {
    if (quoted !== undefined) {
      if (!hasOwn(vars, quoted)) return all
      return isJson ? JSON.stringify(vars[quoted]) : `"${asText(vars[quoted])}"`
    }
    const name = braced ?? bare
    if (!hasOwn(vars, name)) return all
    const text = asText(vars[name])
    return isJson ? JSON.stringify(text).slice(1, -1) : text
  })
}

/** Substitute vars in a JSON value: a string that is exactly "$var" takes the var's value and type. */
export function substituteValue(value, vars) {
  if (typeof value === 'string') {
    const m = VAR_ONLY_RE.exec(value)
    if (m && hasOwn(vars, m[1])) return vars[m[1]]
    if (!value.includes('$')) return value
    return value.replace(INNER_VAR_RE, (all, braced, bare) => {
      const name = braced ?? bare
      return hasOwn(vars, name) ? asText(vars[name]) : all
    })
  }
  if (Array.isArray(value)) return value.map((v) => substituteValue(v, vars))
  if (isObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = substituteValue(v, vars)
    return out
  }
  return value
}

/**
 * Single-key pattern objects with a meaning of their own: {"$oneOf":[..]}, {"$not":p}, {"$optional":p},
 * {"$absent":true}. null for anything else (plain data objects never use these keys).
 */
function specialPattern(p) {
  if (!isObject(p)) return null
  const keys = Object.keys(p)
  if (keys.length !== 1) return null
  const [k] = keys
  if (k === '$oneOf' && Array.isArray(p.$oneOf)) return { kind: 'oneOf', value: p.$oneOf }
  if (k === '$not') return { kind: 'not', value: p.$not }
  if (k === '$optional') return { kind: 'optional', value: p.$optional }
  if (k === '$absent' && p.$absent === true) return { kind: 'absent' }
  return null
}

/**
 * Partial deep match of `pattern` against `actual`.
 * @returns {{ok:true, binds:Record<string,unknown>} | {ok:false, diffs:Array<{path:string, expected:unknown, actual:unknown, reason?:string}>}}
 */
export function matchPartial(pattern, actual, vars = {}, normalize = (s) => s) {
  const binds = Object.create(null)
  const diffs = []
  const lookup = (name) => {
    if (hasOwn(binds, name)) return { found: true, value: binds[name] }
    if (hasOwn(vars, name)) return { found: true, value: vars[name] }
    return { found: false }
  }
  const fail = (path, expected, got, reason) => {
    diffs.push(
      reason === undefined ? { path, expected, actual: got } : { path, expected, actual: got, reason },
    )
  }
  const walk = (p, a, path) => {
    if (typeof p === 'string') {
      if (p === '$_') return
      const m = VAR_ONLY_RE.exec(p)
      if (m) {
        const hit = lookup(m[1])
        if (!hit.found) binds[m[1]] = a
        else if (!deepEqual(hit.value, a)) fail(path, hit.value, a, `$${m[1]} differs`)
        return
      }
      const expected = p.includes('$')
        ? p.replace(INNER_VAR_RE, (all, braced, bare) => {
            const hit = lookup(braced ?? bare)
            return hit.found ? asText(hit.value) : all
          })
        : p
      if (typeof a === 'string' && (a === expected || normalize(a) === expected)) return
      fail(path, expected, a)
      return
    }
    if (Array.isArray(p)) {
      if (!Array.isArray(a)) {
        fail(path, p, a, 'expected an array')
      } else if (a.length !== p.length) {
        fail(path, p, a, `expected ${p.length} items, got ${a.length}`)
      } else {
        p.forEach((item, i) => walk(item, a[i], childPath(path, i)))
      }
      return
    }
    if (isObject(p)) {
      const keys = Object.keys(p)
      if (keys.length === 1 && typeof p.$regex === 'string') {
        if (typeof a !== 'string' || !new RegExp(p.$regex).test(a)) fail(path, `/${p.$regex}/`, a)
        return
      }
      const special = specialPattern(p)
      if (special !== null) {
        const sub = (pattern) => matchPartial(pattern, a, { ...vars, ...binds }, normalize)
        if (special.kind === 'oneOf') {
          const hit = special.value.map(sub).find((r) => r.ok)
          if (hit) Object.assign(binds, hit.binds)
          else fail(path, p, a, 'no alternative matched')
        } else if (special.kind === 'not') {
          if (sub(special.value).ok) fail(path, p, a, 'matched a $not pattern')
        } else if (special.kind === 'optional') {
          walk(special.value, a, path)
        } else if (special.kind === 'absent') {
          fail(path, p, a, 'unexpected (must be absent)')
        }
        return
      }
      if (!isObject(a)) {
        fail(path, p, a, 'expected an object')
        return
      }
      for (const key of keys) {
        if (!hasOwn(a, key)) {
          const tolerant = specialPattern(p[key])
          if (tolerant === null || tolerant.kind === 'oneOf')
            fail(childPath(path, key), p[key], undefined, 'missing')
        } else walk(p[key], a[key], childPath(path, key))
      }
      return
    }
    if (p !== a) fail(path, p, a)
  }
  walk(pattern, actual, '$')
  return diffs.length === 0 ? { ok: true, binds } : { ok: false, diffs }
}

const isScalarId = (v) => typeof v === 'string' || typeof v === 'number'

const PLACEHOLDER_IN_TEXT_RE = /<TOKEN>|<REDACTED>|<ID>|user@example\.invalid/

function placeholderPattern(expected) {
  const parts = expected.split(/(<TOKEN>|<REDACTED>|<ID>|user@example\.invalid)/)
  const body = parts
    .map((part, i) => {
      if (i % 2 === 0) return escapeRe(part)
      return part === 'user@example.invalid' ? '[^\\s"\'<>@]+@[^\\s"\'<>@]+' : '.+?'
    })
    .join('')
  return new RegExp(`^${body}$`, 's')
}

/**
 * Full deep compare of a recorded input frame with what the host sent at replay time. Volatile ids are masked
 * and recorded→actual pairs are collected in `idMap`; placeholders, timestamps and cwd/home differences pass.
 */
export function compareRecorded(expected, actual, options = {}) {
  const normalize = options.normalize ?? ((s) => s)
  const idMap = options.idMap ?? new Map()
  const diffs = []
  const fail = (path, e, a, reason) => {
    diffs.push(
      reason === undefined ? { path, expected: e, actual: a } : { path, expected: e, actual: a, reason },
    )
  }
  const walk = (e, a, path, key) => {
    if (key !== undefined && VOLATILE_KEYS.has(key) && isScalarId(e) && isScalarId(a)) {
      if (e !== a && !isPlaceholder(e)) idMap.set(e, a)
      return
    }
    if (isPlaceholder(e) && a !== undefined) return
    if (key !== undefined && TIMESTAMP_KEY_RE.test(key) && isScalarId(e) && isScalarId(a)) return
    if (typeof e === 'string') {
      if (typeof a !== 'string') {
        fail(path, e, a)
        return
      }
      if (e === a || (ISO_TIME_RE.test(e) && ISO_TIME_RE.test(a))) return
      const n = normalize(a)
      if (n === e) return
      if (PLACEHOLDER_IN_TEXT_RE.test(e) && placeholderPattern(e).test(n)) return
      fail(path, e, a)
      return
    }
    if (Array.isArray(e)) {
      if (!Array.isArray(a)) fail(path, e, a, 'expected an array')
      else if (a.length !== e.length) fail(path, e, a, `expected ${e.length} items, got ${a.length}`)
      else e.forEach((item, i) => walk(item, a[i], childPath(path, i), undefined))
      return
    }
    if (isObject(e)) {
      if (!isObject(a)) {
        fail(path, e, a, 'expected an object')
        return
      }
      for (const k of Object.keys(e)) {
        if (!hasOwn(a, k)) fail(childPath(path, k), e[k], undefined, 'missing')
        else walk(e[k], a[k], childPath(path, k), k)
      }
      for (const k of Object.keys(a))
        if (!hasOwn(e, k)) fail(childPath(path, k), undefined, a[k], 'unexpected')
      return
    }
    if (e !== a) fail(path, e, a)
  }
  walk(expected, actual, '$', undefined)
  return diffs
}

function replaceIdSubstrings(text, idMap) {
  let out = text
  for (const [from, to] of idMap) {
    if (typeof from === 'string' && from.length >= 8 && out.includes(from))
      out = out.split(from).join(String(to))
  }
  return out
}

/** Apply recorded→actual id pairs to an output line. JSON lines are rewritten structurally. */
export function applyIdMap(line, idMap) {
  if (idMap.size === 0) return line
  const parsed = tryParseJson(line)
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object')
    return replaceIdSubstrings(line, idMap)
  let changed = false
  const walk = (v, key) => {
    const volatile = key !== undefined && VOLATILE_KEYS.has(key)
    if (typeof v === 'string') {
      if (idMap.has(v) && (volatile || v.length >= 4)) {
        changed = true
        return idMap.get(v)
      }
      const r = replaceIdSubstrings(v, idMap)
      if (r !== v) changed = true
      return r
    }
    if (typeof v === 'number' && volatile && idMap.has(v)) {
      changed = true
      return idMap.get(v)
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, undefined))
    if (isObject(v)) {
      const out = {}
      for (const [k, child] of Object.entries(v)) out[k] = walk(child, k)
      return out
    }
    return v
  }
  const out = walk(parsed.value, undefined)
  return changed ? JSON.stringify(out) : line
}

/** Maps absolute path prefixes (all slash styles) to placeholders, longest first. */
export function makePathNormalizer(entries) {
  const pairs = []
  for (const [p, placeholder] of entries) {
    if (typeof p !== 'string' || p.length < 2) continue
    for (const v of new Set([p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')])) pairs.push([v, placeholder])
  }
  pairs.sort((x, y) => y[0].length - x[0].length)
  const flags = process.platform === 'win32' || process.platform === 'darwin' ? 'gi' : 'g'
  const rules = pairs.map(([v, placeholder]) => [new RegExp(escapeRe(v), flags), placeholder])
  return (s) => {
    let out = s
    for (const [re, placeholder] of rules) out = out.replace(re, () => placeholder)
    return out
  }
}

const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}...` : s)
const preview = (v, max = 200) => clip(v === undefined ? '(missing)' : JSON.stringify(v), max)
/** Whole-line summaries: raw text for strings, JSON otherwise. */
const previewLine = (v, max = 600) => clip(v === undefined ? '(missing)' : asText(v), max)

export function formatDiffs(diffs, limit = 12) {
  const lines = diffs
    .slice(0, limit)
    .map(
      (d) =>
        `  at ${d.path}: ${d.reason ? `${d.reason}; ` : ''}expected ${preview(d.expected)}, got ${preview(d.actual)}`,
    )
  if (diffs.length > limit) lines.push(`  ... and ${diffs.length - limit} more`)
  return lines
}

function mismatchError(where, diffs, expected, received) {
  return new FakeError(
    EXIT_MISMATCH,
    [
      `fake-cli: stdin mismatch ${where}`,
      ...formatDiffs(diffs),
      `  expected: ${previewLine(expected)}`,
      `  received: ${previewLine(received)}`,
    ].join('\n'),
  )
}

/** argv pattern test: exact token, or prefix when the pattern ends in '*'. */
const argvHas = (argv, pattern) =>
  pattern.endsWith('*') ? argv.some((a) => a.startsWith(pattern.slice(0, -1))) : argv.includes(pattern)

export function argvProblems(spec, argv) {
  const problems = []
  for (const p of spec?.includes ?? spec?.argvIncludes ?? [])
    if (!argvHas(argv, p)) problems.push(`missing ${JSON.stringify(p)}`)
  for (const p of spec?.excludes ?? spec?.argvExcludes ?? [])
    if (argvHas(argv, p)) problems.push(`unexpected ${JSON.stringify(p)}`)
  return problems
}

/** Parse a JSONL file into `{value, lineNo}` entries; blank and comment lines are skipped. */
export function parseJsonl(text, file = '<script>') {
  const entries = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '').trim()
    if (line === '' || line.startsWith('//') || line.startsWith('#')) continue
    const parsed = tryParseJson(line)
    if (!parsed.ok) throw setupError(`${file}:${i + 1}: invalid JSON`)
    entries.push({ value: parsed.value, lineNo: i + 1 })
  }
  return entries
}

// ---------------------------------------------------------------------------------------------------------
// Runtime

const state = { signal: null, wakers: new Set() }
const wakeAll = () => {
  for (const w of [...state.wakers]) w()
}

function sleep(ms) {
  return new Promise((done) => {
    if (state.signal) {
      done()
      return
    }
    const finish = () => {
      clearTimeout(timer)
      state.wakers.delete(onWake)
      done()
    }
    const onWake = () => {
      if (state.signal) finish()
    }
    const timer = setTimeout(finish, Math.max(0, ms))
    state.wakers.add(onWake)
  })
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

class StdinLines {
  constructor(log) {
    this.log = log
    this.queue = []
    this.buffer = ''
    this.eof = false
    this.last = undefined
    const stdin = process.stdin
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk) => {
      this.buffer += chunk
      let nl
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        this.accept(line)
      }
    })
    const close = () => {
      if (this.eof) return
      if (this.buffer.length > 0) {
        const rest = this.buffer
        this.buffer = ''
        this.accept(rest)
      }
      this.eof = true
      this.log({ kind: 'stdin-eof' })
      wakeAll()
    }
    stdin.on('end', close)
    stdin.on('error', close)
  }

  accept(raw) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    this.log({ kind: 'stdin', line })
    if (line.trim() === '') return
    this.queue.push(line)
    wakeAll()
  }

  /** @returns {Promise<{kind:'line', line:string} | {kind:'eof'} | {kind:'timeout'} | {kind:'signal'}>} */
  next(timeoutMs) {
    return new Promise((done) => {
      let timer
      const attempt = () => {
        let result
        if (state.signal) result = { kind: 'signal' }
        else if (this.queue.length > 0) result = { kind: 'line', line: this.queue.shift() }
        else if (this.eof) result = { kind: 'eof' }
        else return
        clearTimeout(timer)
        state.wakers.delete(attempt)
        if (result.kind === 'line') this.last = result.line
        done(result)
      }
      timer = setTimeout(
        () => {
          state.wakers.delete(attempt)
          done({ kind: 'timeout' })
        },
        Math.max(0, timeoutMs),
      )
      state.wakers.add(attempt)
      attempt()
    })
  }
}

const armedSignals = new Set()
function onProcessSignal(signal) {
  state.signal = signal
  wakeAll()
}
function armSignals(signals, on) {
  for (const s of armedSignals) process.off(s, onProcessSignal)
  armedSignals.clear()
  if (!on) return
  for (const s of signals) {
    process.on(s, onProcessSignal)
    armedSignals.add(s)
  }
}

function writeTo(stream, text) {
  if (claudeProjectDir !== null && stream === process.stdout) noteClaudeSessions(text)
  return new Promise((done) => {
    if (text === '' || stream.destroyed || stream.writableEnded) {
      done()
      return
    }
    stream.write(text, () => done())
  })
}

function flushStream(stream) {
  return new Promise((done) => {
    if (stream.destroyed || stream.writableEnded) {
      done()
      return
    }
    stream.write('', () => done())
  })
}

function createLog(path) {
  if (!path) return () => {}
  try {
    mkdirSync(dirname(resolve(path)), { recursive: true })
  } catch {
    // reported by the first failed append, which is swallowed: logging never breaks the fake
  }
  return (entry) => {
    try {
      appendFileSync(path, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
    } catch {
      // ignore
    }
  }
}

function defaultTimeout() {
  const n = Number(process.env.FAKE_CLI_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS
}

function canonicalPath(p) {
  let out = resolve(p)
  try {
    out = realpathSync.native(out)
  } catch {
    // keep the resolved path
  }
  return process.platform === 'win32' ? out.toLowerCase() : out
}

function selectScript(argv) {
  const target = process.env.FAKE_CLI_SCRIPT
  if (!target) throw setupError('FAKE_CLI_SCRIPT is not set (a .jsonl script or a scenario directory)')
  const abs = resolve(target)
  if (!existsSync(abs)) throw setupError(`FAKE_CLI_SCRIPT does not exist: ${abs}`)
  if (!statSync(abs).isDirectory()) return { file: abs, entry: null }

  const scenarioFile = join(abs, 'scenario.json')
  if (!existsSync(scenarioFile)) throw setupError(`no scenario.json in ${abs}`)
  const parsed = tryParseJson(readFileSync(scenarioFile, 'utf8'))
  if (!parsed.ok || !Array.isArray(parsed.value)) throw setupError(`${scenarioFile}: expected a JSON array`)
  const matching = []
  parsed.value.forEach((entry, index) => {
    if (!isObject(entry) || typeof entry.script !== 'string')
      throw setupError(`${scenarioFile}[${index}]: missing "script"`)
    if (argvProblems(entry.match ?? {}, argv).length === 0) matching.push({ entry, index })
  })
  if (matching.length === 0)
    throw setupError(`no scenario entry in ${scenarioFile} matches argv ${JSON.stringify(argv)}`)

  const stateDir = process.env.FAKE_CLI_STATE
  let chosen = matching[0]
  if (stateDir) {
    mkdirSync(stateDir, { recursive: true })
    const key = createHash('sha256').update(canonicalPath(abs)).digest('hex').slice(0, 8)
    chosen = undefined
    for (const m of matching) {
      if (m.entry.repeat === true) {
        chosen = m
        break
      }
      const claim = join(stateDir, `${basename(abs)}-${key}-${m.index}.claim`)
      try {
        const fd = openSync(claim, 'wx')
        writeSync(fd, JSON.stringify({ pid: process.pid, argv }))
        closeSync(fd)
        chosen = m
        break
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err
      }
    }
    if (!chosen)
      throw setupError(`every scenario entry matching argv ${JSON.stringify(argv)} is already claimed`)
  }
  return { file: resolve(abs, chosen.entry.script), entry: chosen.index }
}

const OPS = new Set([
  'expectArgs',
  'stdout',
  'stderr',
  'sleep',
  'expectStdin',
  'label',
  'goto',
  'branch',
  'onStdinEof',
  'onSignal',
  'expectEof',
  'readToEof',
  'writeFile',
  'copyFiles',
  'spawnGrandchild',
  'exit',
  'rpcExpect',
  'rpcExpectResponse',
  'rpcResult',
  'rpcError',
  'rpcDrained',
  'rpcProtocol',
  'rpcNotify',
  'rpcRequest',
])

/** The argv value of a flag (`-o <v>`, `--out=<v>`); `flags` is one spelling or a list. undefined when absent. */
export function argvValue(argv, flags) {
  const list = Array.isArray(flags) ? flags : [flags]
  for (let i = 0; i < argv.length; i++) {
    for (const f of list) {
      if (typeof f !== 'string' || f === '') continue
      if (argv[i] === f && i + 1 < argv.length) return argv[i + 1]
      if (f.startsWith('--') && argv[i].startsWith(`${f}=`)) return argv[i].slice(f.length + 1)
    }
  }
  return undefined
}

function loadScript(entries, file) {
  const ops = []
  const labels = new Map()
  for (const { value, lineNo } of entries) {
    if (!isObject(value) || typeof value.op !== 'string')
      throw setupError(`${file}:${lineNo}: expected {"op":...}`)
    if (!OPS.has(value.op)) throw setupError(`${file}:${lineNo}: unknown op "${value.op}"`)
    if (value.op === 'label') {
      if (typeof value.name !== 'string') throw setupError(`${file}:${lineNo}: label needs a "name"`)
      if (labels.has(value.name)) throw setupError(`${file}:${lineNo}: duplicate label "${value.name}"`)
      labels.set(value.name, ops.length)
    }
    ops.push({ op: value, lineNo })
  }
  const targets = []
  for (const { op, lineNo } of ops) {
    if (op.op === 'goto') targets.push([op.label ?? op.goto, lineNo])
    if (op.op === 'branch') {
      if (!Array.isArray(op.cases)) throw setupError(`${file}:${lineNo}: branch needs "cases"`)
      for (const c of op.cases) targets.push([c?.goto, lineNo])
      if (op.default !== undefined) targets.push([op.default, lineNo])
    }
    if ((op.op === 'onStdinEof' || op.op === 'onSignal') && op.goto !== null && op.goto !== undefined) {
      targets.push([op.goto, lineNo])
    }
    if (op.onTimeout !== undefined) targets.push([op.onTimeout, lineNo])
  }
  for (const [target, lineNo] of targets) {
    if (typeof target !== 'string' || !labels.has(target)) {
      throw setupError(`${file}:${lineNo}: unknown label ${JSON.stringify(target)}`)
    }
  }
  return { ops, labels }
}

function opText(op, vars, where) {
  if (op.json !== undefined) return `${JSON.stringify(substituteValue(op.json, vars))}\n`
  if (typeof op.line === 'string') return `${substituteText(op.line, vars)}\n`
  if (typeof op.raw === 'string') return substituteText(op.raw, vars)
  throw setupError(`${where} needs "line", "json" or "raw"`)
}

function matchInput(spec, line, vars, normalize) {
  if (spec.matchRegex !== undefined && !new RegExp(spec.matchRegex).test(line)) {
    return { ok: false, diffs: [{ path: '$', expected: `/${spec.matchRegex}/`, actual: line }] }
  }
  let binds = Object.create(null)
  let parsed
  if (spec.match !== undefined) {
    let r
    if (typeof spec.match === 'string') {
      r = matchPartial(spec.match, line, vars, normalize)
    } else {
      parsed = tryParseJson(line)
      if (!parsed.ok)
        return { ok: false, diffs: [{ path: '$', expected: spec.match, actual: line, reason: 'not JSON' }] }
      r = matchPartial(spec.match, parsed.value, vars, normalize)
    }
    if (!r.ok) return r
    binds = r.binds
  }
  if (spec.capture !== undefined) {
    parsed ??= tryParseJson(line)
    for (const [name, path] of Object.entries(spec.capture)) {
      const whole = path === '' || path === '$'
      const value = parsed.ok ? getPath(parsed.value, path) : whole ? line : undefined
      if (value === undefined) {
        return {
          ok: false,
          diffs: [
            { path: String(path), expected: '(present)', actual: undefined, reason: `capture $${name}` },
          ],
        }
      }
      binds[name] = value
    }
  }
  return { ok: true, binds }
}

function describeExpectation(op) {
  if (op.op === 'rpcExpect') return `JSON-RPC ${op.kind ?? 'message'} "${op.method}"`
  if (op.op === 'rpcExpectResponse') return `JSON-RPC response to id ${JSON.stringify(op.id)}`
  if (op.match !== undefined) return preview(op.match)
  if (op.matchRegex !== undefined) return `/${op.matchRegex}/`
  if (Array.isArray(op.cases)) return preview(op.cases.map((c) => c.match ?? c.matchRegex ?? '(any)'))
  return '(any line)'
}

function branchSource(on, where) {
  if (on === undefined || on === 'stdin') return { kind: 'stdin' }
  if (on === 'last') return { kind: 'last' }
  if (isObject(on)) {
    if (typeof on.var === 'string') return { kind: 'var', name: on.var }
    if (on.last === true) return { kind: 'last' }
    if (hasOwn(on, 'stdinMatch') || hasOwn(on, 'stdin')) return { kind: 'stdin' }
  }
  throw setupError(`${where}: unsupported branch "on" ${JSON.stringify(on)}`)
}

function spawnGrandchild(op, ctx) {
  const ms = Number(op.sleepMs ?? 60_000)
  // Windows: detached keeps it out of this process's kill-on-close job object (so it outlives a hard kill of
  // the fake, like a real orphan) while its ppid still points here for taskkill /T. POSIX: same process group.
  // cwd: the OS temp dir, so a lingering grandchild never pins the test's working directory on Windows.
  const child = spawn(
    process.execPath,
    ['-e', `setTimeout(() => {}, ${Number.isFinite(ms) ? ms : 60_000})`],
    {
      cwd: tmpdir(),
      stdio: 'ignore',
      detached: process.platform === 'win32',
      windowsHide: true,
    },
  )
  child.on('error', () => {})
  child.unref()
  ctx.vars.grandchildPid = child.pid
  ctx.log({ kind: 'grandchild', pid: child.pid, parent: process.pid })
  return child.pid
}

async function runScript(script, ctx) {
  const { ops, labels } = script
  const { vars } = ctx
  const handlers = { eof: null, signal: null }
  let pc = 0
  const jump = (label) => {
    pc = labels.get(label)
  }
  const where = (i) => `at op #${i + 1} ${ops[i].op.op} (${ctx.file}:${ops[i].lineNo})`
  /** ACP (rpcProtocol): the JSON-RPC 2.0 header on every rpc message written and taken. */
  const rpc = { header: undefined, nextAgentId: 0 }
  const framed = (body) => (rpc.header === undefined ? body : { jsonrpc: rpc.header, ...body })
  /** A client message taken by an rpc op must carry the header once rpcProtocol set one. */
  const headerOrFail = (entry, index) => {
    if (rpc.header === undefined || entry.msg.jsonrpc === rpc.header) return
    throw mismatchError(
      where(index),
      [
        {
          path: '$.jsonrpc',
          expected: rpc.header,
          actual: entry.msg.jsonrpc,
          reason: 'missing JSON-RPC header',
        },
      ],
      { jsonrpc: rpc.header },
      entry.line,
    )
  }

  /** Read one line for an expecting op: returns {line} | {jump} | {signal}; throws on EOF/timeout. */
  const readLine = async (op, index) => {
    const timeoutMs = Number(op.timeoutMs) > 0 ? Number(op.timeoutMs) : defaultTimeout()
    const r = await ctx.stdin.next(timeoutMs)
    if (r.kind === 'line') return { line: r.line }
    if (r.kind === 'signal') return { signal: true }
    if (r.kind === 'eof') {
      if (handlers.eof !== null) {
        const target = handlers.eof
        handlers.eof = null
        return { jump: target }
      }
      throw new FakeError(
        EXIT_STDIN_CLOSED,
        `fake-cli: stdin closed while waiting ${where(index)}\n  expected: ${describeExpectation(op)}`,
      )
    }
    if (op.onTimeout !== undefined) return { jump: op.onTimeout }
    throw new FakeError(
      EXIT_MISMATCH,
      `fake-cli: timed out after ${timeoutMs} ms waiting for stdin ${where(index)}\n  expected: ${describeExpectation(op)}`,
    )
  }

  /** Parse one client line into the JSON-RPC inbox shape; anything else is a protocol mismatch. */
  const rpcEntry = (line, index, op) => {
    const parsed = tryParseJson(line)
    if (!parsed.ok || !isObject(parsed.value)) {
      throw mismatchError(
        where(index),
        [{ path: '$', expected: 'a JSON-RPC message', actual: line, reason: 'not a JSON object' }],
        op.method ?? op.id ?? '(message)',
        line,
      )
    }
    return { msg: parsed.value, line }
  }

  /** First inbox message `accept` takes, else read (and inbox) client lines until one is accepted. */
  const readRpc = async (op, index, accept) => {
    const inbox = ctx.rpcInbox
    const at = inbox.findIndex((e) => accept(e.msg))
    if (at !== -1) return { hit: inbox.splice(at, 1)[0] }
    for (;;) {
      const got = await readLine(op, index)
      if (got.signal) return { signal: true }
      if (got.jump !== undefined) return { jump: got.jump }
      const entry = rpcEntry(got.line, index, op)
      if (accept(entry.msg)) return { hit: entry }
      inbox.push(entry)
    }
  }

  const rpcCapture = (op, index, entry) => {
    if (op.capture === undefined) return
    for (const [name, path] of Object.entries(op.capture)) {
      const value = getPath(entry.msg, path)
      if (value === undefined) {
        throw mismatchError(
          where(index),
          [{ path: String(path), expected: '(present)', actual: undefined, reason: `capture $${name}` }],
          op.capture,
          entry.line,
        )
      }
      vars[name] = value
    }
  }

  const partialOrFail = (pattern, actual, index, entry, prefix) => {
    const r = matchPartial(pattern, actual, vars, ctx.normalize)
    if (!r.ok) {
      throw mismatchError(
        where(index),
        r.diffs.map((d) => ({ ...d, path: d.path.replace(/^\$/, prefix) })),
        pattern,
        entry.line,
      )
    }
    Object.assign(vars, r.binds)
  }

  while (pc < ops.length) {
    if (state.signal !== null) {
      if (handlers.signal !== null) {
        vars.signal = state.signal
        state.signal = null
        jump(handlers.signal)
        continue
      }
      state.signal = null
    }
    const index = pc
    const { op } = ops[pc]
    pc += 1
    switch (op.op) {
      case 'expectArgs': {
        const problems = argvProblems(op, ctx.argv)
        if (problems.length > 0) {
          throw new FakeError(
            EXIT_MISMATCH,
            [
              `fake-cli: argv mismatch ${where(index)}`,
              ...problems.map((p) => `  ${p}`),
              `  argv: ${JSON.stringify(ctx.argv)}`,
            ].join('\n'),
          )
        }
        break
      }
      case 'stdout':
        await writeTo(process.stdout, opText(op, vars, where(index)))
        break
      case 'stderr':
        await writeTo(process.stderr, opText(op, vars, where(index)))
        break
      case 'sleep':
        await sleep(Number(op.ms) || 0)
        break
      case 'label':
        break
      case 'goto':
        jump(op.label ?? op.goto)
        break
      case 'onStdinEof':
        handlers.eof = op.goto ?? null
        break
      case 'onSignal':
        handlers.signal = op.goto ?? null
        armSignals(Array.isArray(op.signals) ? op.signals : ['SIGTERM', 'SIGINT'], handlers.signal !== null)
        break
      case 'expectStdin': {
        const got = await readLine(op, index)
        if (got.signal) {
          pc = index
          continue
        }
        if (got.jump !== undefined) {
          jump(got.jump)
          break
        }
        const r = matchInput(op, got.line, vars, ctx.normalize)
        if (!r.ok) throw mismatchError(where(index), r.diffs, op.match ?? op.matchRegex ?? '(any)', got.line)
        Object.assign(vars, r.binds)
        break
      }
      case 'branch': {
        const source = branchSource(op.on, where(index))
        let line
        if (source.kind === 'stdin') {
          const got = await readLine(op, index)
          if (got.signal) {
            pc = index
            continue
          }
          if (got.jump !== undefined) {
            jump(got.jump)
            break
          }
          line = got.line
        } else if (source.kind === 'last') {
          line = ctx.stdin.last
          if (line === undefined)
            throw new FakeError(EXIT_MISMATCH, `fake-cli: no stdin line read yet ${where(index)}`)
        } else {
          line = hasOwn(vars, source.name) ? asText(vars[source.name]) : ''
        }
        const misses = []
        let target = null
        for (const c of op.cases) {
          const r = matchInput(c, line, vars, ctx.normalize)
          if (r.ok) {
            Object.assign(vars, r.binds)
            target = c.goto
            break
          }
          misses.push(...r.diffs.slice(0, 3).map((d) => ({ ...d, path: `case "${c.goto}" ${d.path}` })))
        }
        target ??= op.default ?? null
        if (target === null)
          throw mismatchError(
            where(index),
            misses,
            op.cases.map((c) => c.match ?? c.matchRegex),
            line,
          )
        jump(target)
        break
      }
      case 'expectEof': {
        const timeoutMs = Number(op.timeoutMs) > 0 ? Number(op.timeoutMs) : defaultTimeout()
        const deadline = Date.now() + timeoutMs
        let interrupted = false
        for (;;) {
          const r = await ctx.stdin.next(Math.max(0, deadline - Date.now()))
          if (r.kind === 'eof') break
          if (r.kind === 'signal') {
            interrupted = true
            break
          }
          if (r.kind === 'line') {
            if (op.ignoreLines === true) continue
            throw new FakeError(
              EXIT_MISMATCH,
              `fake-cli: expected stdin to close ${where(index)} but received a line\n  received: ${previewLine(r.line)}`,
            )
          }
          throw new FakeError(
            EXIT_MISMATCH,
            `fake-cli: timed out after ${timeoutMs} ms waiting for stdin to close ${where(index)}`,
          )
        }
        if (interrupted) {
          pc = index
          continue
        }
        break
      }
      case 'writeFile': {
        let target
        if (op.argvPath !== undefined) {
          // A path the host chose on the command line (`codex exec -o <file>`): written where it points.
          const value = argvValue(ctx.argv, op.argvPath)
          if (value === undefined || value === '')
            throw new FakeError(
              EXIT_MISMATCH,
              `fake-cli: argv has no ${JSON.stringify(op.argvPath)} value ${where(index)}\n  argv: ${JSON.stringify(ctx.argv)}`,
            )
          target = resolve(process.cwd(), value)
        } else {
          // `under: "GEMINI_CLI_HOME"` writes inside the fake's own Gemini home (a test's private folder) instead of
          // its cwd: Gemini's plan file, which its exit_plan_mode request names. No other folder can be named.
          if (op.under !== undefined && op.under !== 'GEMINI_CLI_HOME')
            throw setupError(`${where(index)}: "under" may only name GEMINI_CLI_HOME`)
          const base = op.under === undefined ? process.cwd() : process.env['GEMINI_CLI_HOME']
          if (base === undefined || base === '' || !isAbsolute(base))
            throw setupError(`${where(index)}: GEMINI_CLI_HOME is not an absolute folder here`)
          if (typeof op.path !== 'string' || op.path === '' || isAbsolute(op.path)) {
            throw setupError(`${where(index)}: "path" must be relative to ${op.under ?? 'cwd'}`)
          }
          target = resolve(base, op.path)
          const rel = relative(base, target)
          if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
            throw setupError(`${where(index)}: path escapes ${op.under ?? 'cwd'}`)
        }
        mkdirSync(dirname(target), { recursive: true })
        const raw = typeof op.content === 'string' ? op.content : JSON.stringify(op.content ?? '')
        const content = op.substitute === true ? substituteText(raw, vars) : raw
        if (op.append === true) appendFileSync(target, content)
        else writeFileSync(target, content)
        ctx.log({ kind: 'writeFile', path: op.path ?? target })
        break
      }
      case 'copyFiles': {
        if (typeof op.from !== 'string' || op.from === '')
          throw setupError(`${where(index)}: "from" is required`)
        const source = resolve(dirname(ctx.file), op.from)
        if (!existsSync(source)) throw setupError(`${where(index)}: no such file or directory ${source}`)
        const value = argvValue(ctx.argv, op.argvPath)
        if (value === undefined || value === '')
          throw new FakeError(
            EXIT_MISMATCH,
            `fake-cli: argv has no ${JSON.stringify(op.argvPath)} value ${where(index)}\n  argv: ${JSON.stringify(ctx.argv)}`,
          )
        const destDir = resolve(process.cwd(), value)
        mkdirSync(destDir, { recursive: true })
        const dest = statSync(source).isDirectory() ? destDir : join(destDir, basename(source))
        cpSync(source, dest, { recursive: true })
        ctx.log({ kind: 'copyFiles', from: source, to: dest })
        break
      }
      case 'readToEof': {
        const timeoutMs = Number(op.timeoutMs) > 0 ? Number(op.timeoutMs) : defaultTimeout()
        const deadline = Date.now() + timeoutMs
        const lines = []
        let interrupted = false
        for (;;) {
          const r = await ctx.stdin.next(Math.max(0, deadline - Date.now()))
          if (r.kind === 'eof') break
          if (r.kind === 'signal') {
            interrupted = true
            break
          }
          if (r.kind === 'line') {
            lines.push(r.line)
            continue
          }
          throw new FakeError(
            EXIT_MISMATCH,
            `fake-cli: timed out after ${timeoutMs} ms waiting for stdin to close ${where(index)}`,
          )
        }
        if (interrupted) {
          pc = index
          continue
        }
        const text = lines.join('\n')
        const seen = ctx.normalize(text)
        const wanted =
          op.includes === undefined ? [] : Array.isArray(op.includes) ? op.includes : [op.includes]
        const missing = wanted.filter((w) => !text.includes(w) && !seen.includes(w))
        if (missing.length > 0 || (op.matchRegex !== undefined && !new RegExp(op.matchRegex).test(text))) {
          throw mismatchError(
            where(index),
            [{ path: '$', expected: op.matchRegex ?? wanted, actual: text, reason: 'stdin text' }],
            op.matchRegex ?? wanted,
            text,
          )
        }
        if (typeof op.capture === 'string') vars[op.capture] = text
        break
      }
      case 'rpcExpect': {
        if (typeof op.method !== 'string') throw setupError(`${where(index)}: rpcExpect needs "method"`)
        const kind = op.kind ?? (op.as !== undefined ? 'request' : undefined)
        const accept = (m) =>
          m.method === op.method && (kind === undefined || (kind === 'request') === hasOwn(m, 'id'))
        const got = await readRpc(op, index, accept)
        if (got.signal) {
          pc = index
          continue
        }
        if (got.jump !== undefined) {
          jump(got.jump)
          break
        }
        const entry = got.hit
        headerOrFail(entry, index)
        if (op.params !== undefined) {
          partialOrFail(op.params, entry.msg.params ?? {}, index, entry, '$.params')
        }
        if (typeof op.as === 'string') vars[op.as] = entry.msg.id
        rpcCapture(op, index, entry)
        ctx.log({ kind: 'rpc', method: op.method, id: entry.msg.id ?? null })
        break
      }
      case 'rpcExpectResponse': {
        const want = substituteValue(op.id, vars)
        const accept = (m) => !hasOwn(m, 'method') && hasOwn(m, 'id') && deepEqual(m.id, want)
        const got = await readRpc(op, index, accept)
        if (got.signal) {
          pc = index
          continue
        }
        if (got.jump !== undefined) {
          jump(got.jump)
          break
        }
        const entry = got.hit
        headerOrFail(entry, index)
        if (op.error !== undefined) {
          if (!isObject(entry.msg.error)) {
            throw mismatchError(
              where(index),
              [
                {
                  path: '$.error',
                  expected: op.error,
                  actual: entry.msg.result,
                  reason: 'expected an error',
                },
              ],
              op.error,
              entry.line,
            )
          }
          partialOrFail(op.error, entry.msg.error, index, entry, '$.error')
        } else {
          if (hasOwn(entry.msg, 'error')) {
            throw mismatchError(
              where(index),
              [
                {
                  path: '$.result',
                  expected: op.result ?? '(a result)',
                  actual: entry.msg.error,
                  reason: 'got an error',
                },
              ],
              op.result ?? '(a result)',
              entry.line,
            )
          }
          if (op.result !== undefined) partialOrFail(op.result, entry.msg.result, index, entry, '$.result')
        }
        rpcCapture(op, index, entry)
        ctx.log({ kind: 'rpc-response', id: want })
        break
      }
      case 'rpcResult':
      case 'rpcError': {
        const id = substituteValue(op.id, vars)
        if (id === undefined || (typeof id === 'string' && /^\$[A-Za-z_]/.test(id)))
          throw setupError(`${where(index)}: ${op.op} id ${JSON.stringify(op.id)} is not bound`)
        const error = substituteValue(op.error ?? { code: -32603, message: 'error' }, vars)
        // codex-cli writes an error as {"error","id"}; an ACP agent (the TypeScript SDK) as {"jsonrpc","id","error"}.
        const frame =
          op.op === 'rpcResult'
            ? { id, result: substituteValue(op.result ?? {}, vars) }
            : rpc.header === undefined
              ? { error, id }
              : { id, error }
        await writeTo(process.stdout, `${JSON.stringify(framed(frame))}\n`)
        break
      }
      case 'rpcProtocol': {
        if (op.jsonrpc !== '2.0') throw setupError(`${where(index)}: rpcProtocol supports jsonrpc "2.0" only`)
        rpc.header = op.jsonrpc
        break
      }
      case 'rpcNotify':
      case 'rpcRequest': {
        if (typeof op.method !== 'string') throw setupError(`${where(index)}: ${op.op} needs "method"`)
        const params = op.params !== undefined ? { params: substituteValue(op.params, vars) } : {}
        let body = { method: op.method, ...params }
        if (op.op === 'rpcRequest') {
          const id = op.id !== undefined ? substituteValue(op.id, vars) : rpc.nextAgentId++
          if (typeof op.as === 'string') vars[op.as] = id
          body = { id, ...body }
        }
        await writeTo(process.stdout, `${JSON.stringify(framed(body))}\n`)
        break
      }
      case 'rpcDrained': {
        while (ctx.stdin.queue.length > 0) ctx.rpcInbox.push(rpcEntry(ctx.stdin.queue.shift(), index, op))
        const allow = new Set(Array.isArray(op.allow) ? op.allow : [])
        const left = ctx.rpcInbox.filter(
          (e) => !(typeof e.msg.method === 'string' && !hasOwn(e.msg, 'id') && allow.has(e.msg.method)),
        )
        if (left.length > 0) {
          throw new FakeError(
            EXIT_MISMATCH,
            [
              `fake-cli: unconsumed JSON-RPC messages ${where(index)}`,
              ...left.map((e) => `  ${previewLine(e.line)}`),
            ].join('\n'),
          )
        }
        ctx.rpcInbox.length = 0
        break
      }
      case 'spawnGrandchild': {
        const pid = spawnGrandchild(op, ctx)
        if (op.stdout === true)
          await writeTo(process.stdout, `${JSON.stringify({ type: 'fake_grandchild', pid })}\n`)
        break
      }
      case 'exit':
        return {
          code: typeof op.code === 'number' ? op.code : 0,
          signal: typeof op.signal === 'string' ? op.signal : undefined,
        }
      default:
        throw setupError(`${where(index)}: unknown op`)
    }
  }
  return { code: 0, signal: undefined }
}

/** Recording timing: REPLAY_REALTIME / REPLAY_SPEED honour the recorded `t`; the default replays at once. */
function replayClock() {
  const realtime = process.env.REPLAY_REALTIME === '1' || process.env.REPLAY_SPEED !== undefined
  const speed = Number(process.env.REPLAY_SPEED ?? '1') > 0 ? Number(process.env.REPLAY_SPEED ?? '1') : 1
  let prevT = 0
  return async (frame) => {
    if (!realtime || typeof frame.t !== 'number') return
    const wait = (frame.t - prevT) / speed
    prevT = frame.t
    if (wait > 0) await sleep(wait)
  }
}

/**
 * `{"dir":"eof"}`: the host closed stdin here (exec reads its prompt to EOF; an app-server exits once its input is
 * gone). Waits for the close; client lines that arrive first go to `stray` (JSON-RPC replay: checked at the exit),
 * or are a mismatch when there is no `stray`.
 */
async function replayEof(ctx, where, timeoutMs, stray) {
  for (;;) {
    const r = await ctx.stdin.next(timeoutMs)
    if (r.kind === 'eof' || r.kind === 'signal') return
    if (r.kind === 'line') {
      if (stray === undefined) {
        throw new FakeError(
          EXIT_MISMATCH,
          `fake-cli: unexpected stdin before the recorded close ${where}\n  received: ${previewLine(r.line)}`,
        )
      }
      stray.push(r.line)
      continue
    }
    throw new FakeError(
      EXIT_MISMATCH,
      `fake-cli: timed out after ${timeoutMs} ms waiting for the host to close stdin ${where}`,
    )
  }
}

/**
 * A recording's placeholders for the folders a replay runs with (ACP): <CWD> is the fake's cwd, <GEMINI_CLI_HOME>
 * the fake's own GEMINI_CLI_HOME (when set), <PROJECT> the fixed name `project` (Gemini's project folder under
 * `.gemini/tmp`). `json`: the values go inside a JSON string (escaped).
 */
export function outPlaceholders(text, json) {
  const esc = (v) => (json ? JSON.stringify(v).slice(1, -1) : v)
  let out = text.replaceAll('<CWD>', esc(process.cwd()))
  const geminiHome = process.env['GEMINI_CLI_HOME']
  if (geminiHome !== undefined && geminiHome !== '')
    out = out.replaceAll('<GEMINI_CLI_HOME>', esc(geminiHome))
  return out.replaceAll('<PROJECT>', 'project')
}

/**
 * `{"dir":"file","argvPath":"-o","content":".."}`: what the CLI wrote to the file an argv flag names (exec -o).
 * `{"dir":"file","path":"..","content":".."}`: a file the CLI wrote at that point of the recording (Gemini's plan
 * file, which its exit_plan_mode request names), at `path` with its placeholders filled in (outPlaceholders).
 */
function replayFile(frame, ctx, where) {
  if (typeof frame.path === 'string') {
    const target = outPlaceholders(frame.path, false)
    if (!isAbsolute(target) || /<[A-Z_]+>/.test(target)) {
      throw new FakeError(
        EXIT_MISMATCH,
        `fake-cli: the file frame's path ${JSON.stringify(frame.path)} is not an absolute path here ${where}`,
      )
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, typeof frame.content === 'string' ? frame.content : '')
    ctx.log({ kind: 'writeFile', path: target })
    return
  }
  const value = argvValue(ctx.argv, frame.argvPath)
  if (value === undefined || value === '') {
    throw new FakeError(
      EXIT_MISMATCH,
      `fake-cli: argv has no ${JSON.stringify(frame.argvPath)} value ${where}\n  argv: ${JSON.stringify(ctx.argv)}`,
    )
  }
  const target = resolve(process.cwd(), value)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, typeof frame.content === 'string' ? frame.content : '')
  ctx.log({ kind: 'writeFile', path: target })
}

/**
 * `{"dir":"promptFile","argvPath":"--prompt-file","content":".."}`: the host wrote the prompt to the file an argv
 * flag names before it spawned the CLI (Muse exec reads its prompt from it, never from argv). The file must exist and
 * hold `content` (CRLF folded to LF), else a mismatch (99).
 */
function replayPromptFile(frame, ctx, where) {
  const value = argvValue(ctx.argv, frame.argvPath)
  if (value === undefined || value === '') {
    throw new FakeError(
      EXIT_MISMATCH,
      `fake-cli: argv has no ${JSON.stringify(frame.argvPath)} value ${where}\n  argv: ${JSON.stringify(ctx.argv)}`,
    )
  }
  const target = resolve(process.cwd(), value)
  let text
  try {
    text = readFileSync(target, 'utf8')
  } catch (err) {
    throw new FakeError(
      EXIT_MISMATCH,
      `fake-cli: the prompt file ${target} cannot be read ${where}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const norm = (s) => String(s).replace(/\r\n/g, '\n')
  const expected = typeof frame.content === 'string' ? frame.content : ''
  if (norm(text) !== norm(expected)) {
    throw new FakeError(
      EXIT_MISMATCH,
      [
        `fake-cli: the prompt file differs from the recording ${where}`,
        `  expected: ${previewLine(expected)}`,
        `  received: ${previewLine(text)}`,
      ].join('\n'),
    )
  }
  ctx.log({ kind: 'promptFile', path: target, chars: text.length })
}

/**
 * `{"dir":"hold"}`: the CLI was still running when the host killed it (exec has no graceful stop). The replay idles
 * until the host kills the process; a host that never does is a mismatch after the stdin timeout.
 */
async function replayHold(where, timeoutMs) {
  await sleep(timeoutMs)
  throw new FakeError(
    EXIT_MISMATCH,
    `fake-cli: the host did not stop the process within ${timeoutMs} ms ${where}`,
  )
}

const exitOf = (frame) => {
  const signal = typeof frame.signal === 'string' && typeof frame.code !== 'number' ? frame.signal : undefined
  return { code: typeof frame.code === 'number' ? frame.code : 1, signal }
}

async function replayRecording(entries, ctx) {
  if (entries[0].value.protocol === 'jsonrpc') return replayJsonRpc(entries, ctx)
  const clock = replayClock()
  const timeoutMs = defaultTimeout()
  const idMap = new Map()
  for (const { value: frame, lineNo } of entries.slice(1)) {
    if (!isObject(frame)) throw setupError(`${ctx.file}:${lineNo}: expected a frame object`)
    await clock(frame)
    const where = `at ${ctx.file}:${lineNo}`
    switch (frame.dir) {
      case 'out':
      case 'err': {
        const eol = frame.eol === false ? '' : frame.crlf === true ? '\r\n' : '\n'
        const text = applyIdMap(String(frame.line ?? ''), idMap) + eol
        await writeTo(frame.dir === 'out' ? process.stdout : process.stderr, text)
        break
      }
      case 'in': {
        const expectedLine = String(frame.line ?? '')
        const r = await ctx.stdin.next(timeoutMs)
        if (r.kind === 'eof') {
          throw new FakeError(
            EXIT_STDIN_CLOSED,
            `fake-cli: stdin closed during replay ${where}\n  expected: ${previewLine(expectedLine)}`,
          )
        }
        if (r.kind !== 'line') {
          throw new FakeError(
            EXIT_MISMATCH,
            `fake-cli: timed out after ${timeoutMs} ms waiting for stdin during replay ${where}\n  expected: ${previewLine(expectedLine)}`,
          )
        }
        const expected = tryParseJson(expectedLine)
        const actual = tryParseJson(r.line)
        const diffs =
          expected.ok && actual.ok
            ? compareRecorded(expected.value, actual.value, { normalize: ctx.normalize, idMap })
            : compareRecorded(expectedLine, r.line, { normalize: ctx.normalize, idMap })
        if (diffs.length > 0) throw mismatchError(`during replay ${where}`, diffs, expectedLine, r.line)
        break
      }
      case 'eof':
        await replayEof(ctx, where, timeoutMs, undefined)
        break
      case 'file':
        replayFile(frame, ctx, where)
        break
      case 'promptFile':
        replayPromptFile(frame, ctx, where)
        break
      case 'hold':
        await replayHold(where, timeoutMs)
        break
      case 'exit':
        return exitOf(frame)
      default:
        break // unknown frame kinds are informational
    }
  }
  return { code: 0, signal: undefined }
}

/** What a JSON-RPC message is, by its members (Codex omits the "jsonrpc" header). */
export function rpcKind(msg) {
  if (typeof msg.method === 'string') return hasOwn(msg, 'id') ? 'request' : 'notification'
  return hasOwn(msg, 'id') ? 'response' : 'invalid'
}

/**
 * Replay of a JSON-RPC recording (header "protocol":"jsonrpc": the Codex app-server). Client messages are matched
 * by meaning, not position: a recorded request takes the next client request of the same method, a notification
 * the next notification of the same method, a reply to a server request the reply with that id (server request ids
 * are replayed as recorded, so the client must echo them). A message that arrives before its frame waits in an
 * inbox. The match is then deep-compared like any recorded line (placeholders, cwd/home, timestamps; nested ids
 * masked). The client's own request ids are free: each recorded id maps to the one the client used, and the
 * responses are written with it. At the exit frame, a client message no recorded frame took is a mismatch.
 */
async function replayJsonRpc(entries, ctx) {
  const clock = replayClock()
  const timeoutMs = defaultTimeout()
  const clientIds = new Map()
  /** @type {{msg: Record<string, unknown>, line: string}[]} */
  const inbox = []
  /** @type {string[]} */
  const stray = []
  const toEntry = (line, where) => {
    const parsed = tryParseJson(line)
    if (!parsed.ok || !isObject(parsed.value)) {
      throw mismatchError(
        `during replay ${where}`,
        [{ path: '$', expected: 'a JSON-RPC message', actual: line, reason: 'not a JSON object' }],
        '(a JSON-RPC message)',
        line,
      )
    }
    return { msg: parsed.value, line }
  }
  const take = async (accept, expectedLine, where) => {
    const at = inbox.findIndex((e) => accept(e.msg))
    if (at !== -1) return inbox.splice(at, 1)[0]
    for (;;) {
      const r = await ctx.stdin.next(timeoutMs)
      if (r.kind === 'eof') {
        throw new FakeError(
          EXIT_STDIN_CLOSED,
          `fake-cli: stdin closed during replay ${where}\n  expected: ${previewLine(expectedLine)}`,
        )
      }
      if (r.kind === 'signal') return undefined
      if (r.kind !== 'line') {
        const waiting = inbox.map((e) => `\n  unmatched: ${previewLine(e.line, 200)}`).join('')
        throw new FakeError(
          EXIT_MISMATCH,
          `fake-cli: timed out after ${timeoutMs} ms waiting for stdin during replay ${where}\n  expected: ${previewLine(expectedLine)}${waiting}`,
        )
      }
      const entry = toEntry(r.line, where)
      if (accept(entry.msg)) return entry
      inbox.push(entry)
    }
  }
  for (const { value: frame, lineNo } of entries.slice(1)) {
    if (!isObject(frame)) throw setupError(`${ctx.file}:${lineNo}: expected a frame object`)
    await clock(frame)
    const where = `at ${ctx.file}:${lineNo}`
    switch (frame.dir) {
      case 'out':
      case 'err': {
        const eol = frame.eol === false ? '' : frame.crlf === true ? '\r\n' : '\n'
        let text = String(frame.line ?? '')
        if (frame.dir === 'out') {
          // With FAKE_CLI_OUT_CWD=1 the recording's <CWD> is the pass folder, which a Codex request names (a
          // command's cwd, which the allow cache compares); the fake runs in it, so the server's own messages name it
          // again (JSON-escaped), as a live server would. Off by default: the protocol suite compares frames verbatim.
          if (process.env['FAKE_CLI_OUT_CWD'] === '1') text = outPlaceholders(text, true)
          const parsed = tryParseJson(text)
          const v = parsed.ok && isObject(parsed.value) ? parsed.value : undefined
          if (v !== undefined && rpcKind(v) === 'response' && clientIds.has(v.id)) {
            const mapped = clientIds.get(v.id)
            text = JSON.stringify(
              Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'id' ? mapped : x])),
            )
          }
        }
        await writeTo(frame.dir === 'out' ? process.stdout : process.stderr, text + eol)
        break
      }
      case 'in': {
        const expectedLine = String(frame.line ?? '')
        const parsed = tryParseJson(expectedLine)
        if (!parsed.ok || !isObject(parsed.value) || rpcKind(parsed.value) === 'invalid')
          throw setupError(`${where}: an 'in' frame of a JSON-RPC recording must be a JSON-RPC message`)
        const expected = parsed.value
        const kind = rpcKind(expected)
        const accept = (m) =>
          kind === 'response'
            ? rpcKind(m) === 'response' && deepEqual(m.id, expected.id)
            : rpcKind(m) === kind && m.method === expected.method
        const got = await take(accept, expectedLine, where)
        if (got === undefined) break // a signal: the host is stopping us
        const diffs = compareRecorded(expected, got.msg, { normalize: ctx.normalize, idMap: new Map() })
        if (diffs.length > 0) throw mismatchError(`during replay ${where}`, diffs, expectedLine, got.line)
        if (kind === 'request') clientIds.set(expected.id, got.msg.id)
        ctx.log({ kind: 'rpc', method: expected.method ?? null, id: got.msg.id ?? null })
        break
      }
      case 'eof':
        await replayEof(ctx, where, timeoutMs, stray)
        break
      case 'file':
        replayFile(frame, ctx, where)
        break
      case 'hold':
        await replayHold(where, timeoutMs)
        break
      case 'exit': {
        while (ctx.stdin.queue.length > 0) stray.push(ctx.stdin.queue.shift())
        const left = [...inbox.map((e) => e.line), ...stray]
        if (left.length > 0) {
          throw new FakeError(
            EXIT_MISMATCH,
            [
              `fake-cli: client messages the recording does not have ${where}`,
              ...left.map((l) => `  ${previewLine(l)}`),
            ].join('\n'),
          )
        }
        return exitOf(frame)
      }
      default:
        break // unknown frame kinds are informational
    }
  }
  return { code: 0, signal: undefined }
}

function initialVars() {
  const vars = Object.create(null)
  vars.FAKE_CWD = process.cwd()
  vars.FAKE_HOME = homedir()
  vars.FAKE_PID = process.pid
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('FAKE_VAR_') && k.length > 9 && v !== undefined) vars[k.slice(9)] = v
  }
  return vars
}

function cwdVariants() {
  const out = [process.cwd()]
  try {
    out.push(realpathSync.native(process.cwd()))
  } catch {
    // keep the plain cwd
  }
  // macOS: getcwd() reports /private/var/... while the host spawned us with /var/... (a symlink).
  if (process.platform === 'darwin') {
    for (const p of [...out]) if (p.startsWith('/private/')) out.push(p.slice('/private'.length))
  }
  return [...new Set(out)]
}

const CLAUDE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/

/**
 * `$CLAUDE_CONFIG_DIR/projects/<cwd, non-alphanumerics → '-'>` when this run keeps Claude transcripts (see the
 * header): a persisted `-p` run under an explicit CLAUDE_CONFIG_DIR inside the OS temp dir. null otherwise.
 */
let claudeProjectDir = null

function claudeTranscriptDir(argv) {
  if (process.env.FAKE_CLI_CLAUDE_TRANSCRIPTS === '0') return null
  const configDir = process.env.CLAUDE_CONFIG_DIR
  if (!configDir || !argv.includes('-p') || argv.includes('--no-session-persistence')) return null
  const inside = (base, p) => {
    const rel = relative(base, p)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }
  const inTmp =
    inside(canonicalPath(tmpdir()), canonicalPath(configDir)) ||
    inside(resolve(tmpdir()).toLowerCase(), resolve(configDir).toLowerCase())
  return inTmp ? join(resolve(configDir), 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-')) : null
}

/** The run's `--session-id=<id>` / `--session-id <id>`, if any. */
function argvSessionId(argv) {
  let id
  argv.forEach((a, i) => {
    if (a.startsWith('--session-id=')) id = a.slice('--session-id='.length)
    else if (a === '--session-id') id = argv[i + 1]
  })
  return id
}

/** Keep the transcript of session `id`; best effort, never fails the run. */
function keepClaudeTranscript(id) {
  if (claudeProjectDir === null || typeof id !== 'string' || !CLAUDE_SESSION_ID.test(id)) return
  const file = join(claudeProjectDir, `${id}.jsonl`)
  try {
    mkdirSync(claudeProjectDir, { recursive: true })
    if (!existsSync(file))
      writeFileSync(file, `${JSON.stringify({ type: 'fake-transcript', sessionId: id })}\n`)
  } catch {
    // a transcript the fake could not write only makes canResume answer no
  }
}

/**
 * The real CLI keeps the transcript of the session it reports: a replayed recording reports its recorded id
 * (`system/init`), so that session gets a transcript too.
 */
function noteClaudeSessions(text) {
  for (const line of text.split('\n')) {
    if (!line.includes('session_id') || !line.includes('"init"')) continue
    try {
      const f = JSON.parse(line)
      if (f !== null && f.type === 'system' && f.subtype === 'init') keepClaudeTranscript(f.session_id)
    } catch {
      // not a frame
    }
  }
}

async function finish(log, code, signal) {
  log(signal ? { kind: 'exit', code, signal } : { kind: 'exit', code })
  await Promise.race([Promise.all([flushStream(process.stdout), flushStream(process.stderr)]), delay(2000)])
  if (signal) {
    try {
      process.kill(process.pid, signal)
      await delay(1000)
    } catch {
      // fall through to a plain exit
    }
  }
  process.exit(code)
}

/** FAKE_CLI_LOG_ENV: the named variables as the fake saw them (tests check what the host put in a spawn's env). */
function loggedEnv() {
  const names = (process.env.FAKE_CLI_LOG_ENV ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '')
  if (names.length === 0) return {}
  return { env: Object.fromEntries(names.map((n) => [n, process.env[n] ?? null])) }
}

async function main() {
  const argv = process.argv.slice(2)
  const log = createLog(process.env.FAKE_CLI_LOG)
  log({ kind: 'start', argv, cwd: process.cwd(), ...loggedEnv() })
  const stdin = new StdinLines(log)
  // A host that closed our stdout must not crash the fake with EPIPE; exit codes stay meaningful.
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
  let code
  let signal
  claudeProjectDir = claudeTranscriptDir(argv)
  keepClaudeTranscript(argvSessionId(argv))
  try {
    const selected = selectScript(argv)
    const entries = parseJsonl(readFileSync(selected.file, 'utf8'), selected.file)
    const recording = isObject(entries[0]?.value) && entries[0].value.kind === 'header'
    log({ kind: 'script', file: selected.file, entry: selected.entry, mode: recording ? 'replay' : 'script' })
    const ctx = {
      argv,
      file: selected.file,
      stdin,
      log,
      /** JSON-RPC client messages read but not yet taken by an rpc op. */
      rpcInbox: [],
      vars: initialVars(),
      normalize: makePathNormalizer([...cwdVariants().map((c) => [c, '<CWD>']), [homedir(), '~']]),
    }
    const result = recording
      ? await replayRecording(entries, ctx)
      : await runScript(loadScript(entries, selected.file), ctx)
    code = result.code
    signal = result.signal
  } catch (err) {
    if (err instanceof FakeError) {
      code = err.code
      process.stderr.write(`${err.message}\n`)
    } else {
      code = EXIT_SETUP
      process.stderr.write(`fake-cli: internal error: ${err instanceof Error ? err.stack : String(err)}\n`)
    }
    log({ kind: 'error', code, message: err instanceof Error ? err.message : String(err) })
  }
  await finish(log, code, signal)
}

function isMainModule() {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return canonicalPath(argv1) === canonicalPath(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) await main()
