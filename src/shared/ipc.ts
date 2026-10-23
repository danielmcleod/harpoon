// IPC contract between renderer (via preload) and main/core. Types and string constants ONLY: no zod here, so
// the sandboxed preload never bundles it. Request schemas live in ipc-schemas.ts and `satisfies` Commands.
import type { Rule } from './model/rules.ts'
import type { Op } from './model/ops.ts'
import type { Model } from './model/schema.ts'

export const CMD_CHANNEL = 'harpoon:cmd'
export const EVT_CHANNEL = 'harpoon:evt'
export const IPC_PROTOCOL = 1

// ---- results ------------------------------------------------------------------------

export const RESULT_CODES = [
  'VALIDATION',
  'FORBIDDEN',
  'UNKNOWN_COMMAND',
  'NOT_FOUND',
  'CONFLICT',
  'NEWER_SCHEMA',
  'UNSUPPORTED',
  'STORAGE',
  'SPAWN',
  'TIMEOUT',
  'INTERNAL',
] as const
export type ResultCode = (typeof RESULT_CODES)[number]

export interface ResultError {
  code: ResultCode
  message: string
  details?: unknown
}

/** The invoke promise never rejects; handlers' throws are mapped to `{ok:false}`. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: ResultError }

export interface CmdEnvelope {
  cmd: Cmd
  req: unknown
  /** Correlation id for logs. */
  cid: string
}

// ---- app / shell DTOs ------------------------------------------------------------------

export type Platform = 'win32' | 'darwin' | 'linux'
export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
export const THEMES = ['light', 'dark', 'system'] as const satisfies readonly Theme[]

/** How hex nodes are drawn: flat neon hexagons or isometric prisms (same geometry, two looks). */
export type NodeStyle = 'flat' | 'iso'
export const NODE_STYLES = ['flat', 'iso'] as const satisfies readonly NodeStyle[]

export interface ThemeState {
  theme: Theme
  resolved: ResolvedTheme
}

export interface AppInfo {
  name: string
  version: string
  platform: Platform
  arch: string
  versions: { electron: string | null; chrome: string | null; node: string }
  home: string
  packaged: boolean
  ipcProtocol: number
}

export interface RecentProject {
  path: string
  name: string
  openedAt: number
}

/** HARPOON_HOME/state.json (UI/app state). */
export interface AppState {
  schemaVersion: 1
  theme: Theme
  nodeStyle: NodeStyle
  recentProjects: RecentProject[]
  /** Where this machine keeps each project's repos: project id → repo id → absolute path. */
  repoPaths: Record<string, Record<string, string>>
  /** Where new local designs (no repository needed) are saved. */
  designsDir: string
  /** The Notion MCP server this machine publishes through, per project id (never taken from the shared project). */
  notionServers: Record<string, string>
  /** The AI panel's starting vendor, model and effort on this machine. */
  ai: AiDefaults
  /** Outside agents' access to Harpoon's MCP tools (off unless turned on). */
  externalMcp: { enabled: boolean; port: number; token: string | null }
}

/** Per vendor: the model and effort runs start with (null: the CLI's own default). */
export interface AiDefaults {
  vendor: AiVendor | null
  claude: { model: string | null; effort: string | null }
  codex: { model: string | null; effort: string | null }
}

/** Outside agents' MCP endpoint, as Settings shows it. */
export interface ExternalMcpView {
  enabled: boolean
  /** The fixed port it listens on (so a saved agent configuration keeps working). */
  port: number
  /** Listening now (false when off, or when the port was taken). */
  running: boolean
  url: string | null
  token: string | null
  error: string | null
  /** When an outside agent last called a tool (ms since epoch). */
  lastCall: number | null
  /** The stdio bridge for clients that run a command (`Harpoon --mcp`); null when not known (tests, dev CLI). */
  bridge: { command: string; args: string[] } | null
}

/** One of the user's own MCP tools a conversation may use (a server, a claude.ai connector, Codex's apps). */
export interface UserTool {
  /** As the CLI names it (`linear`, `claude.ai Linear`, `codex_apps`). */
  name: string
  label: string
  kind: 'server' | 'connector' | 'apps'
  /** Connected and working, as far as the CLI says. */
  ok: boolean
}

export interface UserTools {
  claude: UserTool[]
  codex: UserTool[]
}

