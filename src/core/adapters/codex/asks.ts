// Codex server requests → `ask` (Codex approvals): commandExecution, fileChange and permissions
// requestApproval each become an ask; MCP elicitations are auto-cancelled; everything else Harpoon cannot show is
// refused. Replies map exactly per the approvals table (replyFor) and never send acceptWithExecpolicyAmendment.
import type { AllowRule, AskDecision, AskKind, NormalizedEventOf } from '../../../shared/events.ts'
import type { AllowQuery } from '../allow-cache.ts'
import { exactRuleFor, normalizePath, ruleMatches } from '../allow-cache.ts'
import { CODEX_VENDOR } from './capabilities.ts'
import { clip } from './map-item.ts'
import { approvalReply, permissionsReply } from './params.ts'
import type { Rec } from './wire.ts'
import { arr, rec, str } from './wire.ts'

export const COMMAND_APPROVAL = 'item/commandExecution/requestApproval'
export const FILE_APPROVAL = 'item/fileChange/requestApproval'
export const PERMISSIONS_APPROVAL = 'item/permissions/requestApproval'
export const ELICITATION = 'mcpServer/elicitation/request'

/** The server requests relayed to the user. */
export const ASK_METHODS = [COMMAND_APPROVAL, FILE_APPROVAL, PERMISSIONS_APPROVAL] as const
export type AskMethod = (typeof ASK_METHODS)[number]

/**
 * Requests Harpoon cannot answer for the user: refused with a JSON-RPC error (the turn goes on without them), as
 * `codex exec` does. request_user_input is plan mode's clarifying question; the plan then proceeds on assumptions.
 */
export const REFUSED_METHODS = [
  'item/tool/requestUserInput',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'currentTime/read',
  'applyPatchApproval',
  'execCommandApproval',
] as const
export const REFUSED_CODE = -32000
export const REFUSED_MESSAGE = 'Not supported by Harpoon; continue without it.'

export const DETAIL_MAX = 2000

/** Shell text → argv tokens for the allow cache (exact match only; Harpoon never generalizes). */
const tokens = (command: string): string[] =>
  command
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '')

function detailClip(s: string): string {
  return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s
}

export interface AskSpec {
  event: NormalizedEventOf<'ask'>
  /** What the ask asks for, in allow-cache terms (undefined: never cached). */
  query?: AllowQuery
  /** The tool name for `auto-answered` signals. */
  tool: string
}

export interface AskContext {
  requestId: string
  expiresAt: number
  /** The pass cwd: a command running elsewhere names its folder. */
  cwd: string
  /** Paths of the fileChange item an edit approval refers to (cached from item/started). */
  changesOf: (itemId: string) => string[]
}

/** A FileSystemPath (path | glob_pattern | special) in words; undefined when Harpoon cannot say what it is. */
function pathWords(p: Rec | undefined): string | undefined {
  switch (str(p?.['type']) ?? '') {
    case 'path':
      return str(p?.['path'])
    case 'glob_pattern': {
      const g = str(p?.['pattern'])
      return g !== undefined ? `files matching ${g}` : undefined
    }
    case 'special': {
      const v = rec(p?.['value'])
      const sub = str(v?.['subpath'])
      switch (str(v?.['kind']) ?? '') {
        case 'root':
          return 'the whole disk (every folder)'
        case 'minimal':
          return 'the system files commands need'
        case 'project_roots':
          return sub !== undefined && sub !== '' ? `${sub} in the project folders` : 'the project folders'
        case 'tmpdir':
          return 'the temp folder'
        case 'slash_tmp':
          return '/tmp'
        case 'unknown': {
          const path = str(v?.['path'])
          if (path === undefined || path === '') return undefined
          return sub !== undefined && sub !== '' ? `${path} (${sub})` : path
        }
        default:
          return undefined
      }
    }
    default:
      return undefined
  }
}

const KNOWN_NETWORK_KEYS = new Set(['enabled'])
const KNOWN_FS_KEYS = new Set(['read', 'write', 'entries', 'globScanMaxDepth'])

