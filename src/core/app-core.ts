// The Electron-free core: owns the home folder, app state, the event bus and the command table. Main, the dev CLI
// and integration tests all drive it through `invoke`. Commands main answers itself (dialogs, theme, shell) never
// reach here (main/router.ts MAIN_COMMANDS).
import { getPublish, notionServers, setPublish } from './project/publish.ts'
import { createEntry, createSeries, deleteNote, notesIndex, notesTasksAndMentions, readNote, toggleTask, writeNote } from './project/notes.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { adrFilename, adrMarkdown } from '../shared/export/adr.ts'
import type { Cmd, Req, Res, Result } from '../shared/ipc.ts'
import { AppStateStore } from './app-state.ts'
import { EventBus } from './bus.ts'
import { HarpoonError, toResult } from './errors.ts'
import { ensureHome, homePaths } from './home.ts'
import type { HomePaths } from './home.ts'
import type { Logger } from './log.ts'
import { ProjectManager } from './project/manager.ts'
import { McpHost } from './ai/mcp-host.ts'
import { ExternalMcp } from './ai/external.ts'
import { listUserTools } from './ai/user-tools.ts'
import { ConversationStore } from './ai/conversations.ts'
import { installCodexPlugin, writeCodexMarketplace } from './ai/agent-setup.ts'
import type { BridgeCommand } from './ai/agent-setup.ts'
import { ProposalStore } from './ai/proposals.ts'
import { Providers } from './ai/providers.ts'
import { AiRunner } from './ai/runner.ts'
import { join } from 'node:path'
import { deleteCollection, listCollection, putCollection } from './project/collections.ts'
import { renderExport } from './export/index.ts'
import { discoverRepos, resolveRepos } from './project/repos.ts'

export interface CoreOptions {
  home: string
  log: Logger
  /** How to start the `--mcp` stdio bridge (the app's own executable); absent outside the app. */
  bridge?: BridgeCommand
}

export type CoreHandlers = { [C in Cmd]?: (req: Req<C>) => Promise<Res<C>> }

export interface Core {
  readonly paths: HomePaths
  readonly bus: EventBus
  readonly state: AppStateStore
  readonly log: Logger
  readonly projects: ProjectManager
  readonly ai: AiRunner
  invoke(cmd: Cmd, req: unknown): Promise<Result<unknown>>
  shutdown(): Promise<void>
}