/** Installing the Codex plugin: the marketplace folder written, and each CLI step's result. */
export interface CodexPluginResult {
  dir: string
  steps: { command: string; ok: boolean; output: string }[]
}

export interface AppStatePatch {
  theme?: Theme
  nodeStyle?: NodeStyle
  designsDir?: string
  ai?: AiDefaults
}

/** A git repository found on disk. */
export interface DiscoveredRepo {
  path: string
  name: string
  remote: string | null
  branch: string | null
}

/** A linked repo and where it is on this machine (`machine`: set here; `project`: the project file's path). */
export interface ResolvedRepo {
  id: string
  path: string | null
  source: 'machine' | 'project' | 'missing'
  /** Why the project's path hint was not used (null: it was, or there is none). */
  note: string | null
}

export type ShellOpenRequest =
  | { target: 'folder'; path: string }
  | { target: 'file'; path: string }
  | { target: 'home' }
  /** https only, host allowlist. */
  | { target: 'url'; url: string }

export type LogLevel = 'info' | 'warn' | 'error'

// ---- projects ---------------------------------------------------------------------------------------------------

export interface HistoryEntry {
  label: string
  at: number
  source: ModelSource
}

export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  /** Most recent last (at most the last 60). */
  undo?: HistoryEntry[]
  /** The next redo last. */
  redo?: HistoryEntry[]
}

/** The open project as the renderer receives it. */
export interface ProjectView {
  /** The folder holding `.harpoon/` (usually a repo root). */
  root: string
  model: Model
  version: number
  history: HistoryState
}

export type ModelSource = 'user' | 'undo' | 'redo' | 'ai' | 'import' | 'external'

export interface FolderInfo {
  path: string
  hasProject: boolean
  projectName: string | null
  isGitRepo: boolean
  /** In the local designs folder (saved on this machine only, no repository). */
  isLocalDesign: boolean
}

// ---- AI -----------------------------------------------------------------------------------------------------------

export type AiVendor = 'claude' | 'codex'
export const AI_VENDORS = ['claude', 'codex'] as const satisfies readonly AiVendor[]

/**
 * plan: design a change · document: fill in details from code · explain: answer and highlight · import: map a repo ·
 * drift: diagram vs code · solutions: several alternative designs to compare · decision: draft a decision record.
 */
export type AiMode = 'plan' | 'document' | 'explain' | 'import' | 'drift' | 'solutions' | 'decision' | 'scan' | 'notes' | 'publish' | 'investigate' | 'flows' | 'resilience' | 'resolve' | 'implement'
export const AI_MODES = ['plan', 'document', 'explain', 'import', 'drift', 'solutions', 'decision', 'scan', 'notes', 'publish', 'investigate', 'flows', 'resilience', 'resolve', 'implement'] as const satisfies readonly AiMode[]

/** `.harpoon/publish.json`: where the project is published and what was written. */
export interface PublishSettings {
  notion: {
    /** The team's Notion page Harpoon writes under. */
    pageUrl: string
    /** The Notion MCP server (as the CLI names it) the AI uses to write. */
    server: string | null
    includeNotes: boolean
    /** Notion page id per section key (overview, architecture, decisions, adr:<id>…), for updating in place. */
    pages: Record<string, string>
    log: { at: string; summary: string; by: 'ai' | 'import' | 'api' }[]
  }
}

/** What a pattern scan found: checkable rules (with how well the project follows them) and prose guidelines. */
export interface ScanSuggestions {
  summary: string
  rules: { rule: Rule; rationale: string; evidence: string; applies: number; violations: { id: string; name: string }[] }[]
  guidelines: { title: string; text: string; evidence: string; prevalence: string }[]
}

/** Where a piece of work came from (a meeting note item, a chat, by hand), so it can link back. */
export interface SourceRef {
  kind: 'note' | 'chat' | 'manual'
  /** Note path and item id, or null. */
  ref: string | null
  label: string | null
}

/** Extra context for a run: what it builds on and what its result belongs to. */
export interface AiContext {
  /** solutions: refine this set (its options). decision: the set the decision settles. */
  solutionSetId?: string
  /** decision: the record to (re)draft. */
  decisionId?: string
  source?: SourceRef
  /** notes: the note to summarize or extract from (or the series to prepare the next meeting of). */
  notePath?: string
  noteTask?: 'summarize' | 'extract' | 'agenda'
  /** import: only these linked repositories (absent: all of them). */
  repoIds?: string[]
  /** implement: the proposal (usually accepted) to plan the building of. */
  proposalId?: string
}

