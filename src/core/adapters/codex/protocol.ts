// Codex app-server protocol table (probe, required vs optional methods → exec
// route or downgraded capabilities). Derived from protocol/v0.160.0/ (generated from codex-cli 0.160.1 by
// scripts/gen-codex-types.mjs); the generated types are imported type-only. Pure: no Node built-ins.
import type { AskDecision, Usage } from '../../../shared/events.ts'
import type { TokenUsageBreakdown } from './protocol/v0.160.0/v2/TokenUsageBreakdown.ts'

export type { ClientInfo } from './protocol/v0.160.0/ClientInfo.ts'
export type { CollaborationMode } from './protocol/v0.160.0/CollaborationMode.ts'
export type { InitializeCapabilities } from './protocol/v0.160.0/InitializeCapabilities.ts'
export type { InitializeParams } from './protocol/v0.160.0/InitializeParams.ts'
export type { InitializeResponse } from './protocol/v0.160.0/InitializeResponse.ts'
export type { RequestId } from './protocol/v0.160.0/RequestId.ts'
export type { ServerNotification } from './protocol/v0.160.0/ServerNotification.ts'
export type { ServerRequest } from './protocol/v0.160.0/ServerRequest.ts'
export type { AgentMessageDeltaNotification } from './protocol/v0.160.0/v2/AgentMessageDeltaNotification.ts'
export type { ApprovalsReviewer } from './protocol/v0.160.0/v2/ApprovalsReviewer.ts'
export type { AskForApproval } from './protocol/v0.160.0/v2/AskForApproval.ts'
export type { CodexErrorInfo } from './protocol/v0.160.0/v2/CodexErrorInfo.ts'
export type { CommandExecutionApprovalDecision } from './protocol/v0.160.0/v2/CommandExecutionApprovalDecision.ts'
export type { CommandExecutionRequestApprovalParams } from './protocol/v0.160.0/v2/CommandExecutionRequestApprovalParams.ts'
export type { CommandExecutionRequestApprovalResponse } from './protocol/v0.160.0/v2/CommandExecutionRequestApprovalResponse.ts'
export type { ErrorNotification } from './protocol/v0.160.0/v2/ErrorNotification.ts'
export type { FileChangeApprovalDecision } from './protocol/v0.160.0/v2/FileChangeApprovalDecision.ts'
export type { FileChangeRequestApprovalParams } from './protocol/v0.160.0/v2/FileChangeRequestApprovalParams.ts'
export type { FileChangeRequestApprovalResponse } from './protocol/v0.160.0/v2/FileChangeRequestApprovalResponse.ts'
export type { ItemCompletedNotification } from './protocol/v0.160.0/v2/ItemCompletedNotification.ts'
export type { ItemStartedNotification } from './protocol/v0.160.0/v2/ItemStartedNotification.ts'
export type { McpServerElicitationRequestParams } from './protocol/v0.160.0/v2/McpServerElicitationRequestParams.ts'
export type { McpServerElicitationRequestResponse } from './protocol/v0.160.0/v2/McpServerElicitationRequestResponse.ts'
export type { Model } from './protocol/v0.160.0/v2/Model.ts'
export type { ModelListParams } from './protocol/v0.160.0/v2/ModelListParams.ts'
export type { ModelListResponse } from './protocol/v0.160.0/v2/ModelListResponse.ts'
export type { PermissionsRequestApprovalParams } from './protocol/v0.160.0/v2/PermissionsRequestApprovalParams.ts'
export type { PermissionsRequestApprovalResponse } from './protocol/v0.160.0/v2/PermissionsRequestApprovalResponse.ts'
export type { PlanDeltaNotification } from './protocol/v0.160.0/v2/PlanDeltaNotification.ts'
export type { SandboxMode } from './protocol/v0.160.0/v2/SandboxMode.ts'
export type { SandboxPolicy } from './protocol/v0.160.0/v2/SandboxPolicy.ts'
export type { ServerRequestResolvedNotification } from './protocol/v0.160.0/v2/ServerRequestResolvedNotification.ts'
export type { Thread } from './protocol/v0.160.0/v2/Thread.ts'
export type { ThreadItem } from './protocol/v0.160.0/v2/ThreadItem.ts'
export type { ThreadResumeParams } from './protocol/v0.160.0/v2/ThreadResumeParams.ts'
export type { ThreadResumeResponse } from './protocol/v0.160.0/v2/ThreadResumeResponse.ts'
export type { ThreadStartParams } from './protocol/v0.160.0/v2/ThreadStartParams.ts'
export type { ThreadStartResponse } from './protocol/v0.160.0/v2/ThreadStartResponse.ts'
export type { ThreadTokenUsage } from './protocol/v0.160.0/v2/ThreadTokenUsage.ts'
export type { ThreadTokenUsageUpdatedNotification } from './protocol/v0.160.0/v2/ThreadTokenUsageUpdatedNotification.ts'
export type { TokenUsageBreakdown } from './protocol/v0.160.0/v2/TokenUsageBreakdown.ts'
export type { Turn } from './protocol/v0.160.0/v2/Turn.ts'
export type { TurnCompletedNotification } from './protocol/v0.160.0/v2/TurnCompletedNotification.ts'
export type { TurnError } from './protocol/v0.160.0/v2/TurnError.ts'
export type { TurnInterruptParams } from './protocol/v0.160.0/v2/TurnInterruptParams.ts'
export type { TurnPlanUpdatedNotification } from './protocol/v0.160.0/v2/TurnPlanUpdatedNotification.ts'
export type { TurnStartParams } from './protocol/v0.160.0/v2/TurnStartParams.ts'
export type { TurnStartResponse } from './protocol/v0.160.0/v2/TurnStartResponse.ts'
export type { TurnStartedNotification } from './protocol/v0.160.0/v2/TurnStartedNotification.ts'
export type { UserInput } from './protocol/v0.160.0/v2/UserInput.ts'
export type { WindowsSandboxReadiness } from './protocol/v0.160.0/v2/WindowsSandboxReadiness.ts'
export type { WindowsSandboxReadinessResponse } from './protocol/v0.160.0/v2/WindowsSandboxReadinessResponse.ts'
export type { WindowsSandboxSetupCompletedNotification } from './protocol/v0.160.0/v2/WindowsSandboxSetupCompletedNotification.ts'
export type { WindowsSandboxSetupMode } from './protocol/v0.160.0/v2/WindowsSandboxSetupMode.ts'
export type { WindowsSandboxSetupStartParams } from './protocol/v0.160.0/v2/WindowsSandboxSetupStartParams.ts'