export async function createCore(o: CoreOptions): Promise<Core> {
  const paths = homePaths(o.home)
  await ensureHome(paths)
  const bus = new EventBus()
  const state = new AppStateStore(paths.state)
  await state.load()

  const projects = new ProjectManager({ bus, log: o.log.child('project'), state })
  const proposals = new ProposalStore({ bus, log: o.log.child('proposals'), projects })
  const providers = new Providers({ probeCwd: join(paths.tmpDir, 'probe-cwd'), log: o.log.child('providers') })
  const mcp = new McpHost(o.log.child('mcp'))
  const ai = new AiRunner({ providers, mcp, bus, log: o.log.child('ai'), projects, proposals, runsDir: paths.runsDir, conversations: new ConversationStore(join(paths.home, 'conversations')), localRepoPaths: (id) => state.state.repoPaths[id] ?? {}, notionServer: (id) => state.state.notionServers[id] ?? null, implementSettings: () => state.state.implement, rememberImplement: async (p) => void (await state.patch({ implement: { ...state.state.implement, ...p } })) })
  const external = new ExternalMcp({ state, ai, log: o.log.child('external-mcp'), bridge: o.bridge ?? null })
  await external.start()
  bus.on((e) => {
    if (e.kind === 'project-opened') {
      void proposals.load(e.project.root)
      // The project's AI conversations from earlier sessions.
      void ai.loadHistory()
    }
    else if (e.kind === 'project-closed') void proposals.load(null)
  })

  const handlers: CoreHandlers = {
    'project.inspect': (r) => projects.inspect(r.dir),
    'project.create': (r) => projects.create(r.dir, r.name, r.template),
    'project.open': (r) => projects.open(r.dir),
    'project.close': () => projects.close(),
    'project.current': () => Promise.resolve(projects.session?.view() ?? null),
    'project.apply': (r) => Promise.resolve(projects.apply(r)),
    'project.undo': () => Promise.resolve(projects.require().undo()),
    'project.redo': () => Promise.resolve(projects.require().redo()),
    'project.step': (r) => Promise.resolve(projects.require().step(r.steps)),
    'project.save': () => projects.require().flush(),
    'project.recent': () => Promise.resolve(state.state.recentProjects),
    'project.forgetRecent': (r) => state.forgetRecent(r.path),
    'project.createLocal': (r) => projects.createLocal(r.name, r.template),
    'project.importFile': (r) => projects.importFile(r.path),
    'project.saveCopy': (r) => projects.saveCopy(r.dir),
    'repo.resolve': () => {
      const s = projects.require()
      return resolveRepos(s.root, s.model.meta.repos, state.state.repoPaths[s.model.meta.id] ?? {})
    },
    'repo.setLocalPath': async (r) => {
      const s = projects.require()
      const local = await state.setRepoPath(s.model.meta.id, r.repoId, r.path)
      return resolveRepos(s.root, s.model.meta.repos, local)
    },
    'repo.scan': (r) => discoverRepos(r.dir),
    'ai.providers': (r) => providers.views(r.force === true),
    'mcp.external.get': () => Promise.resolve(external.view()),
    'mcp.external.set': (r) => external.set(r),
    'mcp.external.codexPlugin': async (r) => {
      if (o.bridge === undefined) throw new HarpoonError('UNSUPPORTED', 'The Codex plugin needs the Harpoon app (it runs Harpoon --mcp).')
      return r.install ? installCodexPlugin(paths.home, o.bridge) : { dir: await writeCodexMarketplace(paths.home, o.bridge), steps: [] }
    },
    'ai.start': (r) => ai.start(r),
    'ai.send': (r) => ai.send(r.runId, r.prompt, r.tools),
    'ai.tools': (r) => listUserTools(r.force === true),
    'ai.delete': (r) => ai.remove(r.runId),
    'ai.clear': () => ai.clear(),
    'ai.cancel': (r) => Promise.resolve(ai.cancel(r.runId)),
    'ai.runs': () => Promise.resolve(ai.list()),
    'ai.savePlan': (r) => ai.savePlan(r),
    'ai.implement': (r) => ai.implement(r),
    'ai.answer': (r) => Promise.resolve(ai.answer(r.runId, r.requestId, r.decision)),
    'ai.removeWorktree': (r) => ai.removeWorktree(r.runId),
    'proposal.list': () => Promise.resolve(proposals.list()),
    'proposal.accept': (r) => proposals.accept(r.id, r.opIndexes, r.asPlanned === true, r.phase ?? null),
    'proposal.discard': (r) => proposals.discard(r.id),
    'proposal.setOption': (r) => proposals.setOption(r.id, r.option),
    'notes.list': () => notesIndex(projects.require().root),
    'notes.read': (r) => readNote(projects.require().root, r.path),
    'notes.write': async (r) => {
      await writeNote(projects.require().root, r.path, r.meta, r.body)
      bus.emit({ kind: 'notes', path: r.path })
    },
    'notes.delete': async (r) => {
      await deleteNote(projects.require().root, r.path)
      bus.emit({ kind: 'notes', path: null })
    },
    'notes.createSeries': async (r) => {
      const id = await createSeries(projects.require().root, r)
      bus.emit({ kind: 'notes', path: null })
      return id
    },
    'notes.createEntry': async (r) => {
      const path = await createEntry(projects.require().root, r.seriesId, { date: r.date, ...(r.title !== undefined ? { title: r.title } : {}) })
      bus.emit({ kind: 'notes', path: null })
      return path
    },
    'notes.index': () => notesTasksAndMentions(projects.require().root),
    'notes.toggleTask': async (r) => {
      await toggleTask(projects.require().root, r.path, r.line, r.done)
      bus.emit({ kind: 'notes', path: r.path })
    },
    // The Notion server is a per-machine choice (app state): a shared project file must not pick which of the user's
    // MCP servers a publish pass may use.
    'publish.get': async () => {
      const s = projects.require()
      const p = await getPublish(s.root)
      return { notion: { ...p.notion, server: state.state.notionServers[s.model.meta.id] ?? null } }
    },
    'publish.set': async (r) => {
      const s = projects.require()
      await state.setNotionServer(s.model.meta.id, r.notion.server)
      const saved = await setPublish(s.root, { notion: { ...r.notion, server: null } })
      return { notion: { ...saved.notion, server: r.notion.server } }
    },
    'notion.servers': () => notionServers(),
    'decision.exportAdrs': async () => {
      const s = projects.require()
      const all = await listCollection(s.root, 'decisions')
      const dir = join(s.root, 'docs', 'adr')
      await mkdir(dir, { recursive: true })
      for (const d of all) await writeFile(join(dir, adrFilename(d)), adrMarkdown(d, s.model, all), 'utf8')
      return { dir, count: all.length }
    },
    'collection.list': (r) => listCollection(projects.require().root, r.kind),
    'collection.put': (r) => putCollection(projects.require().root, r.kind, r.item),
    'collection.delete': (r) => deleteCollection(projects.require().root, r.kind, r.id),
    'export.render': async (r) => {
      const p = r.proposalId === undefined ? undefined : proposals.get(r.proposalId)
      if (r.proposalId !== undefined && p === undefined) throw new HarpoonError('NOT_FOUND', 'That proposal no longer exists.')
      const s = projects.require()
      const decisions = r.format === 'markdown' ? await listCollection(s.root, 'decisions') : []
      return renderExport(s.model, r.format, r.view, p, decisions)
    },
  }

  const invoke = (cmd: Cmd, req: unknown): Promise<Result<unknown>> =>
    toResult(() => {
      const h = handlers[cmd] as ((req: unknown) => Promise<unknown>) | undefined
      if (h === undefined) throw new HarpoonError('UNSUPPORTED', `${cmd} is not available in this build.`)
      return h(req)
    })

  return {
    paths,
    bus,
    state,
    log: o.log,
    projects,
    ai,
    invoke,
    shutdown: async () => {
      await ai.shutdown()
      await external.stop()
      await mcp.close()
      await projects.close(false)
    },
  }
}
