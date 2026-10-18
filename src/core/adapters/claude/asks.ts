// can_use_tool → `ask` (Claude asks): kind, detail, allow-session rules, and the automatic
// answers the adapter owns (plan capture, read-only deny, unsupported prompts, allow-cache hits).
import { homedir } from 'node:os'
import type { AllowRule, AllowRuleMatch, AskKind, NormalizedEventOf } from '../../../shared/events.ts'
import type { AllowCache, AllowQuery } from '../allow-cache.ts'
import { exactRuleFor, ruleMatches } from '../allow-cache.ts'
import { relativeTo } from '../paths.ts'
import { CLAUDE_VENDOR } from './capabilities.ts'
import { isUnderDir } from './plan-hygiene.ts'
import type { CanUseToolRequest, JsonObject, PermissionUpdate } from './protocol.ts'
import { str } from './protocol.ts'

export const DETAIL_MAX = 2000
const SUMMARY_MAX = 120

const SHELL = new Set(['Bash', 'PowerShell'])
const EDIT = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const NETWORK = new Set(['WebFetch', 'WebSearch'])
const PATH_TOOLS = new Set([...EDIT, 'Read'])

export function askKind(tool: string): AskKind {
  if (SHELL.has(tool)) return 'shell'
  if (EDIT.has(tool)) return 'edit'
  if (NETWORK.has(tool)) return 'network'
  return 'other'
}

const ESC = String.fromCharCode(27)
const ANSI = new RegExp(
  `${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${String.fromCharCode(7)}${ESC}]*(?:${String.fromCharCode(7)}|${ESC}\\\\)|[@-Z\\\\-_])`,
  'g',
)

/** Strip ANSI escapes and C0 controls other than tab and newline. */
export function stripAnsi(s: string): string {
  let out = ''
  for (const ch of s.replace(ANSI, '')) {
    const c = ch.codePointAt(0) ?? 0
    if (c >= 0x20 || ch === '\n' || ch === '\t') out += ch
  }
  return out
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const firstLine = (s: string): string => s.split(/\r?\n/)[0] ?? ''

/** AskUserQuestion input (C15a): `{questions: [{question, header, options, multiSelect}]}`. */
function firstQuestion(input: JsonObject): string | undefined {
  const qs = input['questions']
  const q: unknown = Array.isArray(qs) ? qs[0] : undefined
  return q !== null && typeof q === 'object' ? str((q as JsonObject)['question']) : undefined
}

/**
 * One-line summary of a tool call for `tool` events and ask details. `cwd` (the pass folder; tool events only, live
 * balanced run): a file path inside it reads relative, as Codex's tool lines do, so the clipped line keeps the file
 * name ("Read src/cli.ts", not the folder's own long path cut short). An ask's detail keeps the path as given.
 */
export function summarizeTool(name: string, input: JsonObject, cwd?: string): string {
  const s = (k: string): string | undefined => str(input[k])
  const at = (k: string): string | undefined => {
    const v = s(k)
    return v !== undefined ? relativeTo(v, cwd) : undefined
  }
  let text: string | undefined
  if (SHELL.has(name)) text = s('command')
  else if (PATH_TOOLS.has(name)) text = at('file_path') ?? at('notebook_path')
  else if (name === 'Grep' || name === 'Glob') text = [s('pattern'), at('path')].filter(Boolean).join(' in ')
  else if (name === 'WebFetch') text = s('url')
  else if (name === 'WebSearch' || name === 'ToolSearch') text = s('query')
  else if (name === 'Task' || name === 'Agent') text = s('description')
  else if (name === 'ExitPlanMode') text = 'plan ready'
  // C17: the jsonSchema answer tool; its input is the whole answer, never a summary.
  else if (name === 'StructuredOutput') text = 'answer ready'
  else if (name === 'AskUserQuestion') text = firstQuestion(input)
  else if (/^(TodoWrite|Task(Create|Update|List|Get|Output))$/.test(name)) text = 'updated tasks'
  else if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__')
    text = server !== undefined && tool !== undefined ? `${server}: ${tool}` : name
  } else {
    text = Object.values(input).find((v): v is string => typeof v === 'string')
  }
  return clip(stripAnsi(firstLine(text ?? '')), SUMMARY_MAX)
}