/** The committed types folder (`protocol/v0.160.0/`). */
export const CODEX_PROTOCOL_FOLDER = 'v0.160.0'
/** The CLI the committed folder was generated from (patch release of the pinned protocol line). */
export const CODEX_PROTOCOL_CLI_VERSION = '0.160.1'
/** The bundle `codex app-server generate-json-schema --out <dir>` writes; the probe reads it. */
export const SCHEMA_BUNDLE_FILE = 'codex_app_server_protocol.schemas.json'
/**
 * Probe argv for the method check. `--experimental` is needed to see turn/start.collaborationMode (an experimental
 * field, needed by the native Plan); without it every schema reports the plan capability missing.
 */
export const SCHEMA_PROBE_ARGS = ['app-server', 'generate-json-schema', '--experimental', '--out'] as const
/** One private app-server per pass (never the shared daemon). */
export const APP_SERVER_ARGS = ['app-server', '--listen', 'stdio://'] as const

export type MethodSetKey = 'clientRequests' | 'clientNotifications' | 'serverRequests' | 'serverNotifications'

/** What a missing optional method downgrades. */
export type OptionalCapability = 'modelList' | 'collaborationMode' | 'windowsSandbox' | 'tokenUsage'

export type MethodRole =
  | 'required'
  | { optional: OptionalCapability }
  /** Used when present; its absence downgrades nothing Harpoon gates on. */
  | 'used'
  /** Answered with a JSON-RPC error or an automatic cancel (never relayed to the user). */
  | 'refused'

export interface MethodEntry {
  method: string
  set: MethodSetKey
  /** Schema definition name of the params (null: no params). */
  params: string | null
  /** Schema definition name of the response (requests only; null: an empty object). */
  result?: string | null
  role: MethodRole
  /** Absent from the stable (non --experimental) schema of 0.160.1. */
  experimental?: true
  note: string
}

