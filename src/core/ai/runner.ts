// AI runs: a conversation with Claude Code or Codex about the open project. Each pass starts the CLI read-only in
// the project folder with Harpoon's MCP server attached (a fresh route and token per run); the agent stages changes
// into the run's draft through the tools; when a pass ends with changes, they become a proposal for review.
// Follow-up messages resume the same CLI session against the same draft.
import { withoutNotes } from '../../shared/model/governance.ts'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { resolveRepos } from '../project/repos.ts'
import type { RunHandle } from '../adapters/types.ts'
import type { EventBus } from '../bus.ts'
import { HarpoonError } from '../errors.ts'
import type { Logger } from '../log.ts'
import type { ProjectManager } from '../project/manager.ts'
import { isEmptySummary, summaryCounts } from '../../shared/model/diff.ts'
import { newRequestId } from '../../shared/ids.ts'
import type { AiActivity, AiRunView, AiSelection, AiStartRequest, AiVendor } from '../../shared/ipc.ts'
import type { NormalizedEvent } from '../../shared/events.ts'
import { Draft, switchableDraft } from './draft.ts'
import { testRule } from '../../shared/model/rules.ts'
import { MEETING_TEMPLATE, createEntry, notesIndex, readNote, writeNote } from '../project/notes.ts'
import { checkNotionServer, claudeUserServer, getPublish, logPublish } from '../project/publish.ts'
import { isClaudeAiConnector } from '../adapters/claude/launch.ts'
import { notionSections } from '../export/notion.ts'
import type { NoteDoc } from '../../shared/ipc.ts'
import type { NoteAction, NoteItemKind } from '../../shared/ipc.ts'
import type { DecisionDraft, SolutionsSubmit } from './tools.ts'
import { listCollection, putCollection } from '../project/collections.ts'
import type { AiContext, DecisionRecord, SolutionSet } from '../../shared/ipc.ts'
import type { Model } from '../../shared/model/schema.ts'
import { MCP_SERVER_NAME, MCP_TOKEN_ENV } from './mcp-host.ts'
import type { McpHost, McpRoute } from './mcp-host.ts'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SYSTEM_BRIEF, firstPrompt } from './prompts.ts'
import type { ProposalStore } from './proposals.ts'
import type { Providers } from './providers.ts'
import { registerTools } from './tools.ts'
import type { ToolContext } from './tools.ts'
import { userCodexMcpServers } from './codex-isolation.ts'
import { applySeed } from '../ingest/apply-seed.ts'
import { seedRepository } from '../ingest/seed.ts'
import { checkUserTools } from './user-tools.ts'

interface OptionState {
  key: string
  title: string
  approach: string
  draft: Draft
}

interface RunState {
  view: AiRunView
  /** The working draft (solutions mode: whichever option is active). */
  draft: Draft
  /** The model the run started from. */
  base: Model
  context: AiContext
  options: OptionState[]
  active: number
  solutions: SolutionsSubmit | null
  decision: DecisionDraft | null
  /** publish mode: the pages written and the changelog. */
  published?: { pages: Record<string, string>; summary: string }
  /** publish mode: the user's Notion MCP server the pass may use. */
  allowServers?: string[]
  /** notes mode: what the agent produced. */
  note: { summary?: string; items?: { kind: NoteItemKind; text: string; action: NoteAction }[]; agenda?: string }
  selection: AiSelection
  cwd: string
  /** The project's repos that are on this machine (the agent may read them all). */
  repos: { id: string; name: string; role: string; path: string }[]
  route: McpRoute | null
  configFile: string | null
  handles: Set<RunHandle>
  cancelled: boolean
  /** Harpoon tool calls so far (a pass that makes none never reached the tools). */
  harpoonCalls: number
  sessionId: string | undefined
  submitted: { title: string; rationale: string; risks: string | null } | null
  proposalSeq: number
  emitTimer: ReturnType<typeof setTimeout> | null
  draftTimer: ReturnType<typeof setTimeout> | null
}

const ASK_TIMEOUT_MS = 30_000
/** Import deep dives: at most this many services, this many CLIs at once. */
const DEEP_DIVE_MAX = 12
const DEEP_DIVE_PARALLEL = 3

export interface AiRunnerDeps {
  providers: Providers
  mcp: McpHost
  bus: EventBus
  log: Logger
  projects: ProjectManager
  proposals: ProposalStore
  runsDir: string
  /** Where this machine keeps a project's repos (repo id → path). */
  localRepoPaths: (projectId: string) => Readonly<Record<string, string>>
  /** The Notion MCP server this machine publishes through (null: none chosen). */
  notionServer: (projectId: string) => string | null
}

/** For the prompt: the user's own tools this conversation has, and what they are for. */
export function toolsNote(mode: string, tools: readonly string[]): string {
  if (mode === 'publish' || tools.length === 0) return ''
  return `

(For this conversation the user also turned on these of their own tools: ${tools.join(', ')}. Use them when the request calls for it, for example to create or update an issue, ticket or page about the plan, acting under the user's account. Put the plan's substance into what you create. Do not use them for anything the user did not ask, and never send secrets or credentials through them. Changes to the architecture still go through Harpoon's tools.)`
}

/** For the prompt: which repos the agent can read and how to cite files in them. */
export function repoBrief(root: string, repos: readonly { id: string; name: string; role: string; path: string }[]): string {
  if (repos.length === 0) return ''
  const lines = repos.map((r) => `- ${r.name} (repo id "${r.id}", ${r.role}): ${r.path}`)
  return `\n\nThis project spans several repositories; read them all (the project folder is ${root}):\n${lines.join('\n')}\nFor evidence from these repositories, set evidence.repo to the repo id and the path relative to that repository.`
}

export class AiRunner {
  readonly #runs = new Map<string, RunState>()
  #external: RunState | null = null
  #externalLastCall: number | null = null
  readonly #o: AiRunnerDeps

