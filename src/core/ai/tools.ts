// Harpoon's MCP tools, as the CLI agent sees them. Reads describe the draft (the model plus whatever the agent has
// staged); writes stage ops into the draft, each validated on the spot so a mistake comes back as a tool error the
// agent can fix. Coordinates are never the agent's job: new nodes land next to what they relate to.
import { isPlainRelative } from '../project/confine.ts'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { dataClassCatalog, phasesInOrder } from '../../shared/model/governance.ts'
import { KIND_INFO, PROTOCOLS } from '../../shared/model/kinds.ts'
import { lintModel } from '../../shared/model/lint.ts'
import { removeNodeOps } from '../../shared/model/ops.ts'
import type { Op } from '../../shared/model/ops.ts'
import { ancestorsOf, childrenOf, pathLabel } from '../../shared/model/queries.ts'
import {
  BOUNDARY_TYPES,
  BoundaryZ,
  ChannelZ,
  CONTRACT_KINDS,
  ConnectorZ,
  FEATURE_CATEGORIES,
  FeatureZ,
  FlowZ,
  HOSTINGS,
  NODE_KINDS,
  NodeZ,
  ResilienceZ,
  DEPLOYMENTS,
  FAILOVERS,
  HA_MODES,
  DEPENDENCIES,
  SENSITIVITIES,
  STATUSES,
} from '../../shared/model/schema.ts'
import type { Evidence, HxConnector, HxNode, Model, ProvenanceSource } from '../../shared/model/schema.ts'
import { EFFORTS, NOTE_ACTIONS, NOTE_ITEM_KINDS } from '../../shared/ipc.ts'
import type { NoteAction, NoteItemKind } from '../../shared/ipc.ts'
import { RuleZ, ruleProblem } from '../../shared/model/rules.ts'
import type { Rule } from '../../shared/model/rules.ts'
import type { AiMode, Effort } from '../../shared/ipc.ts'
import { entryNodes, reach, trafficBreaks } from '../../shared/sim/paths.ts'
import { resilienceFindings } from '../../shared/model/resilience.ts'
import { redactText } from '../../shared/redact.ts'
import type { Draft} from './draft.ts';
import { DraftError } from './draft.ts'

/** What submit_solutions hands back (option keys as given by begin_option). */
export interface SolutionsSubmit {
  problem: string
  constraints: string
  criteria: { name: string; weight: number }[]
  options: { key: string; title?: string; summary: string; pros: string[]; cons: string[]; risks: string | null; effort: Effort | null; scores: { criterion: string; score: number; note: string }[] }[]
  recommendation: { key: string; why: string } | null
}

/** What draft_decision hands back. */
export interface DecisionDraft {
  title: string
  context: string
  decision: string
  consequences: string
  options: { title: string; summary: string; chosen: boolean; whyNot: string }[]
  deciders: string[]
  entityIds: string[]
}

export interface ToolContext {
  draft: Draft
  mode: AiMode
  /** solutions mode: the options so far (key, title), and the active one. */
  options?: () => { keys: { key: string; title: string }[]; active: string | null }
  onBeginOption?: (title: string, approach: string) => string
  onSelectOption?: (key: string) => void
  onSubmitSolutions?: (s: SolutionsSubmit) => void
  onDraftDecision?: (d: DecisionDraft) => void
  /** scan mode: a suggested rule (returns how the project does against it) and a guideline. */
  onSuggestRule?: (rule: Rule, rationale: string, evidence: string) => { applies: number; violations: { id: string; name: string }[] }
  onSuggestGuideline?: (g: { title: string; text: string; evidence: string; prevalence: string }) => void
  onSubmitScan?: (summary: string) => void
  /** publish mode: what to write where, and the result. */
  publishPages?: () => Promise<unknown>
  onRecordPublish?: (pages: Record<string, string>, summary: string) => void
  /** notes mode: the task asked for, and what it produced. */
  noteTask?: 'summarize' | 'extract' | 'agenda'
  onNoteSummary?: (summary: string) => void
  onNoteItems?: (items: { kind: NoteItemKind; text: string; action: NoteAction }[]) => void
  onNoteAgenda?: (agenda: string) => void
  runId: string
  provenance: ProvenanceSource
  selection: { nodeIds: string[]; connectorIds: string[]; focusId: string | null }
  /** The draft changed (push it to the window). */
  onChange: () => void
  onHighlight: (nodeIds: string[], note: string | null) => void
  onSubmit: (p: { title: string; rationale: string; risks: string | null }) => void
  onAsk: (questions: { id: string; question: string; options: string[]; why: string | null; multi: boolean }[]) => void
  /** What a tool call did, in words (the AI panel's activity list). */
  onActivity: (a: { tool: string; summary: string; ok: boolean }) => void
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const ok = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] })
const fail = (msg: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: msg }] })

/** Run a tool body; model refusals and zod errors become tool errors with a readable message. */
async function guard(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof DraftError) return fail(err.message)
    if (err instanceof z.ZodError) {
      return fail(err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
    }
    return fail(err instanceof Error ? err.message : String(err))
  }
}

const scrub = (s: string): string => redactText(s, { mode: 'diagnostics' }).text
const scrubOpt = (s: string | undefined | null): string | null => (s === undefined || s === null || s.trim() === '' ? null : scrub(s))

// ---- shared input shapes -----------------------------------------------------------------------------------

const EvidenceIn = z.object({
  path: z
    .string()
    .min(1)
    .max(1000)
    .refine(isPlainRelative, 'Use a path relative to the repository (no drive, no leading slash, no "..").')
    .describe('Repository-relative file path'),
  // Two plain numbers, not a tuple: OpenAI's function schemas reject tuple forms and Codex drops such tools.
  startLine: z.number().int().min(1).optional().describe('First line (1-based)'),
  endLine: z.number().int().min(1).optional().describe('Last line (1-based)'),
  snippet: z.string().max(1500).optional(),
  repo: z.string().optional().describe('Repo id when the project links several repositories'),
})
const evidenceOf = (e: z.infer<typeof EvidenceIn>[] | undefined): Evidence[] =>
  (e ?? []).map((x) => ({
    repo: x.repo ?? null,
    path: x.path,
    lines: x.startLine === undefined ? null : ([x.startLine, Math.max(x.startLine, x.endLine ?? x.startLine)] as [number, number]),
    snippet: scrubOpt(x.snippet),
  }))

/** How a node is deployed (only what the code or infrastructure shows; omit what you do not know). */
const ResilienceIn = z
  .object({
    deployment: z.enum(DEPLOYMENTS).nullable().optional(),
    instances: z.number().int().min(0).max(100_000).nullable().optional().describe('Minimum running instances (replicas)'),
    zones: z.array(z.string().max(200)).max(20).optional().describe('Availability zones or data centres'),
    failover: z.enum(FAILOVERS).nullable().optional(),
    mode: z.enum(HA_MODES).nullable().optional(),
    autoscaling: z.boolean().nullable().optional(),
    backups: z.boolean().nullable().optional(),
    rpo: z.string().max(200).nullable().optional(),
    rto: z.string().max(200).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .describe('Availability: deployment, instances, zones, failover, backups (from Kubernetes replicas/HPA/PDB, autoscaling groups, Multi-AZ settings, Terraform AZ lists, compose deploy.replicas)')

/** Merge stated resilience fields onto what the node has. */
function resilienceOf(cur: HxNode['resilience'], a: z.infer<typeof ResilienceIn> | undefined): HxNode['resilience'] | undefined {
  if (a === undefined) return undefined
  const base = cur ?? ResilienceZ.parse({})
  const next: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(a)) if (v !== undefined) next[k] = typeof v === 'string' ? scrubOpt(v) : v
  return ResilienceZ.parse(next)
}

const FeatureIn = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  category: z.enum(FEATURE_CATEGORIES).optional(),
  protocol: z.string().optional(),
  endpoint: z.string().optional().describe('Route or signature, e.g. "POST /v1/charge" or "rpc Reconcile(Req) returns (Resp)"'),
  description: z.string().optional(),
  contract: z.object({ kind: z.enum(CONTRACT_KINDS), body: z.string().max(20000) }).optional(),
  sla: z.object({ p50Ms: z.number().optional(), p99Ms: z.number().optional(), maxRps: z.number().optional() }).optional(),
  status: z.enum(STATUSES).optional(),
  phase: z.string().optional().describe('Roadmap phase id in which this feature lands'),
  codeRef: EvidenceIn.optional(),
})

