// IPC request validation: one zod.strictObject per command, checked against `Commands` in both directions at compile
// time. Main runs every `harpoon:cmd` request through `parseRequest` before the core sees it. Structural checks only;
// the core still owns the semantic ones.
import { NOTE_ACTIONS, NOTE_ITEM_KINDS } from './ipc.ts'
import { EFFORTS } from './ipc.ts'
import { z } from 'zod'
import { AI_MODES, AI_VENDORS, NODE_STYLES, THEMES } from './ipc.ts'
import { OpZ } from './model/ops.ts'
import type { Cmd, CollectionItem, ExportFormat, Req, Result } from './ipc.ts'
import { COLLECTION_KINDS } from './ipc.ts'
import type { Op } from './model/ops.ts'

// ---- bounds ---------------------------------------------------------------------------------------------------

const KB = 1024

export const ID_MAX = 128
export const PATH_MAX = 4096
export const LOG_MSG_MAX = 16 * KB
export const PROMPT_MAX = 100 * KB

export const PathZ = z
  .string()
  .min(1)
  .max(PATH_MAX)
  .refine((s) => !s.includes('\u0000'), 'A path cannot contain a NUL character')
const HttpsUrlZ = z.url({ protocol: /^https$/, message: 'Expected an https URL' }).max(2048)
export const optional = <T extends z.ZodType>(t: T): z.ZodExactOptional<T> => t.exactOptional()

// ---- request shapes ---------------------------------------------------------------------------------------------

const VoidZ = z.undefined()
/** A model id or alias as the CLIs take them (claude-opus-5-5, opus, gpt-6-luna, sonnet[1m]). */
const ModelIdZ = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:/@[\]-]+$/, 'Not a model id')
/** An MCP server or connector name as the CLIs show them (`linear`, `claude.ai Linear`). */
const ToolNameZ = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/, 'Not a tool name')
const EffortZ = z.string().regex(/^[a-z]{1,20}$/, 'Not an effort level')
const EXPORT_FORMATS = ['harpoon-json', 'interchange-json', 'json-schema', 'mermaid', 'mermaid-sequence', 'plantuml', 'drawio', 'svg', 'markdown', 'brief'] as const satisfies readonly ExportFormat[]
const ExportViewZ = z.strictObject({
  focusId: z.string().max(ID_MAX).nullable(),
  expanded: z.array(z.string().max(ID_MAX)).max(5000),
  style: z.enum(NODE_STYLES),
  theme: z.enum(['light', 'dark']),
  includeNotes: z.boolean().default(false),
})

type RequestSchemaMap = { readonly [C in Cmd]: z.ZodType<Req<C>> }