/**
 * Every method Harpoon sends, answers or reads. Others are liveness only (every line counts as
 * liveness) and land in the raw log.
 */
export const METHODS: readonly MethodEntry[] = [
  // client → server requests
  {
    method: 'initialize',
    set: 'clientRequests',
    params: 'InitializeParams',
    result: 'InitializeResponse',
    role: 'required',
    note: 'handshake; clientInfo.version is required on the wire (-32600 without it)',
  },
  {
    method: 'thread/start',
    set: 'clientRequests',
    params: 'ThreadStartParams',
    result: 'ThreadStartResponse',
    role: 'required',
    note: 'thread.id is the session, persisted before turn/start',
  },
  {
    method: 'thread/resume',
    set: 'clientRequests',
    params: 'ThreadResumeParams',
    result: 'ThreadResumeResponse',
    role: 'required',
    note: 'Fix and P19 resume; excludeTurns:true; the echoed thread.id must match',
  },
  {
    method: 'turn/start',
    set: 'clientRequests',
    params: 'TurnStartParams',
    result: 'TurnStartResponse',
    role: 'required',
    note: 'prompt as input[{type:text}]; collaborationMode (experimental) for native Plan; outputSchema',
  },
  {
    method: 'turn/interrupt',
    set: 'clientRequests',
    params: 'TurnInterruptParams',
    result: 'TurnInterruptResponse',
    role: 'required',
    note: 'graceful stop step',
  },
  {
    method: 'model/list',
    set: 'clientRequests',
    params: 'ModelListParams',
    result: 'ModelListResponse',
    role: { optional: 'modelList' },
    note: 'model picker',
  },
  {
    method: 'windowsSandbox/readiness',
    set: 'clientRequests',
    params: null,
    result: 'WindowsSandboxReadinessResponse',
    role: { optional: 'windowsSandbox' },
    note: 'win32 probe: vendor.codex.winSandbox',
  },
  {
    method: 'windowsSandbox/setupStart',
    set: 'clientRequests',
    params: 'WindowsSandboxSetupStartParams',
    result: 'WindowsSandboxSetupStartResponse',
    role: 'used',
    note: 'vendor_setup executor (user click only)',
  },
  // client → server notifications
  {
    method: 'initialized',
    set: 'clientNotifications',
    params: null,
    role: 'used',
    note: 'sent after the initialize response',
  },
  // server → client notifications
  {
    method: 'item/agentMessage/delta',
    set: 'serverNotifications',
    params: 'AgentMessageDeltaNotification',
    role: 'required',
    note: 'text',
  },
  {
    method: 'turn/completed',
    set: 'serverNotifications',
    params: 'TurnCompletedNotification',
    role: 'required',
    note: 'done, or error classified by turn.error.codexErrorInfo',
  },
  {
    method: 'thread/tokenUsage/updated',
    set: 'serverNotifications',
    params: 'ThreadTokenUsageUpdatedNotification',
    role: { optional: 'tokenUsage' },
    note: 'cumulative totals → per-pass delta',
  },
  {
    method: 'thread/started',
    set: 'serverNotifications',
    params: 'ThreadStartedNotification',
    role: 'used',
    note: 'echo of the thread; the session comes from the response',
  },
  {
    method: 'turn/started',
    set: 'serverNotifications',
    params: 'TurnStartedNotification',
    role: 'used',
    note: 'turn id for turn/interrupt',
  },
  {
    method: 'item/started',
    set: 'serverNotifications',
    params: 'ItemStartedNotification',
    role: 'used',
    note: 'tool start; caches the item for the ask detail',
  },
  {
    method: 'item/completed',
    set: 'serverNotifications',
    params: 'ItemCompletedNotification',
    role: 'used',
    note: 'tool end; the final agentMessage; the plan item',
  },
  {
    method: 'item/plan/delta',
    set: 'serverNotifications',
    params: 'PlanDeltaNotification',
    role: 'used',
    note: 'plan item text (native Plan)',
  },
  {
    method: 'turn/plan/updated',
    set: 'serverNotifications',
    params: 'TurnPlanUpdatedNotification',
    role: 'used',
    note: 'todo tool',
  },
  {
    method: 'serverRequest/resolved',
    set: 'serverNotifications',
    params: 'ServerRequestResolvedNotification',
    role: 'used',
    note: 'ask-withdrawn for an ask still pending',
  },
  {
    method: 'error',
    set: 'serverNotifications',
    params: 'ErrorNotification',
    role: 'used',
    note: 'willRetry:true is liveness; false is terminal unless turn/completed follows',
  },
  {
    method: 'windowsSandbox/setupCompleted',
    set: 'serverNotifications',
    params: 'WindowsSandboxSetupCompletedNotification',
    role: 'used',
    note: 'vendor_setup result',
  },
  // server → client requests
  {
    method: 'item/commandExecution/requestApproval',
    set: 'serverRequests',
    params: 'CommandExecutionRequestApprovalParams',
    result: 'CommandExecutionRequestApprovalResponse',
    role: 'required',
    note: 'ask shell (network with networkApprovalContext)',
  },
  {
    method: 'item/fileChange/requestApproval',
    set: 'serverRequests',
    params: 'FileChangeRequestApprovalParams',
    result: 'FileChangeRequestApprovalResponse',
    role: 'required',
    note: 'ask edit',
  },
  {
    method: 'item/permissions/requestApproval',
    set: 'serverRequests',
    params: 'PermissionsRequestApprovalParams',
    result: 'PermissionsRequestApprovalResponse',
    role: 'used',
    note: 'ask network/other; deny = {permissions:{}}',
  },
  {
    method: 'mcpServer/elicitation/request',
    set: 'serverRequests',
    params: 'McpServerElicitationRequestParams',
    result: 'McpServerElicitationRequestResponse',
    role: 'refused',
    note: 'auto-cancelled: {action:cancel, content:null, _meta:null}',
  },
  {
    method: 'item/tool/requestUserInput',
    set: 'serverRequests',
    params: 'ToolRequestUserInputParams',
    result: 'ToolRequestUserInputResponse',
    role: 'refused',
    note: 'JSON-RPC error',
  },
  {
    method: 'item/tool/call',
    set: 'serverRequests',
    params: 'DynamicToolCallParams',
    result: 'DynamicToolCallResponse',
    role: 'refused',
    note: 'JSON-RPC error',
  },
  {
    method: 'account/chatgptAuthTokens/refresh',
    set: 'serverRequests',
    params: 'ChatgptAuthTokensRefreshParams',
    result: 'ChatgptAuthTokensRefreshResponse',
    role: 'refused',
    note: 'JSON-RPC error (Harpoon never handles credentials)',
  },
  {
    method: 'attestation/generate',
    set: 'serverRequests',
    params: 'AttestationGenerateParams',
    result: 'AttestationGenerateResponse',
    role: 'refused',
    note: 'JSON-RPC error (requestAttestation is never declared)',
  },
  {
    method: 'currentTime/read',
    set: 'serverRequests',
    params: 'CurrentTimeReadParams',
    result: 'CurrentTimeReadResponse',
    role: 'refused',
    experimental: true,
    note: 'JSON-RPC error',
  },
  {
    method: 'applyPatchApproval',
    set: 'serverRequests',
    params: 'ApplyPatchApprovalParams',
    result: 'ApplyPatchApprovalResponse',
    role: 'refused',
    note: 'legacy v1 approval; JSON-RPC error',
  },
  {
    method: 'execCommandApproval',
    set: 'serverRequests',
    params: 'ExecCommandApprovalParams',
    result: 'ExecCommandApprovalResponse',
    role: 'refused',
    note: 'legacy v1 approval; JSON-RPC error',
  },
]