function featureOf(f: z.infer<typeof FeatureIn>, taken: (id: string) => boolean): z.output<typeof FeatureZ> {
  let id = f.id ?? f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (id === '') id = 'feature'
  if (f.id === undefined) {
    let n = 2
    const base = id
    while (taken(id)) id = `${base}-${n++}`
  }
  return FeatureZ.parse({
    id,
    name: scrub(f.name),
    category: f.category ?? 'api',
    protocol: scrubOpt(f.protocol),
    endpoint: scrubOpt(f.endpoint),
    description: f.description === undefined ? '' : scrub(f.description),
    contract: f.contract === undefined ? null : { kind: f.contract.kind, body: scrub(f.contract.body) },
    sla: f.sla === undefined ? null : { p50Ms: f.sla.p50Ms ?? null, p99Ms: f.sla.p99Ms ?? null, maxRps: f.sla.maxRps ?? null },
    status: f.status ?? 'existing',
    phase: f.phase ?? null,
    codeRef: f.codeRef === undefined ? null : (evidenceOf([f.codeRef])[0] ?? null),
  })
}

// ---- read views ---------------------------------------------------------------------------------------------

function nodeBrief(n: HxNode): Record<string, unknown> {
  return {
    id: n.id,
    name: n.name,
    kind: n.kind,
    ...(n.boundary === 'external' ? { boundary: 'external' } : {}),
    ...(n.status !== 'existing' ? { status: n.status } : {}),
    ...(n.techStack !== null ? { tech: n.techStack } : {}),
    ...(n.team !== null ? { team: n.team } : {}),
    ...(n.dataClasses.length > 0 ? { data: n.dataClasses } : {}),
    ...(n.phase !== null ? { phase: n.phase } : {}),
  }
}

