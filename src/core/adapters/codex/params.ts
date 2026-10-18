// JSON-RPC params the Codex adapter sends (handshake, threads and turns,
// approvals), typed by the generated protocol. Exported so the fixture recipes (tests/fixtures/codex/recipes/) can
// build the same frames the adapter sends.
import type { AskDecision } from '../../../shared/events.ts'
import type { Mode } from '../../../shared/run.ts'
import type { LocalPreset } from '../../../shared/vendors.ts'
import type { StartStep } from '../types.ts'
import { CLIENT_NAME, CLIENT_VERSION, LOCAL_PROVIDER_ID } from './capabilities.ts'
import { ephemeralFor, localProviderConfig, sandboxFor } from './launch.ts'
import { APPROVAL_DECISIONS, permissionsReply as protocolPermissionsReply } from './protocol.ts'
import type {
  CollaborationMode,
  InitializeParams,
  JsonValue,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
} from './wire.ts'
import { rec } from './wire.ts'

export { ELICITATION_CANCEL } from './protocol.ts'

/** `initialize{clientInfo:{name:'harpoon'}, capabilities:{experimentalApi: planNative}}`. */
export function initializeParams(experimentalApi: boolean): InitializeParams {
  return {
    clientInfo: { name: CLIENT_NAME, title: null, version: CLIENT_VERSION },
    capabilities: { experimentalApi, requestAttestation: false },
  }
}

export interface ThreadInput {
  step: StartStep
  mode: Mode
  cwd: string
  /** `null` / absent: the CLI's default model. A local preset always names its model. */
  model?: string | null | undefined
  local?: LocalPreset | undefined
  /** New threads only (thread/start `developerInstructions`). */
  systemAppend?: string | undefined
  /** Harpoon design passes: the MCP server to attach (its tools pre-approved). */
  mcp?: { name: string; url: string; tokenEnv: string; disable?: string[] | undefined; allow?: string[] | undefined } | undefined
}

function threadConfig(i: ThreadInput): Record<string, JsonValue> | undefined {
  const config: Record<string, JsonValue> = {}
  if (i.local !== undefined) Object.assign(config, localProviderConfig(i.local))
  // X17: the catalog refresh searches the web (read-only, ephemeral, config:{web_search:'live'}).
  if (i.step === 'catalog') config['web_search'] = 'live'
  if (i.mcp !== undefined) {
    // Dotted keys, exactly as `-c` overrides spell them (the form verified live with codex 0.160).
    const k = `mcp_servers.${i.mcp.name}`
    config[`${k}.url`] = i.mcp.url
    config[`${k}.bearer_token_env_var`] = i.mcp.tokenEnv
    config[`${k}.default_tools_approval_mode`] = 'approve'
    // Only Harpoon's tools: the user's own servers stay off for this pass.
    // Only plain names make a safe dotted key (as in launch.ts); a name with dots or quotes would address another key.
    for (const other of i.mcp.disable ?? []) if (other !== i.mcp.name && !(i.mcp.allow ?? []).includes(other) && /^[A-Za-z0-9_-]+$/.test(other)) config[`mcp_servers.${other}.enabled`] = false
    // A user server the pass may use (publishing): its tools run without prompts too.
    for (const s of i.mcp.allow ?? []) if (/^[A-Za-z0-9_-]+$/.test(s)) config[`mcp_servers.${s}.default_tools_approval_mode`] = 'approve'
  }
  return Object.keys(config).length > 0 ? config : undefined
}

/**
 * The model a pass runs: the pass's own model when it names one, else a local preset's model, else the CLI default.
 * A model picked for a local-preset pass (the composer lists the server's models) is the one that runs.
 */
export function modelOf(i: Pick<ThreadInput, 'model' | 'local'>): string | undefined {
  if (i.model !== undefined && i.model !== null && i.model.trim() !== '') return i.model
  return i.local?.model
}

/**
 * thread/start: `{cwd, model?, sandbox, approvalPolicy, approvalsReviewer:'user', developerInstructions?, ephemeral,
 * config?}`. Read-only steps run `{sandbox:'read-only', approvalPolicy:'never', ephemeral:true}`.
 */
export function threadStartParams(i: ThreadInput): ThreadStartParams {
  const { sandbox, approvalPolicy } = sandboxFor(i.step, i.mode)
  const model = modelOf(i)
  const config = threadConfig(i)
  return {
    cwd: i.cwd,
    ...(model !== undefined ? { model } : {}),
    ...(i.local !== undefined ? { modelProvider: LOCAL_PROVIDER_ID } : {}),
    sandbox,
    approvalPolicy,
    approvalsReviewer: 'user',
    ...(i.systemAppend !== undefined && i.systemAppend !== ''
      ? { developerInstructions: i.systemAppend }
      : {}),
    ephemeral: ephemeralFor(i.step),
    ...(config !== undefined ? { config } : {}),
  }
}

