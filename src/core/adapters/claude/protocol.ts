// Claude Code stream-json control protocol: the frames Harpoon reads and writes.
// Shapes come from the Agent SDK's types (@anthropic-ai/claude-agent-sdk, a dev dependency) where they are exported; the
// rest are local mirrors of the SDK's private declarations plus fields seen in the recordings.
import type {
  AccountInfo,
  ModelInfo as SdkModelInfo,
  ModelUsage,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKPermissionDenial,
  TerminalReason,
} from '@anthropic-ai/claude-agent-sdk'

export type { PermissionUpdate, SdkModelInfo }

export type JsonObject = Record<string, unknown>

/** SDKControlPermissionRequest (private in the SDK). Fields as seen in the C03–C10 recordings. */
export interface CanUseToolRequest {
  subtype: 'can_use_tool'
  tool_name: string
  input: JsonObject
  tool_use_id: string
  permission_suggestions?: PermissionUpdate[]
  blocked_path?: string
  decision_reason?: string
  decision_reason_type?: string
  suppress_always_allow_rule?: boolean
  default_to_no?: boolean
  title?: string
  display_name?: string
  description?: string
  requires_user_interaction?: boolean
  agent_id?: string
}

export interface ControlRequestFrame {
  type: 'control_request'
  request_id: string
  request: { subtype: string } & JsonObject
}

export interface ControlCancelFrame {
  type: 'control_cancel_request'
  request_id: string
}

export type ControlResponseBody =
  | { subtype: 'success'; request_id: string; response?: JsonObject }
  | { subtype: 'error'; request_id: string; error: string }

export interface ControlResponseFrame {
  type: 'control_response'
  response: ControlResponseBody
}

export interface UserMessageFrame {
  type: 'user'
  message: { role: 'user'; content: { type: 'text'; text: string }[] }
  parent_tool_use_id: null
}

export type StdinFrame = ControlRequestFrame | ControlResponseFrame | UserMessageFrame

/** The initialize reply subset Harpoon keeps; `account.email`/`organization` are never read. */
export interface InitializeResponse {
  models?: SdkModelInfo[]
  account?: Pick<AccountInfo, 'subscriptionType' | 'apiProvider' | 'tokenSource' | 'apiKeySource'>
}

/** `system/init`, plus `mcp_server_errors` (not in the SDK types; absent in every recording). */
export interface SystemInitFrame {
  type: 'system'
  subtype: 'init'
  session_id: string
  model?: string
  permissionMode?: PermissionMode
  claude_code_version?: string
  apiKeySource?: string
  mcp_server_errors?: unknown[]
}

/** `result.usage`: this turn's tokens (C08a/C08b: equal to the Δ of the cumulative `modelUsage`). */
export interface ResultUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface ResultFrame {
  type: 'result'
  subtype: string
  is_error?: boolean
  result?: string
  session_id?: string
  total_cost_usd?: number
  usage?: ResultUsage
  modelUsage?: Record<string, Partial<ModelUsage>>
  permission_denials?: SDKPermissionDenial[]
  errors?: string[]
  terminal_reason?: TerminalReason
  stop_reason?: string | null
  num_turns?: number
  duration_ms?: number
  api_error_status?: number | null
  /** C17: the answer to the initialize request's `jsonSchema` on a successful result (the SDK's types). */
  structured_output?: unknown
}

// ---- builders (one JSON object per line; the proc layer appends LF) ---------------------------------------

/**
 * `initialize` (the SDK's SDKControlInitializeRequest). `jsonSchema` asks for a structured answer, which comes
 * back in `result.structured_output` (C17); sent only when given, so every other pass's frame is unchanged.
 */
export function initializeRequest(
  requestId: string,
  o: { appendSystemPrompt?: string; jsonSchema?: object } = {},
): ControlRequestFrame {
  const request: ControlRequestFrame['request'] = { subtype: 'initialize' }
  if (o.appendSystemPrompt !== undefined && o.appendSystemPrompt !== '') {
    request['appendSystemPrompt'] = o.appendSystemPrompt
  }
  if (o.jsonSchema !== undefined) request['jsonSchema'] = o.jsonSchema
  return { type: 'control_request', request_id: requestId, request }
}

export function interruptRequest(requestId: string): ControlRequestFrame {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }
}

export function userMessage(text: string): UserMessageFrame {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  }
}

function permissionResponse(requestId: string, result: PermissionResult): ControlResponseFrame {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: result },
  }
}

/** Allow, echoing the original input; `updatedPermissions` only when non-empty. */
export function allowResponse(
  requestId: string,
  input: JsonObject,
  updatedPermissions?: readonly PermissionUpdate[],
): ControlResponseFrame {
  const result: PermissionResult = { behavior: 'allow', updatedInput: input }
  if (updatedPermissions !== undefined && updatedPermissions.length > 0) {
    result.updatedPermissions = [...updatedPermissions]
  }
  return permissionResponse(requestId, result)
}

export function denyResponse(requestId: string, message: string, interrupt = false): ControlResponseFrame {
  const result: PermissionResult = interrupt
    ? { behavior: 'deny', message, interrupt: true }
    : { behavior: 'deny', message }
  return permissionResponse(requestId, result)
}

export function errorResponse(requestId: string, error: string): ControlResponseFrame {
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }
}

/**
 * allow-session: the vendor's suggestions minus `setMode`, every destination rewritten to `session` (C04c:
 * every suggestion seen targeted `localSettings`, which would write into the user's repo).
 */
export function sessionPermissions(suggestions: readonly PermissionUpdate[] | undefined): PermissionUpdate[] {
  return (suggestions ?? [])
    .filter((s) => s.type !== 'setMode')
    .map((s) => ({ ...s, destination: 'session' as const }))
}

// ---- parsing ----------------------------------------------------------------------------------------------

export function parseFrame(line: string): JsonObject | undefined {
  const t = line.trim()
  if (!t.startsWith('{')) return undefined
  try {
    const v: unknown = JSON.parse(t)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : undefined
  } catch {
    return undefined
  }
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
export const obj = (v: unknown): JsonObject | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : undefined

export function asCanUseTool(request: JsonObject): CanUseToolRequest | undefined {
  if (request['subtype'] !== 'can_use_tool') return undefined
  const toolName = str(request['tool_name'])
  if (toolName === undefined) return undefined
  return {
    ...(request as Partial<CanUseToolRequest>),
    subtype: 'can_use_tool',
    tool_name: toolName,
    input: obj(request['input']) ?? {},
    tool_use_id: str(request['tool_use_id']) ?? '',
  }
}