function tree(m: Model, parentId: string | null, depth: number): unknown[] {
  return childrenOf(m, parentId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((n) => {
      const kids = depth < 4 ? tree(m, n.id, depth + 1) : []
      return { ...nodeBrief(n), ...(kids.length > 0 ? { children: kids } : {}) }
    })
}

function connBrief(c: HxConnector): Record<string, unknown> {
  return {
    id: c.id,
    source: c.source,
    target: c.target,
    protocol: c.channelA.protocol,
    ...(c.channelB !== null ? { returnProtocol: c.channelB.protocol } : {}),
    ...(c.sync === 'async' ? { async: true } : {}),
    ...(c.channelA.auth !== null ? { auth: c.channelA.auth } : {}),
    ...(c.status !== 'existing' ? { status: c.status } : {}),
    ...(c.channelA.dataClasses.length > 0 || (c.channelB?.dataClasses.length ?? 0) > 0
      ? { data: [...new Set([...c.channelA.dataClasses, ...(c.channelB?.dataClasses ?? [])])] }
      : {}),
    ...(c.phase !== null ? { phase: c.phase } : {}),
  }
}

function nodeDetail(m: Model, n: HxNode): Record<string, unknown> {
  return {
    ...n,
    path: pathLabel(m, n.id),
    ancestors: ancestorsOf(m, n.id).map((a) => a.id),
    children: childrenOf(m, n.id).map(nodeBrief),
    connectors: Object.values(m.connectors).filter((c) => c.source === n.id || c.target === n.id).map(connBrief),
    boundaries: Object.values(m.boundaries).filter((b) => b.nodeIds.includes(n.id)).map((b) => b.id),
  }
}

// ---- registration -------------------------------------------------------------------------------------------

/** Words for the activity list from a tool's input and result. */
function describe(tool: string, a: Record<string, unknown>, r: ToolResult, d: Draft): string {
  const text = r.content[0]?.text ?? ''
  if (r.isError === true) return text.slice(0, 300)
  const nm = (id: unknown): string => (typeof id === 'string' ? (d.model.nodes[id]?.name ?? id) : '')
  switch (tool) {
    case 'add_node':
      return `Added ${String(a['name'])}${a['parentId'] !== undefined ? ` inside ${nm(a['parentId'])}` : ''}`
    case 'update_node':
      return `Updated ${nm(a['id'])}`
    case 'remove_node':
      return `Removed ${String(a['id'])}`
    case 'add_connector':
      return `Connected ${nm(a['source'])} → ${nm(a['target'])} (${String(a['protocol'])})`
    case 'update_connector':
      return `Updated connector ${String(a['id'])}`
    case 'remove_connector':
      return `Removed connector ${String(a['id'])}`
    case 'upsert_feature':
      return `Feature ${String(a['name'])} on ${nm(a['nodeId'])}`
    case 'upsert_boundary':
      return `Boundary ${String(a['name'])}`
    case 'upsert_flow':
      return `Flow ${String(a['name'])}`
    case 'get_node':
      return `Read ${nm(a['id'])}`
    case 'search':
      return `Searched “${String(a['query'])}”`
    case 'submit_proposal':
      return `Submitted: ${String(a['title'])}`
    case 'ask_user':
      return 'Asked you some questions'
    default:
      return tool.replace(/_/g, ' ')
  }
}

export function registerTools(rawServer: McpServer, ctx: ToolContext): void {
  const d = ctx.draft
  // Every tool reports what it did (or why it failed) to the activity list.
  const server = {
    registerTool: (name: string, config: unknown, handler: (a: Record<string, unknown>) => Promise<ToolResult>) =>
      (rawServer.registerTool as (n: string, c: unknown, h: (a: Record<string, unknown>) => Promise<ToolResult>) => unknown)(name, config, async (a) => {
        const r = await handler(a)
        ctx.onActivity({ tool: name, summary: describe(name, a, r, d), ok: r.isError !== true })
        return r
      }),
  } as unknown as McpServer
  const prov = (): { source: ProvenanceSource; runId: string; at: number } => ({ source: ctx.provenance, runId: ctx.runId, at: Date.now() })
  const stage = (ops: Op[]): void => {
    if (ctx.mode === 'solutions' && ctx.options?.().active == null) throw new DraftError('Call begin_option first: every change belongs to one of the options.')
    if (ctx.mode === 'decision') throw new DraftError('Drafting a decision record does not change the diagram; call draft_decision instead.')
    if (ctx.mode === 'scan') throw new DraftError('A pattern scan does not change the diagram; suggest rules and guidelines instead.')
    if (ctx.mode === 'notes') throw new DraftError('Working on notes does not change the diagram; use record_summary, record_note_items or draft_agenda.')
    if (ctx.mode === 'publish') throw new DraftError('Publishing does not change the diagram.')
    d.apply(ops)
    ctx.onChange()
  }
  const ro = { readOnlyHint: true, openWorldHint: false }
  // Writes only stage ops in a draft the user reviews: never destructive, never outside the app. Saying so
  // explicitly matters: MCP's defaults call an unannotated tool destructive, and read-only sandboxes hide those.
  const draftWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }

  const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'x'
  /** Data-class ids checked against the catalog (undefined: not given). */
  const dataClassIds = (ids: string[] | undefined): string[] | undefined => {
    if (ids === undefined) return undefined
    const catalog = dataClassCatalog(d.model.meta)
    return [
      ...new Set(
        ids.map((x) => {
          const hit = catalog.find((c) => c.id === x.toLowerCase() || c.label.toLowerCase() === x.toLowerCase())
          if (hit === undefined) throw new DraftError(`Unknown data class "${x}". Use one of: ${catalog.map((c) => c.id).join(', ')}.`)
          return hit.id
        }),
      ),
    ]
  }
  /**
   * Ownership, data and roadmap fields from a tool's input. A team or phase is matched by id or name; a team name not
   * in the project yet is created (as a meta op staged before the entity's own).
   */
  const governance = (a: {
    notes?: string | undefined
    team?: string | null | undefined
    owner?: string | null | undefined
    sensitivity?: (typeof SENSITIVITIES)[number] | null | undefined
    dataClasses?: string[] | undefined
    phase?: string | null | undefined
  }): { fields: Record<string, unknown>; ops: Op[] } => {
    const fields: Record<string, unknown> = {}
    const ops: Op[] = []
    const meta = d.model.meta
    if (a.notes !== undefined) fields['notes'] = scrub(a.notes)
    if (a.owner !== undefined) fields['owner'] = scrubOpt(a.owner)
    if (a.sensitivity !== undefined) fields['sensitivity'] = a.sensitivity
    const dc = dataClassIds(a.dataClasses)
    if (dc !== undefined) fields['dataClasses'] = dc
    if (a.team !== undefined) {
      if (a.team === null || a.team.trim() === '') fields['team'] = null
      else {
        const want = a.team.trim()
        const hit = meta.teams.find((t) => t.id === want || t.name.toLowerCase() === want.toLowerCase())
        if (hit !== undefined) fields['team'] = hit.id
        else {
          let id = slug(want)
          for (let i = 2; meta.teams.some((t) => t.id === id); i++) id = `${slug(want)}-${i}`
          ops.push({ op: 'updateMeta', patch: { teams: [...meta.teams, { id, name: want, contact: null, color: null }] } })
          fields['team'] = id
        }
      }
    }
    if (a.phase !== undefined) {
      if (a.phase === null || a.phase.trim() === '') fields['phase'] = null
      else {
        const want = a.phase.trim()
        const hit = meta.phases.find((p) => p.id === want || p.name.toLowerCase() === want.toLowerCase())
        if (hit === undefined) {
          const names = phasesInOrder(meta).map((p) => `${p.id} (${p.name})`)
          throw new DraftError(names.length === 0 ? 'The project has no roadmap phases yet; leave phase out.' : `Unknown phase "${want}". Use one of: ${names.join(', ')}.`)
        }
        fields['phase'] = hit.id
      }
    }
    return { fields, ops }
  }

  server.registerTool(
    'get_overview',
    {
      description:
        'The architecture as it stands in your draft: project summary, the node hierarchy (children nest inside their parent), all connectors, boundaries and flows, and what the user has selected. Call this first.',
      inputSchema: {},
      annotations: ro,
    },
    () =>
      guard(() => {
        const m = d.model
        return ok({
          project: { name: m.meta.name, description: m.meta.description, repos: m.meta.repos, teams: m.meta.teams, phases: phasesInOrder(m.meta) },
          nodes: tree(m, null, 0),
          connectors: Object.values(m.connectors).map(connBrief),
          boundaries: Object.values(m.boundaries).map((b) => ({ id: b.id, name: b.name, type: b.type, parentId: b.parentId, nodeIds: b.nodeIds, ...(b.dataClasses.length > 0 ? { approvedData: b.dataClasses } : {}) })),
          flows: Object.values(m.flows).map((f) => ({ id: f.id, name: f.name, steps: f.steps.length })),
          selection: ctx.selection,
        })
      }),
  )

  server.registerTool(
    'get_node',
    { description: 'Everything about one node: fields, features with contracts, children, connectors, boundaries.', inputSchema: { id: z.string() }, annotations: ro },
    ({ id }) =>
      guard(() => {
        const n = d.model.nodes[d.nodeRef(id)]
        return n === undefined ? fail(`Unknown node "${id}".`) : ok(nodeDetail(d.model, n))
      }),
  )

  server.registerTool(
    'get_connector',
    { description: 'Everything about one connector: both channels, policies, evidence.', inputSchema: { id: z.string() }, annotations: ro },
    ({ id }) => guard(() => ok(d.model.connectors[d.connectorRef(id)])),
  )

  server.registerTool(
    'search',
    { description: 'Find nodes by name, id, tech stack, tag or feature name.', inputSchema: { query: z.string().min(1) }, annotations: ro },
    ({ query }) =>
      guard(() => {
        const q = query.toLowerCase()
        const hits = Object.values(d.model.nodes).filter((n) =>
          [n.id, n.name, n.techStack ?? '', n.vendor ?? '', ...n.tags, ...n.features.map((f) => `${f.name} ${f.endpoint ?? ''}`)].join(' ').toLowerCase().includes(q),
        )
        return ok(hits.slice(0, 40).map((n) => ({ ...nodeBrief(n), path: pathLabel(d.model, n.id) })))
      }),
  )

  server.registerTool(
    'get_vocabulary',
    { description: 'Allowed node kinds (with meanings), statuses, boundary types, feature categories, common protocols, sensitivity levels, data classes, teams and roadmap phases.', inputSchema: {}, annotations: ro },
    () =>
      guard(() =>
        ok({
          kinds: Object.fromEntries(NODE_KINDS.map((k) => [k, KIND_INFO[k].hint])),
          hostings: HOSTINGS,
          statuses: STATUSES,
          boundaryTypes: BOUNDARY_TYPES,
          featureCategories: FEATURE_CATEGORIES,
          contractKinds: CONTRACT_KINDS,
          protocols: PROTOCOLS,
          sensitivities: SENSITIVITIES,
          dataClasses: dataClassCatalog(d.model.meta).map((c) => ({ id: c.id, label: c.label, regime: c.regime })),
          teams: d.model.meta.teams.map((t) => ({ id: t.id, name: t.name })),
          phases: phasesInOrder(d.model.meta).map((p) => ({ id: p.id, name: p.name, target: p.target })),
        }),
      ),
  )

  server.registerTool(
    'get_draft',
    { description: 'What you have staged so far: added, modified and removed entities.', inputSchema: {}, annotations: ro },
    () => guard(() => ok(d.summary())),
  )

  server.registerTool(
    'add_node',
    {
      description:
        'Stage a new node. Nest inner components (processes, local databases, caches, workers) inside their service with parentId. Third-party services: boundary "external", kind "saas" (or identity/cdn) and a vendor. Returns the id.',
      inputSchema: {
        name: z.string().min(1),
        kind: z.enum(NODE_KINDS),
        id: z.string().optional().describe('Optional lower-case slug; generated from the name when omitted'),
        parentId: z.string().optional().describe('Id of the node this one lives inside'),
        boundary: z.enum(['internal', 'external']).optional(),
        status: z.enum(STATUSES).optional(),
        vendor: z.string().optional(),
        techStack: z.string().optional(),
        role: z.string().optional(),
        hosting: z.enum(HOSTINGS).optional().describe('Where it runs'),
        provider: z.string().optional().describe('AWS, Azure, GCP, on-prem data centre, …'),
        region: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        features: z.array(FeatureIn).optional(),
        notes: z.string().optional().describe('Working notes: uncertain findings, gotchas, open questions (not the description)'),
        team: z.string().optional().describe('Owning team (id or name; a new name creates the team)'),
        owner: z.string().optional().describe('Owning person or alias'),
        sensitivity: z.enum(SENSITIVITIES).optional(),
        dataClasses: z.array(z.string()).optional().describe('Regulated data it stores or processes (ids from get_vocabulary: pii, pci, phi…); only with evidence'),
        phase: z.string().optional().describe('Roadmap phase (id or name) in which this change lands'),
        near: z.string().optional().describe('Place it next to this existing node (same level)'),
        evidence: z.array(EvidenceIn).optional(),
        confidence: z.number().min(0).max(1).optional(),
        resilience: ResilienceIn.optional(),
      },
      annotations: draftWrite
    },
    (a) =>
      guard(() => {
        const parentId = a.parentId === undefined || a.parentId === '' ? null : d.nodeRef(a.parentId, 'parent')
        const id = d.newNodeId(a.name, a.id)
        const near = a.near === undefined ? null : d.nodeRef(a.near, 'near node')
        const { at, placed } = d.cellFor(parentId, near)
        const taken = new Set<string>()
        const features = (a.features ?? []).map((f) => {
          const x = featureOf(f, (fid) => taken.has(fid))
          taken.add(x.id)
          return x
        })
        const gov = governance(a)
        const node = NodeZ.parse({
          ...gov.fields,
          id,
          name: scrub(a.name),
          kind: a.kind,
          parentId,
          boundary: a.boundary ?? (KIND_INFO[a.kind].externalByDefault ? 'external' : 'internal'),
          status: a.status ?? 'existing',
          vendor: scrubOpt(a.vendor),
          techStack: scrubOpt(a.techStack),
          role: scrubOpt(a.role),
          hosting: a.hosting ?? null,
          provider: scrubOpt(a.provider),
          region: scrubOpt(a.region),
          description: a.description === undefined ? '' : scrub(a.description),
          tags: a.tags ?? [],
          features,
          evidence: evidenceOf(a.evidence),
          confidence: a.confidence ?? null,
          provenance: prov(),
          resilience: resilienceOf(null, a.resilience) ?? null,
        })
        stage([...gov.ops, { op: 'addNode', node, at }])
        if (!placed) d.markUnplaced(id)
        return ok({ id })
      }),
  )

  server.registerTool(
    'update_node',
    {
      description: 'Change fields of a node (only the fields you pass). Use parentId to move it inside another node (null: top level).',
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).optional(),
        kind: z.enum(NODE_KINDS).optional(),
        parentId: z.string().nullable().optional(),
        boundary: z.enum(['internal', 'external']).optional(),
        status: z.enum(STATUSES).optional(),
        vendor: z.string().nullable().optional(),
        techStack: z.string().nullable().optional(),
        role: z.string().nullable().optional(),
        hosting: z.enum(HOSTINGS).nullable().optional(),
        provider: z.string().nullable().optional(),
        region: z.string().nullable().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        notes: z.string().optional().describe('Working notes: uncertain findings, gotchas, open questions (not the description)'),
        team: z.string().nullable().optional().describe('Owning team (id or name; a new name creates the team)'),
        owner: z.string().nullable().optional().describe('Owning person or alias'),
        sensitivity: z.enum(SENSITIVITIES).nullable().optional(),
        dataClasses: z.array(z.string()).optional().describe('Regulated data it stores or processes (ids from get_vocabulary: pii, pci, phi…); only with evidence'),
        phase: z.string().nullable().optional().describe('Roadmap phase (id or name) in which this change lands'),
        evidence: z.array(EvidenceIn).optional().describe('Replaces the evidence list'),
        confidence: z.number().min(0).max(1).nullable().optional(),
        resilience: ResilienceIn.optional(),
      },
      annotations: draftWrite
    },
    (a) =>
      guard(() => {
        const id = d.nodeRef(a.id)
        const cur = d.model.nodes[id]
        if (cur === undefined) return fail(`Unknown node "${a.id}".`)
        const locked = new Set(cur.lockedFields)
        const patch: Record<string, unknown> = {}
        const set = (k: string, v: unknown): void => {
          if (v === undefined) return
          if (locked.has(k)) throw new DraftError(`${cur.name}.${k} is locked by the user; leave it as it is.`)
          patch[k] = v
        }
        set('name', a.name === undefined ? undefined : scrub(a.name))
        set('kind', a.kind)
        if (a.parentId !== undefined) set('parentId', a.parentId === null || a.parentId === '' ? null : d.nodeRef(a.parentId, 'parent'))
        set('boundary', a.boundary)
        set('status', a.status)
        set('vendor', a.vendor === undefined ? undefined : scrubOpt(a.vendor))
        set('techStack', a.techStack === undefined ? undefined : scrubOpt(a.techStack))
        set('role', a.role === undefined ? undefined : scrubOpt(a.role))
        set('hosting', a.hosting)
        set('provider', a.provider === undefined ? undefined : scrubOpt(a.provider))
        set('region', a.region === undefined ? undefined : scrubOpt(a.region))
        set('description', a.description === undefined ? undefined : scrub(a.description))
        set('tags', a.tags)
        set('evidence', a.evidence === undefined ? undefined : evidenceOf(a.evidence))
        set('confidence', a.confidence)
        set('resilience', resilienceOf(cur.resilience, a.resilience))
        const gov = governance(a)
        for (const [k, v] of Object.entries(gov.fields)) set(k, v)
        if (Object.keys(patch).length === 0) return ok({ id, unchanged: true })
        const ops: Op[] = [...gov.ops, { op: 'updateNode', id, patch }]
        // Moving into another parent: give it a free cell there.
        if ('parentId' in patch) ops.push({ op: 'setLayout', id, at: d.cellFor(patch['parentId'] as string | null, null).at })
        stage(ops)
        return ok({ id })
      }),
  )

  server.registerTool(
    'remove_node',
    { description: 'Remove a node, everything inside it and every connector touching them.', inputSchema: { id: z.string() }, annotations: draftWrite },
    ({ id }) =>
      guard(() => {
        const nid = d.nodeRef(id)
        const ops = removeNodeOps(d.model, nid)
        stage(ops)
        return ok({ removed: ops.filter((o) => o.op === 'removeNode').length, connectorsRemoved: ops.filter((o) => o.op === 'removeConnector').length })
      }),
  )

  const ChannelIn = {
    transport: z.string().optional(),
    auth: z.string().optional().describe('mTLS, OAuth2, API key…'),
    serialization: z.string().optional(),
    encryption: z.string().optional(),
    interval: z.string().optional().describe('Polling / heartbeat interval, e.g. "1s"'),
    dataClasses: z.array(z.string()).optional().describe('Regulated data channel A carries (pii, pci…)'),
    returnDataClasses: z.array(z.string()).optional().describe('Regulated data the return channel carries'),
    notes: z.string().optional(),
    team: z.string().optional().describe('Owning team (id or name)'),
    phase: z.string().optional().describe('Roadmap phase (id or name) in which this connector lands'),
  }

  server.registerTool(
    'add_connector',
    {
      description:
        'Stage a connector from source to target. Request/response links are duplex (default): channel A carries requests source→target, channel B the responses back (returnProtocol). Fire-and-forget messaging (Kafka, queues, webhooks): sync "async" and duplex false. Connect the most specific nodes (inner components) when known.',
      inputSchema: {
        source: z.string(),
        target: z.string(),
        protocol: z.string().min(1).describe('Channel A protocol, e.g. gRPC, HTTPS, Kafka, SQL'),
        id: z.string().optional(),
        duplex: z.boolean().optional(),
        returnProtocol: z.string().optional(),
        sync: z.enum(['sync', 'async']).optional(),
        label: z.string().optional().describe('Badge text when it should differ from the protocol'),
        description: z.string().optional(),
        status: z.enum(STATUSES).optional(),
        timeoutMs: z.number().min(0).optional(),
        retries: z.number().int().min(0).max(20).optional(),
        circuitBreaker: z.boolean().optional(),
        dependency: z.enum(DEPENDENCIES).optional().describe('"soft" when the caller keeps working without it (fallback, cache, async); default "hard"'),
        evidence: z.array(EvidenceIn).optional(),
        confidence: z.number().min(0).max(1).optional(),
        ...ChannelIn,
      },
      annotations: draftWrite
    },
    (a) =>
      guard(() => {
        const source = d.nodeRef(a.source, 'source')
        const target = d.nodeRef(a.target, 'target')
        const async = a.sync === 'async'
        const duplex = a.duplex ?? !async
        const id = d.newConnectorId(source, target, a.id)
        const gov = governance({ team: a.team, phase: a.phase, notes: a.notes })
        const channel = ChannelZ.parse({
          dataClasses: dataClassIds(a.dataClasses) ?? [],
          protocol: a.protocol,
          transport: a.transport ?? null,
          auth: a.auth ?? null,
          serialization: a.serialization ?? null,
          encryption: a.encryption ?? null,
          interval: a.interval ?? null,
        })
        const connector = ConnectorZ.parse({
          id,
          source,
          target,
          duplex,
          sync: a.sync ?? 'sync',
          channelA: channel,
          channelB: duplex ? ChannelZ.parse({ protocol: a.returnProtocol ?? a.protocol, auth: null, dataClasses: dataClassIds(a.returnDataClasses) ?? [] }) : null,
          label: a.label ?? null,
          description: a.description === undefined ? '' : scrub(a.description),
          status: a.status ?? 'existing',
          policies: { timeoutMs: a.timeoutMs ?? null, retries: a.retries ?? null, backoff: null, circuitBreaker: a.circuitBreaker ?? false },
          dependency: a.dependency ?? 'hard',
          evidence: evidenceOf(a.evidence),
          confidence: a.confidence ?? null,
          provenance: prov(),
          ...gov.fields,
        })
        stage([...gov.ops, { op: 'addConnector', connector }])
        return ok({ id })
      }),
  )

  server.registerTool(
    'update_connector',
    {
      description: 'Change a connector (only the fields you pass). Channel fields apply to channel A unless prefixed return*.',
      inputSchema: {
        id: z.string(),
        source: z.string().optional(),
        target: z.string().optional(),
        protocol: z.string().optional(),
        returnProtocol: z.string().nullable().optional().describe('null makes it one-way'),
        sync: z.enum(['sync', 'async']).optional(),
        label: z.string().nullable().optional(),
        description: z.string().optional(),
        status: z.enum(STATUSES).optional(),
        timeoutMs: z.number().min(0).nullable().optional(),
        retries: z.number().int().min(0).max(20).nullable().optional(),
        circuitBreaker: z.boolean().optional(),
        dependency: z.enum(DEPENDENCIES).optional(),
        ...ChannelIn,
      },
      annotations: draftWrite
    },
    (a) =>
      guard(() => {
        const id = d.connectorRef(a.id)
        const cur = d.model.connectors[id]
        if (cur === undefined) return fail(`Unknown connector "${a.id}".`)
        const patch: Record<string, unknown> = {}
        if (a.source !== undefined) patch['source'] = d.nodeRef(a.source, 'source')
        if (a.target !== undefined) patch['target'] = d.nodeRef(a.target, 'target')
        const chA = { ...cur.channelA }
        let touchedA = false
        for (const k of ['protocol', 'transport', 'auth', 'serialization', 'encryption', 'interval'] as const) {
          const v = a[k]
          if (v !== undefined) {
            ;(chA as Record<string, unknown>)[k] = v
            touchedA = true
          }
        }
        const dA = dataClassIds(a.dataClasses)
        if (dA !== undefined) {
          chA.dataClasses = dA
          touchedA = true
        }
        if (touchedA) patch['channelA'] = chA
        if (a.returnProtocol !== undefined) {
          patch['duplex'] = a.returnProtocol !== null
          patch['channelB'] = a.returnProtocol === null ? null : { ...(cur.channelB ?? ChannelZ.parse({})), protocol: a.returnProtocol }
        }
        const dB = dataClassIds(a.returnDataClasses)
        if (dB !== undefined) {
          const base = (patch['channelB'] as HxConnector['channelB'] | undefined) ?? cur.channelB
          if (base === null) throw new DraftError('This connector has no return channel; set returnProtocol first.')
          patch['channelB'] = { ...base, dataClasses: dB }
        }
        const gov = governance({ team: a.team, phase: a.phase, notes: a.notes })
        Object.assign(patch, gov.fields)
        if (a.sync !== undefined) patch['sync'] = a.sync
        if (a.dependency !== undefined) patch['dependency'] = a.dependency
        if (a.label !== undefined) patch['label'] = a.label
        if (a.description !== undefined) patch['description'] = scrub(a.description)
        if (a.status !== undefined) patch['status'] = a.status
        if (a.timeoutMs !== undefined || a.retries !== undefined || a.circuitBreaker !== undefined) {
          patch['policies'] = {
            ...cur.policies,
            ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}),
            ...(a.retries !== undefined ? { retries: a.retries } : {}),
            ...(a.circuitBreaker !== undefined ? { circuitBreaker: a.circuitBreaker } : {}),
          }
        }
        stage([...gov.ops, { op: 'updateConnector', id, patch }])
        return ok({ id })
      }),
  )

  server.registerTool(
    'remove_connector',
    { description: 'Remove a connector.', inputSchema: { id: z.string() }, annotations: draftWrite },
    ({ id }) =>
      guard(() => {
        stage([{ op: 'removeConnector', id: d.connectorRef(id) }])
        return ok({ removed: id })
      }),
  )

  server.registerTool(
    'upsert_feature',
    {
      description:
        'Add or replace a feature in a node\'s feature catalog (an API, async worker, data store or security guard it provides), with its endpoint/signature, contract and SLA. Same id (or same name) replaces.',
      inputSchema: { nodeId: z.string(), ...FeatureIn.shape },
      annotations: draftWrite
    },
    (a) =>
      guard(() => {
        const nodeId = d.nodeRef(a.nodeId)
        const n = d.model.nodes[nodeId]
        if (n === undefined) return fail(`Unknown node "${a.nodeId}".`)
        const { nodeId: _n, ...fin } = a
        const existing = n.features.find((f) => (a.id !== undefined ? f.id === a.id : f.name.toLowerCase() === a.name.toLowerCase()))
        const feature = featureOf({ ...fin, ...(existing !== undefined ? { id: existing.id } : {}) }, (fid) => n.features.some((f) => f.id === fid))
        const features = existing !== undefined ? n.features.map((f) => (f.id === existing.id ? feature : f)) : [...n.features, feature]
        stage([{ op: 'updateNode', id: nodeId, patch: { features } }])
        return ok({ nodeId, featureId: feature.id, replaced: existing !== undefined })
      }),
  )

  server.registerTool(
    'remove_feature',
    { description: 'Remove a feature from a node.', inputSchema: { nodeId: z.string(), featureId: z.string() }, annotations: draftWrite },
    (a) =>
      guard(() => {
        const nodeId = d.nodeRef(a.nodeId)
        const n = d.model.nodes[nodeId]
        if (n === undefined || !n.features.some((f) => f.id === a.featureId)) return fail('No such feature.')
        stage([{ op: 'updateNode', id: nodeId, patch: { features: n.features.filter((f) => f.id !== a.featureId) } }])
        return ok({ removed: a.featureId })
      }),
  )

  server.registerTool(
    'upsert_boundary',
    {
      description: 'Create or update a boundary zone (VPC, subnet, k8s namespace, DMZ, compliance perimeter, third-party area) around nodes on one level.',
      inputSchema: {
        name: z.string().min(1),
        id: z.string().optional(),
        type: z.enum(BOUNDARY_TYPES).optional(),
        parentId: z.string().nullable().optional().describe('The node whose inner level the zone is drawn in (null: top level)'),
        nodeIds: z.array(z.string()).optional(),
        description: z.string().optional(),
        dataClasses: z.array(z.string()).optional().describe('Regulated data this zone is approved for (compliance zones)'),
        team: z.string().optional(),
      },
      annotations: draftWrite
    },
    (a) =>
      guard(() => {
        const m = d.model
        const gov = governance({ team: a.team })
        const approved = dataClassIds(a.dataClasses)
        const id = a.id !== undefined && m.boundaries[a.id] !== undefined ? a.id : (a.id ?? a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
        const nodeIds = (a.nodeIds ?? []).map((x) => d.nodeRef(x))
        const parentId = a.parentId === undefined || a.parentId === null || a.parentId === '' ? null : d.nodeRef(a.parentId, 'parent')
        if (m.boundaries[id] !== undefined) {
          stage([
            ...gov.ops,
            {
              op: 'updateBoundary',
              id,
              patch: {
                ...gov.fields,
                ...(approved !== undefined ? { dataClasses: approved } : {}),
                name: a.name,
                ...(a.type !== undefined ? { type: a.type } : {}),
                ...(a.nodeIds !== undefined ? { nodeIds } : {}),
                ...(a.description !== undefined ? { description: a.description } : {}),
                ...(a.parentId !== undefined ? { parentId } : {}),
              },
            },
          ])
          return ok({ id, updated: true })
        }
        stage([...gov.ops, { op: 'addBoundary', boundary: BoundaryZ.parse({ ...gov.fields, id, name: a.name, type: a.type ?? 'vpc', parentId, nodeIds, description: a.description ?? '', dataClasses: approved ?? [] }) }])
        return ok({ id })
      }),
  )

  server.registerTool(
    'upsert_flow',
    {
      description: 'Create or replace a flow: a named request path (user journey) as ordered connector steps. direction A = source→target (request), B = target→source (response).',
      inputSchema: {
        name: z.string().min(1),
        id: z.string().optional(),
        description: z.string().optional(),
        steps: z.array(z.object({ connectorId: z.string(), direction: z.enum(['A', 'B']).optional(), note: z.string().optional() })),
      },
      annotations: draftWrite
    },
    (a) =>
      guard(() => {
        const m = d.model
        const steps = a.steps.map((s) => ({ connectorId: d.connectorRef(s.connectorId), direction: s.direction ?? 'A', note: s.note ?? null }))
        const id = a.id ?? a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        if (m.flows[id] !== undefined) {
          stage([{ op: 'updateFlow', id, patch: { name: a.name, steps, ...(a.description !== undefined ? { description: a.description } : {}) } }])
          return ok({ id, updated: true })
        }
        stage([{ op: 'addFlow', flow: FlowZ.parse({ id, name: a.name, description: a.description ?? '', steps }) }])
        return ok({ id })
      }),
  )

  server.registerTool(
    'ask_user',
    {
      description:
        'Ask the user up to 4 short questions when the request leaves design decisions open that you cannot find in the diagram or the code (which existing service should own it, sync or async, which vendor, which data store, where it is hosted, scale). Give 2-5 concrete options per question when you can. After calling this, stop: end your turn without staging changes; the answers arrive as the next message.',
      inputSchema: {
        questions: z
          .array(
            z.object({
              question: z.string().min(3).max(300),
              options: z
                .array(z.string().min(1).max(120))
                .max(6)
                .describe('2-5 short, concrete choices shown as buttons (put the choices here, not in the question text); empty only for a truly open question'),
              why: z.string().max(300).optional().describe('One line on why the answer changes the design'),
              multi: z.boolean().optional().describe('Several options may be picked'),
            }),
          )
          .min(1)
          .max(4),
      },
      annotations: ro,
    },
    (a) =>
      guard(() => {
        ctx.onAsk(a.questions.map((q, i) => ({ id: `q${i + 1}`, question: q.question, options: q.options, why: q.why ?? null, multi: q.multi === true })))
        return ok('The questions are shown to the user. End your turn now without staging anything; their answers will be the next message.')
      }),
  )

  server.registerTool(
    'highlight',
    {
      description: 'Highlight nodes on the user\'s canvas while you explain something (e.g. what breaks if a node fails). Does not change the draft.',
      inputSchema: { nodeIds: z.array(z.string()).min(1), note: z.string().optional() },
      annotations: ro,
    },
    (a) =>
      guard(() => {
        const ids = a.nodeIds.map((x) => d.nodeRef(x))
        ctx.onHighlight(ids, a.note ?? null)
        return ok({ highlighted: ids })
      }),
  )

  server.registerTool(
    'validate_draft',
    { description: 'Check the draft for problems (unconnected nodes, missing protocols, unauthenticated external links, sync cycles). Fix what you introduced before submitting.', inputSchema: {}, annotations: ro },
    () =>
      guard(() => {
        const before = new Set(lintModel(d.base).map((p) => `${p.code}|${p.nodeId ?? ''}|${p.connectorId ?? ''}`))
        const now = lintModel(d.model)
        const haBefore = new Set(resilienceFindings(d.base).map((f) => `${f.kind}|${f.nodeId ?? ''}|${f.connectorId ?? ''}`))
        return ok({
          introducedByDraft: now.filter((p) => !before.has(`${p.code}|${p.nodeId ?? ''}|${p.connectorId ?? ''}`)),
          preExisting: now.length,
          // Availability gaps on the request path (single points of failure, one-zone services, unprotected outside calls).
          resilience: resilienceFindings(d.model)
            .filter((f) => f.severity !== 'info')
            .map((f) => ({ kind: f.kind, node: f.nodeId, connector: f.connectorId, message: f.message, fix: f.fix, new: !haBefore.has(`${f.kind}|${f.nodeId ?? ''}|${f.connectorId ?? ''}`) })),
        })
      }),
  )

  server.registerTool(
    'check_traffic',
    {
      description:
        'Simulated traffic in the draft: where requests from the entry points (or the nodes you name) get to, and every place they stop or cannot reach, with the reason and what to change (a dead end, a connector pointing the wrong way, a node nothing reaches, on-prem calling cloud without a network hop). Use it to verify links before submitting.',
      inputSchema: { from: z.array(z.string()).max(50).optional().describe('Node ids to send traffic from (default: the entry points)') },
      annotations: ro,
    },
    (a) =>
      guard(() => {
        const m = d.model
        const sources = a.from !== undefined && a.from.length > 0 ? a.from.filter((id) => m.nodes[id] !== undefined) : entryNodes(m)
        const r = reach(m, sources)
        return ok({
          from: sources.map((id) => `${m.nodes[id]?.name ?? id} (${id})`),
          reached: [...r.nodes].map((id) => m.nodes[id]?.name ?? id),
          stops: trafficBreaks(m, sources).map((b) => ({ kind: b.kind, node: b.nodeId, connector: b.connectorId, message: b.message, fix: b.hint })),
        })
      }),
  )

  server.registerTool(
    'submit_proposal',
    {
      description: 'Finish: hand the draft to the user for review with a short title and rationale. Call this once, last, when the draft is complete.',
      inputSchema: { title: z.string().min(1).max(120), rationale: z.string().max(4000), risks: z.string().max(2000).optional() },
      annotations: draftWrite
    },
    (a) =>
      guard(() => {
        if (ctx.mode === 'solutions') return fail('In this mode, finish with submit_solutions (all options and the comparison), not submit_proposal.')
        if (ctx.mode === 'decision') return fail('In this mode, finish with draft_decision.')
        d.settlePlacement()
        ctx.onSubmit({ title: a.title, rationale: scrub(a.rationale), risks: scrubOpt(a.risks) })
        ctx.onChange()
        return ok({ submitted: true, changes: d.summary() })
      }),
  )

  server.registerTool(
    'get_rules',
    { description: "The project's rules (checked by validate_draft) and guidelines (conventions to follow in designs).", inputSchema: {}, annotations: ro },
    () =>
      guard(() =>
        ok({
          rules: d.model.meta.rules.filter((r) => r.enabled).map((r) => ({ id: r.id, name: r.name, description: r.description, target: r.target, where: r.where, require: r.require })),
          guidelines: d.model.meta.guidelines.filter((g) => g.enabled).map((g) => ({ title: g.title, text: g.text })),
        }),
      ),
  )

  if (ctx.mode === 'solutions') registerSolutionTools(server, ctx, draftWrite, ro)
  if (ctx.mode === 'scan') registerScanTools(server, ctx, draftWrite)
  if (ctx.mode === 'notes') registerNoteTools(server, ctx, draftWrite)
  if (ctx.mode === 'publish') registerPublishTools(server, ctx, draftWrite, ro)
  if (ctx.mode === 'decision') registerDecisionTools(server, ctx, draftWrite)
}

