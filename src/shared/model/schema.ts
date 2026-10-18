// The Harpoon domain model. zod is the source of truth: every type here is inferred from its schema, the same
// schemas validate project files, IPC payloads and AI tool calls, and `z.toJSONSchema` publishes them.
//
// Storage is flat and normalized; hierarchy is `parentId`. Optional values are `null` (never absent) so patches can
// clear a field and diffs stay field-by-field. Layout (hex coordinates) is kept apart from semantics.
import { z } from 'zod'
import { GuidelineZ, RuleZ } from './rules.ts'

// ---- vocab -------------------------------------------------------------------------------------------------

export const NODE_KINDS = [
  'system',
  'service',
  'gateway',
  'database',
  'cache',
  'queue',
  'stream',
  'worker',
  'function',
  'storage',
  'cdn',
  'client',
  'identity',
  'saas',
  'scheduler',
  'observability',
  'process',
  'module',
  'frontend',
  'mobile',
  'desktop',
  'device',
  'search',
  'ml',
  'warehouse',
  'pipeline',
  'network',
  'legacy',
] as const
export type NodeKind = (typeof NODE_KINDS)[number]

export const BOUNDARY_SIDES = ['internal', 'external'] as const
export type BoundarySide = (typeof BOUNDARY_SIDES)[number]

export const STATUSES = ['existing', 'planned', 'in-progress', 'deprecated', 'removed'] as const
export type Status = (typeof STATUSES)[number]

export const FEATURE_CATEGORIES = ['api', 'async', 'data', 'security', 'ui', 'job', 'integration', 'other'] as const
export type FeatureCategory = (typeof FEATURE_CATEGORIES)[number]

export const CONTRACT_KINDS = ['openapi', 'proto', 'json-schema', 'graphql', 'example', 'text'] as const
export type ContractKind = (typeof CONTRACT_KINDS)[number]

/** Docking ports of a flat-top hexagon, by the direction its edge faces. */
export const PORTS = ['n', 'ne', 'se', 's', 'sw', 'nw'] as const
export type Port = (typeof PORTS)[number]

export const BOUNDARY_TYPES = [
  'vpc',
  'subnet',
  'k8s-namespace',
  'dmz',
  'compliance',
  'third-party',
  'domain',
  'cloud-account',
  'region',
  'datacenter',
  'edge',
  'other',
] as const
export type BoundaryType = (typeof BOUNDARY_TYPES)[number]

/** Where a component runs. */
export const HOSTINGS = ['cloud', 'on-prem', 'hybrid', 'saas', 'edge', 'device', 'serverless'] as const
export type Hosting = (typeof HOSTINGS)[number]

/** How sensitive the data an entity holds or handles is (one level per entity). */
export const SENSITIVITIES = ['public', 'internal', 'confidential', 'restricted'] as const
export type Sensitivity = (typeof SENSITIVITIES)[number]

export const PHASE_STATUSES = ['not-started', 'active', 'done'] as const
export type PhaseStatus = (typeof PHASE_STATUSES)[number]

export const BACKOFFS = ['none', 'fixed', 'exponential'] as const
export const PROVENANCE_SOURCES = ['user', 'ai-import', 'ai-plan', 'seed'] as const
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number]

// ---- primitives --------------------------------------------------------------------------------------------

export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/
export const IdZ = z.string().regex(ID_PATTERN, 'ids are lower-case letters, digits, ".", "_" or "-" (max 80)')
const Text = (max: number) => z.string().max(max)
const ShortText = Text(200)
const Nullable = <T extends z.ZodType>(t: T) => t.nullable().default(null)
/** A nullable field with no default (patch shapes). */
const N = <T extends z.ZodType>(t: T) => t.nullable()

/**
 * An entity is a raw field shape (no defaults: patches use it, so a patch never fills in a default it was not given)
 * plus its defaults; the full schema applies the defaults.
 */
