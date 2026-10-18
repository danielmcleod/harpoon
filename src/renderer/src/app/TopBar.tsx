// Top bar: the project (name, history, save state), Edit / Docs, search, present, share and AI. What the main area
// shows is picked in the view rail on the left; node style lives with the canvas controls.
import { openSettings } from '../settings/ProjectSettings.tsx'
import { DropdownMenu } from 'radix-ui'
import { Activity, BookOpen, Check, ChevronDown, Copy, FileJson, FolderGit2, FolderOpen, FolderSearch, PanelLeft, PanelRight, PencilRuler, Redo2, Search, Settings2, Sparkles, Undo2, X } from 'lucide-react'
import { Logo } from '../components/brand/Logo.tsx'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { ExportMenu } from '../panels/ExportMenu.tsx'
import { isViewer } from '../lib/viewer.ts'
import { PresentButton } from '../present/PresentButton.tsx'
import { HistoryMenu, SaveStatus } from './HistoryMenu.tsx'
import { closeProject, openProjectDialog, redo, saveAsFile, saveCopyTo, setMode, undo } from '../state/actions.ts'
import { invoke } from '../ipc/client.ts'
import { setUi, useStore } from '../state/store.ts'
import type { Mode } from '../state/store.ts'

const MODES: { id: Mode; label: string; icon: typeof PencilRuler; hint: string }[] = [
  { id: 'edit', label: 'Edit', icon: PencilRuler, hint: 'Edit the architecture' },
  { id: 'docs', label: 'Docs', icon: BookOpen, hint: 'Read-only: browse and present without moving things by accident' },
]

export function TopBar(): React.JSX.Element {
  const viewer = isViewer()
  const name = useStore((s) => s.project?.model.meta.name ?? '')
  const root = useStore((s) => s.project?.root ?? '')
  const mode = useStore((s) => s.ui.mode)
  const history = useStore((s) => s.project?.history)
  const search = useStore((s) => s.ui.search)
  const aiOpen = useStore((s) => s.ui.aiOpen)
  const leftCollapsed = useStore((s) => s.ui.leftCollapsed)
  const rightCollapsed = useStore((s) => s.ui.rightCollapsed)

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-panel px-3">
      <Logo className="size-6" />
      {viewer ? (
        <span className="max-w-64 truncate px-1.5 text-sm font-semibold">{name}</span>
      ) : (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="flex max-w-64 items-center gap-1 rounded-md px-1.5 py-1 text-sm font-semibold hover:bg-accent" title={root}>
            <span className="truncate">{name}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={6} className="z-50 min-w-56 rounded-lg border bg-popover p-1 text-sm shadow-lg">
            <div className="truncate px-2 py-1 text-xs text-muted-foreground">{root}</div>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <MenuItem onSelect={() => openSettings()} icon={<Settings2 />}>
              Project settings…
            </MenuItem>
            <MenuItem onSelect={() => openSettings('repos')} icon={<FolderGit2 />}>
              Repositories…
            </MenuItem>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <MenuItem onSelect={() => void saveAsFile()} icon={<FileJson />}>
              Save as a single file (.harpoon.json)…
            </MenuItem>
            <MenuItem onSelect={() => void saveCopyTo()} icon={<Copy />}>
              Save a copy to a folder or repo…
            </MenuItem>
            <MenuItem onSelect={() => void invoke('shell.open', { target: 'folder', path: root })} icon={<FolderSearch />}>
              Show in folder
            </MenuItem>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <MenuItem onSelect={() => void openProjectDialog()} icon={<FolderOpen />}>
              Open another folder…
            </MenuItem>
            <MenuItem onSelect={() => void closeProject()} icon={<X />}>
              Close project
            </MenuItem>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      )}

      {!viewer && (
      <div className="ml-1 flex items-center">
        <Button variant="ghost" size="icon" aria-label="Undo" title={history?.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'} disabled={history?.canUndo !== true} onClick={() => void undo()}>
          <Undo2 />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Redo" title={history?.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'} disabled={history?.canRedo !== true} onClick={() => void redo()}>
          <Redo2 />
        </Button>
        <HistoryMenu />
        <span className="ml-1.5 hidden xl:flex">
          <SaveStatus />
        </span>
      </div>
      )}

      <div className="flex min-w-0 flex-1 items-center justify-center">
        {mode === 'sim' ? (
          <span className="flex items-center gap-1.5 rounded-full border border-primary/50 bg-primary/10 px-3 py-1 text-xs font-medium">
            <Activity className="size-3.5 text-primary" />
            Traffic simulator
            <button type="button" onClick={() => setMode(viewer ? 'docs' : 'edit')} className="ml-1 text-muted-foreground hover:text-foreground" aria-label="Leave the simulator">
              <X className="size-3.5" />
            </button>
          </span>
        ) : (
          !viewer && (
            <div role="radiogroup" aria-label="Mode" className="flex items-center rounded-full border bg-background p-0.5">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.id}
                  aria-label={m.label}
                  title={m.hint}
                  onClick={() => setMode(m.id)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                    mode === m.id ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <m.icon className="size-3.5" />
                  <span className="hidden lg:inline">{m.label}</span>
                </button>
              ))}
            </div>
          )
        )}
      </div>

      <label className="relative flex items-center">
        <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setUi({ search: e.target.value })}
          placeholder="Search nodes, features…"
          aria-label="Search"
          className="h-8 w-32 rounded-md border bg-background pr-2 pl-7 text-xs transition-[width] outline-none focus:w-56 focus:border-ring xl:w-44"
        />
      </label>

      {!viewer && <PresentButton />}
      {!viewer && <ExportMenu />}

      {!viewer && (
        <Button size="sm" variant={aiOpen ? 'secondary' : 'default'} icon={<Sparkles />} aria-label="Ask AI" title="Ask AI" onClick={() => setUi((ui) => ({ aiOpen: !ui.aiOpen }))}>
          <span className="hidden lg:inline">Ask AI</span>
        </Button>
      )}

      <div className="ml-1 flex items-center border-l pl-1">
        <Button variant="ghost" size="icon" aria-label="Toggle left panel" onClick={() => setUi({ leftCollapsed: !leftCollapsed })}>
          <PanelLeft />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Toggle right panel" onClick={() => setUi({ rightCollapsed: !rightCollapsed })}>
          <PanelRight />
        </Button>
      </div>
    </header>
  )
}

export function MenuItem({ children, icon, onSelect, checked }: { children: React.ReactNode; icon?: React.ReactNode; onSelect: () => void; checked?: boolean }): React.JSX.Element {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-[highlighted]:bg-accent [&_svg]:size-4 [&_svg]:text-muted-foreground"
    >
      {icon}
      <span className="flex-1">{children}</span>
      {checked === true && <Check />}
    </DropdownMenu.Item>
  )
}
