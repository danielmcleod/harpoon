// ThreadItem → normalized `tool` events (event mapping: item/started / item/completed for
// commandExecution, fileChange, mcpToolCall, webSearch, collabAgent; turn/plan/updated → the todo tool). One mapper
// for both routes: exec items go through exec-shim.ts first (a lossy snake_case copy of the same items).
import type { NormalizedEventOf, ToolStatus } from '../../../shared/events.ts'
import type { Rec } from './wire.ts'
import { arr, num, rec, str } from './wire.ts'
import { relativeTo } from '../paths.ts'

export const SUMMARY_MAX = 120

const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

/** One line, no control characters, at most `max` characters. */
export function clip(s: string, max = SUMMARY_MAX): string {
  let out = ''
  for (const ch of (s.replace(ANSI, '').split(/\r?\n/)[0] ?? '').trim()) {
    const c = ch.codePointAt(0) ?? 0
    if (c >= 0x20 || ch === '\t') out += ch
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out
}

/** Items shown as tools, and their tool name. */
export const TOOL_ITEM_NAMES: Readonly<Record<string, string>> = {
  commandExecution: 'shell',
  fileChange: 'edit',
  mcpToolCall: 'mcp',
  dynamicToolCall: 'tool',
  webSearch: 'web_search',
  collabAgentToolCall: 'agent',
}

export const isToolItem = (item: Rec): boolean =>
  str(item['type']) !== undefined && str(item['type'])! in TOOL_ITEM_NAMES

/** `Read a.ts`, `Search "foo" in src`, `List src`, else `$ <command>` (commandActions first, as the TUI does). */
export function commandSummary(item: Rec): string {
  const actions = arr(item['commandActions'])
    .map(rec)
    .filter((a): a is Rec => a !== undefined)
  const parts: string[] = []
  for (const a of actions) {
    const type = str(a['type'])
    if (type === 'read') parts.push(`Read ${str(a['name']) ?? str(a['path']) ?? ''}`.trim())
    else if (type === 'listFiles') parts.push(`List ${str(a['path']) ?? '.'}`)
    else if (type === 'search') {
      const q = str(a['query'])
      const p = str(a['path'])
      parts.push(`Search${q !== undefined ? ` "${q}"` : ''}${p !== undefined ? ` in ${p}` : ''}`)
    } else {
      parts.length = 0
      break
    }
  }
  if (parts.length > 0) return clip(parts.join(', '))
  // Codex runs each command through a shell (on Windows `"C:\…\powershell.exe" -Command '<script>'`, live X02); the
  // actions carry the script itself, so the line shows what ran rather than the wrapper.
  const scripts = actions.map((a) => str(a['command'])).filter((c) => c !== undefined && c.trim() !== '')
  if (scripts.length > 0 && scripts.length === actions.length) return clip(`$ ${scripts.join('; ')}`)
  return clip(`$ ${unwrapShell(str(item['command']) ?? '')}`)
}

const SHELL_WRAPPER =
  /^"?(?:[^"\s]*[\\/])?(powershell|pwsh|bash|zsh|sh)(?:\.exe)?"?\s+(?:-(?:NoProfile|NoLogo|NonInteractive)\s+)*(?:-Command|-lc|-c)\s+([\s\S]+)$/i

/**
 * The script of a command Codex ran through a shell (`"C:\…\powershell.exe" -Command '<script>'`, `bash -lc
 * '<script>'`); any other command as given. exec items carry no commandActions to read it from (live E02).
 */
export function unwrapShell(command: string): string {
  const m = SHELL_WRAPPER.exec(command.trim())
  if (m === null) return command
  const shell = (m[1] ?? '').toLowerCase()
  const body = (m[2] ?? '').trim()
  const q = body[0]
  if ((q !== "'" && q !== '"') || body.length < 2 || !body.endsWith(q)) return body
  const inner = body.slice(1, -1)
  if (q === '"') return inner
  // A single-quoted script: PowerShell doubles a quote inside it, a POSIX shell writes '\''.
  return shell === 'powershell' || shell === 'pwsh'
    ? inner.replaceAll("''", "'")
    : inner.replaceAll("'\\''", "'")
}

const KIND_LETTER: Readonly<Record<string, string>> = { add: 'A', delete: 'D', update: 'M' }

/** File paths of a fileChange item (for edit asks and the tool summary). */
export function changePaths(item: Rec): string[] {
  return arr(item['changes'])
    .map((c) => str(rec(c)?.['path']))
    .filter((p): p is string => p !== undefined)
}

/** `A x.ts, M y.ts, D z.ts` (a move reads `R a -> b`); paths inside `cwd` relative to it. */
export function fileChangeSummary(item: Rec, cwd?: string): string {
  const parts = arr(item['changes']).flatMap((c) => {
    const r = rec(c)
    const path = str(r?.['path'])
    if (path === undefined) return []
    const kind = rec(r?.['kind'])
    const type = str(kind?.['type']) ?? str(r?.['kind']) ?? 'update'
    const move = str(kind?.['move_path'])
    if (move !== undefined) return [`R ${relativeTo(path, cwd)} -> ${relativeTo(move, cwd)}`]
    return [`${KIND_LETTER[type] ?? 'M'} ${relativeTo(path, cwd)}`]
  })
  return clip(parts.length > 0 ? parts.join(', ') : 'file changes')
}

function firstStringArg(v: unknown): string | undefined {
  const r = rec(v)
  if (r === undefined) return typeof v === 'string' ? v : undefined
  return Object.values(r).find((x): x is string => typeof x === 'string')
}