/** `title ?? "<display name>: <summary>"`, then the model's description, the reason and the blocked path. */
export function askDetail(req: CanUseToolRequest): string {
  const name = req.display_name ?? req.tool_name
  const summary = summarizeTool(req.tool_name, req.input)
  const head = req.title ?? (summary ? `${name}: ${summary}` : name)
  const parts = [head]
  if (req.description && req.description !== summary && !head.includes(req.description)) {
    parts.push(req.description)
  }
  if (req.decision_reason) parts.push(req.decision_reason)
  if (req.blocked_path) parts.push(`Path: ${req.blocked_path}`)
  return clip(stripAnsi(parts.join('\n')), DETAIL_MAX)
}

export function askEvent(
  requestId: string,
  req: CanUseToolRequest,
  expiresAt: number,
): NormalizedEventOf<'ask'> {
  const ev: NormalizedEventOf<'ask'> = {
    type: 'ask',
    requestId,
    kind: askKind(req.tool_name),
    detail: askDetail(req),
    expiresAt,
    allowSession: req.suppress_always_allow_rule !== true && req.requires_user_interaction !== true,
  }
  if (req.decision_reason) ev.reason = clip(stripAnsi(req.decision_reason), DETAIL_MAX)
  if (req.default_to_no === true) ev.defaultToNo = true
  return ev
}

// ---- allow cache ------------------------------------------------------------------------------------------

const tokens = (command: string): string[] =>
  command
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '')

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const o = v as JsonObject
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** What an ask asks for, in allow-cache terms. */
export function allowQuery(req: CanUseToolRequest): AllowQuery {
  const q: AllowQuery = { vendor: CLAUDE_VENDOR, kind: askKind(req.tool_name), tool: req.tool_name }
  const input = req.input
  if (SHELL.has(req.tool_name)) {
    const cmd = str(input['command'])
    if (cmd !== undefined) q.argv = tokens(cmd)
  } else if (PATH_TOOLS.has(req.tool_name)) {
    const p = str(input['file_path']) ?? str(input['notebook_path'])
    if (p !== undefined) q.path = p
  } else if (req.tool_name === 'WebFetch') {
    const url = str(input['url'])
    if (url !== undefined) q.url = url
  } else if (req.tool_name === 'WebSearch') {
    const query = str(input['query'])
    if (query !== undefined) q.argv = [query]
  } else {
    q.argv = [stableJson(input)]
  }
  return q
}

/** Claude rule syntax → match. Undefined when the vendor scope cannot be represented exactly. */
function matchForRuleContent(tool: string, content: string | undefined): AllowRuleMatch | undefined {
  if (content === undefined || content === '') return {}
  if (SHELL.has(tool)) {
    const prefix = /^(.*?)(?::\*| \*)$/.exec(content)?.[1]
    const body = prefix ?? content
    if (body.includes('*') || body.trim() === '') return undefined
    return prefix !== undefined ? { argvPrefix: tokens(body) } : { argv: tokens(body) }
  }
  if (PATH_TOOLS.has(tool)) {
    // `//abs` is absolute, `/x` is relative to the project root (the pass cwd), `~/x` is the home.
    const glob = content.startsWith('//')
      ? content.slice(1)
      : content.startsWith('/')
        ? content.slice(1)
        : content
    return glob === '' ? undefined : { pathGlob: glob }
  }
  if (tool === 'WebFetch') {
    const host = /^domain:(.+)$/.exec(content)?.[1]
    return host !== undefined ? { host } : undefined
  }
  return undefined
}

/** `Tool(content)` strings for `--allowedTools`, from the vendor's addRules/allow suggestions. */
export function nativeRulesFrom(suggestions: readonly PermissionUpdate[]): string[] {
  const out: string[] = []
  for (const s of suggestions) {
    if (s.type !== 'addRules' || s.behavior !== 'allow') continue
    for (const r of s.rules) out.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)
  }
  return [...new Set(out)]
}