export interface ProviderView {
  id: AiVendor
  name: string
  /** Installed, signed in and usable. */
  ok: boolean
  version: string | null
  account: string | null
  /** `resolved`: the full model id an alias such as "opus" stands for; `efforts`: the levels it accepts. */
  models: { id: string; label: string; isDefault: boolean; resolved: string | null; efforts: string[] }[]
  /** Why it is not usable, in plain words. */
  issue: string | null
}

export interface AiSelection {
  nodeIds: string[]
  connectorIds: string[]
  focusId: string | null
}

export interface AiStartRequest {
  vendor: AiVendor
  model?: string | null
  effort?: string | null
  /** The user's own MCP tools (servers, connectors) this conversation may use. */
  tools?: string[]
  mode: AiMode
  prompt: string
  selection: AiSelection
  context?: AiContext
}

export type AiRunStatus = 'starting' | 'running' | 'done' | 'failed' | 'cancelled'

export interface AiTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface AiActivity {
  id: string
  name: string
  summary: string
  status: 'running' | 'ok' | 'failed'
}

/** A question the AI needs answered before it can design the change (multiple choice, or free text). */
export interface AiQuestion {
  id: string
  question: string
  options: string[]
  /** Why it matters (shown small under the question). */
  why: string | null
  /** Several options may be picked. */
  multi: boolean
}

export interface AiUsage {
  input: number
  output: number
  costUsd: number | null
}

export interface AiRunView {
  id: string
  vendor: AiVendor
  model: string | null
  effort: string | null
  /** Driven by an outside agent over MCP (no CLI of Harpoon's own). */
  external: boolean
  /** The user's own MCP tools this conversation may use. */
  tools: string[]
  /** implement: the implementation plan the CLI's own plan mode produced (null: none yet). */
  plan: string | null
  mode: AiMode
  status: AiRunStatus
  title: string
  createdAt: number
  turns: AiTurn[]
  activity: AiActivity[]
  usage: AiUsage | null
  proposalId: string | null
  error: string | null
  /** The draft's net change from the model the run started from. */
  changeCount: number
  /** What a multi-pass job (import) is doing now. */
  phase: string | null
  /** Open questions from the AI, waiting for your answers (null: none). */
  questions: AiQuestion[] | null
  /** solutions mode: the comparison the run produced. */
  solutionSetId: string | null
  /** decision mode: the record it drafted. */
  decisionId: string | null
  /** solutions mode: the options so far and the one being worked on. */
  options: { key: string; title: string; changes: number }[]
  activeOption: string | null
  /** scan mode: the suggested rules and guidelines. */
  suggestions: ScanSuggestions | null
  /** notes mode: the note it wrote to or created. */
  notePath: string | null
}

export type ProposalStatus = 'pending' | 'accepted' | 'discarded'

export interface Proposal {
  id: string
  runId: string
  title: string
  rationale: string
  risks: string | null
  vendor: AiVendor
  mode: AiMode
  prompt: string
  createdAt: number
  status: ProposalStatus
  ops: Op[]
  /** Where the request came from (a note item…), for backlinks. */
  source?: SourceRef | null
  /** When the proposal is one of several alternatives (a solution set's option). */
  option: ProposalOption | null
}

export interface ProposalOption {
  solutionSetId: string
  /** A, B, C and so on. */
  key: string
  summary: string
  pros: string[]
  cons: string[]
  effort: Effort | null
}

export const EFFORTS = ['S', 'M', 'L', 'XL'] as const
export type Effort = (typeof EFFORTS)[number]

export interface Criterion {
  id: string
  name: string
  /** 1 (nice to have) to 5 (decisive). */
  weight: number
}

export interface OptionScore {
  /** Proposal id. */
  option: string
  criterion: string
  /** 1 (poor) to 5 (excellent). */
  score: number
  note: string
}

/** A problem with several proposed solutions to compare, and (once decided) the one chosen. */
export interface SolutionSet {
  id: string
  title: string
  problem: string
  constraints: string
  criteria: Criterion[]
  /** Proposal ids, in option order. */
  options: string[]
  scores: OptionScore[]
  /** The AI's pick and why (null: none). */
  recommendation: { option: string; why: string } | null
  status: 'open' | 'decided' | 'abandoned'
  chosen: string | null
  decisionId: string | null
  runId: string | null
  createdAt: number
  source: SourceRef | null
}