export interface RequiredMethod {
  method: string
  set: MethodSetKey
}

/** Required methods: any one missing → the exec route, with a warning. */
export const REQUIRED_METHODS: readonly RequiredMethod[] = METHODS.filter((m) => m.role === 'required').map(
  ({ method, set }) => ({ method, set }),
)

/** Optional methods: each missing one downgrades a capability. collaborationMode is a turn/start field. */
export const OPTIONAL_CAPABILITIES: Readonly<
  Record<
    OptionalCapability,
    { kind: 'method'; set: MethodSetKey; method: string } | { kind: 'field'; type: string; field: string }
  >
> = {
  modelList: { kind: 'method', set: 'clientRequests', method: 'model/list' },
  collaborationMode: { kind: 'field', type: 'TurnStartParams', field: 'collaborationMode' },
  windowsSandbox: { kind: 'method', set: 'clientRequests', method: 'windowsSandbox/readiness' },
  tokenUsage: { kind: 'method', set: 'serverNotifications', method: 'thread/tokenUsage/updated' },
}

/**
 * One type Harpoon relies on. `sent`: Harpoon builds it (params, replies, the enum values it sends), so a removed
 * property or value AND a new required property break the adapter. `read`: Harpoon only reads it (server frames,
 * the enum values it branches on), so only a removed property or value breaks it; a new required property of a
 * server frame is the server's business.
 */