/**
 * The "Allow for this run" rule for an answered ask. A single vendor rule for this tool whose scope Harpoon
 * can represent becomes a `vendor-suggestion` rule (only if it covers this very ask); anything else becomes an
 * exact rule for this ask. `nativeRules` always carries the vendor's own rule strings.
 */
export function allowRuleFor(
  req: CanUseToolRequest,
  suggestions: readonly PermissionUpdate[],
  opts: { cwd?: string; home?: string } = {},
): AllowRule | undefined {
  const query = allowQuery(req)
  const native = nativeRulesFrom(suggestions)
  const own = suggestions
    .filter((s) => s.type === 'addRules' && s.behavior === 'allow')
    .flatMap((s) => (s.type === 'addRules' ? s.rules : []))
  const matchOpts = { cwd: opts.cwd, home: opts.home ?? homedir() }
  if (own.length === 1 && own[0]!.toolName === req.tool_name) {
    const match = matchForRuleContent(req.tool_name, own[0]!.ruleContent)
    if (match !== undefined) {
      const rule: AllowRule = {
        vendor: CLAUDE_VENDOR,
        kind: query.kind,
        tool: req.tool_name,
        match,
        source: 'vendor-suggestion',
      }
      if (native.length > 0) rule.nativeRules = native
      if (ruleMatches(rule, query, definedOnly(matchOpts))) return rule
    }
  }
  const exact = exactRuleFor(query)
  if (exact === undefined) return undefined
  if (native.length > 0) exact.nativeRules = native
  else if (SHELL.has(req.tool_name)) {
    const cmd = str(req.input['command'])?.trim()
    if (cmd && !/[\r\n]/.test(cmd)) exact.nativeRules = [`${req.tool_name}(${cmd})`]
  }
  return exact
}

function definedOnly(o: { cwd?: string | undefined; home?: string | undefined }): {
  cwd?: string
  home?: string
} {
  const out: { cwd?: string; home?: string } = {}
  if (o.cwd !== undefined) out.cwd = o.cwd
  if (o.home !== undefined) out.home = o.home
  return out
}

// ---- automatic answers ------------------------------------------------------------------------------------

export type AutoAnswer =
  | { kind: 'plan-capture' }
  | { kind: 'readonly' }
  | { kind: 'unsupported' }
  | { kind: 'allow-cache'; rule: AllowRule }

export interface AutoAnswerContext {
  /** Native plan pass: ExitPlanMode is captured, every other ask is denied. */
  planPass: boolean
  /** Read-only pass (no host is attached, so asks are not expected). */
  readOnly: boolean
  cache?: AllowCache | undefined
  cwd?: string | undefined
}

/** The adapter's own answer for an ask, or undefined to raise it to the user. Checked in this order. */
export function autoAnswerFor(req: CanUseToolRequest, ctx: AutoAnswerContext): AutoAnswer | undefined {
  if (ctx.planPass && req.tool_name === 'ExitPlanMode') return { kind: 'plan-capture' }
  if (ctx.planPass || ctx.readOnly) return { kind: 'readonly' }
  if (req.requires_user_interaction === true) return { kind: 'unsupported' }
  const hit = ctx.cache?.match(allowQuery(req), ctx.cwd !== undefined ? { cwd: ctx.cwd } : {})
  return hit !== undefined ? { kind: 'allow-cache', rule: hit } : undefined
}

/**
 * The plan text: `input.plan`, else the plan file when it lies under `<config dir>/plans`. `home` resolves a
 * `~`-relative planFilePath (default: the OS home).
 */
export function capturePlan(
  input: JsonObject,
  plansDir: string,
  readFile: ((path: string) => string | undefined) | undefined,
  home: string = homedir(),
): string | undefined {
  const plan = str(input['plan'])?.trim()
  if (plan) return plan
  const file = str(input['planFilePath'])
  if (file === undefined || readFile === undefined) return undefined
  if (!isUnderDir(file, plansDir, home)) return undefined
  return readFile(file)?.trim() || undefined
}