export interface PermissionSummary {
  kind: AskKind
  /** One line per grant: network, write, read, no access. */
  lines: string[]
  /** Something asks for more (or other) access: the user is shown it. */
  any: boolean
  /** Every part was put in words; false: the request is shown as Codex sent it too. */
  complete: boolean
}

/**
 * What a permission profile (`permissions` of item/permissions/requestApproval, `additionalPermissions` of a command)
 * grants, in words: network, the legacy `fileSystem.read` / `fileSystem.write` lists and the 0.160 `fileSystem.entries`
 * (path | glob | special root, each read / write / deny). Allow grants the object as sent (protocol.ts permissionsReply),
 * so anything Harpoon cannot describe makes the summary incomplete and the ask shows the raw request.
 */
export function permissionSummary(p: Rec | undefined): PermissionSummary {
  const network = rec(p?.['network'])
  const fs = rec(p?.['fileSystem'])
  let complete = true
  const lines: string[] = []
  const strings = (v: unknown): string[] => {
    const list = arr(v)
    if (v !== null && v !== undefined && !Array.isArray(v)) complete = false
    const out = list.filter((x): x is string => typeof x === 'string' && x !== '')
    if (out.length !== list.length) complete = false
    return out
  }
  if (network !== undefined) {
    if (Object.keys(network).some((k) => !KNOWN_NETWORK_KEYS.has(k))) complete = false
    const enabled = network['enabled']
    if (enabled !== true && enabled !== false && enabled !== null && enabled !== undefined) complete = false
  } else if (p?.['network'] !== null && p?.['network'] !== undefined) complete = false
  const networkOn = network?.['enabled'] === true
  if (networkOn) lines.push('Network access')
  const write: string[] = []
  const read: string[] = []
  const deny: string[] = []
  if (fs !== undefined) {
    if (Object.keys(fs).some((k) => !KNOWN_FS_KEYS.has(k))) complete = false
    write.push(...strings(fs['write']))
    read.push(...strings(fs['read']))
    const entries = fs['entries']
    if (entries !== undefined && entries !== null && !Array.isArray(entries)) complete = false
    for (const e of arr(entries)) {
      const entry = rec(e)
      const where = pathWords(rec(entry?.['path']))
      const access = str(entry?.['access'])
      if (where === undefined) {
        complete = false
        continue
      }
      if (access === 'write') write.push(where)
      else if (access === 'read') read.push(where)
      else if (access === 'deny') deny.push(where)
      else complete = false
    }
  } else if (p?.['fileSystem'] !== null && p?.['fileSystem'] !== undefined) complete = false
  if (write.length > 0) lines.push(`Write access: ${write.join(', ')}`)
  if (read.length > 0) lines.push(`Read access: ${read.join(', ')}`)
  if (deny.length > 0) lines.push(`No access: ${deny.join(', ')}`)
  return {
    kind: write.length > 0 ? 'edit' : networkOn ? 'network' : 'other',
    lines,
    any: lines.length > 0 || !complete,
    complete,
  }
}

/** The request as Codex sent it, for a part Harpoon could not put in words. */
function rawLine(v: unknown): string {
  return `As Codex sent it: ${clip(JSON.stringify(v) ?? '', 600)}`
}

