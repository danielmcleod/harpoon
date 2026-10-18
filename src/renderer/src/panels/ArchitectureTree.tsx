// The architecture tree: every node by hierarchy. Click selects and brings the node into view (expanding its
// containers); double-click opens it (focus); in the editor, drag a row onto another to move it inside.
import { ChevronRight, Lock, Maximize2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { coordKey, nearestFreeCell } from '@shared/geometry/hex.ts'
import { ancestorsOf, descendantIds } from '@shared/model/queries.ts'
import type { HxNode, Model } from '@shared/model/schema.ts'
import { cn } from '../lib/cn.ts'
import { kindIcon, nodeColor } from '../lib/icons.tsx'
import { centerOn, edit, focus, select } from '../state/actions.ts'
import { setUi, useStore } from '../state/store.ts'
import { setAiMode } from '../state/ai.ts'
import { useModel } from '../canvas/useScene.ts'

const STATUS_DOT: Record<HxNode['status'], string> = {
  existing: 'bg-success',
  planned: 'bg-info',
  'in-progress': 'bg-warning',
  deprecated: 'bg-muted-foreground',
  removed: 'bg-destructive',
}

function byName(a: HxNode, b: HxNode): number {
  if (a.boundary !== b.boundary) return a.boundary === 'internal' ? -1 : 1
  return a.name.localeCompare(b.name)
}

/** Expand every container of `id` on the canvas (leaving focus if it is outside), then select and centre it. */
export function reveal(m: Model, id: string): void {
  const ui = useStore.getState().ui
  const chain = ancestorsOf(m, id).map((a) => a.id)
  let focusId = ui.focusId
  if (focusId !== null && focusId !== id && !chain.includes(focusId)) focusId = null
  const stopAt = focusId === null ? chain.length : chain.indexOf(focusId)
  const toOpen = chain.slice(0, stopAt === -1 ? chain.length : stopAt)
  setUi((u) => ({
    focusId,
    expanded: { ...(focusId !== u.focusId ? {} : u.expanded), ...Object.fromEntries(toOpen.map((x) => [x, true as const])) },
    fitNonce: focusId !== u.focusId ? u.fitNonce + 1 : u.fitNonce,
  }))
  select({ kind: 'node', ids: [id] })
  setTimeout(() => centerOn(id), 80)
}

export function ArchitectureTree(): React.JSX.Element {
  const model = useModel()
  const selection = useStore((s) => s.ui.selection)
  const editable = useStore((s) => s.ui.mode === 'edit')
  const search = useStore((s) => s.ui.search.trim().toLowerCase())
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const kids = useMemo(() => {
    const map = new Map<string | null, HxNode[]>()
    for (const n of Object.values(model.nodes)) {
      const l = map.get(n.parentId)
      if (l === undefined) map.set(n.parentId, [n])
      else l.push(n)
    }
    for (const l of map.values()) l.sort(byName)
    return map
  }, [model])

  const matches = useMemo(() => {
    if (search === '') return null
    const hit = new Set<string>()
    for (const n of Object.values(model.nodes)) {
      if (`${n.name} ${n.id} ${n.techStack ?? ''}`.toLowerCase().includes(search)) {
        hit.add(n.id)
        for (const a of ancestorsOf(model, n.id)) hit.add(a.id)
      }
    }
    return hit
  }, [model, search])

  const selected = new Set(selection?.kind === 'node' ? selection.ids : [])

  const moveInto = (id: string, parentId: string | null): void => {
    const n = model.nodes[id]
    if (n === undefined || n.parentId === parentId) return
    if (parentId !== null && (parentId === id || descendantIds(model, id).includes(parentId))) return
    const taken = new Set(Object.values(model.nodes).filter((x) => x.parentId === parentId).map((x) => model.layout[x.id]).filter((c) => c !== undefined).map(coordKey))
    const at = nearestFreeCell({ q: 0, r: 0 }, (c) => taken.has(coordKey(c)))
    edit([{ op: 'updateNode', id, patch: { parentId } }, { op: 'setLayout', id, at }], { label: 'move into group' })
  }

  const row = (n: HxNode, depth: number): React.JSX.Element | null => {
    if (matches !== null && !matches.has(n.id)) return null
    const children = kids.get(n.id) ?? []
    const isOpen = open[n.id] ?? (matches !== null || depth === 0)
    const Icon = kindIcon(n.kind)
    return (
      <li key={n.id}>
        <div
          role="treeitem"
          aria-selected={selected.has(n.id)}
          aria-expanded={children.length > 0 ? isOpen : undefined}
          tabIndex={0}
          draggable={editable}
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-harpoon-node', n.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(e) => {
            if (!editable || !e.dataTransfer.types.includes('application/x-harpoon-node')) return
            e.preventDefault()
            setDropTarget(n.id)
          }}
          onDragLeave={() => setDropTarget((t) => (t === n.id ? null : t))}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setDropTarget(null)
            const id = e.dataTransfer.getData('application/x-harpoon-node')
            if (id !== '') moveInto(id, n.id)
          }}
          onClick={() => reveal(model, n.id)}
          onDoubleClick={() => focus(n.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') reveal(model, n.id)
            if (e.key === 'ArrowRight' && children.length > 0) setOpen((o) => ({ ...o, [n.id]: true }))
            if (e.key === 'ArrowLeft') setOpen((o) => ({ ...o, [n.id]: false }))
          }}
          className={cn(
            'group flex h-8 cursor-default items-center gap-1.5 rounded-md pr-2 text-[13px] outline-none',
            selected.has(n.id) ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
            dropTarget === n.id && 'ring-1 ring-ring',
            'focus-visible:ring-1 focus-visible:ring-ring',
          )}
          style={{ paddingLeft: 6 + depth * 14 }}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className={cn('flex size-4 items-center justify-center rounded text-muted-foreground', children.length === 0 && 'invisible')}
            onClick={(e) => {
              e.stopPropagation()
              setOpen((o) => ({ ...o, [n.id]: !isOpen }))
            }}
          >
            <ChevronRight className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')} />
          </button>
          <Icon className="size-3.5 shrink-0" style={{ color: nodeColor(n) }} />
          <span className={cn('min-w-0 flex-1 truncate', n.status === 'deprecated' && 'line-through opacity-70', n.status === 'planned' && 'italic')}>{n.name}</span>
          {children.length > 0 && (
            <button
              type="button"
              tabIndex={-1}
              title="Open inside"
              aria-label={`Open ${n.name}`}
              className="hidden rounded p-0.5 text-muted-foreground group-hover:block hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                focus(n.id)
              }}
            >
              <Maximize2 className="size-3" />
            </button>
          )}
          {n.boundary === 'external' && <Lock className="size-3 text-muted-foreground" aria-label="external" />}
          <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[n.status])} title={n.status} />
        </div>
        {children.length > 0 && isOpen && <ul role="group">{children.map((c) => row(c, depth + 1))}</ul>}
      </li>
    )
  }

  const top = kids.get(null) ?? []
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <h2 className="flex h-10 shrink-0 items-center px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Architecture</h2>
      <ul
        role="tree"
        aria-label="Architecture tree"
        className="scroll-region min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
        onDragOver={(e) => {
          if (editable && e.dataTransfer.types.includes('application/x-harpoon-node')) e.preventDefault()
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData('application/x-harpoon-node')
          if (id !== '') moveInto(id, null)
        }}
      >
        {top.map((n) => row(n, 0))}
        {top.length === 0 && (
          <li className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs text-muted-foreground">
            Nothing here yet. Drag a component from the palette, or let the AI map the code in this folder.
            <button
              type="button"
              className="rounded-md border border-primary/50 bg-primary/10 px-2.5 py-1 text-foreground hover:bg-primary/20"
              onClick={() => {
                setAiMode('import')
                setUi({ aiOpen: true })
              }}
            >
              Map this repository with AI
            </button>
          </li>
        )}
      </ul>
    </section>
  )
}