function registerSolutionTools(server: McpServer, ctx: ToolContext, draftWrite: object, ro: object): void {
  server.registerTool(
    'begin_option',
    {
      description:
        'Start a new alternative solution. Every change you stage after this belongs to this option (each option starts from the current architecture, not from other options). Returns the option key (A, B, C…).',
      inputSchema: { title: z.string().min(1).max(120).describe('Short name, e.g. "Async fraud service on Kafka"'), approach: z.string().max(2000).describe('One or two sentences on the approach and how it differs from the others') },
      annotations: draftWrite,
    },
    (a) => guard(() => ok({ key: ctx.onBeginOption?.(a.title, scrub(a.approach)), note: 'Now stage this option with the usual tools.' })),
  )
  server.registerTool(
    'select_option',
    { description: 'Switch to an existing option (to revise it). Later changes go into that option.', inputSchema: { key: z.string().min(1).max(4) }, annotations: draftWrite },
    (a) =>
      guard(() => {
        ctx.onSelectOption?.(a.key.toUpperCase())
        return ok({ active: a.key.toUpperCase() })
      }),
  )
  server.registerTool(
    'list_options',
    { description: 'The options so far and which one is active.', inputSchema: {}, annotations: ro },
    () => guard(() => ok(ctx.options?.() ?? { keys: [], active: null })),
  )
  server.registerTool(
    'submit_solutions',
    {
      description:
        'Finish: hand all options to the user as a comparison. Give the problem, 3-6 evaluation criteria with weights 1-5, and per option a summary, pros, cons, risks, effort and a 1-5 score per criterion, plus your recommendation. Call once, last (again after revising options).',
      inputSchema: {
        problem: z.string().min(1).max(4000),
        constraints: z.string().max(4000).optional(),
        criteria: z.array(z.object({ name: z.string().min(1).max(100), weight: z.number().min(1).max(5) })).min(1).max(8),
        options: z
          .array(
            z.object({
              key: z.string().min(1).max(4),
              title: z.string().max(120).optional(),
              summary: z.string().min(1).max(3000),
              pros: z.array(z.string().max(300)).max(10),
              cons: z.array(z.string().max(300)).max(10),
              risks: z.string().max(2000).optional(),
              effort: z.enum(EFFORTS).optional(),
              scores: z.array(z.object({ criterion: z.string().max(100), score: z.number().min(1).max(5), note: z.string().max(300).optional() })).max(8),
            }),
          )
          .min(1)
          .max(6),
        recommendation: z.object({ key: z.string().max(4), why: z.string().max(2000) }).optional(),
      },
      annotations: draftWrite,
    },
    (a) =>
      guard(() => {
        const known = new Set(ctx.options?.().keys.map((k) => k.key) ?? [])
        const missing = a.options.map((o) => o.key.toUpperCase()).filter((k) => !known.has(k))
        if (missing.length > 0) return fail(`Unknown option key(s) ${missing.join(', ')}. Start each option with begin_option.`)
        ctx.onSubmitSolutions?.({
          problem: scrub(a.problem),
          constraints: scrubOpt(a.constraints) ?? '',
          criteria: a.criteria,
          options: a.options.map((o) => ({
            key: o.key.toUpperCase(),
            ...(o.title !== undefined ? { title: o.title } : {}),
            summary: scrub(o.summary),
            pros: o.pros.map(scrub),
            cons: o.cons.map(scrub),
            risks: scrubOpt(o.risks),
            effort: o.effort ?? null,
            scores: o.scores.map((sc) => ({ criterion: sc.criterion, score: sc.score, note: sc.note ?? '' })),
          })),
          recommendation: a.recommendation === undefined ? null : { key: a.recommendation.key.toUpperCase(), why: scrub(a.recommendation.why) },
        })
        return ok({ submitted: true, options: a.options.length })
      }),
  )
}

