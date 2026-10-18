// The view rail: a slim column at the left edge for switching what the main area shows (the diagram, tables,
// roadmap, decisions, notes, the traffic simulator), with project settings and the theme at the bottom. It keeps
// the top bar for the project, editing and sharing.
import { Activity, CircleHelp, Hexagon, Milestone, Moon, NotebookPen, PanelBottom, Scale, Settings2, Sun, Table2 } from 'lucide-react'
import { cn } from '../lib/cn.ts'
import { isViewer } from '../lib/viewer.ts'
import { setMode, setTheme } from '../state/actions.ts'
import { setUi, useStore } from '../state/store.ts'
import type { UiState } from '../state/store.ts'
import { openSettings } from '../settings/ProjectSettings.tsx'
import { openHelp } from '../help/HelpDialog.tsx'

type ViewId = UiState['view']

const VIEWS: { id: ViewId; label: string; icon: typeof Hexagon; hint: string; editorOnly?: boolean }[] = [
  { id: 'canvas', label: 'Diagram', icon: Hexagon, hint: 'The diagram' },
  { id: 'split', label: 'Split', icon: PanelBottom, hint: 'The diagram with a table under it' },
  { id: 'tables', label: 'Tables', icon: Table2, hint: 'Services, connectors, endpoints, data, changes and problems as tables, plus a dependency matrix' },
  { id: 'roadmap', label: 'Roadmap', icon: Milestone, hint: 'Planned work by roadmap phase' },
  { id: 'decisions', label: 'Decisions', icon: Scale, hint: 'Compare proposed solutions and keep the decision log' },
  { id: 'notes', label: 'Notes', icon: NotebookPen, hint: 'Project and meeting notes, action items', editorOnly: true },
]

function RailButton({ active, label, hint, icon: Icon, onClick }: { active: boolean; label: string; hint: string; icon: typeof Hexagon; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={hint}
      onClick={onClick}
      className={cn(
        'flex w-full flex-col items-center gap-0.5 rounded-md px-0.5 py-1.5 text-[9.5px] leading-none',
        active ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <Icon className={cn('size-[18px]', active && 'text-primary')} />
      <span className="max-w-full truncate">{label}</span>
    </button>
  )
}

export function ViewRail(): React.JSX.Element {
  const viewer = isViewer()
  const view = useStore((s) => s.ui.view)
  const mode = useStore((s) => s.ui.mode)
  const theme = useStore((s) => s.theme)
  const sim = mode === 'sim'
  const pick = (id: ViewId): void => {
    // Leaving the simulator goes back to editing (read-only in the viewer).
    if (sim) setMode(viewer ? 'docs' : 'edit')
    setUi({ view: id })
  }

  return (
    <nav aria-label="Views" className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-panel px-1 py-2">
      <div role="tablist" aria-orientation="vertical" className="flex w-full flex-col gap-1">
        {VIEWS.filter((v) => !(viewer && v.editorOnly === true)).map((v) => (
          <RailButton key={v.id} active={!sim && view === v.id} label={v.label} hint={v.hint} icon={v.icon} onClick={() => pick(v.id)} />
        ))}
        <div className="my-1 h-px w-full bg-border" />
        <RailButton
          active={sim}
          label="Simulate"
          hint="Traffic simulator: load, latency, faults and cascades"
          icon={Activity}
          onClick={() => {
            setUi({ view: 'canvas' })
            setMode('sim')
          }}
        />
      </div>
      <div className="mt-auto flex w-full flex-col gap-1">
        <RailButton active={false} label="Help" hint="Help and keyboard shortcuts (F1)" icon={CircleHelp} onClick={() => openHelp()} />
        {!viewer && <RailButton active={false} label="Settings" hint="Project settings" icon={Settings2} onClick={() => openSettings()} />}
        <RailButton
          active={false}
          label={theme.resolved === 'dark' ? 'Light' : 'Dark'}
          hint="Toggle light / dark"
          icon={theme.resolved === 'dark' ? Sun : Moon}
          onClick={() => void setTheme(theme.resolved === 'dark' ? 'light' : 'dark')}
        />
      </div>
    </nav>
  )
}
