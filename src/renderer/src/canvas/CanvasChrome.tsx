// Floating canvas controls: breadcrumbs when a subgraph is focused, zoom controls, the detail level (Overview folds
// small parts into the service that uses them), Tidy, the blast-radius banner, and a legend of line styles.
import { RoadmapBar } from './RoadmapBar.tsx'
import { Panel, useReactFlow } from '@xyflow/react'
import { Box, Cable, ChevronRight, Expand, Hexagon, Home, LayoutGrid, Minus, Network, Plus, Shrink, Wand2 } from 'lucide-react'
import { cn } from '../lib/cn.ts'
import { ancestorsOf } from '@shared/model/queries.ts'
import { Button } from '../components/ui/Button.tsx'
import { cancelConnect, edit, focus, setNodeStyle, toast } from '../state/actions.ts'
import { tidyOps } from './edits.ts'
import { setUi, useStore } from '../state/store.ts'
import { useModel, useScene } from './useScene.ts'
import { ImpactBanner } from './ImpactBanner.tsx'
import { Lens } from './Lens.tsx'

export function CanvasChrome(): React.JSX.Element {
  const rf = useReactFlow()
  const model = useModel()
  const focusId = useStore((s) => s.ui.focusId)
  const connectFrom = useStore((s) => s.ui.connectFrom)
  const editable = useStore((s) => s.ui.mode === 'edit')
  const scene = useScene(model)
  const expandedCount = useStore((s) => Object.keys(s.ui.expanded).length)
  // The simulator's transport bar takes the bottom centre: keep the corners compact.
  const sim = useStore((s) => s.ui.mode === 'sim')
  const nodeStyle = useStore((s) => s.prefs.nodeStyle)
  const detail = useStore((s) => s.ui.detail)
  const overview = detail === 'overview'
  const crumbs = focusId === null ? [] : [...ancestorsOf(model, focusId).reverse(), model.nodes[focusId]].filter((n) => n !== undefined)

  const expandAll = (): void => {
    const ids = Object.values(model.nodes).filter((n) => Object.values(model.nodes).some((c) => c.parentId === n.id)).map((n) => n.id)
    setUi({ expanded: Object.fromEntries(ids.map((id) => [id, true as const])) })
  }

  return (
    <>
      <Panel position="top-left">
        <nav aria-label="Breadcrumb" className="flex items-center gap-0.5 rounded-lg border bg-popover/90 px-1 py-1 text-xs shadow-sm backdrop-blur">
          <button type="button" onClick={() => focus(null)} className="flex items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-accent">
            <Home className="size-3.5" />
            {model.meta.name}
          </button>
          {crumbs.map((n) => (
            <span key={n.id} className="flex items-center gap-0.5">
              <ChevronRight className="size-3 text-muted-foreground" />
              <button type="button" onClick={() => focus(n.id)} className="rounded px-1.5 py-0.5 hover:bg-accent">
                {n.name}
              </button>
            </span>
          ))}
        </nav>
      </Panel>

      {connectFrom !== null && (
        <Panel position="top-center">
          <div className="flex items-center gap-2 rounded-lg border border-primary/60 bg-popover/95 px-3 py-1.5 text-xs shadow-md">
            <Cable className="size-3.5 text-primary" />
            <span>
              Connecting from <strong>{model.nodes[connectFrom]?.name ?? connectFrom}</strong>: click the node it calls or sends to.
            </span>
            <button type="button" onClick={cancelConnect} className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
              Cancel (Esc)
            </button>
          </div>
        </Panel>
      )}

      <ImpactBanner />
      {!sim && <RoadmapBar />}
      {!sim && <Lens />}

      <Panel position="bottom-left">
        <div className="flex items-center gap-0.5 rounded-lg border bg-popover/90 p-1 shadow-sm backdrop-blur">
          <Button variant="ghost" size="icon" className="size-7" aria-label="Zoom out" onClick={() => void rf.zoomOut({ duration: 150 })}>
            <Minus />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Zoom in" onClick={() => void rf.zoomIn({ duration: 150 })}>
            <Plus />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Fit view" title="Fit view" onClick={() => void rf.fitView({ padding: 0.15, duration: 300 })}>
            <Expand />
          </Button>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <div role="radiogroup" aria-label="Node style" className="flex items-center">
            <button type="button" role="radio" aria-checked={nodeStyle === 'flat'} title="Flat hexagons" onClick={() => void setNodeStyle('flat')} className={cn('rounded p-1.5', nodeStyle === 'flat' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              <Hexagon className="size-3.5" />
            </button>
            <button type="button" role="radio" aria-checked={nodeStyle === 'iso'} title="Isometric blocks" onClick={() => void setNodeStyle('iso')} className={cn('rounded p-1.5', nodeStyle === 'iso' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              <Box className="size-3.5" />
            </button>
          </div>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <div role="radiogroup" aria-label="Detail" className="flex items-center">
            <button type="button" role="radio" aria-checked={overview} title="Overview: small parts only one service uses are folded into it, and every node is drawn collapsed" onClick={() => setUi({ detail: 'overview' })} className={cn('flex items-center gap-1 rounded px-1.5 py-1 text-xs', overview ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              <Network className="size-3.5" />
              Overview
            </button>
            <button type="button" role="radio" aria-checked={!overview} title="Full detail: every node, expanded where you opened it" onClick={() => setUi({ detail: 'full' })} className={cn('flex items-center gap-1 rounded px-1.5 py-1 text-xs', !overview ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              <LayoutGrid className="size-3.5" />
              Full
            </button>
          </div>
          {!sim && editable && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              icon={<Wand2 />}
              title="Arrange what is on screen: callers left, callees right, shorter lines that stop crossing or running through nodes, containers at their drawn size (undoable)"
              onClick={() => {
                const ops = tidyOps(model, scene)
                if (ops.length === 0) toast('Already tidy.')
                else if (edit(ops, { label: 'tidy layout' })) toast(`Tidied ${ops.length} node${ops.length === 1 ? '' : 's'}. Undo to put them back.`)
              }}
            >
              Tidy
            </Button>
          )}
          {!sim && !overview && (
            <>
              <span className="mx-0.5 h-4 w-px bg-border" />
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={expandedCount > 0 ? () => setUi({ expanded: {} }) : expandAll} icon={expandedCount > 0 ? <Shrink /> : <Expand />}>
                {expandedCount > 0 ? 'Collapse all' : 'Expand all'}
              </Button>
            </>
          )}
        </div>
      </Panel>

      <Panel position="bottom-right" className={sim ? 'hidden' : undefined}>
        <div className="hidden items-center gap-3 rounded-lg border bg-popover/90 px-3 py-1.5 text-[10.5px] text-muted-foreground shadow-sm backdrop-blur @min-[720px]:flex">
          <Legend color="var(--hx-cyan)" label="HTTP" />
          <Legend color="var(--hx-violet)" label="RPC" />
          <Legend color="var(--hx-amber)" label="Events" />
          <Legend color="var(--hx-blue)" label="Data" />
          <span className="flex items-center gap-1">
            <svg width="22" height="8" aria-hidden>
              <path d="M1 4h18" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />
            </svg>
            planned
          </span>
        </div>
      </Panel>
    </>
  )
}

function Legend({ color, label }: { color: string; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <svg width="22" height="10" aria-hidden>
        <path d="M1 3h18l-6 -3" stroke={color} strokeWidth="1.6" fill="none" strokeLinecap="round" />
        <path d="M21 8H3l6 3" stroke={color} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </svg>
      {label}
    </span>
  )
}