export interface WatchedShape {
  dir: 'sent' | 'read'
  props?: readonly string[]
  values?: readonly string[]
}

/**
 * The parts of a type Harpoon relies on: properties it sends or reads, enum values it sends or branches on. A
 * newer schema that breaks one (WatchedShape) breaks the adapter: the weekly type-diff job and the probe's shape
 * check report it. New optional properties are never breaking.
 */
export const WATCHED_SHAPES: Readonly<Record<string, WatchedShape>> = {
  InitializeParams: { dir: 'sent', props: ['clientInfo', 'capabilities'] },
  ClientInfo: { dir: 'sent', props: ['name', 'title', 'version'] },
  InitializeCapabilities: { dir: 'sent', props: ['experimentalApi', 'requestAttestation'] },
  ThreadStartParams: {
    dir: 'sent',
    props: [
      'cwd',
      'model',
      'modelProvider',
      'sandbox',
      'approvalPolicy',
      'approvalsReviewer',
      'developerInstructions',
      'ephemeral',
      'config',
    ],
  },
  ThreadResumeParams: {
    dir: 'sent',
    props: [
      'threadId',
      'cwd',
      'model',
      'modelProvider',
      'sandbox',
      'approvalPolicy',
      'approvalsReviewer',
      'developerInstructions',
      'config',
      'excludeTurns',
    ],
  },
  TurnStartParams: { dir: 'sent', props: ['threadId', 'input', 'collaborationMode', 'outputSchema'] },
  TurnInterruptParams: { dir: 'sent', props: ['threadId', 'turnId'] },
  CollaborationMode: { dir: 'sent', props: ['mode', 'settings'] },
  Settings: { dir: 'sent', props: ['model', 'reasoning_effort', 'developer_instructions'] },
  ModeKind: { dir: 'sent', values: ['plan', 'default'] },
  SandboxMode: { dir: 'sent', values: ['read-only', 'workspace-write', 'danger-full-access'] },
  AskForApproval: { dir: 'sent', values: ['on-request', 'never'] },
  ApprovalsReviewer: { dir: 'sent', values: ['user'] },
  CommandExecutionApprovalDecision: {
    dir: 'sent',
    values: ['accept', 'acceptForSession', 'decline', 'cancel'],
  },
  CommandExecutionRequestApprovalResponse: { dir: 'sent', props: ['decision'] },
  FileChangeApprovalDecision: { dir: 'sent', values: ['accept', 'acceptForSession', 'decline', 'cancel'] },
  FileChangeRequestApprovalResponse: { dir: 'sent', props: ['decision'] },
  PermissionsRequestApprovalResponse: { dir: 'sent', props: ['permissions', 'scope'] },
  McpServerElicitationRequestResponse: { dir: 'sent', props: ['action', 'content', '_meta'] },
  WindowsSandboxSetupStartParams: { dir: 'sent', props: ['mode'] },
  WindowsSandboxSetupMode: { dir: 'sent', values: ['elevated', 'unelevated'] },
  InitializeResponse: { dir: 'read', props: ['userAgent'] },
  ThreadStartResponse: { dir: 'read', props: ['thread', 'model'] },
  ThreadResumeResponse: { dir: 'read', props: ['thread', 'model'] },
  TurnStartResponse: { dir: 'read', props: ['turn'] },
  Thread: { dir: 'read', props: ['id'] },
  Turn: { dir: 'read', props: ['id', 'status', 'error'] },
  WindowsSandboxReadiness: { dir: 'read', values: ['ready', 'notConfigured', 'updateRequired'] },
  WindowsSandboxReadinessResponse: { dir: 'read', props: ['status'] },
  WindowsSandboxSetupCompletedNotification: { dir: 'read', props: ['mode', 'success', 'error'] },
  TurnStatus: { dir: 'read', values: ['completed', 'interrupted', 'failed', 'inProgress'] },
  AgentMessageDeltaNotification: { dir: 'read', props: ['itemId', 'delta'] },
  TurnCompletedNotification: { dir: 'read', props: ['threadId', 'turn'] },
  ServerRequestResolvedNotification: { dir: 'read', props: ['requestId'] },
  ThreadTokenUsageUpdatedNotification: { dir: 'read', props: ['tokenUsage'] },
  TokenUsageBreakdown: {
    dir: 'read',
    props: [
      'inputTokens',
      'cachedInputTokens',
      'cacheWriteInputTokens',
      'outputTokens',
      'reasoningOutputTokens',
    ],
  },
  ThreadTokenUsage: { dir: 'read', props: ['total', 'last'] },
  TurnError: { dir: 'read', props: ['message', 'codexErrorInfo', 'additionalDetails'] },
  ErrorNotification: { dir: 'read', props: ['error', 'willRetry'] },
  CommandExecutionRequestApprovalParams: {
    dir: 'read',
    props: ['itemId', 'command', 'cwd', 'reason', 'networkApprovalContext', 'availableDecisions'],
  },
  FileChangeRequestApprovalParams: { dir: 'read', props: ['itemId', 'reason', 'grantRoot'] },
  PermissionsRequestApprovalParams: { dir: 'read', props: ['permissions', 'reason'] },
}