const RULE_FORMAT = `A rule is JSON: {"id": "kebab-id", "name": "...", "description": "why", "severity": "error"|"warn"|"info", "target": "node"|"connector"|"boundary", "where": <condition or null>, "require": <condition>, "message": "{name} ... ({source}/{target} for connectors)"}.
A condition is one of:
- field test {"field": "kind", "op": "eq"|"ne"|"in"|"notIn"|"includes"|"excludes"|"exists"|"empty"|"matches"|"gt"|"lt", "value": ...}. Node fields: kind, status, boundary (internal/external), name, team (effective), owner, hosting, provider, techStack, tags, dataClasses (handled, derived), sensitivity, phase, description, vendor, inbound, outbound, children, features.count, boundaries (types of zones it is in), parent.kind. Connector fields: protocol, auth, encrypted (boolean), sync, dataClasses, status, team, source.<node field>, target.<node field>.
- {"all": [conditions]}, {"any": [conditions]}, {"not": condition}
- nodes: {"connectsTo": {"dir": "out"|"in"|"any", "where": <condition on the other node>, "via": <condition on the connector>}, "count": "some"|"none"|"all"}, {"insideBoundary": {"where": <condition on the boundary: type, name, dataClasses>}}, {"hasAncestor": condition}, {"hasChild": condition}
- connectors: {"crossesTeam": true}, {"crossesBoundary": true}
Example: frontends call only gateways: {"target": "node", "where": {"field": "kind", "op": "in", "value": ["frontend", "mobile"]}, "require": {"connectsTo": {"dir": "out", "where": {"field": "kind", "op": "ne", "value": "gateway"}}, "count": "none"}}`