function withDefaults<S extends z.ZodRawShape, D extends { [K in keyof S]?: z.output<S[K]> }>(
  shape: S,
  defaults: D,
): { [K in keyof S]: K extends keyof D ? z.ZodDefault<S[K]> : S[K] } {
  const out: Record<string, z.ZodType> = { ...(shape as unknown as Record<string, z.ZodType>) }
  for (const [k, v] of Object.entries(defaults)) {
    const field = shape[k] as unknown as z.ZodType
    out[k] = field.default(v as never)
  }
  return out as { [K in keyof S]: K extends keyof D ? z.ZodDefault<S[K]> : S[K] }
}

export const EvidenceZ = z.object({
  /** Repo id from the project's `repos` (null: the project folder itself). */
  repo: Nullable(ShortText),
  path: Text(1000),
  /** 1-based inclusive line range. */
  lines: Nullable(z.tuple([z.number().int().min(1), z.number().int().min(1)])),
  snippet: Nullable(Text(2000)),
})
export type Evidence = z.infer<typeof EvidenceZ>

export const ProvenanceZ = z.object({
  source: z.enum(PROVENANCE_SOURCES),
  /** AI run id that produced it. */
  runId: Nullable(ShortText),
  at: z.number().int().min(0),
})
export type Provenance = z.infer<typeof ProvenanceZ>

export const DocLinkZ = z.object({ title: ShortText, url: Text(2000) })
export type DocLink = z.infer<typeof DocLinkZ>

// ---- features ----------------------------------------------------------------------------------------------

export const ContractZ = z.object({ kind: z.enum(CONTRACT_KINDS), body: Text(50_000) })
export type Contract = z.infer<typeof ContractZ>

export const SlaZ = z.object({
  p50Ms: Nullable(z.number().min(0)),
  p99Ms: Nullable(z.number().min(0)),
  maxRps: Nullable(z.number().min(0)),
})
export type Sla = z.infer<typeof SlaZ>

export const FeatureZ = z.object({
  id: IdZ,
  name: ShortText.min(1),
  category: z.enum(FEATURE_CATEGORIES).default('api'),
  description: Text(5000).default(''),
  protocol: Nullable(ShortText),
  /** Route or signature: `POST /v1/charge`, `rpc ReconcileState(Req) returns (Resp)`. */
  endpoint: Nullable(Text(500)),
  contract: Nullable(ContractZ),
  sla: Nullable(SlaZ),
  codeRef: Nullable(EvidenceZ),
  status: z.enum(STATUSES).default('existing'),
  /** Roadmap phase in which this feature's status change lands. */
  phase: Nullable(IdZ),
})
export type Feature = z.infer<typeof FeatureZ>

// ---- nodes -------------------------------------------------------------------------------------------------

export const NodeSimZ = z.object({
  /** Requests/s this node can serve before it saturates. */
  capacityRps: Nullable(z.number().min(0)),
  /** Base service time per request. */
  latencyMs: Nullable(z.number().min(0)),
  /** Fraction of requests that fail on their own (0..1). */
  errorRate: Nullable(z.number().min(0).max(1)),
  /** Load this node generates as an entry point (clients, schedulers). */
  entryRps: Nullable(z.number().min(0)),
})
export type NodeSim = z.infer<typeof NodeSimZ>