export const WATCHED_TYPES: readonly string[] = Object.keys(WATCHED_SHAPES)

// ---- schema bundle → method set -----------------------------------------------------------------------------

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)

export interface MethodSet {
  clientRequests: Set<string>
  clientNotifications: Set<string>
  serverRequests: Set<string>
  serverNotifications: Set<string>
  /** A definition by name (top level or under `definitions.v2`). */
  definition(name: string): unknown
  /** Property names of an object definition (oneOf/anyOf/allOf variants merged; `$ref`s followed). */
  fieldsOf(name: string): string[]
  /** Enum values of a string definition (variants merged). */
  valuesOf(name: string): string[]
}

const ROOTS: Record<MethodSetKey, string> = {
  clientRequests: 'ClientRequest',
  clientNotifications: 'ClientNotification',
  serverRequests: 'ServerRequest',
  serverNotifications: 'ServerNotification',
}

function methodNames(root: unknown): Set<string> {
  const out = new Set<string>()
  if (!isObj(root)) return out
  const variants = [root['oneOf'], root['anyOf']].flatMap((v) => (Array.isArray(v) ? (v as unknown[]) : []))
  for (const v of variants) {
    if (!isObj(v) || !isObj(v['properties'])) continue
    const m = v['properties']['method']
    if (!isObj(m)) continue
    if (typeof m['const'] === 'string') out.add(m['const'])
    if (Array.isArray(m['enum']))
      for (const e of m['enum'] as unknown[]) if (typeof e === 'string') out.add(e)
  }
  return out
}

/**
 * The method inventory of a `generate-json-schema` bundle (`codex_app_server_protocol.schemas.json`). Tolerant: a
 * malformed bundle gives empty sets, which the protocol check reports as missing required methods.
 */