export const REQUEST_SCHEMAS = {
  'app.info': VoidZ,
  'dialog.pickFolder': z.strictObject({ defaultPath: optional(PathZ), title: optional(z.string().max(200)) }),
  'shell.open': z.discriminatedUnion('target', [
    z.strictObject({ target: z.literal('folder'), path: PathZ }),
    z.strictObject({ target: z.literal('file'), path: PathZ }),
    z.strictObject({ target: z.literal('home') }),
    z.strictObject({ target: z.literal('url'), url: HttpsUrlZ }),
  ]),
  'log.write': z.strictObject({
    level: z.enum(['info', 'warn', 'error']),
    msg: z.string().max(LOG_MSG_MAX),
    // Bounded: a renderer log line cannot grow the log by megabytes.
    data: optional(z.unknown().refine((d) => JSON.stringify(d ?? null).length <= 16_000, 'log data too large')),
  }),
  'state.get': VoidZ,
  'state.set': z.strictObject({
    theme: optional(z.enum(THEMES)),
    nodeStyle: optional(z.enum(NODE_STYLES)),
    designsDir: optional(PathZ),
    ai: optional(
      z.strictObject({
        vendor: z.enum(AI_VENDORS).nullable(),
        claude: z.strictObject({ model: ModelIdZ.nullable(), effort: EffortZ.nullable() }),
        codex: z.strictObject({ model: ModelIdZ.nullable(), effort: EffortZ.nullable() }),
      }),
    ),
  }),
  'evidence.reveal': z.strictObject({ repo: z.string().max(ID_MAX).nullable(), path: z.string().min(1).max(1000) }),
  'project.createLocal': z.strictObject({ name: z.string().min(1).max(200), template: optional(z.enum(['blank', 'sample'])) }),
  'project.importFile': z.strictObject({ path: PathZ }),
  'project.saveCopy': z.strictObject({ dir: PathZ }),
  'dialog.pickFile': z.strictObject({ title: optional(z.string().max(200)), filters: optional(z.array(z.strictObject({ name: z.string().max(100), extensions: z.array(z.string().max(20)).max(10) })).max(5)) }),
  'project.inspect': z.strictObject({ dir: PathZ }),
  'project.create': z.strictObject({
    dir: PathZ,
    name: optional(z.string().max(200)),
    template: optional(z.enum(['blank', 'sample'])),
  }),
  'project.open': z.strictObject({ dir: PathZ }),
  'project.close': VoidZ,
  'project.current': VoidZ,
  // The ops' own shapes are checked again (and patch defaults dropped) by parseOps in the core.
  'project.apply': z.strictObject({
    ops: z.array(OpZ).max(20_000) as unknown as z.ZodType<Op[]>,
    label: optional(z.string().max(200)),
    coalesceKey: optional(z.string().max(200)),
    txId: optional(z.string().max(100)),
  }),
  'project.undo': VoidZ,
  'project.redo': VoidZ,
  'project.step': z.strictObject({ steps: z.number().int().min(-500).max(500) }),
  'project.save': VoidZ,
  'project.recent': VoidZ,
  'project.forgetRecent': z.strictObject({ path: PathZ }),
  'ai.providers': z.strictObject({ force: optional(z.boolean()) }),
  'mcp.external.get': VoidZ,
  'mcp.external.codexPlugin': z.strictObject({ install: z.boolean() }),
  'mcp.addToEditor': z.strictObject({ editor: z.enum(['vscode', 'cursor']) }),
  'mcp.external.set': z.strictObject({ enabled: optional(z.boolean()), port: optional(z.number().int().min(1024).max(65535)), regenerate: optional(z.boolean()) }),
  'ai.start': z.strictObject({
    vendor: z.enum(AI_VENDORS),
    model: optional(ModelIdZ.nullable()),
    effort: optional(EffortZ.nullable()),
    tools: optional(z.array(ToolNameZ).max(20)),
    mode: z.enum(AI_MODES),
    prompt: z.string().max(PROMPT_MAX),
    selection: z.strictObject({
      nodeIds: z.array(z.string().max(ID_MAX)).max(2000),
      connectorIds: z.array(z.string().max(ID_MAX)).max(2000),
      focusId: z.string().max(ID_MAX).nullable(),
    }),
    context: optional(
      z.strictObject({
        solutionSetId: optional(z.string().max(ID_MAX)),
        decisionId: optional(z.string().max(ID_MAX)),
        source: optional(z.strictObject({ kind: z.enum(['note', 'chat', 'manual']), ref: z.string().max(1000).nullable(), label: z.string().max(500).nullable() })),
        notePath: optional(z.string().max(1000)),
        noteTask: optional(z.enum(['summarize', 'extract', 'agenda'])),
        repoIds: optional(z.array(z.string().max(ID_MAX)).max(100)),
        proposalId: optional(z.string().max(ID_MAX)),
      }),
    ),
  }),
  'ai.send': z.strictObject({ runId: z.string().max(ID_MAX), prompt: z.string().min(1).max(PROMPT_MAX), tools: optional(z.array(ToolNameZ).max(20)) }),
  'ai.tools': z.strictObject({ force: optional(z.boolean()) }),
  'ai.cancel': z.strictObject({ runId: z.string().max(ID_MAX) }),
  'ai.runs': VoidZ,
  'proposal.list': VoidZ,
  'proposal.accept': z.strictObject({
    id: z.string().max(ID_MAX),
    opIndexes: optional(z.array(z.number().int().min(0)).max(100_000)),
    asPlanned: optional(z.boolean()),
    phase: optional(z.string().max(ID_MAX)),
  }),
  'proposal.discard': z.strictObject({ id: z.string().max(ID_MAX) }),
  'proposal.setOption': z.strictObject({
    id: z.string().max(ID_MAX),
    option: z.strictObject({
      solutionSetId: z.string().max(ID_MAX),
      key: z.string().min(1).max(4),
      summary: z.string().max(5000),
      pros: z.array(z.string().max(500)).max(20),
      cons: z.array(z.string().max(500)).max(20),
      effort: z.enum(EFFORTS).nullable(),
    }),
  }),
  'decision.exportAdrs': VoidZ,
  'publish.get': VoidZ,
  'publish.set': z.strictObject({
    notion: z.strictObject({
      pageUrl: z.string().max(2000),
      server: z.string().max(200).nullable(),
      includeNotes: z.boolean(),
      pages: z.record(z.string().max(300), z.string().max(200)),
      log: z.array(z.strictObject({ at: z.string().max(40), summary: z.string().max(4000), by: z.enum(['ai', 'import', 'api']) })).max(200),
    }),
  }),
  'notion.servers': VoidZ,
  'export.notion': z.strictObject({ view: ExportViewZ, png: z.string().max(40_000_000).nullable() }),
  'notion.setToken': z.strictObject({ token: z.string().min(10).max(500).nullable() }),
  'notion.tokenStatus': VoidZ,
  'notion.attachBundle': z.strictObject({ view: ExportViewZ }),
  'notes.list': VoidZ,
  'notes.read': z.strictObject({ path: z.string().max(200) }),
  'notes.write': z.strictObject({
    path: z.string().max(200),
    meta: z.strictObject({
      title: z.string().max(300),
      date: z.string().max(20).nullable(),
      attendees: z.array(z.string().max(200)).max(100),
      summary: z.string().max(20_000),
      items: z.array(z.strictObject({ id: z.string().max(40), kind: z.enum(NOTE_ITEM_KINDS), text: z.string().max(2000), action: z.enum(NOTE_ACTIONS), done: z.boolean() })).max(200),
      cadence: z.string().max(100).nullable(),
    }),
    body: z.string().max(500_000),
  }),
  'notes.delete': z.strictObject({ path: z.string().max(200) }),
  'notes.createSeries': z.strictObject({ title: z.string().min(1).max(200), cadence: z.string().max(100).nullable(), attendees: z.array(z.string().max(200)).max(100), description: z.string().max(5000) }),
  'notes.createEntry': z.strictObject({ seriesId: z.string().max(80), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), title: optional(z.string().max(300)) }),
  'notes.index': VoidZ,
  'notes.toggleTask': z.strictObject({ path: z.string().max(200), line: z.number().int().min(0), done: z.boolean() }),
  'repo.resolve': VoidZ,
  'repo.setLocalPath': z.strictObject({ repoId: z.string().max(ID_MAX), path: PathZ.nullable() }),
  'repo.scan': z.strictObject({ dir: PathZ }),
  'collection.list': z.strictObject({ kind: z.enum(COLLECTION_KINDS) }),
  // The item's own shape is validated by the core (collections.ts).
  'collection.put': z.strictObject({ kind: z.enum(COLLECTION_KINDS), item: z.unknown() as unknown as z.ZodType<CollectionItem> }),
  'collection.delete': z.strictObject({ kind: z.enum(COLLECTION_KINDS), id: z.string().max(ID_MAX) }),
  'export.render': z.strictObject({ format: z.enum(EXPORT_FORMATS), view: ExportViewZ, proposalId: optional(z.string().max(ID_MAX)) }),
  'export.save': z.strictObject({
    filename: z.string().min(1).max(255),
    content: optional(z.string().max(50 * 1024 * KB)),
    base64: optional(z.string().max(70 * 1024 * KB)),
  }),
  'export.viewer': z.strictObject({ view: ExportViewZ }),
  'export.bundle': z.strictObject({ view: ExportViewZ }),
} satisfies RequestSchemaMap