  constructor(o: AiRunnerDeps) {
    this.#o = o
  }

  list(): AiRunView[] {
    return [...this.#runs.values()].map((r) => r.view).sort((a, b) => b.createdAt - a.createdAt)
  }

  async start(req: AiStartRequest): Promise<AiRunView> {
    const session = this.#o.projects.require()
    const meta = session.model.meta
    const resolved = await resolveRepos(session.root, meta.repos, this.#o.localRepoPaths(meta.id))
    // Import: only the repositories the user picked (absent or empty: all of them).
    const picked = req.mode === 'import' && req.context?.repoIds !== undefined && req.context.repoIds.length > 0 ? new Set(req.context.repoIds) : null
    const repos = resolved.flatMap((r) => {
      const ref = meta.repos.find((x) => x.id === r.id)
      if (picked !== null && !picked.has(r.id)) return []
      return r.path === null || ref === undefined ? [] : [{ id: r.id, name: ref.name, role: ref.role, path: r.path }]
    })
    // The user's own tools picked for this conversation (Linear, GitHub…), checked against what the CLI has.
    const tools = req.mode === 'publish' ? [] : await checkUserTools(req.vendor, req.tools ?? []).catch((err: unknown) => {
      throw new HarpoonError('VALIDATION', err instanceof Error ? err.message : String(err))
    })
    const id = newRequestId('ai')
    const state: RunState = {
      view: {
        id,
        vendor: req.vendor,
        model: req.model ?? null,
        effort: req.effort ?? null,
        external: false,
        tools,
        mode: req.mode,
        status: 'starting',
        title: req.prompt.trim().split('\n')[0]?.slice(0, 80) || defaultTitle(req.mode),
        createdAt: Date.now(),
        turns: [{ role: 'user', text: req.prompt.trim() }],
        activity: [],
        usage: null,
        proposalId: null,
        error: null,
        changeCount: 0,
        phase: null,
        questions: null,
        solutionSetId: req.context?.solutionSetId ?? null,
        decisionId: req.context?.decisionId ?? null,
        options: [],
        activeOption: null,
        suggestions: req.mode === 'scan' ? { summary: '', rules: [], guidelines: [] } : null,
        notePath: req.context?.notePath ?? null,
      },
      draft: new Draft(session.model),
      base: session.model,
      context: req.context ?? {},
      options: [],
      active: -1,
      solutions: null,
      decision: null,
      note: {},
      selection: req.selection,
      cwd: session.root,
      repos,
      route: null,
      configFile: null,
      handles: new Set(),
      cancelled: false,
      harpoonCalls: 0,
      sessionId: undefined,
      submitted: null,
      proposalSeq: 0,
      emitTimer: null,
      draftTimer: null,
    }
    if (tools.length > 0) state.allowServers = tools
    if (req.mode === 'publish') {
      // Publishing writes outside the machine, so it runs with Claude, whose tools can be limited to Harpoon's and
      // Notion's (Codex can still read the disk through its shell).
      if (req.vendor !== 'claude') throw new HarpoonError('UNSUPPORTED', 'Publishing to Notion runs with Claude Code. Switch the AI panel to Claude Code.')
      const pub = await getPublish(session.root)
      if (pub.notion.pageUrl.trim() === '') throw new HarpoonError('VALIDATION', 'Set the Notion page to publish to first (Project settings → Notion).')
      const server = this.#o.notionServer(meta.id)
      if (server === null || server.trim() === '') throw new HarpoonError('VALIDATION', 'Pick the Notion MCP server your CLI uses (Project settings → Notion).')
      await checkNotionServer(server)
      state.allowServers = [server]
    }
    if (req.mode === 'solutions') {
      // One draft per option; with none active, tools read the starting model and writes are refused.
      const idle = new Draft(session.model)
      state.draft = switchableDraft(() => state.options[state.active]?.draft ?? idle)
      if (req.context?.solutionSetId !== undefined) await this.#loadOptions(state, req.context.solutionSetId)
    }
    this.#runs.set(id, state)
    this.#emit(state, true)
    const prompt = firstPrompt({ mode: req.mode, prompt: req.prompt, selection: req.selection, model: session.model }) + repoBrief(session.root, repos)
    const missing = resolved.filter((r) => r.path === null && (picked === null || picked.has(r.id))).map((r) => meta.repos.find((x) => x.id === r.id)?.name ?? r.id)
    if (missing.length > 0) this.#activity(state, 'repos', `Not cloned on this machine, so not read: ${missing.join(', ')} (locate them in Project settings)`, 'failed')
    void this.#job(state, prompt, false)
    return state.view
  }

  /**
   * Outside agents (Settings → AI → Outside agents): each MCP request registers the plan tools against one shared run
   * for the open project. Their changes go to a draft like any run's; each submit_proposal saves a proposal to review
   * here and starts a fresh draft from the diagram as it is then.
   */
  registerExternal(server: McpServer): void {
    const session = this.#o.projects.session
    if (session === null) {
      server.registerTool('get_overview', { description: 'The open Harpoon project (none is open right now).' }, () => ({
        isError: true,
        content: [{ type: 'text' as const, text: 'No project is open in Harpoon. Ask the user to open one, then try again.' }],
      }))
      return
    }
    let s = this.#external
    if (s === null || s.cwd !== session.root || s.view.status === 'cancelled') s = this.#newExternal()
    // Nothing staged yet: follow the diagram as the user edits it.
    else if (s.draft.proposalOps().length === 0 && s.base !== session.model) {
      s.base = session.model
      s.draft = new Draft(session.model)
    }
    this.#externalLastCall = Date.now()
    const run = s
    const ctx = this.#toolContext(run)
    registerTools(server, {
      ...ctx,
      onSubmit: (sub) => {
        run.submitted = sub
        run.view.title = sub.title
        void this.#finishExternal(run)
      },
      onAsk: () => {
        throw new HarpoonError('UNSUPPORTED', 'Harpoon cannot pass questions on from outside agents; ask your user directly, then continue.')
      },
    })
  }

  get externalLastCall(): number | null {
    return this.#externalLastCall
  }

  #newExternal(): RunState {
    const session = this.#o.projects.require()
    const id = newRequestId('ext')
    const s: RunState = {
      view: {
        id,
        vendor: 'claude',
        model: null,
        effort: null,
        external: true,
        tools: [],
        mode: 'plan',
        status: 'running',
        title: 'Outside agent',
        createdAt: Date.now(),
        turns: [],
        activity: [],
        usage: null,
        proposalId: null,
        error: null,
        changeCount: 0,
        phase: 'Connected over MCP',
        questions: null,
        solutionSetId: null,
        decisionId: null,
        options: [],
        activeOption: null,
        suggestions: null,
        notePath: null,
      },
      draft: new Draft(session.model),
      base: session.model,
      context: {},
      options: [],
      active: -1,
      solutions: null,
      decision: null,
      note: {},
      selection: { nodeIds: [], connectorIds: [], focusId: null },
      cwd: session.root,
      repos: [],
      route: null,
      configFile: null,
      handles: new Set(),
      cancelled: false,
      harpoonCalls: 0,
      sessionId: undefined,
      submitted: null,
      proposalSeq: 0,
      emitTimer: null,
      draftTimer: null,
    }
    this.#external = s
    this.#runs.set(id, s)
    this.#emit(s, true)
    return s
  }

  /** An outside agent submitted: save the proposal, then start over from the diagram as it is now. */
  async #finishExternal(s: RunState): Promise<void> {
    try {
      s.view.proposalId = null
      await this.#finish(s)
      if (s.view.proposalId !== null) this.#activity(s, 'proposal', `Proposal ready to review: ${s.submitted?.title ?? 'changes'}`, 'ok')
    } catch (err) {
      this.#activity(s, 'proposal', `Could not save the proposal: ${err instanceof Error ? err.message : String(err)}`, 'failed')
    }
    const model = this.#o.projects.session?.model
    if (model !== undefined) {
      s.base = model
      s.draft = new Draft(model)
    }
    s.submitted = null
    this.#draftChanged(s)
    this.#emit(s, true)
  }