function registerScanTools(server: McpServer, ctx: ToolContext, draftWrite: object): void {
  server.registerTool(
    'suggest_rule',
    {
      description: `Suggest a checkable rule the architecture follows (or should). Harpoon checks it against the diagram at once and returns how many components it applies to and which break it; tighten or drop rules most do not follow (unless the exceptions are real problems worth flagging). ${RULE_FORMAT}`,
      inputSchema: {
        rule: z.string().min(10).max(8000).describe('The rule as a JSON string'),
        rationale: z.string().min(1).max(1000).describe('Why this convention exists here'),
        evidence: z.string().max(1500).describe('Where in the code you saw it (files, patterns)'),
      },
      annotations: draftWrite,
    },
    (a) =>
      guard(() => {
        let raw: unknown
        try {
          raw = JSON.parse(a.rule)
        } catch {
          return fail('rule is not valid JSON.')
        }
        const r = RuleZ.parse(raw)
        const problem = ruleProblem(r)
        if (problem !== null) return fail(`${problem} Use a short, simple pattern (no nested repetition, alternation inside repetition, or back-references).`)
        const res = ctx.onSuggestRule?.(r, scrub(a.rationale), scrub(a.evidence)) ?? { applies: 0, violations: [] }
        return ok({ appliesTo: res.applies, breaking: res.violations.length, examples: res.violations.slice(0, 8).map((v) => v.name) })
      }),
  )
  server.registerTool(
    'suggest_guideline',
    {
      description: 'Suggest a convention found in the code that a diagram cannot check (layering, error handling, outbox, logging, testing, naming). Give where you saw it and how widespread it is.',
      inputSchema: {
        title: z.string().min(1).max(200),
        text: z.string().min(1).max(2000).describe('What to do, when it applies'),
        evidence: z.string().max(1500),
        prevalence: z.string().max(200).describe('e.g. "11 of 12 services"'),
      },
      annotations: draftWrite,
    },
    (a) =>
      guard(() => {
        ctx.onSuggestGuideline?.({ title: scrub(a.title), text: scrub(a.text), evidence: scrub(a.evidence), prevalence: scrub(a.prevalence) })
        return ok({ noted: true })
      }),
  )
  server.registerTool(
    'submit_scan',
    { description: 'Finish the scan with a short summary of the patterns found and notable deviations.', inputSchema: { summary: z.string().min(1).max(4000) }, annotations: draftWrite },
    (a) =>
      guard(() => {
        ctx.onSubmitScan?.(scrub(a.summary))
        return ok({ submitted: true })
      }),
  )
}