/**
 * thread/resume: `{threadId, excludeTurns:true, …}` with the same safety set as a start (a cold resume would
 * otherwise fall back to the thread's or the user's settings). No developerInstructions: the thread keeps its own.
 */
export function threadResumeParams(threadId: string, i: ThreadInput): ThreadResumeParams {
  const { ephemeral: _e, developerInstructions: _d, ...rest } = threadStartParams(i)
  return { threadId, excludeTurns: true, ...rest }
}

/** The plan collaboration mode; the model is the one thread/start answered with (the settings require one). */
export function planCollaboration(model: string): CollaborationMode {
  return { mode: 'plan', settings: { model, reasoning_effort: null, developer_instructions: null } }
}

export function turnStartParams(o: {
  threadId: string
  prompt: string
  /**
   * Live balanced run: the model this turn runs instead of the one the thread answered with ("Override the model for
   * this turn and subsequent turns"): model/list's default, for a pass with no model whose resolved model the account
   * does not list (default-model.ts). Absent: the thread's own model.
   */
  model?: string | undefined
  collaborationMode?: CollaborationMode | undefined
  outputSchema?: object | undefined
}): TurnStartParams {
  return {
    threadId: o.threadId,
    input: [{ type: 'text', text: o.prompt, text_elements: [] }],
    ...(o.model !== undefined ? { model: o.model } : {}),
    ...(o.collaborationMode !== undefined ? { collaborationMode: o.collaborationMode } : {}),
    ...(o.outputSchema !== undefined ? { outputSchema: strictOutputSchema(o.outputSchema) } : {}),
  }
}

/** Keywords OpenAI's strict structured outputs may refuse; Harpoon's own parsers enforce these limits. */
const NOT_STRICT = new Set(['minLength', 'maxLength', 'minItems', 'maxItems'])

/** `prop` that may also be null (a type union, the enum widened; anything without a type through anyOf). */
function nullable(prop: unknown): unknown {
  const p = rec(prop)
  if (p === undefined) return prop
  const type = p['type']
  if (typeof type === 'string' || Array.isArray(type)) {
    const types = (Array.isArray(type) ? type : [type]) as unknown[]
    if (types.includes('null')) return p
    const out: Record<string, unknown> = { ...p, type: [...types, 'null'] }
    if (Array.isArray(p['enum']) && !(p['enum'] as unknown[]).includes(null))
      out['enum'] = [...(p['enum'] as unknown[]), null]
    return out
  }
  return { anyOf: [p, { type: 'null' }] }
}

/**
 * An outputSchema as OpenAI's strict structured outputs take it, which Codex applies to every outputSchema (live X17:
 * an optional property was refused with 400 `invalid_json_schema`, "'required' is required to include every key in
 * properties. Missing 'aliases'"). Every object lists all its properties as required and closes them; a property that
 * was optional may be null instead; the length and count limits strict mode refuses are dropped. Pure and idempotent.
 */
export function strictOutputSchema(schema: object): { [key: string]: JsonValue } {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    const n = rec(node)
    if (n === undefined) return node
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(n)) {
      if (NOT_STRICT.has(k)) continue
      if (k === 'properties' || k === '$defs' || k === 'definitions') {
        const props = rec(v)
        out[k] =
          props === undefined
            ? v
            : Object.fromEntries(Object.entries(props).map(([name, p]) => [name, walk(p)]))
      } else if (k === 'items' || k === 'anyOf' || k === 'oneOf' || k === 'allOf' || k === 'not') {
        out[k] = walk(v)
      } else out[k] = v
    }
    const props = rec(out['properties'])
    if (props !== undefined) {
      const required = new Set(
        Array.isArray(n['required']) ? (n['required'] as unknown[]).filter((r) => typeof r === 'string') : [],
      )
      out['properties'] = Object.fromEntries(
        Object.entries(props).map(([name, p]) => [name, required.has(name) ? p : nullable(p)]),
      )
      out['required'] = Object.keys(props)
      out['additionalProperties'] = false
    }
    return out
  }
  return walk(schema) as { [key: string]: JsonValue }
}

/**
 * Approvals: allow → accept, allow-session → acceptForSession, deny → decline (the turn continues),
 * timeout/cancel → cancel (the turn is interrupted). Never `acceptWithExecpolicyAmendment`: it persists rules.
 */
export function approvalReply(d: AskDecision): {
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
} {
  return { decision: APPROVAL_DECISIONS[d] }
}

/**
 * item/permissions/requestApproval: allow grants what was asked for this turn, allow-session for the session; deny
 * (and a timeout) is `{permissions:{}}`: anything left out of the grant is denied.
 */
export function permissionsReply(d: AskDecision, requested: unknown): unknown {
  const r = rec(requested) ?? {}
  return protocolPermissionsReply(d, { network: r['network'], fileSystem: r['fileSystem'] })
}