  async send(runId: string, prompt: string, tools?: string[]): Promise<AiRunView> {
    const s = this.#runs.get(runId)
    if (s === undefined) throw new HarpoonError('NOT_FOUND', 'That conversation is gone.')
    if (s.view.status === 'running' || s.view.status === 'starting') throw new HarpoonError('CONFLICT', 'Wait for the current answer first.')
    // A follow-up may bring tools the conversation did not have (accept a plan, then "create a Linear issue for it").
    if (tools !== undefined && s.view.mode !== 'publish') {
      const checked = await checkUserTools(s.view.vendor, tools).catch((err: unknown) => {
        throw new HarpoonError('VALIDATION', err instanceof Error ? err.message : String(err))
      })
      s.view.tools = checked
      if (checked.length > 0) s.allowServers = checked
      else delete s.allowServers
    }
    // After an accepted or discarded proposal, follow-ups start from the model as it is now.
    const pid = s.view.proposalId
    const p = pid === null ? undefined : this.#o.proposals.get(pid)
    if (p !== undefined && p.status !== 'pending' && s.view.mode !== 'solutions') {
      s.draft = new Draft(this.#o.projects.require().model)
      s.view.proposalId = null
      s.submitted = null
    }
    s.view.turns.push({ role: 'user', text: prompt.trim() })
    s.view.questions = null
    s.view.status = 'starting'
    s.view.error = null
    this.#emit(s, true)
    // Solutions: say which options exist, so "change B" lands on the right draft.
    const reminder =
      s.view.mode === 'solutions' && s.options.length > 0
        ? `

(Options so far: ${s.options.map((o) => `${o.key} "${o.title}"`).join(', ')}. Use select_option before editing one, then submit_solutions again.)`
        : ''
    void this.#job(s, prompt.trim() + reminder, s.sessionId !== undefined)
    return s.view
  }

  cancel(runId: string): void {
    const s = this.#runs.get(runId)
    if (s === undefined || s.handles.size === 0) return
    s.cancelled = true
    for (const h of s.handles) void this.#o.providers.adapter(s.view.vendor).stop(h, 'user')
    s.view.status = 'cancelled'
    s.view.phase = null
    this.#emit(s, true)
  }

  async shutdown(): Promise<void> {
    for (const s of this.#runs.values()) {
      for (const h of s.handles) await this.#o.providers.adapter(s.view.vendor).stop(h, 'shutdown').catch(() => undefined)
      s.route?.close()
    }
  }

  /** One job: open the run's MCP route, run its pass(es), then turn the draft into a proposal. */
  async #job(s: RunState, prompt: string, resume: boolean): Promise<void> {
    const v = s.view
    s.cancelled = false
    try {
      await this.#openRoute(s)
      if (v.mode === 'import' && !resume) await this.#importJob(s, prompt)
      else {
        v.phase = null
        await this.#runPass(s, { prompt, resume, quiet: false, label: null })
      }
      if (v.status === 'running' || v.status === 'starting') v.status = v.error !== null ? 'failed' : 'done'
    } catch (err) {
      v.status = 'failed'
      v.error = err instanceof Error ? err.message : String(err)
      this.#o.log.warn('ai job failed', { runId: v.id, err: v.error })
    } finally {
      v.phase = null
      s.route?.close()
      s.route = null
      // The per-run MCP config (no token in it, but no reason to keep it either).
      if (s.configFile !== null) await rm(dirname(s.configFile), { recursive: true, force: true }).catch(() => undefined)
      s.configFile = null
      const last = v.turns.at(-1)
      if (last?.role === 'assistant' && last.text.trim() === '') v.turns.pop()
      // Saving the result can fail (a file, a stale note); report it on the run, never as an unhandled error.
      try {
        await this.#finish(s)
      } catch (err) {
        v.status = 'failed'
        v.error = `Could not save the result: ${err instanceof Error ? err.message : String(err)}`
        this.#o.log.warn('ai finish failed', { runId: v.id, err: v.error })
      }
      this.#emit(s, true)
    }
  }