export function methodSetFromSchema(bundle: unknown): MethodSet {
  const defs = isObj(bundle) && isObj(bundle['definitions']) ? bundle['definitions'] : {}
  const v2 = isObj(defs['v2']) ? defs['v2'] : {}
  const definition = (name: string): unknown => (name === 'v2' ? undefined : (defs[name] ?? v2[name]))
  const deref = (node: unknown, seen: Set<string>): unknown => {
    if (!isObj(node) || typeof node['$ref'] !== 'string') return node
    const name = node['$ref'].split('/').pop() ?? ''
    if (seen.has(name)) return undefined
    seen.add(name)
    return deref(definition(name), seen)
  }
  const variantsOf = (name: string): Json[] => {
    const out: Json[] = []
    const walk = (node: unknown, seen: Set<string>): void => {
      const n = deref(node, seen)
      if (!isObj(n)) return
      out.push(n)
      for (const key of ['oneOf', 'anyOf', 'allOf'])
        if (Array.isArray(n[key])) for (const v of n[key] as unknown[]) walk(v, seen)
    }
    walk(definition(name), new Set([name]))
    return out
  }
  const sets = Object.fromEntries(
    (Object.keys(ROOTS) as MethodSetKey[]).map((k) => [k, methodNames(definition(ROOTS[k]))]),
  ) as Record<MethodSetKey, Set<string>>
  return {
    ...sets,
    definition,
    fieldsOf: (name) => {
      const names = new Set<string>()
      for (const v of variantsOf(name))
        if (isObj(v['properties'])) for (const p of Object.keys(v['properties'])) names.add(p)
      return [...names]
    },
    valuesOf: (name) => {
      const values = new Set<string>()
      for (const v of variantsOf(name)) {
        if (Array.isArray(v['enum']))
          for (const e of v['enum'] as unknown[]) if (typeof e === 'string') values.add(e)
        if (typeof v['const'] === 'string') values.add(v['const'])
      }
      return [...values]
    },
  }
}

const requiredOf = (set: MethodSet, name: string): string[] => {
  const d = set.definition(name)
  return isObj(d) && Array.isArray(d['required'])
    ? (d['required'] as unknown[]).filter((r): r is string => typeof r === 'string')
    : []
}

/** Watched shapes a schema no longer satisfies (the app-server protocol drifts between releases). */
export function shapeProblems(set: MethodSet): string[] {
  const problems: string[] = []
  for (const [type, shape] of Object.entries(WATCHED_SHAPES)) {
    if (set.definition(type) === undefined) {
      problems.push(`${type}: missing from the schema`)
      continue
    }
    if (shape.props) {
      const fields = set.fieldsOf(type)
      for (const p of shape.props) if (!fields.includes(p)) problems.push(`${type}.${p}: property removed`)
      if (shape.dir === 'sent') {
        for (const r of requiredOf(set, type))
          if (!shape.props.includes(r)) problems.push(`${type}.${r}: new required property`)
      }
    }
    if (shape.values) {
      const values = set.valuesOf(type)
      for (const v of shape.values) if (!values.includes(v)) problems.push(`${type}: value "${v}" removed`)
    }
  }
  return problems
}

export interface ProtocolCheck {
  /** `codex-exec` when a required method is missing. */
  transport: 'codex-app-server' | 'codex-exec'
  missingRequired: string[]
  capabilities: Record<OptionalCapability, boolean>
  missingOptional: OptionalCapability[]
  /** Watched shapes this schema breaks (a warning; the route stays as the method check says). */
  shapeProblems: string[]
}

/** The probe's method check over a parsed schema bundle. */
export function checkProtocol(bundle: unknown): ProtocolCheck {
  const set = methodSetFromSchema(bundle)
  const missingRequired = REQUIRED_METHODS.filter((r) => !set[r.set].has(r.method)).map((r) => r.method)
  const capabilities = {} as Record<OptionalCapability, boolean>
  for (const [cap, where] of Object.entries(OPTIONAL_CAPABILITIES) as [
    OptionalCapability,
    (typeof OPTIONAL_CAPABILITIES)[OptionalCapability],
  ][]) {
    capabilities[cap] =
      where.kind === 'method'
        ? set[where.set].has(where.method)
        : set.fieldsOf(where.type).includes(where.field)
  }
  return {
    transport: missingRequired.length > 0 ? 'codex-exec' : 'codex-app-server',
    missingRequired,
    capabilities,
    missingOptional: (Object.keys(capabilities) as OptionalCapability[]).filter((c) => !capabilities[c]),
    shapeProblems: shapeProblems(set),
  }
}

// ---- JSON-RPC errors ------------------------------------------------------------------------------------------

/**
 * A request the server does not know. JSON-RPC says -32601, but codex-cli 0.160.1 deserializes the method as an
 * enum (ClientRequest is a serde-tagged union), so it can answer -32600 "Invalid request: unknown variant `<method>`,
 * expected one of …" instead. Both count. (Not yet in a recorded fixture: no live recording sends an unknown method.)
 */