/** The pass folder and a command's folder are the same (normalized; case-folded on Windows). */
function sameFolder(a: string, b: string): boolean {
  const x = normalizePath(a)
  const y = normalizePath(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** The ask for one approval request (kind, detail, reason, allowSession). */
export function askFor(method: AskMethod, params: Rec, c: AskContext): AskSpec {
  const reason = str(params['reason'])
  let kind: AskKind
  let detail: string
  let tool: string
  let query: AllowQuery | undefined
  let allowSession = true
  switch (method) {
    case COMMAND_APPROVAL: {
      const command = str(params['command']) ?? ''
      const cwd = str(params['cwd'])
      const net = rec(params['networkApprovalContext'])
      // A command in another folder is shown with it, and an "Allow for this run" never covers it (the
      // cache's exact rule has no folder, so only a command in the pass folder is cached).
      const elsewhere = cwd !== undefined && cwd !== '' && !sameFolder(cwd, c.cwd)
      const where = elsewhere ? `\nin ${cwd}` : ''
      // Extra access a command asks for with it (an experimental connection's additionalPermissions): shown, and a
      // request that carries any is never cached (the rule could not say it).
      const extra = rec(params['additionalPermissions'])
      const extraSummary =
        params['additionalPermissions'] !== null && params['additionalPermissions'] !== undefined
          ? permissionSummary(extra)
          : undefined
      const extraText =
        extraSummary !== undefined && extraSummary.any
          ? `\nIt also asks for: ${[
              ...extraSummary.lines,
              ...(extraSummary.complete ? [] : [rawLine(params['additionalPermissions'])]),
            ].join('; ')}`
          : ''
      const cacheable = !elsewhere && extraSummary === undefined
      if (str(params['kind']) === 'writeStdin') {
        kind = 'shell'
        tool = 'shell-input'
        detail = `Input to a running command: ${command}${where}${extraText}`
      } else if (net !== undefined) {
        const host = str(net['host']) ?? 'a host'
        kind = 'network'
        tool = 'network'
        detail = `Network access to ${host}${str(net['protocol']) !== undefined ? ` (${str(net['protocol'])})` : ''}${
          command !== '' ? `\n${command}` : ''
        }${where}${extraText}`
        if (str(net['host']) !== undefined && extraSummary === undefined)
          query = { vendor: CODEX_VENDOR, kind, tool, host }
      } else {
        kind = 'shell'
        tool = 'shell'
        detail = `${command}${where}${extraText}`
        if (command.trim() !== '' && cacheable)
          query = { vendor: CODEX_VENDOR, kind, tool, argv: tokens(command) }
      }
      const available = params['availableDecisions']
      if (Array.isArray(available)) allowSession = available.includes('acceptForSession')
      break
    }
    case FILE_APPROVAL: {
      const paths = c.changesOf(str(params['itemId']) ?? '')
      const root = str(params['grantRoot'])
      kind = 'edit'
      tool = 'edit'
      detail = `Edit ${paths.length > 0 ? paths.join(', ') : 'files'}${
        root !== undefined ? `\nand write anywhere under ${root} for the rest of the session` : ''
      }`
      if (paths.length > 0 && root === undefined) query = { vendor: CODEX_VENDOR, kind, tool, paths }
      break
    }
    case PERMISSIONS_APPROVAL: {
      const s = permissionSummary(rec(params['permissions']))
      kind = s.kind
      tool = 'permissions'
      const lines = [...s.lines, ...(s.complete ? [] : [rawLine(params['permissions'])])]
      detail = lines.join('\n') || 'Extra permissions'
      break
    }
  }
  const event: NormalizedEventOf<'ask'> = {
    type: 'ask',
    requestId: c.requestId,
    kind,
    detail: detailClip(detail),
    expiresAt: c.expiresAt,
    allowSession,
  }
  if (reason !== undefined && reason.trim() !== '') event.reason = detailClip(reason)
  return query !== undefined ? { event, query, tool } : { event, tool }
}

/** The JSON-RPC result for a user's decision (the approvals table). */
export function replyFor(method: AskMethod, d: AskDecision, params: Rec): unknown {
  if (method === PERMISSIONS_APPROVAL) return permissionsReply(d, params['permissions'])
  return approvalReply(d)
}

/** A run's allow rule (an earlier "Allow for this run") that answers this ask. */
export function matchingRule(
  rules: readonly AllowRule[],
  query: AllowQuery | undefined,
  cwd: string,
): AllowRule | undefined {
  if (query === undefined) return undefined
  return rules.find((r) => r.vendor === CODEX_VENDOR && ruleMatches(r, query, { cwd }))
}

/** The exact rule an allow-session adds to the run (later processes accept the same request on their own). */
export function ruleFor(query: AllowQuery | undefined): AllowRule | undefined {
  return query === undefined ? undefined : exactRuleFor(query)
}

/** A short label for a refused or cancelled request (`auto-answered.tool`). */
export function requestLabel(method: string, params: Rec): string {
  if (method === ELICITATION) return `mcp:${str(params['serverName']) ?? 'server'}`
  return clip(method, 60)
}