const nodeShape = {
  id: IdZ,
  parentId: N(IdZ),
  name: ShortText.min(1),
  kind: z.enum(NODE_KINDS),
  boundary: z.enum(BOUNDARY_SIDES),
  /** Third-party vendor shown on external nodes (Stripe, Twilio). */
  vendor: N(ShortText),
  techStack: N(ShortText),
  role: N(ShortText),
  /** Where it runs (cloud, on-prem, device…), on which provider (AWS, Azure, GCP, a data centre) and region. */
  hosting: N(z.enum(HOSTINGS)),
  provider: N(ShortText),
  region: N(ShortText),
  description: Text(20_000),
  /** Working notes (gotchas, TODOs, who to ask); kept out of exports unless asked for. */
  notes: Text(20_000),
  /** Owning team (an id from `meta.teams`; null: inherited from the parent) and a person or alias. */
  team: N(IdZ),
  owner: N(ShortText),
  sensitivity: N(z.enum(SENSITIVITIES)),
  /** Regulated data it stores or processes (ids from the data-class catalog: pii, pci, phi…). */
  dataClasses: z.array(IdZ).max(30),
  /** Roadmap phase in which its status change lands (planned: appears; deprecated/removed: goes). */
  phase: N(IdZ),
  status: z.enum(STATUSES),
  tags: z.array(ShortText).max(50),
  features: z.array(FeatureZ).max(500),
  docs: z.array(DocLinkZ).max(100),
  evidence: z.array(EvidenceZ).max(200),
  provenance: N(ProvenanceZ),
  /** AI confidence 0..1 (null: human-authored). */
  confidence: N(z.number().min(0).max(1)),
  /** Fields an AI re-scan must never overwrite. */
  lockedFields: z.array(ShortText).max(50),
  sim: N(NodeSimZ),
}
export const NodeZ = z.object(
  withDefaults(nodeShape, {
    parentId: null,
    kind: 'service',
    boundary: 'internal',
    vendor: null,
    techStack: null,
    role: null,
    hosting: null,
    provider: null,
    region: null,
    description: '',
    notes: '',
    team: null,
    owner: null,
    sensitivity: null,
    dataClasses: [],
    phase: null,
    status: 'existing',
    tags: [],
    features: [],
    docs: [],
    evidence: [],
    provenance: null,
    confidence: null,
    lockedFields: [],
    sim: null,
  }),
)
export type HxNode = z.infer<typeof NodeZ>
export type HxNodeInput = z.input<typeof NodeZ>

// ---- connectors --------------------------------------------------------------------------------------------

export const ChannelZ = z.object({
  protocol: ShortText.default('HTTPS'),
  transport: Nullable(ShortText),
  auth: Nullable(ShortText),
  serialization: Nullable(ShortText),
  encryption: Nullable(ShortText),
  /** Polling / heartbeat interval, e.g. "1s". */
  interval: Nullable(ShortText),
  description: Nullable(Text(2000)),
  payloadSchema: Nullable(Text(50_000)),
  /** Regulated data this direction carries (a request and its response often differ). */
  dataClasses: z.array(IdZ).max(30).default([]),
})
export type Channel = z.infer<typeof ChannelZ>

export const PoliciesZ = z.object({
  timeoutMs: Nullable(z.number().min(0)),
  retries: Nullable(z.number().int().min(0).max(20)),
  backoff: Nullable(z.enum(BACKOFFS)),
  circuitBreaker: z.boolean().default(false),
})
export type Policies = z.infer<typeof PoliciesZ>

export const EdgeSimZ = z.object({
  /** Calls made on this connector per request the source handles. */
  fanout: Nullable(z.number().min(0)),
  payloadKb: Nullable(z.number().min(0)),
})
export type EdgeSim = z.infer<typeof EdgeSimZ>

const connectorShape = {
  id: IdZ,
  source: IdZ,
  target: IdZ,
  sourcePort: N(z.enum(PORTS)),
  targetPort: N(z.enum(PORTS)),
  /** Two anti-parallel harpoons: channel A source→target, channel B target→source. */
  duplex: z.boolean(),
  sync: z.enum(['sync', 'async']),
  channelA: ChannelZ,
  channelB: N(ChannelZ),
  /** Badge text override (default: channel A's protocol). */
  label: N(ShortText),
  description: Text(5000),
  notes: Text(20_000),
  team: N(IdZ),
  phase: N(IdZ),
  policies: PoliciesZ,
  status: z.enum(STATUSES),
  evidence: z.array(EvidenceZ).max(200),
  provenance: N(ProvenanceZ),
  confidence: N(z.number().min(0).max(1)),
  sim: N(EdgeSimZ),
}
export const ConnectorZ = z.object(
  withDefaults(connectorShape, {
    sourcePort: null,
    targetPort: null,
    duplex: true,
    sync: 'sync',
    channelA: ChannelZ.parse({}),
    channelB: null,
    label: null,
    description: '',
    notes: '',
    team: null,
    phase: null,
    policies: PoliciesZ.parse({}),
    status: 'existing',
    evidence: [],
    provenance: null,
    confidence: null,
    sim: null,
  }),
)
export type HxConnector = z.infer<typeof ConnectorZ>
export type HxConnectorInput = z.input<typeof ConnectorZ>

