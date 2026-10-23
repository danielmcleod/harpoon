// In-app help: short topic pages and the keyboard shortcuts, opened from the view rail, the welcome screen, `?` or F1.
import { Dialog } from 'radix-ui'
import { X } from 'lucide-react'
import { Button } from '../components/ui/Button.tsx'
import { Kbd } from '../components/ui/Kbd.tsx'
import { cn } from '../lib/cn.ts'
import { KEYS, useShortcut } from '../lib/keys.ts'
import { setUi, useStore } from '../state/store.ts'
import { AiNote } from '../ai/AiNote.tsx'

export const HELP_TOPICS = ['start', 'diagram', 'views', 'ai', 'rules', 'saving', 'keys'] as const
export type HelpTopic = (typeof HELP_TOPICS)[number]

const TITLE: Record<HelpTopic, string> = {
  start: 'Getting started',
  diagram: 'The diagram',
  views: 'Tables, roadmap, decisions, notes',
  ai: 'AI assistant',
  rules: 'Rules and problems',
  saving: 'Saving and sharing',
  keys: 'Keyboard shortcuts',
}

export function openHelp(topic: HelpTopic = 'start'): void {
  setUi({ help: topic })
}

export function HelpDialog(): React.JSX.Element | null {
  const topic = useStore((s) => s.ui.help)
  const toggle = (): void => setUi((ui) => ({ help: ui.help === null ? 'start' : null }))
  useShortcut(KEYS.keyboardSheet, () => openHelp('keys'), { description: 'Keyboard shortcuts' })
  useShortcut('f1', toggle, { description: 'Help' })
  if (topic === null) return null
  return (
    <Dialog.Root open onOpenChange={(o) => !o && setUi({ help: null })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex h-[min(640px,90vh)] w-[min(820px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-popover shadow-2xl outline-none">
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <Dialog.Title className="flex-1 text-sm font-semibold">Harpoon help</Dialog.Title>
            <Dialog.Description className="sr-only">How Harpoon works, topic by topic, and its keyboard shortcuts.</Dialog.Description>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close help">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1">
            <nav aria-label="Help topics" className="flex w-48 shrink-0 flex-col gap-0.5 border-r p-2">
              {HELP_TOPICS.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-current={t === topic ? 'page' : undefined}
                  onClick={() => setUi({ help: t })}
                  className={cn('rounded-md px-2 py-1.5 text-left text-xs', t === topic ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
                >
                  {TITLE[t]}
                </button>
              ))}
            </nav>
            <article className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm leading-relaxed">
              <h2 className="mb-3 text-base font-semibold">{TITLE[topic]}</h2>
              <Page topic={topic} />
            </article>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function P({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="mb-3 text-muted-foreground">{children}</p>
}

function List({ items }: { items: React.ReactNode[] }): React.JSX.Element {
  return (
    <ul className="mb-3 flex list-disc flex-col gap-1.5 pl-5 text-muted-foreground">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  )
}

const B = ({ children }: { children: React.ReactNode }): React.JSX.Element => <b className="font-medium text-foreground">{children}</b>

function Page({ topic }: { topic: HelpTopic }): React.JSX.Element {
  switch (topic) {
    case 'start':
      return (
        <>
          <P>Harpoon maps, documents and plans software architecture as a diagram of hexagons: services, data stores, queues and outside systems, joined by connectors.</P>
          <List
            items={[
              <><B>New design</B> starts an empty design saved on this computer. No git needed.</>,
              <><B>Open a folder or repo</B> keeps the design in that folder&apos;s <code>.harpoon</code> directory, next to the code, so it can be versioned with it.</>,
              <><B>Explore the sample</B> opens a finished example to look around in.</>,
              <>The rail on the left switches between the diagram, tables, roadmap, decisions, notes and the traffic simulator. Settings and the theme sit at its bottom.</>,
              <>The top bar holds the project menu, undo and redo, the Editor / Docs switch, search, Present, Share and Ask AI.</>,
            ]}
          />
          <P>
            Press <Kbd combo={KEYS.toggleMode} /> to switch between <B>Editor</B> (change things) and <B>Docs</B> (read, inspect and present without moving anything).
          </P>
        </>
      )
    case 'diagram':
      return (
        <List
          items={[
            <>Drag a kind from the palette onto the canvas to add a node. Select it and press <Kbd>C</Kbd>, then click another node, to connect them.</>,
            <>Click to select; the inspector on the right shows its details, features, contracts and connectors.</>,
            <>Double-click a service to expand it in place and see the parts inside. <Kbd combo={KEYS.focusNode} /> opens it on its own; <Kbd combo={KEYS.up} /> goes back up.</>,
            <><B>Modules</B> are responsibilities inside a service that need not connect to anything; they never count as unconnected.</>,
            <>Lenses colour nodes by status, team, data class, roadmap phase or <B>resilience</B> (how much failure each survives; SPOF marks single points of failure). Show impact dims everything not upstream or downstream of a node, or shows what one instance, its zone or the whole node failing takes down.</>,
            <><B>Simulate</B> on the rail runs modelled traffic through the diagram, with faults (including losing an instance, a zone or a region) and cascades. Its numbers are modelled, not measured.</>,
            <><B>Where traffic stops</B> in the simulator lists dead ends, connectors that point the wrong way and missing network hops, with a marker on each node. <B>Investigate with AI</B> reads the code and infrastructure to find the real path and proposes fixes. Requests travel along connectors from caller to callee.</>,
            <><B>Flows</B> (project panel) are request paths that Trace a flow follows. <B>Review flows with AI</B> fixes broken ones and adds the journeys that have none.</>,
            <><B>Present</B> steps through saved views full screen; use the arrow keys or Space, and Esc to stop.</>,
          ]}
        />
      )
    case 'views':
      return (
        <List
          items={[
            <><B>Tables</B> list services, connectors, endpoints, data, changes and problems, plus a dependency matrix. <B>Split</B> shows a table under the diagram.</>,
            <><B>Roadmap</B> groups planned work by phase (set phases in Project settings). Pick a phase to see the diagram as it will be.</>,
            <><B>Decisions</B> compares alternative solutions side by side and keeps a log of decision records.</>,
            <><B>Notes</B> holds project and meeting notes as Markdown files, with action items collected in one list. The live diagram sits beside the note: what the note @mentions is marked on it, clicking a mention shows that node, and selecting a node offers to mention it. Hide the diagram from the note&apos;s header; open the inspector with the right-panel button.</>,
          ]}
        />
      )
    case 'ai':
      return (
        <>
          <AiNote className="mb-4" />
          <P>Open the assistant with Ask AI or <Kbd combo={KEYS.ai} />, then pick what it should do:</P>
          <List
            items={[
              <><B>Plan a change</B>: describe an addition; it lands as planned nodes for you to review.</>,
              <><B>Propose solutions</B>: get two to four alternative designs with pros, cons and scores.</>,
              <><B>Document</B>, <B>Explain</B>, <B>Import repo</B> and <B>Drift check</B> read the code to fill in, answer about, map or check the diagram.</>,
              <><B>Scan for patterns</B> (Rules) suggests rules from the code&apos;s conventions; notes, decision records and Notion publishing use it too.</>,
            ]}
          />
          <P>
            <B>Plan the implementation</B> (on a decision record, an accepted proposal, or the AI panel) hands the work to your CLI&apos;s own plan mode: Claude Code&apos;s plan mode
            or Codex&apos;s plan collaboration mode reads the code and plans how to build it: steps, files, tests, rollout and risks. A decision keeps its plan; follow up below to
            refine it or, with Tools, turn it into issues.
          </P>
          <P>
            With a plan in hand, <B>Save plan</B> writes it as Markdown to <code>.harpoon/plans</code> in the project (change the folder in Settings → AI → Implementing), and{' '}
            <B>Implement this plan</B> has the CLI carry it out in the repository you pick. Choose how much it asks first: <B>Manual</B> (every edit and command),{' '}
            <B>Accept edits</B> (edits freely, asks before commands) or <B>Auto</B> (the CLI&apos;s own judgement: Claude Code&apos;s auto mode, Codex&apos;s approve-for-me).
            Requests appear in the conversation to allow or deny. For git it follows the repository&apos;s own instructions (CLAUDE.md, AGENTS.md, skills) by default, or
            creates a branch, or works in a separate worktree; it never pushes unless those instructions say to. When background work it started (a long test run, a sub-agent)
            is still going, the conversation waits for it and carries on.
          </P>
          <P>
            Conversations are kept on this computer for each project (the latest 50, never in the project folder), so they are still there after you close
            Harpoon; replying continues the CLI&apos;s own session. Delete one, or clear the history, from the conversation list.
            Keep talking after a run: the box below the conversation follows up in the same session, so the AI remembers the plan you accepted. <B>Tools</B> beside it lets
            that conversation use some of your own MCP servers or connectors (Linear, GitHub, Jira…), for example &quot;create a Linear issue for this plan&quot;. They are off unless
            you tick them, and the AI acts in them under your account.
          </P>
          <P>The CLI runs read-only in the project folder: it can read the code but never edits files. It changes the diagram only through Harpoon&apos;s own tools, into a draft you accept or discard. Select nodes first to narrow what it looks at.</P>
          <P>Install and sign in to <B>Claude Code</B> (<code>claude</code>) or <B>Codex</B> (<code>codex</code>) first. The assistant shows which ones it found.</P>
          <P>
            Pick the model and effort at the top of the panel. Settings → <B>AI</B> keeps the defaults for this computer, checks your CLIs again (update a CLI to see newer
            models, or type any model id), and can let an agent you run yourself use Harpoon&apos;s tools through MCP: install the plugin for Codex (CLI, desktop app and
            IDE extension), add Harpoon to VS Code or Cursor, or copy the setup for Claude Code, Claude Desktop and other clients.
          </P>
          <P>
            <B>Import repo</B> with several linked repositories: untick the ones to skip and describe what to bring in, for example &quot;only checkout and payments; from
            the gateway just the public routes&quot;. Services that do more than that come in with only the parts in scope.
          </P>
        </>
      )
    case 'rules':
      return (
        <List
          items={[
            <><B>Problems</B> checks the diagram as you work: unconnected nodes, connectors without a protocol, outside links without auth, data handled outside its approved boundary, planned work ordered before what it depends on, and more.</>,
            <>To fix problems: hover one for its fix (the wrench needs no AI, for things like a deleted team or phase; the sparkles ask the AI), tick several and <B>Resolve selected</B>, or <B>Resolve all with AI</B>. Right-click a node (or several selected) for <B>Resolve problems with AI</B>; the Problems table resolves what it shows. The AI checks the code before changing anything and says which problems it fixed or left, and why.</>,
            <>Project settings → <B>Rules &amp; guidelines</B> adds your own checks (for example, which services may call which) and written guidelines the AI follows.</>,
          ]}
        />
      )
    case 'saving':
      return (
        <List
          items={[
            <>Changes save as you go; <Kbd combo={KEYS.save} /> saves now. Undo and redo cover every change, AI ones included.</>,
            <>A design is a folder of plain JSON and Markdown files. Inside a git repo you can commit it with the code, but git is optional.</>,
            <>The project menu can save the design as a single file, or a copy to another folder or repo.</>,
            <><B>Share</B> exports pictures, Markdown docs, diagram code (Mermaid, PlantUML, draw.io) and a read-only HTML viewer that opens in any browser.</>,
            <>Publishing to Notion is set up in Project settings → Notion.</>,
          ]}
        />
      )
    case 'keys':
      return <Shortcuts />
  }
}

const SHORTCUTS: { group: string; rows: { keys: string[]; label: string }[] }[] = [
  {
    group: 'Anywhere',
    rows: [
      { keys: [KEYS.save], label: 'Save' },
      { keys: [KEYS.undo], label: 'Undo' },
      { keys: [KEYS.redo, KEYS.redoAlt], label: 'Redo' },
      { keys: [KEYS.toggleMode], label: 'Switch Editor / Docs' },
      { keys: [KEYS.ai], label: 'Show or hide the AI assistant' },
      { keys: ['f1'], label: 'Help' },
      { keys: [KEYS.keyboardSheet], label: 'These shortcuts' },
    ],
  },
  {
    group: 'Diagram',
    rows: [
      { keys: ['c'], label: 'Connect from the selected node (canvas focused)' },
      { keys: [KEYS.focusNode], label: 'Open the selected node on its own' },
      { keys: [KEYS.up], label: 'Delete the selection, or go up a level' },
      { keys: [KEYS.del], label: 'Delete the selection' },
      { keys: ['escape'], label: 'Cancel connecting, blast radius or search; then clear the selection' },
    ],
  },
  {
    group: 'Presenting',
    rows: [
      { keys: ['arrowright', 'space'], label: 'Next view' },
      { keys: ['arrowleft'], label: 'Previous view' },
      { keys: ['escape'], label: 'Stop presenting' },
    ],
  },
  {
    group: 'Window',
    rows: [
      { keys: ['mod+='], label: 'Zoom in' },
      { keys: ['mod+-'], label: 'Zoom out' },
      { keys: ['mod+0'], label: 'Reset zoom' },
      { keys: ['mod+q'], label: 'Quit' },
    ],
  },
]

const NAMED: Record<string, string> = { arrowright: '→', arrowleft: '←', space: 'Space', f1: 'F1', backspace: 'Backspace', delete: 'Delete' }

function Shortcuts(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      {SHORTCUTS.map((g) => (
        <section key={g.group}>
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.group}</h3>
          <table className="w-full text-xs">
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.label} className="border-b last:border-0">
                  <td className="py-1.5 pr-3">{r.label}</td>
                  <td className="py-1.5 text-right whitespace-nowrap">
                    {r.keys.map((k, i) => (
                      <span key={k}>
                        {i > 0 && <span className="px-1 text-muted-foreground">or</span>}
                        {NAMED[k] !== undefined ? <Kbd>{NAMED[k]}</Kbd> : <Kbd combo={k} />}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}