  /** What the MCP tools may do for a run: read and stage into its draft, and report back to it. */
  #toolContext(s: RunState): ToolContext {
    const v = s.view
    return {
      draft: s.draft,
      mode: v.mode,
      ...(s.context.noteTask !== undefined ? { noteTask: s.context.noteTask } : {}),
      options: () => ({ keys: s.options.map((o) => ({ key: o.key, title: o.title })), active: s.options[s.active]?.key ?? null }),
      onBeginOption: (title, approach) => {
        const key = String.fromCharCode(65 + s.options.length)
        s.options.push({ key, title, approach, draft: new Draft(s.base) })
        s.active = s.options.length - 1
        this.#syncOptions(s)
        return key
      },
      onSelectOption: (key) => {
        const i = s.options.findIndex((o) => o.key === key)
        if (i < 0) throw new HarpoonError('VALIDATION', `No option ${key}; the options are ${s.options.map((o) => o.key).join(', ') || 'none yet'}.`)
        s.active = i
        this.#syncOptions(s)
        this.#draftChanged(s)
      },
      onSubmitSolutions: (sub) => {
        s.solutions = sub
        for (const o of sub.options) {
          const opt = s.options.find((x) => x.key === o.key)
          if (opt !== undefined && o.title !== undefined && o.title.trim() !== '') opt.title = o.title
        }
        v.title = sub.problem.split('\n')[0]?.slice(0, 80) ?? v.title
        this.#syncOptions(s)
      },
      onSuggestRule: (rule, rationale, evidence) => {
        const res = testRule(s.base, rule)
        const violations = res.violations.map((x) => ({ id: x.id, name: s.base.nodes[x.id]?.name ?? x.message }))
        const sug = v.suggestions
        if (sug !== null) {
          sug.rules = [...sug.rules.filter((x) => x.rule.id !== rule.id), { rule, rationale, evidence, applies: res.applies, violations }]
          this.#emit(s, true)
        }
        return { applies: res.applies, violations }
      },
      onSuggestGuideline: (g) => {
        if (v.suggestions === null) return
        v.suggestions.guidelines = [...v.suggestions.guidelines.filter((x) => x.title !== g.title), g]
        this.#emit(s, true)
      },
      onSubmitScan: (summary) => {
        if (v.suggestions !== null) v.suggestions.summary = summary
        v.title = 'Pattern scan'
        this.#emit(s, true)
      },
      publishPages: async () => {
        const root = this.#o.projects.require().root
        const pub = await getPublish(root)
        const decisions = await listCollection(root, 'decisions')
        let notes: NoteDoc[] | null = null
        if (pub.notion.includeNotes) {
          const idx = await notesIndex(root)
          const paths = [...(idx.project !== null ? ['project.md'] : []), ...idx.series.flatMap((x) => x.entries.map((e) => e.path))]
          notes = (await Promise.all(paths.map((p) => readNote(root, p).catch(() => null)))).filter((d): d is NoteDoc => d !== null)
        }
        const model = this.#o.projects.require().model
        const sections = notionSections({ model: pub.notion.includeNotes ? model : withoutNotes(model), decisions, notes, diagram: null, bundle: null, date: new Date().toISOString().slice(0, 10) })
        return { targetPage: pub.notion.pageUrl, sections: sections.map((x) => ({ ...x, pageId: pub.notion.pages[x.key] ?? null })), lastPublish: pub.notion.log[0] ?? null }
      },
      onRecordPublish: (pages, summary) => {
        s.published = { pages, summary }
        v.title = 'Published to Notion'
      },
      onNoteSummary: (summary) => {
        s.note = { ...s.note, summary }
      },
      onNoteItems: (items) => {
        s.note = { ...s.note, items }
      },
      onNoteAgenda: (agenda) => {
        s.note = { ...s.note, agenda }
      },
      onDraftDecision: (dd) => {
        s.decision = dd
        v.title = dd.title
      },
      runId: v.id,
      provenance: v.mode === 'import' ? 'ai-import' : 'ai-plan',
      selection: s.selection,
      onChange: () => this.#draftChanged(s),
      onHighlight: (nodeIds, note) => this.#o.bus.emit({ kind: 'ai-highlight', runId: v.id, nodeIds, note }),
      onSubmit: (sub) => {
        // The first submission names the proposal (later deep-dive passes only add to it).
        if (s.submitted === null) {
          s.submitted = sub
          v.title = sub.title
        } else if (sub.rationale.trim() !== '') s.submitted = { ...s.submitted, rationale: `${s.submitted.rationale}\n\n${sub.rationale}` }
      },
      onAsk: (questions) => {
        v.questions = questions
        this.#emit(s, true)
      },
      onActivity: (a) => {
        s.harpoonCalls++
        this.#activity(s, a.tool, a.summary, a.ok ? 'ok' : 'failed')
        if (!a.ok) this.#o.log.info('tool refused', { runId: v.id, tool: a.tool, why: a.summary })
      },
    }
  }

  async #openRoute(s: RunState): Promise<void> {
    const v = s.view
    const route = await this.#o.mcp.open(v.id, (server) => registerTools(server, this.#toolContext(s)))
    s.route = route
    const dir = join(this.#o.runsDir, v.id)
    await mkdir(dir, { recursive: true })
    s.configFile = join(dir, 'mcp.json')
    // The token is not in this file: Claude expands ${HARPOON_MCP_TOKEN} from the child's environment. A publish pass
    // also gets the chosen Notion server, copied from the user's config, so the CLI can stay on this file alone.
    const servers: Record<string, unknown> = { [MCP_SERVER_NAME]: { type: 'http', url: route.url, headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` } } }
    // Claude reads servers from this file only (strict), so the user's servers picked for the run are copied in. Codex
    // switches its own servers on or off by name instead (launch.ts).
    for (const name of v.vendor === 'claude' ? (s.allowServers ?? []) : []) {
      if (isClaudeAiConnector(name)) continue
      const cfg = await claudeUserServer(name)
      if (cfg === null) throw new HarpoonError('VALIDATION', `"${name}" is not a user-level MCP server in ~/.claude.json; add it with "claude mcp add --scope user", or use a claude.ai connector.`)
      servers[name] = cfg
    }
    await writeFile(s.configFile, JSON.stringify({ mcpServers: servers }), { mode: 0o600 })
  }

  /**
   * Import: a deterministic seed (compose, Kubernetes, manifests), one inventory pass that confirms and completes
   * the system map, then parallel deep dives into each service (inner parts, features, outbound calls), all into
   * the same draft.
   */
  async #importJob(s: RunState, prompt: string): Promise<void> {
    const v = s.view
    // What the user asked to bring in (or leave out) holds for every pass, deep dives included.
    const request = v.turns.find((t) => t.role === 'user')?.text.trim() ?? ''
    const scoped = request !== ''
    const scopeNote = scoped
      ? ` The user scoped this import: "${request.slice(0, 2000)}". Add only the parts of this service that fall within that scope (other responsibilities stay out); if none do, change nothing and say so.`
      : ''
    v.phase = 'Scanning infrastructure files'
    this.#emit(s, true)
    // The project folder, unless it is one of the linked repos anyway, then every linked repo on this machine.
    // Picked repositories leave the project folder out.
    const picked = (s.context.repoIds?.length ?? 0) > 0
    const targets: { dir: string; repoId: string | null; name: string }[] = [
      ...(picked || s.repos.some((r) => resolve(r.path) === resolve(s.cwd)) ? [] : [{ dir: s.cwd, repoId: null, name: 'project folder' }]),
      ...s.repos.map((r) => ({ dir: r.path, repoId: r.id, name: r.name })),
    ]
    const found: string[] = []
    for (const t of targets) {
      const seed = await seedRepository(t.dir).catch(() => null)
      if (seed === null || seed.nodes.length === 0) continue
      const r = applySeed(s.draft, seed, v.id, t.repoId)
      this.#draftChanged(s)
      for (const n of seed.notes) this.#activity(s, 'scan', targets.length > 1 ? `${t.name}: ${n}` : n, 'ok')
      this.#activity(s, 'seed', `Staged ${r.added} components and ${r.links} links from ${targets.length > 1 ? `${t.name}'s ` : ''}infrastructure files`, 'ok')
      found.push(...seed.nodes.map((n) => `${n.name} [${n.kind}]${targets.length > 1 ? ` (${t.name})` : ''}`))
    }
    let seedNote = 'A deterministic scan found no docker-compose, Kubernetes or package manifests.'
    if (found.length > 0) {
      seedNote = `A deterministic scan of infrastructure files already staged these components in the draft (verify them; fix kinds, names and links; remove false ones${scoped ? ' and any outside the requested scope' : ''}): ${found.join(', ')}.`
    }
    if (this.#stopped(s)) return

    v.phase = 'Mapping the system'
    this.#emit(s, true)
    await this.#runPass(s, { prompt: `${prompt}\n\n${seedNote}\n\nIn this pass focus on the system map: deployables, data stores, brokers, external services, the links between them, and boundaries. Deeper per-service detail (inner components, full feature catalogs) follows in later passes, so keep each service brief here. Call submit_proposal when the map is complete.`, resume: false, quiet: false, label: null })
    if (this.#stopped(s)) return

    // Deep dives: every internal service the draft now has (cap, so a huge repo does not fan out without bound).
    const services = Object.values(s.draft.model.nodes)
      .filter((n) => n.parentId === null && n.boundary === 'internal' && (n.kind === 'service' || n.kind === 'worker' || n.kind === 'function' || n.kind === 'gateway'))
      .slice(0, DEEP_DIVE_MAX)
    let done = 0
    const queue = [...services]
    const worker = async (): Promise<void> => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
        if (this.#stopped(s)) return
        v.phase = `Deep dive ${done + 1}/${services.length}`
        this.#emit(s, true)
        const where = n.evidence
          .map((e) => {
            const repo = e.repo === null ? undefined : s.repos.find((r) => r.id === e.repo)
            return repo === undefined ? e.path : `${relative(s.cwd, join(repo.path, e.path)) || e.path} (repo ${repo.name})`
          })
          .slice(0, 5)
          .join(', ')
        await this.#runPass(s, {
          prompt: `${firstPrompt({ mode: 'document', prompt: '', selection: { nodeIds: [n.id], connectorIds: [], focusId: null }, model: s.draft.model })}${repoBrief(s.cwd, s.repos)}\n\nDeep dive into ONE service: ${n.name} (id ${n.id})${where !== '' ? `, found in ${where}` : ''}.${scopeNote} Read its code. Add its inner components as children (processes/modules, local database or cache, background workers, consumers), its features (routes/RPCs with endpoints and short contracts), and its outbound connections to other nodes already in the draft (with protocols). When a connection now starts or ends at one of its inner components, retarget the existing service-level connector to that component (update_connector source/target) instead of adding a duplicate. Do not restructure other services. Attach evidence. Call submit_proposal once with a one-line title for this service.`,
          resume: false,
          quiet: true,
          label: n.name,
        })
        done++
      }
    }
    await Promise.all(Array.from({ length: Math.min(DEEP_DIVE_PARALLEL, services.length) }, () => worker()))
  }

  #stopped(s: RunState): boolean {
    return s.cancelled || s.view.status === 'cancelled'
  }

  /** Run one CLI pass against the run's draft. Quiet passes (import deep dives) report only activity. */
  async #runPass(s: RunState, o: { prompt: string; resume: boolean; quiet: boolean; label: string | null }): Promise<void> {
    const v = s.view
    const route = s.route
    const configFile = s.configFile
    if (route === null || configFile === null) throw new HarpoonError('INTERNAL', 'MCP route not open.')
    const adapter = this.#o.providers.adapter(v.vendor)
    // The probe teaches the adapter the account's facts (Codex: which models it may run).
    await this.#o.providers.probe(v.vendor).catch(() => undefined)
    const handle = adapter.start({
      runId: v.id,
      step: 'design',
      cwd: s.cwd,
      readDirs: s.repos.map((r) => r.path).filter((p) => resolve(p) !== resolve(s.cwd)),
      prompt: o.prompt + toolsNote(v.mode, v.tools),
      ...(o.resume ? {} : { systemAppend: SYSTEM_BRIEF }),
      model: v.model,
      effort: v.effort,
      mode: 'readonly',
      planNative: false,
      allowRules: [],
      trustFolder: false,
      askTimeoutMs: ASK_TIMEOUT_MS,
      ephemeral: false,
      mcp: {
        name: MCP_SERVER_NAME,
        url: route.url,
        tokenEnv: MCP_TOKEN_ENV,
        configFile,
        ...(v.vendor === 'codex' ? { disable: userCodexMcpServers() } : {}),
        ...(s.allowServers !== undefined ? { allow: s.allowServers } : {}),
        readCode: v.mode !== 'publish',
      },
      env: { [MCP_TOKEN_ENV]: route.token },
      ...(o.resume && s.sessionId !== undefined ? { resume: { sessionId: s.sessionId } } : {}),
    })
    s.handles.add(handle)
    v.status = 'running'
    if (!o.quiet) v.turns.push({ role: 'assistant', text: '' })
    const passId = o.label !== null ? this.#activity(s, 'pass', `${o.label}: working`, 'running') : null
    this.#emit(s, true)
    // Set from the event callback (TS cannot see that, so widen it explicitly).
    let fatal = null as string | null
    const toolCallsBefore = s.harpoonCalls
    handle.onEvent((e) => {
      if (e.type === 'error' && e.fatal) fatal = e.message
      this.#onEvent(s, e, handle, o.quiet)
    })
    // Claude reports its MCP servers in its init frame; a failed connection would otherwise end "successfully" with
    // an answer that never touched the diagram.
    handle.onSignal((sig) => {
      if (sig.type !== 'meta' || sig.key !== 'mcp_servers' || !Array.isArray(sig.value)) return
      const ours = (sig.value as { name?: unknown; status?: unknown }[]).find((x) => x.name === MCP_SERVER_NAME)
      if (ours !== undefined && ours.status !== 'connected') {
        fatal = `Claude could not connect to Harpoon's tools (MCP status: ${String(ours.status)}). Check that nothing blocks loopback connections, then try again.`
        void this.#o.providers.adapter(v.vendor).stop(handle, 'user')
      }
    })
    await handle.exited
    // Any CLI: a pass that should have used the diagram tools but never reached them.
    if (fatal === null && s.harpoonCalls === toolCallsBefore && !s.cancelled && v.mode !== 'explain') {
      fatal = `${v.vendor === 'claude' ? 'Claude' : 'Codex'} finished without using Harpoon's tools, so nothing was staged. It may not have connected to them; try again, or check the CLI's MCP settings.`
    }
    s.handles.delete(handle)
    if (!o.quiet) s.sessionId = handle.sessionId() ?? s.sessionId
    if (passId !== null) {
      const a = v.activity.find((x) => x.id === passId)
      if (a !== undefined) {
        a.summary = `${o.label}: ${fatal === null ? 'done' : `failed (${fatal})`}`
        a.status = fatal === null ? 'ok' : 'failed'
      }
      this.#emit(s, false)
    } else if (fatal !== null) v.error = fatal
  }

  /** Log an activity row; returns its id so a long step can update it in place. */
  #activity(s: RunState, name: string, summary: string, status: AiActivity['status']): string {
    const v = s.view
    const id = `a${v.activity.length}-${Date.now()}`
    v.activity.push({ id, name, summary, status })
    if (v.activity.length > 600) v.activity.splice(0, v.activity.length - 600)
    this.#emit(s, false)
    return id
  }

  #onEvent(s: RunState, e: NormalizedEvent, handle: RunHandle, quiet: boolean): void {
    const v = s.view
    switch (e.type) {
      case 'session':
        if (!quiet) s.sessionId = e.id
        break
      case 'text': {
        if (quiet) return
        const last = v.turns.at(-1)
        if (last?.role === 'assistant') last.text += e.delta
        else v.turns.push({ role: 'assistant', text: e.delta })
        this.#o.bus.emit({ kind: 'ai-text', runId: v.id, delta: e.delta })
        return
      }
      case 'tool': {
        // Harpoon's own tools report themselves (onActivity); the CLI's tool-loading step is noise.
        if (/harpoon/i.test(e.name) || /^(mcp:)?harpoon[\s:/]/i.test(e.summary) || e.name === 'ToolSearch') return
        const id = e.id ?? `${e.name}-${v.activity.length}`
        const existing = v.activity.find((a) => a.id === id)
        const status: AiActivity['status'] = e.phase === 'end' ? (e.status === 'ok' || e.status === undefined ? 'ok' : 'failed') : 'running'
        if (existing !== undefined) {
          existing.status = status
          if (e.summary !== '') existing.summary = e.summary
        } else v.activity.push({ id, name: e.name, summary: e.summary, status })
        if (v.activity.length > 600) v.activity.splice(0, v.activity.length - 600)
        break
      }
      case 'ask':
        // Read-only passes never need permission; refuse anything that asks.
        this.#o.providers.adapter(v.vendor).answer(handle, e.requestId, 'deny')
        break
      case 'done':
        if (e.usage !== undefined) {
          const prev = v.usage ?? { input: 0, output: 0, costUsd: null }
          v.usage = {
            input: prev.input + e.usage.input,
            output: prev.output + e.usage.output,
            costUsd: e.usage.costUsd === undefined ? prev.costUsd : (prev.costUsd ?? 0) + e.usage.costUsd,
          }
        }
        break
      case 'error':
        break
    }
    this.#emit(s, false)
  }

  #draftChanged(s: RunState): void {
    const sum = s.draft.summary()
    const c = summaryCounts(sum)
    s.view.changeCount = c.added + c.modified + c.removed
    if (s.view.mode === 'solutions') {
      const o = s.options[s.active]
      const row = s.view.options.find((x) => x.key === o?.key)
      if (row !== undefined) row.changes = s.view.changeCount
    }
    if (s.draftTimer !== null) return
    s.draftTimer = setTimeout(() => {
      s.draftTimer = null
      this.#o.bus.emit({ kind: 'ai-draft', runId: s.view.id, ops: s.draft.proposalOps() })
      this.#emit(s, true)
    }, 120)
  }

  #syncOptions(s: RunState): void {
    s.view.options = s.options.map((o) => {
      const c = summaryCounts(o.draft.summary())
      return { key: o.key, title: o.title, changes: c.added + c.modified + c.removed }
    })
    s.view.activeOption = s.options[s.active]?.key ?? null
    this.#emit(s, true)
  }

  /** Refining an existing comparison: its options become this run's drafts again. */
  async #loadOptions(s: RunState, setId: string): Promise<void> {
    const root = this.#o.projects.require().root
    const set = (await listCollection(root, 'solutions')).find((x) => x.id === setId)
    if (set === undefined) return
    for (const pid of set.options) {
      const p = this.#o.proposals.get(pid)
      if (p === undefined || p.option === null) continue
      const draft = new Draft(s.base)
      try {
        draft.apply(p.ops)
      } catch {
        // an option that no longer applies starts empty; the agent can rebuild it
      }
      s.options.push({ key: p.option.key, title: p.title, approach: p.option.summary, draft })
    }
    s.active = s.options.length > 0 ? 0 : -1
    this.#syncOptions(s)
  }

  /** solutions mode: each option becomes a proposal; together they form a solution set to compare. */
  async #finishSolutions(s: RunState): Promise<void> {
    const v = s.view
    if (s.options.length === 0) return
    const root = this.#o.projects.require().root
    const setId = v.solutionSetId ?? `s-${v.id}`
    const sub = s.solutions
    const firstUser = v.turns.find((t) => t.role === 'user')?.text ?? ''
    const proposalIds: string[] = []
    for (const o of s.options) {
      o.draft.settlePlacement()
      const info = sub?.options.find((x) => x.key === o.key)
      const id = `p-${setId}-${o.key.toLowerCase()}`
      proposalIds.push(id)
      const existing = this.#o.proposals.get(id)
      await this.#o.proposals.put({
        id,
        runId: v.id,
        title: o.title,
        rationale: info?.summary ?? o.approach,
        risks: info?.risks ?? null,
        vendor: v.vendor,
        mode: v.mode,
        prompt: firstUser,
        createdAt: existing?.createdAt ?? Date.now(),
        status: existing?.status ?? 'pending',
        ops: o.draft.proposalOps(),
        option: { solutionSetId: setId, key: o.key, summary: info?.summary ?? o.approach, pros: info?.pros ?? [], cons: info?.cons ?? [], effort: info?.effort ?? null },
      })
    }
    const prev = (await listCollection(root, 'solutions')).find((x) => x.id === setId)
    const critId = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'criterion'
    const keyToId = new Map(s.options.map((o, i) => [o.key, proposalIds[i] ?? '']))
    const set: SolutionSet = {
      id: setId,
      title: prev?.title ?? v.title,
      problem: sub?.problem ?? prev?.problem ?? firstUser,
      constraints: sub?.constraints ?? prev?.constraints ?? '',
      criteria: sub !== null ? sub.criteria.map((c) => ({ id: critId(c.name), name: c.name, weight: c.weight })) : (prev?.criteria ?? []),
      options: proposalIds,
      scores:
        sub !== null
          ? sub.options.flatMap((o) => o.scores.map((sc) => ({ option: keyToId.get(o.key) ?? '', criterion: critId(sc.criterion), score: sc.score, note: sc.note })).filter((x) => x.option !== ''))
          : (prev?.scores ?? []),
      recommendation: sub?.recommendation != null ? { option: keyToId.get(sub.recommendation.key) ?? '', why: sub.recommendation.why } : (prev?.recommendation ?? null),
      status: prev?.status ?? 'open',
      chosen: prev?.chosen ?? null,
      decisionId: prev?.decisionId ?? null,
      runId: v.id,
      createdAt: prev?.createdAt ?? Date.now(),
      source: prev?.source ?? s.context.source ?? null,
    }
    await putCollection(root, 'solutions', set)
    v.solutionSetId = setId
    this.#o.bus.emit({ kind: 'collection', collection: 'solutions' })
  }

  /** decision mode: the drafted record (a new ADR, or a redraft of the given one). */
  async #finishDecision(s: RunState): Promise<void> {
    const v = s.view
    const dd = s.decision
    if (dd === null) return
    const root = this.#o.projects.require().root
    const all = await listCollection(root, 'decisions')
    const prev = all.find((x) => x.id === (v.decisionId ?? ''))
    const number = prev?.number ?? all.reduce((n, x) => Math.max(n, x.number), 0) + 1
    const model = this.#o.projects.require().model
    const set = s.context.solutionSetId === undefined ? undefined : (await listCollection(root, 'solutions')).find((x) => x.id === s.context.solutionSetId)
    const rec: DecisionRecord = {
      id: prev?.id ?? `adr-${String(number).padStart(4, '0')}`,
      number,
      title: dd.title,
      status: prev?.status ?? (set?.chosen != null ? 'accepted' : 'proposed'),
      date: prev?.date ?? new Date().toISOString().slice(0, 10),
      deciders: dd.deciders.length > 0 ? dd.deciders : (prev?.deciders ?? []),
      context: dd.context,
      decision: dd.decision,
      consequences: dd.consequences,
      options: dd.options.map((o) => {
        const pid = set?.options.find((id) => this.#o.proposals.get(id)?.title.toLowerCase() === o.title.toLowerCase()) ?? null
        return { proposalId: pid, title: o.title, summary: o.summary, chosen: o.chosen, whyNot: o.whyNot }
      }),
      entityIds: dd.entityIds.filter((id) => model.nodes[id] !== undefined || model.connectors[id] !== undefined),
      phase: prev?.phase ?? null,
      supersedes: prev?.supersedes ?? null,
      supersededBy: prev?.supersededBy ?? null,
      solutionSetId: prev?.solutionSetId ?? s.context.solutionSetId ?? null,
      links: prev?.links ?? [],
      source: prev?.source ?? s.context.source ?? null,
      createdAt: prev?.createdAt ?? Date.now(),
    }
    await putCollection(root, 'decisions', rec)
    v.decisionId = rec.id
    if (set !== undefined && set.decisionId !== rec.id) {
      await putCollection(root, 'solutions', { ...set, decisionId: rec.id })
      this.#o.bus.emit({ kind: 'collection', collection: 'solutions' })
    }
    this.#o.bus.emit({ kind: 'collection', collection: 'decisions' })
  }

  /** notes mode: write the summary or items into the note, or create the next meeting with the agenda. */
  async #finishNotes(s: RunState): Promise<void> {
    const v = s.view
    const path = s.context.notePath
    if (path === undefined) return
    const root = this.#o.projects.require().root
    if (s.note.agenda !== undefined) {
      const seriesId = path.split('/')[0] ?? ''
      const date = new Date().toISOString().slice(0, 10)
      const body = `## Agenda\n${s.note.agenda.trim()}\n\n${MEETING_TEMPLATE.replace(/## Agenda\n- \n\n/, '')}`
      v.notePath = await createEntry(root, seriesId, { date, body, title: 'Next meeting' })
      this.#o.bus.emit({ kind: 'notes', path: null })
      return
    }
    if (s.note.summary === undefined && s.note.items === undefined) return
    const doc = await readNote(root, path)
    const meta = { ...doc.meta }
    if (s.note.summary !== undefined) meta.summary = s.note.summary
    if (s.note.items !== undefined) {
      // Keep what was already ticked off (same text), number the rest after the existing ones.
      const prev = new Map(doc.meta.items.map((i) => [i.text.trim().toLowerCase(), i]))
      let n = doc.meta.items.reduce((x, i) => Math.max(x, Number(i.id.replace(/\D/g, '')) || 0), 0)
      meta.items = s.note.items.map((i) => {
        const old = prev.get(i.text.trim().toLowerCase())
        return old !== undefined ? { ...old, kind: i.kind, action: i.action } : { id: `i${++n}`, kind: i.kind, text: i.text, action: i.action, done: false }
      })
    }
    await writeNote(root, path, meta, doc.body)
    this.#o.bus.emit({ kind: 'notes', path })
  }

  async #finish(s: RunState): Promise<void> {
    const v = s.view
    if (v.mode === 'publish') {
      if (s.published !== undefined) await logPublish(this.#o.projects.require().root, 'ai', s.published.summary, s.published.pages)
      return
    }
    if (v.mode === 'notes') return this.#finishNotes(s)
    if (v.mode === 'solutions') return this.#finishSolutions(s)
    if (v.mode === 'decision') return this.#finishDecision(s)
    s.draft.settlePlacement()
    if (isEmptySummary(s.draft.summary())) return
    const ops = s.draft.proposalOps()
    if (ops.length === 0) return
    let id = v.proposalId
    if (id === null) {
      s.proposalSeq++
      id = s.proposalSeq === 1 ? `p-${v.id}` : `p-${v.id}-${s.proposalSeq}`
      v.proposalId = id
    }
    const firstUser = v.turns.find((t) => t.role === 'user')?.text ?? ''
    await this.#o.proposals.put({
      id,
      runId: v.id,
      title: s.submitted?.title ?? v.title,
      rationale: s.submitted?.rationale ?? v.turns.filter((t) => t.role === 'assistant').at(-1)?.text.slice(0, 4000) ?? '',
      risks: s.submitted?.risks ?? null,
      vendor: v.vendor,
      mode: v.mode,
      prompt: firstUser,
      createdAt: Date.now(),
      status: 'pending',
      ops,
      option: null,
      source: s.context.source ?? null,
    })
    this.#o.bus.emit({ kind: 'ai-draft', runId: v.id, ops })
  }

  /** Push the run's view (status changes at once; streaming activity at most every 150 ms). */
  #emit(s: RunState, now: boolean): void {
    const send = (): void => {
      s.emitTimer = null
      this.#o.bus.emit({ kind: 'ai-run', run: structuredClone(s.view) })
    }
    if (now) {
      if (s.emitTimer !== null) clearTimeout(s.emitTimer)
      send()
      return
    }
    s.emitTimer ??= setTimeout(send, 150)
  }

  vendorOf(runId: string): AiVendor | undefined {
    return this.#runs.get(runId)?.view.vendor
  }
}

function defaultTitle(mode: AiStartRequest['mode']): string {
  return mode === 'import' ? 'Import repository' : mode === 'document' ? 'Document' : mode === 'drift' ? 'Drift check' : mode === 'explain' ? 'Question' : 'Plan'
}