export function isUnknownMethodError(e: { code?: unknown; message?: unknown }): boolean {
  if (e.code === -32601) return true
  return e.code === -32600 && typeof e.message === 'string' && /unknown variant `/.test(e.message)
}

/**
 * turn/start refused the experimental collaborationMode field: -32602, or the -32600 form serde gives a
 * field the server rejects. Either way native Plan falls back to emulated before any model call (no retry budget).
 */
export function isCollaborationModeRejected(e: { code?: unknown; message?: unknown }): boolean {
  if (e.code === -32602) return true
  return (
    e.code === -32600 &&
    typeof e.message === 'string' &&
    /collaborationMode|collaboration_mode|experimentalApi/i.test(e.message)
  )
}

// ---- approvals ------------------------------------------------------------------------------------------------

export type ApprovalDecisionWire = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

/** Approvals: command and file-change asks. `cancel` is the ask-timeout (and Stop) answer. */
export const APPROVAL_DECISIONS: Readonly<Record<AskDecision, ApprovalDecisionWire>> = {
  allow: 'accept',
  'allow-session': 'acceptForSession',
  deny: 'decline',
  cancel: 'cancel',
}

/**
 * Decisions Harpoon never sends: both persist rules into the user's Codex config (exec policy / network policy)
 * beyond the run: never send acceptWithExecpolicyAmendment.
 */
export const NEVER_SENT_DECISIONS = ['acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment'] as const

/** The permissions ask: allow grants what was requested (turn or session scope); deny grants nothing. */
export function permissionsReply(
  decision: AskDecision,
  requested: { network?: unknown; fileSystem?: unknown },
): { permissions: Record<string, unknown>; scope?: 'turn' | 'session' } {
  if (decision === 'deny' || decision === 'cancel') return { permissions: {} }
  const granted: Record<string, unknown> = {}
  if (requested.network !== null && requested.network !== undefined) granted['network'] = requested.network
  if (requested.fileSystem !== null && requested.fileSystem !== undefined)
    granted['fileSystem'] = requested.fileSystem
  return { permissions: granted, scope: decision === 'allow-session' ? 'session' : 'turn' }
}

/** MCP elicitations are auto-cancelled, never relayed. */
export const ELICITATION_CANCEL = { action: 'cancel', content: null, _meta: null } as const

// ---- usage ----------------------------------------------------------------------------------------------------

/**
 * One cumulative `ThreadTokenUsage.total` (or exec `turn.completed.usage`) → Harpoon Usage. OpenAI counts cached
 * input inside `inputTokens` and reasoning inside `outputTokens`, so `input` is the uncached part, `cacheRead` the
 * cached part, and `reasoning` is informational (Capabilities.reasoningIncludedInOutput = true). Cache writes are
 * reported as their own field, as Codex does. Feed the result to usage.ts `perPassUsage` (cumulative → delta).
 */
export function usageFromTokenBreakdown(
  b: Pick<
    TokenUsageBreakdown,
    'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningOutputTokens'
  > &
    Partial<Pick<TokenUsageBreakdown, 'cacheWriteInputTokens'>>,
): Usage {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const cached = n(b.cachedInputTokens)
  return {
    input: Math.max(0, n(b.inputTokens) - cached),
    output: n(b.outputTokens),
    cacheRead: cached,
    cacheWrite: n(b.cacheWriteInputTokens),
    reasoning: n(b.reasoningOutputTokens),
  }
}

/** exec `--json` usage (snake_case, cumulative for the thread) in the app-server breakdown's shape. */
export function breakdownFromExecUsage(
  u: Record<string, unknown>,
): Pick<
  TokenUsageBreakdown,
  'inputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens' | 'outputTokens' | 'reasoningOutputTokens'
> {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    inputTokens: n(u['input_tokens']),
    cachedInputTokens: n(u['cached_input_tokens']),
    cacheWriteInputTokens: n(u['cache_write_input_tokens']),
    outputTokens: n(u['output_tokens']),
    reasoningOutputTokens: n(u['reasoning_output_tokens']),
  }
}