const nonEmpty = (s: string | undefined): string | undefined =>
  s !== undefined && s.trim() !== '' ? s : undefined

/** Web search actions that read pages; a `search` (or no action yet) reads none. */
const PAGE_ACTIONS = new Set(['openPage', 'findInPage', 'other'])

/**
 * The pages a web search item read, distinct, in order: the action's `url`, then the `url` of each of its `results`.
 * Live X17 (codex-cli 0.160.1): an opened page comes as action `other`, or `findInPage` with a null url, and the pages
 * are only in `results` (opaque JSON in the protocol, read defensively). A `search` action's results are search hits,
 * not pages read, so it has none.
 */
export function webPagesOf(item: Rec): string[] {
  const action = rec(item['action'])
  if (!PAGE_ACTIONS.has(str(action?.['type']) ?? '')) return []
  const urls = [str(action?.['url']), ...arr(item['results']).map((r) => str(rec(r)?.['url']))]
    .map((u) => u?.trim())
    .filter((u): u is string => u !== undefined && u !== '')
  return [...new Set(urls)]
}

/**
 * A web search item: the page it read (`openPage` / `findInPage` / `other`: the first page's URL, which the catalog
 * refresh counts as a page read, then "(+N more)"), else the query.
 */
function webSearchSummary(item: Rec): string {
  const action = rec(item['action'])
  const url = nonEmpty(str(action?.['url']))
  const pages = webPagesOf(item)
  if (pages.length > 0) {
    const [first = '', ...rest] = pages
    const more = rest.length > 0 ? ` (+${rest.length} more)` : ''
    return `${clip(first, 300 - more.length)}${more}`
  }
  const q =
    nonEmpty(str(action?.['query'])) ??
    nonEmpty(str(arr(action?.['queries'])[0])) ??
    nonEmpty(str(item['query'])) ??
    url ??
    'web search'
  return clip(q)
}

/** Tool name and summary of a tool item (undefined for anything that is not a tool); `cwd` is the pass folder. */
export function toolOf(item: Rec, cwd?: string): { id: string; name: string; summary: string } | undefined {
  const type = str(item['type'])
  const id = str(item['id'])
  if (type === undefined || id === undefined || !(type in TOOL_ITEM_NAMES)) return undefined
  switch (type) {
    case 'commandExecution':
      return { id, name: 'shell', summary: commandSummary(item) }
    case 'fileChange':
      return { id, name: 'edit', summary: fileChangeSummary(item, cwd) }
    case 'mcpToolCall': {
      const server = str(item['server']) ?? 'mcp'
      const tool = str(item['tool']) ?? 'tool'
      return { id, name: `mcp:${server}/${tool}`, summary: clip(firstStringArg(item['arguments']) ?? tool) }
    }
    case 'dynamicToolCall': {
      const ns = str(item['namespace'])
      const tool = str(item['tool']) ?? 'tool'
      return {
        id,
        name: `tool:${ns !== undefined ? `${ns}/` : ''}${tool}`,
        summary: clip(firstStringArg(item['arguments']) ?? tool),
      }
    }
    case 'webSearch':
      return { id, name: 'web_search', summary: webSearchSummary(item) }
    case 'collabAgentToolCall':
      return { id, name: `agent:${str(item['tool']) ?? 'agent'}`, summary: clip(str(item['prompt']) ?? '') }
    default:
      return undefined
  }
}

/** A completed item's status: completed → ok; failed / interrupted → failed; declined → declined. */
export function endStatus(item: Rec): ToolStatus {
  const status = str(item['status'])
  if (status === 'declined') return 'declined'
  if (status === 'failed' || status === 'interrupted') return 'failed'
  if (str(item['type']) === 'commandExecution') {
    const code = num(item['exitCode'])
    if (code !== undefined && code !== 0) return 'failed'
  }
  if (str(item['type']) === 'mcpToolCall' && item['error'] !== null && item['error'] !== undefined)
    return 'failed'
  if (str(item['type']) === 'dynamicToolCall' && item['success'] === false) return 'failed'
  return 'ok'
}

export function toolStart(item: Rec, cwd?: string): NormalizedEventOf<'tool'> | undefined {
  const t = toolOf(item, cwd)
  return t === undefined
    ? undefined
    : { type: 'tool', id: t.id, name: t.name, summary: t.summary, phase: 'start' }
}

export function toolEnd(item: Rec, cwd?: string): NormalizedEventOf<'tool'> | undefined {
  const t = toolOf(item, cwd)
  return t === undefined
    ? undefined
    : { type: 'tool', id: t.id, name: t.name, summary: t.summary, phase: 'end', status: endStatus(item) }
}

/** turn/plan/updated (exec: todo_list) → the todo tool: `2/5 done · next: write the test`. */
export function todoEvent(
  steps: readonly { text: string; done: boolean; active?: boolean }[],
  id = 'todo',
): NormalizedEventOf<'tool'> {
  const done = steps.filter((s) => s.done).length
  const next = steps.find((s) => s.active === true) ?? steps.find((s) => !s.done)
  const summary = clip(`${done}/${steps.length} done${next !== undefined ? ` · next: ${next.text}` : ''}`)
  return { type: 'tool', id, name: 'todo', summary }
}

/** turn/plan/updated `plan: [{step, status: pending|inProgress|completed}]`. */
export function planSteps(plan: unknown): { text: string; done: boolean; active: boolean }[] {
  return arr(plan).flatMap((p) => {
    const r = rec(p)
    const text = str(r?.['step'])
    if (text === undefined) return []
    const status = str(r?.['status'])
    return [{ text, done: status === 'completed', active: status === 'inProgress' }]
  })
}