function registerPublishTools(server: McpServer, ctx: ToolContext, draftWrite: object, ro: object): void {
  server.registerTool(
    'get_publish_pages',
    { description: 'What to publish and where: the target Notion page, the sections (key, title, Markdown), the page id each section had last time, and the last changelog.', inputSchema: {}, annotations: ro },
    () => guard(async () => ok((await ctx.publishPages?.()) ?? {})),
  )
  server.registerTool(
    'record_publish',
    {
      description: 'Finish: the Notion page id of every section you wrote (by section key) and a short changelog of what changed since the last publish.',
      inputSchema: { pages: z.array(z.object({ key: z.string().max(300), pageId: z.string().max(200) })).max(500), summary: z.string().min(1).max(4000) },
      annotations: draftWrite,
    },
    (a) =>
      guard(() => {
        ctx.onRecordPublish?.(Object.fromEntries(a.pages.map((p) => [p.key, p.pageId])), scrub(a.summary))
        return ok({ recorded: a.pages.length })
      }),
  )
}

function registerNoteTools(server: McpServer, ctx: ToolContext, draftWrite: object): void {
  const TOOL_FOR = { summarize: 'record_summary', extract: 'record_note_items', agenda: 'draft_agenda' } as const
  /** Each note task saves one thing; another tool's output would be dropped, so say which one to use. */
  const wrongTask = (tool: string): ToolResult | null =>
    ctx.noteTask !== undefined && TOOL_FOR[ctx.noteTask] !== tool ? fail(`The task is "${ctx.noteTask}": call ${TOOL_FOR[ctx.noteTask]} instead.`) : null
  if (ctx.noteTask === undefined || ctx.noteTask === 'summarize')
  server.registerTool(
    'record_summary',
    { description: 'Save the summary of the note (Markdown bullets).', inputSchema: { summary: z.string().min(1).max(8000) }, annotations: draftWrite },
    (a) =>
      guard(() => {
        const wrong = wrongTask('record_summary')
        if (wrong !== null) return wrong
        ctx.onNoteSummary?.(scrub(a.summary))
        return ok({ saved: true })
      }),
  )
  if (ctx.noteTask === undefined || ctx.noteTask === 'extract')
  server.registerTool(
    'record_note_items',
    {
      description: 'Save the actionable items found in the note, each with its kind and the action that fits.',
      inputSchema: {
        items: z
          .array(z.object({ kind: z.enum(NOTE_ITEM_KINDS), text: z.string().min(1).max(1000).describe('Self-contained: it becomes a request on its own'), action: z.enum(NOTE_ACTIONS) }))
          .max(60),
      },
      annotations: draftWrite,
    },
    (a) =>
      guard(() => {
        const wrong = wrongTask('record_note_items')
        if (wrong !== null) return wrong
        ctx.onNoteItems?.(a.items.map((i) => ({ kind: i.kind, text: scrub(i.text), action: i.action })))
        return ok({ saved: a.items.length })
      }),
  )
  if (ctx.noteTask === undefined || ctx.noteTask === 'agenda')
  server.registerTool(
    'draft_agenda',
    { description: 'Save the agenda for the next meeting (Markdown); it becomes the next meeting note.', inputSchema: { agenda: z.string().min(1).max(10000) }, annotations: draftWrite },
    (a) =>
      guard(() => {
        const wrong = wrongTask('draft_agenda')
        if (wrong !== null) return wrong
        ctx.onNoteAgenda?.(scrub(a.agenda))
        return ok({ saved: true })
      }),
  )
}