export const DECISION_STATUSES = ['proposed', 'accepted', 'rejected', 'superseded', 'deprecated'] as const
export type DecisionStatus = (typeof DECISION_STATUSES)[number]

/** An architecture decision record (ADR). */
export interface DecisionRecord {
  id: string
  /** ADR number (ADR-0007). */
  number: number
  title: string
  status: DecisionStatus
  /** yyyy-mm-dd */
  date: string
  deciders: string[]
  context: string
  decision: string
  consequences: string
  options: { proposalId: string | null; title: string; summary: string; chosen: boolean; whyNot: string }[]
  /** Nodes and connectors it is about. */
  entityIds: string[]
  phase: string | null
  supersedes: string | null
  supersededBy: string | null
  solutionSetId: string | null
  links: { title: string; url: string }[]
  source: SourceRef | null
  /** How to build it: the plan the AI wrote in its CLI's plan mode (Markdown; '' for none yet). */
  implementationPlan: string
  createdAt: number
}

// ---- views, scenarios, exports ------------------------------------------------------------------------------------

// ---- notes ------------------------------------------------------------------------------------------------------

export const NOTE_ITEM_KINDS = ['task', 'decision', 'question', 'change', 'fact', 'convention', 'ownership'] as const
export type NoteItemKind = (typeof NOTE_ITEM_KINDS)[number]
/** What can be done with an item: propose solutions, plan the change, update the diagram, record a decision, add a guideline, nothing. */
export const NOTE_ACTIONS = ['solutions', 'plan', 'document', 'decision', 'guideline', 'none'] as const
export type NoteAction = (typeof NOTE_ACTIONS)[number]

/** Something worth acting on, extracted from a note by the AI. */
export interface NoteItem {
  id: string
  kind: NoteItemKind
  text: string
  /** The suggested next step. */
  action: NoteAction
  done: boolean
}

export interface NoteFrontMatter {
  title: string
  /** yyyy-mm-dd (meetings). */
  date: string | null
  attendees: string[]
  summary: string
  items: NoteItem[]
  /** Series only: how often it meets. */
  cadence: string | null
}

export interface NoteDoc {
  /** Relative to `.harpoon/notes/`: `project.md`, `<series>/_series.md`, `<series>/<yyyy-mm-dd>.md`. */
  path: string
  meta: NoteFrontMatter
  body: string
}

export interface NoteMeta {
  path: string
  title: string
  date: string | null
  openTasks: number
  items: number
}

export interface NoteIndex {
  project: NoteMeta | null
  series: { id: string; title: string; cadence: string | null; attendees: string[]; description: string; entries: NoteMeta[] }[]
}

export interface NoteTask {
  path: string
  title: string
  date: string | null
  line: number
  text: string
  done: boolean
  due: string | null
}

export const COLLECTION_KINDS = ['views', 'scenarios', 'tables', 'solutions', 'decisions'] as const
export type CollectionKind = (typeof COLLECTION_KINDS)[number]

export const TABLE_TABS = ['services', 'connectors', 'endpoints', 'data', 'changes', 'problems'] as const
export type TableTab = (typeof TABLE_TABS)[number]

/** A saved table view: which table, its columns, sorting, filters and grouping. */
export interface SavedTable {
  id: string
  name: string
  tab: TableTab
  hidden: string[]
  sorting: { id: string; desc: boolean }[]
  filters: { id: string; value: string }[]
  grouping: string[]
  search: string
}

export interface CollectionItems {
  views: SavedView
  scenarios: SavedScenario
  tables: SavedTable
  solutions: SolutionSet
  decisions: DecisionRecord
}
export type CollectionItem = CollectionItems[CollectionKind]

/** A saved view: a presentation scene (what is open, expanded, highlighted, and where the camera is). */
export interface SavedView {
  id: string
  name: string
  notes: string
  order: number
  focusId: string | null
  expanded: string[]
  nodeStyle: NodeStyle | null
  flowId: string | null
  blast: { id: string; dir: 'upstream' | 'downstream' | 'both' } | null
  camera: { x: number; y: number; zoom: number } | null
  /** Roadmap phase shown (null: today). */
  asOf: string | null
}

