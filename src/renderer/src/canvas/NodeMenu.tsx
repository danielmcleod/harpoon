// Right-click menu for a node: expand/collapse, open inside, blast radius, status, duplicate, delete.
import { Cable, Copy, Crosshair, Maximize2, Minimize2, PanelTopOpen, Route, Sparkles, Trash2, Wrench } from 'lucide-react'
import { useEffect } from 'react'
import { uniqueId } from '@shared/model/ids.ts'
import { coordKey, nearestFreeCell } from '@shared/geometry/hex.ts'
import type { Status } from '@shared/model/schema.ts'
import { cn } from '../lib/cn.ts'
import { isViewer } from '../lib/viewer.ts'
import { deleteSelection } from '../panels/selectionOps.ts'
import { edit, focus, select, startConnect, toggleExpanded } from '../state/actions.ts'
import { getState, setUi } from '../state/store.ts'
import { investigateTraffic } from '../sim/investigate.ts'
import { problemsAbout, resolveWithAi } from '../ai/resolve.ts'
import { startIn } from '../state/ai.ts'

export interface MenuState {
  x: number
  y: number
  nodeId: string
}

export function NodeMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }): React.JSX.Element | null {
  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [onClose])

  const s = getState()
  const m = s.project?.model
  const n = m?.nodes[menu.nodeId]
  if (m === undefined || n === undefined) return null
  const editable = s.ui.mode === 'edit'
  const expanded = s.ui.expanded[n.id] === true
  const hasKids = Object.values(m.nodes).some((x) => x.parentId === n.id)
  // Right-clicking one of several selected nodes resolves for the whole selection.
  const sel = s.ui.selection
  const targets = sel?.kind === 'node' && sel.ids.length > 1 && sel.ids.includes(n.id) ? sel.ids : [n.id]
  const about = problemsAbout(m, targets)
  const problemCount = about.problems.length + about.findings.length

  const run = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
    onClose()
  }

  const duplicate = (): void => {
    const id = uniqueId(n.name, (x) => m.nodes[x] !== undefined)
    const taken = new Set(Object.values(m.nodes).filter((x) => x.parentId === n.parentId).map((x) => m.layout[x.id]).filter((c) => c !== undefined).map(coordKey))
    const at = nearestFreeCell(m.layout[n.id] ?? { q: 0, r: 0 }, (c) => taken.has(coordKey(c)))
    if (edit([{ op: 'addNode', node: { ...n, id, name: `${n.name} copy`, provenance: { source: 'user', runId: null, at: Date.now() } }, at }], { label: 'duplicate' })) {
      select({ kind: 'node', ids: [id] })
    }
  }
  const setStatus = (status: Status): void => {
    edit([{ op: 'updateNode', id: n.id, patch: { status } }], { label: `mark ${status}` })
  }

  const Item = ({ icon, label, onClick, danger }: { icon?: React.ReactNode; label: string; onClick: (e: React.MouseEvent) => void; danger?: boolean }): React.JSX.Element => (
    <button
      type="button"
      role="menuitem"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent [&_svg]:size-3.5 [&_svg]:text-muted-foreground', danger === true && 'text-destructive [&_svg]:text-destructive')}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <div
      role="menu"
      aria-label={`${n.name} actions`}
      className="fixed z-50 w-52 rounded-lg border bg-popover p-1 shadow-xl"
      style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 320) }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="truncate px-2 py-1 text-[11px] font-semibold text-muted-foreground">{n.name}</div>
      <Item icon={expanded ? <Minimize2 /> : <Maximize2 />} label={expanded ? 'Collapse' : hasKids ? 'Expand in place' : 'Map inner parts'} onClick={run(() => toggleExpanded(n.id))} />
      <Item icon={<PanelTopOpen />} label="Open inside" onClick={run(() => focus(n.id))} />
      {editable && <Item icon={<Cable />} label="Connect to…" onClick={run(() => startConnect(n.id))} />}
      <Item icon={<Crosshair />} label="Show impact (what breaks, what it needs)" onClick={run(() => setUi({ blast: { id: n.id, dir: 'both', hops: Infinity } }))} />
      {!isViewer() && (
        <Item icon={<Sparkles />} label="Ask AI about this…" onClick={run(() => {
          select({ kind: 'node', ids: [n.id] })
          startIn('explain')
        })} />
      )}
      {editable && problemCount > 0 && (
        <Item
          icon={<Wrench />}
          label={`Resolve problems with AI (${problemCount}${targets.length > 1 ? `, ${targets.length} nodes` : ''})`}
          onClick={run(() => resolveWithAi(about.problems, about.findings, targets.length > 1 ? `${targets.length} selected nodes` : `${n.name} (and its inner parts)`))}
        />
      )}
      {editable && <Item icon={<Route />} label="Investigate traffic with AI" onClick={run(() => investigateTraffic(n.id))} />}
      {editable && (
        <>
          <div className="my-1 h-px bg-border" />
          {n.status !== 'planned' && <Item label="Mark as planned" onClick={run(() => setStatus('planned'))} />}
          {n.status !== 'existing' && <Item label="Mark as existing" onClick={run(() => setStatus('existing'))} />}
          {n.status !== 'deprecated' && <Item label="Mark as deprecated" onClick={run(() => setStatus('deprecated'))} />}
          <Item icon={<Copy />} label="Duplicate" onClick={run(duplicate)} />
          <Item icon={<Trash2 />} label={hasKids ? 'Delete with inner parts' : 'Delete'} danger onClick={run(() => {
            select({ kind: 'node', ids: [n.id] })
            deleteSelection()
          })} />
        </>
      )}
    </div>
  )
}