function registerDecisionTools(server: McpServer, ctx: ToolContext, draftWrite: object): void {
  server.registerTool(
    'draft_decision',
    {
      description:
        'Write the architecture decision record: title (the decision, short and imperative), context (forces, constraints, why now), decision (what we will do and why this option), consequences (good, bad, follow-ups), the options considered (chosen marked, the others with why not), deciders if known, and the ids of the nodes/connectors it concerns. Markdown is fine in the long fields. Call once, last.',
      inputSchema: {
        title: z.string().min(1).max(200),
        context: z.string().min(1).max(20000),
        decision: z.string().min(1).max(20000),
        consequences: z.string().max(20000),
        options: z.array(z.object({ title: z.string().max(200), summary: z.string().max(3000), chosen: z.boolean(), whyNot: z.string().max(2000).optional() })).max(10),
        deciders: z.array(z.string().max(200)).max(20).optional(),
        entityIds: z.array(z.string().max(100)).max(200).optional(),
      },
      annotations: draftWrite,
    },
    (a) =>
      guard(() => {
        ctx.onDraftDecision?.({
          title: scrub(a.title),
          context: scrub(a.context),
          decision: scrub(a.decision),
          consequences: scrub(a.consequences),
          options: a.options.map((o) => ({ title: o.title, summary: scrub(o.summary), chosen: o.chosen, whyNot: scrubOpt(o.whyNot) ?? '' })),
          deciders: a.deciders ?? [],
          entityIds: a.entityIds ?? [],
        })
        return ok({ drafted: true })
      }),
  )
}
