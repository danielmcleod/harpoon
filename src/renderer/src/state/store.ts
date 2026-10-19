// The renderer's single zustand store: app prefs, the open project's model mirror, and UI state (mode, selection,
// expanded nodes, focus). Mutations live in actions.ts; components read with selectors.
import { create } from 'zustand'
import type { AiMode, AiRunView, AiVendor, AppState, Proposal, ProjectView, ProviderView, ThemeState, ToastLevel } from '@shared/ipc.ts'
import type { Op } from '@shared/model/ops.ts'
import type { BlastDirection } from '@shared/model/queries.ts'

export type Mode = 'edit' | 'docs' | 'sim'

export type Selection =
  | { kind: 'node'; ids: string[] }
  | { kind: 'connector'; ids: string[] }
  | { kind: 'boundary'; ids: string[] }
  | null

export interface Toast {
  id: number
  level: ToastLevel
  message: string
}

export interface UiState {
  mode: Mode
  selection: Selection
  /** The feature open in the inspector's detail column. */
  featureId: string | null
  /** Nodes drawn expanded in place. */
  expanded: Record<string, true>
  /** Focused subgraph (null: the whole system). */
  focusId: string | null
  blast: { id: string; dir: BlastDirection; hops: number } | null
  leftCollapsed: boolean
  rightCollapsed: boolean
  aiOpen: boolean
  search: string
  /** The flow shown on the canvas (its connectors emphasized). */
  flowId: string | null
  /** Connect mode: the node a new connector starts from; the next node clicked is its target. */
  connectFrom: string | null
  /** Lens: colour nodes by status, team, data or phase; legend keys in `hidden` dim (null: lens off). */
  lens: { kind: 'status' | 'team' | 'data' | 'phase'; hidden: string[] } | null
  /** The diagram, the tables, both (tables under the diagram), or the roadmap board. */
  view: 'canvas' | 'tables' | 'split' | 'roadmap' | 'decisions' | 'notes'
  /** Notes view: the open note path ('@tasks': open action items; null: none). */
  note: string | null
  /** Decisions view: the comparison or decision record open (null: the list only). */
  records: { kind: 'set' | 'decision'; id: string } | null
  /** Roadmap: the phase whose end state the canvas shows (null: today). */
  asOf: string | null
  /** Project settings dialog: the open tab (null: closed). */
  settings: 'general' | 'repos' | 'teams' | 'phases' | 'data' | 'rules' | 'notion' | 'ai' | null
  /** Help dialog: the open topic (null: closed). */
  help: 'start' | 'diagram' | 'views' | 'ai' | 'rules' | 'saving' | 'keys' | null
  /** Bumped to ask the canvas to fit the view (after open, focus change). */
  fitNonce: number
  /** Bumped with a node id to ask the canvas to centre on it. */
  centerOn: { id: string; nonce: number } | null
}

export interface AiState {
  providers: ProviderView[] | null
  vendor: AiVendor
  model: string | null
  /** Reasoning effort for new runs (null: the CLI's default). */
  effort: string | null
  /** Import: the linked repositories to read (null: all of them). */
  importRepos: string[] | null
  mode: AiMode
  runs: Record<string, AiRunView>
  activeRunId: string | null
  /** Live draft ops per run (net change from the model the run started from). */
  drafts: Record<string, Op[]>
  highlight: { runId: string; nodeIds: string[]; note: string | null } | null
  proposals: Record<string, Proposal>
  /** What the canvas shows as a diff overlay: a proposal, or a run's live draft. */
  review: { kind: 'proposal'; id: string } | { kind: 'draft'; runId: string } | null
  /** Ops of the reviewed proposal the user unticked. */
  excluded: Record<number, true>
}

export interface SaveState {
  status: 'saved' | 'saving' | 'error'
  at: number | null
  error: string | null
}

export interface StoreState {
  ready: boolean
  save: SaveState
  theme: ThemeState
  prefs: AppState
  project: ProjectView | null
  ui: UiState
  ai: AiState
  toasts: Toast[]
}

export const INITIAL_AI: AiState = {
  providers: null,
  vendor: 'claude',
  model: null,
  effort: null,
  importRepos: null,
  mode: 'plan',
  runs: {},
  activeRunId: null,
  drafts: {},
  highlight: null,
  proposals: {},
  review: null,
  excluded: {},
}

export const INITIAL_UI: UiState = {
  mode: 'edit',
  selection: null,
  featureId: null,
  expanded: {},
  focusId: null,
  blast: null,
  leftCollapsed: false,
  rightCollapsed: false,
  aiOpen: false,
  search: '',
  flowId: null,
  connectFrom: null,
  lens: null,
  settings: null,
  help: null,
  view: 'canvas',
  asOf: null,
  records: null,
  note: null,
  fitNonce: 0,
  centerOn: null,
}

export const useStore = create<StoreState>(() => ({
  ready: false,
  save: { status: 'saved', at: null, error: null },
  theme: { theme: 'dark', resolved: 'dark' },
  prefs: { schemaVersion: 1, theme: 'dark', nodeStyle: 'flat', recentProjects: [], repoPaths: {}, designsDir: '', notionServers: {}, ai: { vendor: null, claude: { model: null, effort: null }, codex: { model: null, effort: null } }, externalMcp: { enabled: false, port: 47821, token: null } },
  project: null,
  ui: INITIAL_UI,
  ai: INITIAL_AI,
  toasts: [],
}))

export const getState = useStore.getState
export const setState = useStore.setState

/** Merge into ai. */
export function setAi(patch: Partial<AiState> | ((ai: AiState) => Partial<AiState>)): void {
  setState((s) => ({ ai: { ...s.ai, ...(typeof patch === 'function' ? patch(s.ai) : patch) } }))
}

/** Merge into ui. */
export function setUi(patch: Partial<UiState> | ((ui: UiState) => Partial<UiState>)): void {
  setState((s) => ({ ui: { ...s.ui, ...(typeof patch === 'function' ? patch(s.ui) : patch) } }))
}