// ---- boundaries and flows ----------------------------------------------------------------------------------

const boundaryShape = {
  id: IdZ,
  /** The node whose interior the zone is drawn in (null: the top level). */
  parentId: N(IdZ),
  name: ShortText.min(1),
  type: z.enum(BOUNDARY_TYPES),
  description: Text(5000),
  notes: Text(20_000),
  team: N(IdZ),
  /** Regulated data this zone is approved for (a compliance zone: "PCI zone"). */
  dataClasses: z.array(IdZ).max(30),
  nodeIds: z.array(IdZ).max(2000),
}
export const BoundaryZ = z.object(
  withDefaults(boundaryShape, { parentId: null, type: 'vpc', description: '', notes: '', team: null, dataClasses: [], nodeIds: [] }),
)
export type HxBoundary = z.infer<typeof BoundaryZ>

export const FlowStepZ = z.object({
  connectorId: IdZ,
  /** A: source→target, B: target→source. */
  direction: z.enum(['A', 'B']).default('A'),
  note: Nullable(Text(2000)),
})
export type FlowStep = z.infer<typeof FlowStepZ>

const flowShape = {
  id: IdZ,
  name: ShortText.min(1),
  description: Text(5000),
  steps: z.array(FlowStepZ).max(500),
  /** Share of simulated traffic that follows this flow (relative weight). */
  weight: z.number().min(0),
}
export const FlowZ = z.object(withDefaults(flowShape, { description: '', steps: [], weight: 1 }))
export type HxFlow = z.infer<typeof FlowZ>

// ---- layout ------------------------------------------------------------------------------------------------

/** Axial hex coordinates on the parent's grid (top level: the system canvas). */
export const HexCoordZ = z.object({ q: z.number().int(), r: z.number().int() })
export type HexCoord = z.infer<typeof HexCoordZ>

// ---- project -----------------------------------------------------------------------------------------------

export const SCHEMA_VERSION = 1

export const REPO_ROLES = ['service', 'infra', 'shared-lib', 'frontend', 'docs', 'other'] as const
export type RepoRole = (typeof REPO_ROLES)[number]

export const RepoRefZ = z.object({
  id: IdZ,
  name: ShortText.min(1),
  /**
   * Where it usually is, relative to the project folder (or absolute). Only a hint: each machine can point the repo
   * at its own clone (kept in app state, not in the project).
   */
  path: Text(4096),
  /** Git remote, so teammates can tell which repo it is and clone it. */
  remote: Nullable(Text(1000)),
  role: z.enum(REPO_ROLES).default('service'),
  defaultBranch: Nullable(ShortText),
})
export type RepoRef = z.infer<typeof RepoRefZ>

export const TeamZ = z.object({
  id: IdZ,
  name: ShortText.min(1),
  /** Channel, email or alias. */
  contact: Nullable(ShortText),
  /** CSS colour for the Team lens (null: picked from the palette). */
  color: Nullable(ShortText),
})
export type Team = z.infer<typeof TeamZ>

/** A project-specific data class (the built-in catalog covers PII, PCI, PHI, CJIS…). */
export const DataClassZ = z.object({
  id: IdZ,
  label: ShortText.min(1),
  /** The regime that governs it (GDPR, HIPAA…). */
  regime: Nullable(ShortText),
  description: Text(2000).default(''),
})
export type DataClass = z.infer<typeof DataClassZ>

