// The command palette (⌘/Ctrl+K): jump to a node by name, switch view, turn a lens or a panel on or off, and run the
// common actions that already exist elsewhere. Typing filters; ↑/↓ and Enter pick; Esc (or the shortcut again) closes.
import { Command } from 'cmdk'
import { Dialog } from 'radix-ui'
import {
  Activity,
  BookOpen,
  Box,
  CircleHelp,
  Crosshair,
  Expand,
  FileJson,
  FolderGit2,
  FolderOpen,
  Hexagon,
  Home,
  Layers,
  LayoutGrid,
  Milestone,
  Moon,
  Network,
  NotebookPen,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PencilRuler,
  Presentation,
  Redo2,
  Scale,
  Search,
  Settings2,
  Shrink,
  Sparkles,
  Sun,
  Table2,
  Undo2,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { AiMode } from '@shared/ipc.ts'
import { LENS_KINDS, LENS_LABEL } from '../canvas/lensMarks.ts'
import { nodeMatches } from '../canvas/useScene.ts'
import { Kbd } from '../components/ui/Kbd.tsx'
import { openHelp } from '../help/HelpDialog.tsx'
import { kindIcon, nodeColor } from '../lib/icons.tsx'
import { KEYS, useShortcut } from '../lib/keys.ts'
import { isViewer } from '../lib/viewer.ts'
import { reveal } from '../panels/ArchitectureTree.tsx'
import { startPresentation } from '../present/presentStore.ts'
import { openSettings } from '../settings/ProjectSettings.tsx'
import {
  closeProject,
  focus,
  openProjectDialog,
  redo,
  saveAsFile,
  setMode,
  setNodeStyle,
  setTheme,
  undo,
} from '../state/actions.ts'
import { clearHighlight, startIn } from '../state/ai.ts'
import { getState, setUi } from '../state/store.ts'
import type { UiState } from '../state/store.ts'

interface Cmd {
  id: string
  group: 'Go to' | 'Diagram' | 'Panels' | 'Actions'
  label: string
  icon: typeof Hexagon
  /** A lib/keys.ts combo shown as a hint. */
  keys?: string
  /** Other words that find it. */
  more?: string
  run: () => void
}

const GROUPS: Cmd['group'][] = ['Go to', 'Diagram', 'Panels', 'Actions']
/** Nodes listed for one search (the rest are a few more letters away). */
const NODE_LIMIT = 30

const onDiagram = (ui: UiState): boolean => ui.mode === 'sim' || ui.view === 'canvas' || ui.view === 'split'

/** What can be run right now (read once when the palette opens, so labels say what a toggle will do). */
function commands(): Cmd[] {
  const viewer = isViewer()
  const s = getState()
  const ui = s.ui
  const history = s.project?.history
  const view = (id: UiState['view']) => (): void => {
    // Leaving the simulator goes back to editing (read-only in the viewer), as the view rail does.
    if (getState().ui.mode === 'sim') setMode(viewer ? 'docs' : 'edit')
    setUi({ view: id })
  }
  const diagram = (fn: () => void) => (): void => {
    if (!onDiagram(getState().ui)) setUi({ view: 'canvas' })
    fn()
  }
  const ask = (mode: AiMode, label: string, more: string): Cmd => ({
    id: `ai-${mode}`,
    group: 'Actions',
    label: `Ask AI: ${label}`,
    icon: Sparkles,
    more,
    run: () => startIn(mode),
  })
  const out: (Cmd | false)[] = [
    {
      id: 'view-canvas',
      group: 'Go to',
      label: 'Diagram',
      icon: Hexagon,
      more: 'view canvas',
      run: view('canvas'),
    },
    {
      id: 'view-strata',
      group: 'Go to',
      label: 'Levels: the architecture in 3D',
      icon: Layers,
      more: 'view 3d strata decks core tiers',
      run: view('strata'),
    },
    {
      id: 'view-split',
      group: 'Go to',
      label: 'Split: diagram with a table under it',
      icon: PanelBottom,
      more: 'view',
      run: view('split'),
    },
    {
      id: 'view-tables',
      group: 'Go to',
      label: 'Tables',
      icon: Table2,
      more: 'view services connectors endpoints data changes problems matrix',
      run: view('tables'),
    },
    {
      id: 'view-roadmap',
      group: 'Go to',
      label: 'Roadmap',
      icon: Milestone,
      more: 'view phases planned',
      run: view('roadmap'),
    },
    {
      id: 'view-decisions',
      group: 'Go to',
      label: 'Decisions',
      icon: Scale,
      more: 'view adr compare solutions',
      run: view('decisions'),
    },
    !viewer && {
      id: 'view-notes',
      group: 'Go to',
      label: 'Notes',
      icon: NotebookPen,
      more: 'view meetings action items',
      run: view('notes'),
    },
    {
      id: 'view-sim',
      group: 'Go to',
      label: 'Traffic simulator',
      icon: Activity,
      more: 'simulate load faults',
      run: () => (setUi({ view: 'canvas' }), setMode('sim')),
    },
    ui.focusId !== null && {
      id: 'top',
      group: 'Go to',
      label: 'Top level of the diagram',
      icon: Home,
      more: 'up home whole system',
      run: diagram(() => focus(null)),
    },

    {
      id: 'fit',
      group: 'Diagram',
      label: 'Fit the diagram in view',
      icon: Expand,
      keys: KEYS.fit,
      more: 'zoom',
      run: diagram(() => setUi((u) => ({ fitNonce: u.fitNonce + 1 }))),
    },
    ui.detail === 'full'
      ? {
          id: 'detail',
          group: 'Diagram',
          label: 'Detail: Overview',
          icon: Network,
          more: 'fold collapse satellites',
          run: diagram(() => setUi({ detail: 'overview' })),
        }
      : {
          id: 'detail',
          group: 'Diagram',
          label: 'Detail: Full',
          icon: LayoutGrid,
          more: 'every node',
          run: diagram(() => setUi({ detail: 'full' })),
        },
    s.prefs.nodeStyle === 'flat'
      ? {
          id: 'style',
          group: 'Diagram',
          label: 'Node style: Isometric blocks',
          icon: Box,
          more: 'iso 3d',
          run: () => void setNodeStyle('iso'),
        }
      : {
          id: 'style',
          group: 'Diagram',
          label: 'Node style: Flat hexagons',
          icon: Hexagon,
          more: '2d',
          run: () => void setNodeStyle('flat'),
        },
    Object.keys(ui.expanded).length > 0 && {
      id: 'collapse',
      group: 'Diagram',
      label: 'Collapse all',
      icon: Shrink,
      more: 'expanded',
      run: () => setUi({ expanded: {} }),
    },
    ...LENS_KINDS.filter((k) => ui.lens?.kind !== k).map((k): Cmd => ({
      id: `lens-${k}`,
      group: 'Diagram',
      label: `Lens: colour by ${LENS_LABEL[k].toLowerCase()}`,
      icon: Layers,
      more: 'color',
      run: diagram(() => setUi({ lens: { kind: k, hidden: [] } })),
    })),
    ui.lens !== null && {
      id: 'lens-off',
      group: 'Diagram',
      label: `Lens off (${LENS_LABEL[ui.lens.kind]})`,
      icon: Layers,
      more: 'colour color clear',
      run: () => setUi({ lens: null }),
    },
    ui.blast !== null && {
      id: 'blast-off',
      group: 'Diagram',
      label: 'Clear the impact analysis',
      icon: Crosshair,
      more: 'blast radius',
      run: () => setUi({ blast: null }),
    },
    s.ai.highlight !== null && {
      id: 'highlight-off',
      group: 'Diagram',
      label: 'Clear the AI highlight',
      icon: X,
      more: 'dim',
      run: clearHighlight,
    },
    ui.search !== '' && {
      id: 'search-off',
      group: 'Diagram',
      label: 'Clear the search',
      icon: Search,
      keys: 'escape',
      run: () => setUi({ search: '' }),
    },

    {
      id: 'left',
      group: 'Panels',
      label: ui.leftCollapsed ? 'Show the left panel' : 'Hide the left panel',
      icon: PanelLeft,
      more: 'toggle architecture tree palette',
      run: () => setUi((u) => ({ leftCollapsed: !u.leftCollapsed })),
    },
    // In notes the inspector is the one beside the diagram, closed until asked for (as the top bar's button).
    ui.view === 'notes' && ui.mode !== 'sim'
      ? {
          id: 'right',
          group: 'Panels',
          label: ui.notesInspector ? 'Hide the inspector' : 'Show the inspector',
          icon: PanelRight,
          more: 'toggle right panel',
          run: () => setUi((u) => ({ notesInspector: !u.notesInspector })),
        }
      : {
          id: 'right',
          group: 'Panels',
          label: ui.rightCollapsed ? 'Show the inspector' : 'Hide the inspector',
          icon: PanelRight,
          more: 'toggle right panel',
          run: () => setUi((u) => ({ rightCollapsed: !u.rightCollapsed })),
        },
    !viewer && {
      id: 'ai',
      group: 'Panels',
      label: ui.aiOpen ? 'Hide the AI assistant' : 'Show the AI assistant',
      icon: Sparkles,
      keys: KEYS.ai,
      more: 'toggle panel chat',
      run: () => setUi((u) => ({ aiOpen: !u.aiOpen })),
    },

    !viewer &&
      history?.canUndo === true && {
        id: 'undo',
        group: 'Actions',
        label: `Undo${history.undoLabel ? ` ${history.undoLabel}` : ''}`,
        icon: Undo2,
        keys: KEYS.undo,
        run: () => void undo(),
      },
    !viewer &&
      history?.canRedo === true && {
        id: 'redo',
        group: 'Actions',
        label: `Redo${history.redoLabel ? ` ${history.redoLabel}` : ''}`,
        icon: Redo2,
        keys: KEYS.redo,
        run: () => void redo(),
      },
    !viewer &&
      ui.mode !== 'edit' && {
        id: 'mode-edit',
        group: 'Actions',
        label: 'Switch to Edit',
        icon: PencilRuler,
        keys: KEYS.toggleMode,
        more: 'mode editor',
        run: () => setMode('edit'),
      },
    !viewer &&
      ui.mode !== 'docs' && {
        id: 'mode-docs',
        group: 'Actions',
        label: 'Switch to Docs (read-only)',
        icon: BookOpen,
        keys: KEYS.toggleMode,
        more: 'mode browse',
        run: () => setMode('docs'),
      },
    {
      id: 'present',
      group: 'Actions',
      label: 'Present the saved views',
      icon: Presentation,
      more: 'slides presentation',
      run: () => startPresentation(0),
    },
    !viewer && ask('plan', 'plan a change', 'design proposal'),
    !viewer && ask('explain', 'explain the architecture', 'question'),
    !viewer && ask('document', 'document from the code', 'descriptions'),
    !viewer && ask('drift', 'sync with the code', 'drift'),
    !viewer && {
      id: 'settings',
      group: 'Actions',
      label: 'Project settings…',
      icon: Settings2,
      more: 'teams phases data rules notion',
      run: () => openSettings(),
    },
    !viewer && {
      id: 'repos',
      group: 'Actions',
      label: 'Repositories…',
      icon: FolderGit2,
      more: 'settings code',
      run: () => openSettings('repos'),
    },
    !viewer && {
      id: 'save-file',
      group: 'Actions',
      label: 'Save as a single file (.harpoon.json)…',
      icon: FileJson,
      more: 'export',
      run: () => void saveAsFile(),
    },
    !viewer && {
      id: 'open',
      group: 'Actions',
      label: 'Open another folder…',
      icon: FolderOpen,
      keys: KEYS.open,
      more: 'project repository',
      run: () => void openProjectDialog(),
    },
    !viewer && {
      id: 'close',
      group: 'Actions',
      label: 'Close project',
      icon: X,
      run: () => void closeProject(),
    },
    s.theme.resolved === 'dark'
      ? {
          id: 'theme',
          group: 'Actions',
          label: 'Light theme',
          icon: Sun,
          more: 'appearance',
          run: () => void setTheme('light'),
        }
      : {
          id: 'theme',
          group: 'Actions',
          label: 'Dark theme',
          icon: Moon,
          more: 'appearance',
          run: () => void setTheme('dark'),
        },
    { id: 'help', group: 'Actions', label: 'Help', icon: CircleHelp, keys: 'f1', run: () => openHelp() },
    {
      id: 'keys',
      group: 'Actions',
      label: 'Keyboard shortcuts',
      icon: CircleHelp,
      keys: KEYS.keyboardSheet,
      run: () => openHelp('keys'),
    },
  ]
  return out.filter((c): c is Cmd => c !== false)
}

const ITEM =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:size-3.5 [&_svg]:shrink-0'
const GROUP =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase'

export function CommandPalette(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  useShortcut(KEYS.palette, () => setOpen(true), { reserved: true, description: 'Command palette' })
  return open ? <Palette onClose={() => setOpen(false)} /> : null
}

function Palette({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [search, setSearch] = useState('')
  const all = useMemo(commands, [])
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = all.filter((c) => {
    const hay = `${c.label} ${c.group} ${c.more ?? ''}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  const model = getState().project?.model
  const q = search.trim().toLowerCase()
  const rank = (name: string): number =>
    name.toLowerCase().startsWith(q) ? 0 : name.toLowerCase().includes(q) ? 1 : 2
  const hits =
    model === undefined || q === ''
      ? []
      : Object.values(model.nodes)
          .filter((n) => nodeMatches(n, q))
          .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
  const pick = (run: () => void) => (): void => {
    onClose()
    run()
  }
  const jump = (id: string) => (): void => {
    const s = getState()
    if (s.project === null) return
    if (!onDiagram(s.ui)) setUi({ view: 'canvas' })
    reveal(s.project.model, id)
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[16vh] left-1/2 z-50 w-[min(560px,94vw)] -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl outline-none"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command
            label="Command palette"
            shouldFilter={false}
            vimBindings={false}
            loop
            onKeyDown={(e) => {
              // The shortcut that opened it closes it again.
              if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                onClose()
              }
            }}
          >
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <Command.Input
                autoFocus
                value={search}
                onValueChange={setSearch}
                placeholder="Jump to a node, switch view, run an action…"
                className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[min(440px,56vh)] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-xs text-muted-foreground">
                Nothing matches.
              </Command.Empty>
              {hits.length > 0 && (
                <Command.Group heading="Nodes" className={GROUP}>
                  {hits.slice(0, NODE_LIMIT).map((n) => {
                    const Icon = kindIcon(n.kind)
                    return (
                      <Command.Item
                        key={n.id}
                        value={`node ${n.id}`}
                        onSelect={pick(jump(n.id))}
                        className={ITEM}
                      >
                        <Icon style={{ color: nodeColor(n) }} />
                        <span className="min-w-0 truncate">{n.name}</span>
                        <span className="ml-auto shrink-0 truncate pl-3 text-[10.5px] text-muted-foreground">
                          {n.techStack ?? n.kind}
                        </span>
                      </Command.Item>
                    )
                  })}
                  {hits.length > NODE_LIMIT && (
                    <div className="px-2 py-1 text-[10.5px] text-muted-foreground">
                      …and {hits.length - NODE_LIMIT} more; keep typing.
                    </div>
                  )}
                </Command.Group>
              )}
              {GROUPS.map((g) => {
                const items = shown.filter((c) => c.group === g)
                if (items.length === 0) return null
                return (
                  <Command.Group key={g} heading={g} className={GROUP}>
                    {items.map((c) => (
                      <Command.Item key={c.id} value={`cmd ${c.id}`} onSelect={pick(c.run)} className={ITEM}>
                        <c.icon className="text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{c.label}</span>
                        {c.keys !== undefined && <Kbd combo={c.keys} />}
                      </Command.Item>
                    ))}
                  </Command.Group>
                )
              })}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