export interface SavedScenario {
  id: string
  name: string
  multiplier: number
  profile: 'constant' | 'ramp' | 'spike' | 'diurnal'
  faults: { id: string; type: 'down' | 'latency' | 'partition' | 'ratelimit' | 'errors' | 'instance' | 'zone' | 'region'; target: string; value: number; from: number; until: number | null }[]
}

export type ExportFormat =
  | 'harpoon-json'
  | 'interchange-json'
  | 'json-schema'
  | 'mermaid'
  | 'mermaid-sequence'
  | 'plantuml'
  | 'drawio'
  | 'svg'
  | 'markdown'
  | 'brief'

/** What a picture export shows: the current view of the canvas. */
export interface ExportView {
  focusId: string | null
  expanded: string[]
  style: NodeStyle
  theme: ResolvedTheme
  /** Include working notes (left out of shared exports by default). */
  includeNotes: boolean
}

export interface ExportResult {
  filename: string
  content: string
  mime: string
}

export interface ApplyRequest {
  ops: Op[]
  label?: string
  coalesceKey?: string
  txId?: string
}

// ---- commands ---------------------------------------------------------------------------

/** Every command, with request and response types. A missing handler or schema is a compile error. */
export interface Commands {
  // app / shell
  'app.info': { req: void; res: AppInfo }
  'dialog.pickFolder': { req: { defaultPath?: string; title?: string }; res: string | null }
  'shell.open': { req: ShellOpenRequest; res: void }
  'log.write': { req: { level: LogLevel; msg: string; data?: unknown }; res: void }
  'state.get': { req: void; res: AppState }
  'state.set': { req: AppStatePatch; res: AppState }
  // projects
  'project.inspect': { req: { dir: string }; res: FolderInfo }
  'project.create': { req: { dir: string; name?: string; template?: 'blank' | 'sample' }; res: ProjectView }
  'project.open': { req: { dir: string }; res: ProjectView }
  'project.close': { req: void; res: void }
  'project.current': { req: void; res: ProjectView | null }
  'project.apply': { req: ApplyRequest; res: { version: number } }
  'project.undo': { req: void; res: { version: number } }
  'project.redo': { req: void; res: { version: number } }
  /** Undo (negative) or redo (positive) several steps at once (the History list). */
  'project.step': { req: { steps: number }; res: { version: number } }
  'project.save': { req: void; res: void }
  'project.recent': { req: void; res: RecentProject[] }
  'project.forgetRecent': { req: { path: string }; res: RecentProject[] }
  /** A new design in the local designs folder: no folder to pick, no repository needed. */
  'project.createLocal': { req: { name: string; template?: 'blank' | 'sample' }; res: ProjectView }
  /** Open a single-file design (.harpoon.json) as a new local design. */
  'project.importFile': { req: { path: string }; res: ProjectView }
  /** Copy the open project into another folder (e.g. a repository) and open the copy. */
  'project.saveCopy': { req: { dir: string }; res: ProjectView }
  /** Show an evidence file in its folder (never opens or runs it); it must be inside the project or a linked repo. */
  'evidence.reveal': { req: { repo: string | null; path: string }; res: void }
  'dialog.pickFile': { req: { title?: string; filters?: { name: string; extensions: string[] }[] }; res: string | null }
  // repositories
  /** Where each linked repo is on this machine. */
  'repo.resolve': { req: void; res: ResolvedRepo[] }
  /** Point a linked repo at a clone on this machine (null: forget it and use the project's path). */
  'repo.setLocalPath': { req: { repoId: string; path: string | null }; res: ResolvedRepo[] }
  /** Git repos at or below a folder. */
  'repo.scan': { req: { dir: string }; res: DiscoveredRepo[] }
  // AI
  'ai.providers': { req: { force?: boolean }; res: ProviderView[] }
  'mcp.external.get': { req: void; res: ExternalMcpView }
  /** Turn outside access on or off, move it to another port, or issue a new token (the old one stops working). */
  'mcp.external.set': { req: { enabled?: boolean; port?: number; regenerate?: boolean }; res: ExternalMcpView }
  /** Write the Codex plugin (local marketplace); with install, also register it with the Codex CLI. */
  'mcp.external.codexPlugin': { req: { install: boolean }; res: CodexPluginResult }
  /** Open VS Code's or Cursor's "add MCP server" prompt for the stdio bridge (the link is built in main). */
  'mcp.addToEditor': { req: { editor: 'vscode' | 'cursor' }; res: void }
  'ai.start': { req: AiStartRequest; res: AiRunView }
  /** `tools`: the user's own MCP tools this conversation may use from now on (absent: keep the run's). */
  'ai.send': { req: { runId: string; prompt: string; tools?: string[] }; res: AiRunView }
  /** The user's own MCP servers and connectors each CLI has (`force`: ask the CLIs again). */
  'ai.tools': { req: { force?: boolean }; res: UserTools }
  'ai.cancel': { req: { runId: string }; res: void }
  'ai.runs': { req: void; res: AiRunView[] }
  'proposal.list': { req: void; res: Proposal[] }
  /** `phase`: with asPlanned, the roadmap phase the new things land in. */
  'proposal.accept': { req: { id: string; opIndexes?: number[]; asPlanned?: boolean; phase?: string }; res: { version: number } }
  'proposal.discard': { req: { id: string }; res: void }
  /** Make a saved proposal one option of a comparison. */
  'proposal.setOption': { req: { id: string; option: ProposalOption }; res: void }
  // notes
  'notes.list': { req: void; res: NoteIndex }
  'notes.read': { req: { path: string }; res: NoteDoc }
  'notes.write': { req: { path: string; meta: NoteFrontMatter; body: string }; res: void }
  'notes.delete': { req: { path: string }; res: void }
  'notes.createSeries': { req: { title: string; cadence: string | null; attendees: string[]; description: string }; res: string }
  /** A new meeting in a series (template, usual attendees, open items carried over). Returns its path. */
  'notes.createEntry': { req: { seriesId: string; date: string; title?: string }; res: string }
  /** Tasks across all notes, and which notes mention which entities. */
  'notes.index': { req: void; res: { tasks: NoteTask[]; mentions: Record<string, { path: string; title: string }[]> } }
  'notes.toggleTask': { req: { path: string; line: number; done: boolean }; res: void }
  // publishing
  'publish.get': { req: void; res: PublishSettings }
  'publish.set': { req: PublishSettings; res: PublishSettings }
  /** MCP servers in the CLIs' configs that look like Notion. */
  'notion.servers': { req: void; res: { claude: string[]; codex: string[] } }
  /** A zip of Markdown pages (plus the diagram and the share bundle) for Notion's import. Null when cancelled. */
  'export.notion': { req: { view: ExportView; png: string | null }; res: string | null }
  /** The Notion integration token (kept encrypted on this machine): set it, or clear it with null. */
  'notion.setToken': { req: { token: string | null }; res: { hasToken: boolean } }
  'notion.tokenStatus': { req: void; res: { hasToken: boolean; canEncrypt: boolean } }
  /** Upload the share bundle to the Notion page and attach it (Notion API). */
  'notion.attachBundle': { req: { view: ExportView }; res: { filename: string } }
  /** Write every decision record to docs/adr/NNNN-title.md in the project folder. */
  'decision.exportAdrs': { req: void; res: { dir: string; count: number } }
  // views, scenarios, exports
  'collection.list': { req: { kind: CollectionKind }; res: CollectionItem[] }
  'collection.put': { req: { kind: CollectionKind; item: CollectionItem }; res: CollectionItem }
  'collection.delete': { req: { kind: CollectionKind; id: string }; res: void }
  'export.render': { req: { format: ExportFormat; view: ExportView; proposalId?: string }; res: ExportResult }
  /** Save dialog + write. Text content, or base64 bytes (PNG). Null when cancelled. */
  'export.save': { req: { filename: string; content?: string; base64?: string }; res: string | null }
  /** A self-contained read-only HTML viewer of the project. Null when cancelled. */
  'export.viewer': { req: { view: ExportView }; res: string | null }
  /** Everything in one zip: the project, the HTML viewer, docs, pictures and diagram code. Null when cancelled. */
  'export.bundle': { req: { view: ExportView }; res: string | null }
}