export const PhaseZ = z.object({
  id: IdZ,
  name: ShortText.min(1),
  /** Sort order (phases run in ascending order). */
  order: z.number().int(),
  /** Target date, yyyy-mm-dd. */
  target: Nullable(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  status: z.enum(PHASE_STATUSES).default('not-started'),
  description: Text(5000).default(''),
})
export type Phase = z.infer<typeof PhaseZ>

const metaShape = {
  id: IdZ,
  name: ShortText.min(1),
  description: Text(20_000),
  repos: z.array(RepoRefZ).max(50),
  teams: z.array(TeamZ).max(200),
  /** Extra data classes on top of the built-in catalog. */
  dataClasses: z.array(DataClassZ).max(100),
  phases: z.array(PhaseZ).max(50),
  /** Custom architecture rules (checked with the built-in problems) and prose guidelines (fed to AI designs). */
  rules: z.array(RuleZ).max(500),
  guidelines: z.array(GuidelineZ).max(500),
}
export const MetaZ = z.object(withDefaults(metaShape, { description: '', repos: [], teams: [], dataClasses: [], phases: [], rules: [], guidelines: [] }))
export type ProjectMeta = z.infer<typeof MetaZ>

/** `.harpoon/project.json` as written: arrays sorted by id, so git diffs stay small. */
export const ProjectFileZ = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(SCHEMA_VERSION),
  meta: MetaZ,
  nodes: z.array(NodeZ).default([]),
  connectors: z.array(ConnectorZ).default([]),
  boundaries: z.array(BoundaryZ).default([]),
  flows: z.array(FlowZ).default([]),
})
export type ProjectFile = z.infer<typeof ProjectFileZ>

/** `.harpoon/layout.json`: coordinates only. */
export const LayoutFileZ = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  nodes: z.record(IdZ, HexCoordZ).default({}),
})
export type LayoutFile = z.infer<typeof LayoutFileZ>

/** The in-memory model: records keyed by id. */
export interface Model {
  meta: ProjectMeta
  nodes: Record<string, HxNode>
  connectors: Record<string, HxConnector>
  boundaries: Record<string, HxBoundary>
  flows: Record<string, HxFlow>
  layout: Record<string, HexCoord>
}

export function emptyModel(meta: { id: string; name: string }): Model {
  return {
    meta: MetaZ.parse(meta),
    nodes: {},
    connectors: {},
    boundaries: {},
    flows: {},
    layout: {},
  }
}

const byId = <T extends { id: string }>(xs: Iterable<T>): T[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
const toRecord = <T extends { id: string }>(xs: readonly T[]): Record<string, T> => Object.fromEntries(xs.map((x) => [x.id, x]))

export function modelFromFiles(p: ProjectFile, l: LayoutFile | null): Model {
  return {
    meta: p.meta,
    nodes: toRecord(p.nodes),
    connectors: toRecord(p.connectors),
    boundaries: toRecord(p.boundaries),
    flows: toRecord(p.flows),
    layout: { ...(l?.nodes ?? {}) },
  }
}

export function projectFileOf(m: Model): ProjectFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: m.meta,
    nodes: byId(Object.values(m.nodes)),
    connectors: byId(Object.values(m.connectors)),
    boundaries: byId(Object.values(m.boundaries)),
    flows: byId(Object.values(m.flows)),
  }
}

export function layoutFileOf(m: Model): LayoutFile {
  const nodes: Record<string, HexCoord> = {}
  for (const id of Object.keys(m.layout).sort()) {
    const c = m.layout[id]
    if (c !== undefined && m.nodes[id] !== undefined) nodes[id] = { q: c.q, r: c.r }
  }
  return { schemaVersion: SCHEMA_VERSION, nodes }
}

// Partial patches (what the update ops carry): the raw shapes, so absent fields stay absent. `id` never changes.
// zod types an absent key as `?: T | undefined`; the patch types below say `?: T`, and applyOps drops undefined values.
type Patch<T> = { [K in keyof Omit<T, 'id'>]?: T[K] }
export const NodePatchZ = z.object(nodeShape).omit({ id: true }).partial()
export type NodePatch = Patch<HxNode>
export const ConnectorPatchZ = z.object(connectorShape).omit({ id: true }).partial()
export type ConnectorPatch = Patch<HxConnector>
export const BoundaryPatchZ = z.object(boundaryShape).omit({ id: true }).partial()
export type BoundaryPatch = Patch<HxBoundary>
export const FlowPatchZ = z.object(flowShape).omit({ id: true }).partial()
export type FlowPatch = Patch<HxFlow>
export const MetaPatchZ = z.object(metaShape).omit({ id: true }).partial()
export type MetaPatch = Patch<ProjectMeta>