// ---- compile-time checks ------------------------------------------------------------------------------------------

type AssertNever<T extends never> = T

/** Commands whose `Req<C>` does not fit the schema's output (void requests must parse to `undefined`). */
type Uncovered = {
  [C in Cmd]: [Req<C>] extends [void]
    ? [z.output<(typeof REQUEST_SCHEMAS)[C]>] extends [undefined]
      ? never
      : C
    : [Req<C>] extends [z.output<(typeof REQUEST_SCHEMAS)[C]>]
      ? never
      : C
}[Cmd]
export type _EveryRequestCovered = AssertNever<Uncovered>

// ---- parse ----------------------------------------------------------------------------------------------------

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return 'request'
  let out = ''
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`
    else out += out === '' ? String(seg) : `.${String(seg)}`
  }
  return out
}

/**
 * Validate one request. Unknown commands answer UNKNOWN_COMMAND; a mismatch answers VALIDATION with
 * `<path>: <issue>` for the first issue and every zod issue in `details`.
 */
export function parseRequest<C extends Cmd>(cmd: C, raw: unknown): Result<Req<C>> {
  if (typeof cmd !== 'string' || !Object.prototype.hasOwnProperty.call(REQUEST_SCHEMAS, cmd)) {
    const name = String(cmd).slice(0, ID_MAX)
    return { ok: false, error: { code: 'UNKNOWN_COMMAND', message: `Unknown command "${name}".` } }
  }
  const schema = REQUEST_SCHEMAS[cmd] as z.ZodType<Req<C>>
  const r = schema.safeParse(raw)
  if (r.success) return { ok: true, value: r.data }
  const issues = r.error.issues
  const first = issues[0]
  const head = first !== undefined ? `${formatPath(first.path)}: ${first.message}` : 'request: Invalid input'
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''
  return { ok: false, error: { code: 'VALIDATION', message: head + more, details: issues } }
}