export type Cmd = keyof Commands
export type Req<C extends Cmd> = Commands[C]['req']
export type Res<C extends Cmd> = Commands[C]['res']
/** Commands whose request is `void` may omit it. */
export type InvokeArgs<C extends Cmd> = Req<C> extends void ? [req?: undefined] : [req: Req<C>]

export const COMMAND_AREAS = ['app', 'project', 'ai', 'export'] as const
export type CommandArea = (typeof COMMAND_AREAS)[number]

/** Runtime list of every command (exhaustive both ways via `satisfies`). */
export const COMMAND_AREA = {
  'app.info': 'app',
  'dialog.pickFolder': 'app',
  'shell.open': 'app',
  'log.write': 'app',
  'state.get': 'app',
  'state.set': 'app',
  'project.inspect': 'project',
  'project.create': 'project',
  'project.open': 'project',
  'project.close': 'project',
  'project.current': 'project',
  'project.apply': 'project',
  'project.undo': 'project',
  'project.redo': 'project',
  'project.step': 'project',
  'project.save': 'project',
  'project.recent': 'project',
  'project.forgetRecent': 'project',
  'project.createLocal': 'project',
  'project.importFile': 'project',
  'project.saveCopy': 'project',
  'dialog.pickFile': 'app',
  'evidence.reveal': 'app',
  'repo.resolve': 'project',
  'repo.setLocalPath': 'project',
  'repo.scan': 'project',
  'ai.providers': 'ai',
  'mcp.external.get': 'ai',
  'mcp.external.set': 'ai',
  'mcp.external.codexPlugin': 'ai',
  'mcp.addToEditor': 'ai',
  'ai.start': 'ai',
  'ai.send': 'ai',
  'ai.tools': 'ai',
  'ai.cancel': 'ai',
  'ai.runs': 'ai',
  'proposal.list': 'ai',
  'proposal.accept': 'ai',
  'proposal.discard': 'ai',
  'proposal.setOption': 'ai',
  'decision.exportAdrs': 'project',
  'publish.get': 'project',
  'publish.set': 'project',
  'notion.servers': 'app',
  'export.notion': 'export',
  'notion.setToken': 'app',
  'notion.tokenStatus': 'app',
  'notion.attachBundle': 'export',
  'notes.list': 'project',
  'notes.read': 'project',
  'notes.write': 'project',
  'notes.delete': 'project',
  'notes.createSeries': 'project',
  'notes.createEntry': 'project',
  'notes.index': 'project',
  'notes.toggleTask': 'project',
  'collection.list': 'project',
  'collection.put': 'project',
  'collection.delete': 'project',
  'export.render': 'export',
  'export.save': 'export',
  'export.viewer': 'export',
  'export.bundle': 'export',
} as const satisfies Record<Cmd, CommandArea>

// ---- push events ----------------------------------------------------------------------------

export type ToastLevel = 'info' | 'warn' | 'error'

/** Batched over EVT_CHANNEL. */
export type AppEvent =
  /** A project collection changed (views, scenarios, tables, solution sets, decisions). */
  | { kind: 'collection'; collection: CollectionKind }
  /** A note changed (path), or notes in general (null). */
  | { kind: 'notes'; path: string | null }
  | { kind: 'theme'; theme: ThemeState }
  | { kind: 'toast'; level: ToastLevel; message: string }
  /** An applied op batch: the renderer applies the same ops to its mirror (version must be its version + 1). */
  | {
      kind: 'model'
      version: number
      ops: Op[]
      source: ModelSource
      label: string
      history: HistoryState
      txId?: string
    }
  /** A project was opened (or the open one replaced): the renderer takes this view as is. */
  | { kind: 'project-opened'; project: ProjectView }
  | { kind: 'project-closed' }
  /** The project was written to disk (autosave or Ctrl+S); `error` when it could not be. */
  | { kind: 'saved'; at: number; error: string | null }
  /** An AI run's state (sent on every change except text deltas). */
  | { kind: 'ai-run'; run: AiRunView }
  | { kind: 'ai-text'; runId: string; delta: string }
  /** The run's draft as net ops from the model it started from (the canvas overlays them live). */
  | { kind: 'ai-draft'; runId: string; ops: Op[] }
  | { kind: 'ai-highlight'; runId: string; nodeIds: string[]; note: string | null }
  | { kind: 'proposal'; proposal: Proposal }

export type AppEventKind = AppEvent['kind']
export type AppEventOf<K extends AppEventKind> = Extract<AppEvent, { kind: K }>

/** `window.harpoon`, exposed by the preload. */
export interface HarpoonApi {
  invoke<C extends Cmd>(cmd: C, ...args: InvokeArgs<C>): Promise<Result<Res<C>>>
  subscribe(cb: (batch: AppEvent[]) => void): () => void
  readonly platform: Platform
  /** Applied before createRoot so the first paint matches main's backgroundColor. */
  readonly initialTheme: ThemeState
}
