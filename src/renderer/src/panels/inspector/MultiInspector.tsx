// Several nodes selected: group them into a new container, put them in a boundary, change status, delete.
import { Boxes, Shapes, Trash2, Sparkles } from 'lucide-react'
import { coordKey, nearestFreeCell } from '@shared/geometry/hex.ts'
import { uniqueId } from '@shared/model/ids.ts'
import type { Op } from '@shared/model/ops.ts'
import { BoundaryZ, NodeZ, STATUSES } from '@shared/model/schema.ts'
import type { Status } from '@shared/model/schema.ts'
import { Button } from '../../components/ui/Button.tsx'
import { edit, select, toggleExpanded } from '../../state/actions.ts'
import { useModel } from '../../canvas/useScene.ts'
import { deleteSelection } from '../selectionOps.ts'
import { STATUS_LABEL } from './NodeInspector.tsx'
import { problemsAbout, resolveWithAi } from '../../ai/resolve.ts'
import { AI_NOTE_SHORT } from '../../ai/AiNote.tsx'

export function MultiInspector({ ids, readOnly }: { ids: string[]; readOnly: boolean }): React.JSX.Element {
  const model = useModel()
  const nodes = ids.map((id) => model.nodes[id]).filter((n) => n !== undefined)
  const parents = new Set(nodes.map((n) => n.parentId))
  const sameLevel = parents.size === 1
  const parentId = sameLevel ? (nodes[0]?.parentId ?? null) : null

  const group = (): void => {
    const gid = uniqueId('new-group', (x) => model.nodes[x] !== undefined)
    const first = nodes[0]
    const at = first !== undefined ? (model.layout[first.id] ?? { q: 0, r: 0 }) : { q: 0, r: 0 }
    const ops: Op[] = [
      { op: 'addNode', node: NodeZ.parse({ id: gid, name: 'New group', kind: 'system', parentId, provenance: { source: 'user', runId: null, at: Date.now() } }), at: null },
    ]
    const taken = new Set<string>()
    for (const n of nodes) {
      const cell = nearestFreeCell(model.layout[n.id] ?? { q: 0, r: 0 }, (c) => taken.has(coordKey(c)))
      taken.add(coordKey(cell))
      ops.push({ op: 'updateNode', id: n.id, patch: { parentId: gid } }, { op: 'setLayout', id: n.id, at: cell })
    }
    ops.push({ op: 'setLayout', id: gid, at })
    if (edit(ops, { label: 'group' })) {
      toggleExpanded(gid, true)
      select({ kind: 'node', ids: [gid] })
    }
  }

  const zone = (): void => {
    const id = uniqueId('new-zone', (x) => model.boundaries[x] !== undefined)
    if (edit([{ op: 'addBoundary', boundary: BoundaryZ.parse({ id, name: 'New zone', parentId, nodeIds: nodes.map((n) => n.id) }) }], { label: 'add boundary' })) {
      select({ kind: 'boundary', ids: [id] })
    }
  }

  const setStatus = (status: Status): void => {
    edit(nodes.map((n) => ({ op: 'updateNode' as const, id: n.id, patch: { status } })), { label: 'set status' })
  }
  const about = problemsAbout(model, ids)
  const count = about.problems.length + about.findings.length

  return (
    <div className="p-3">
      <h3 className="text-sm font-semibold">{nodes.length} nodes selected</h3>
      <p className="mt-0.5 mb-3 text-xs text-muted-foreground">{nodes.map((n) => n.name).join(', ')}</p>
      {!readOnly && (
        <div className="flex flex-col gap-2">
          {count > 0 && (
            <Button size="sm" variant="outline" icon={<Sparkles />} onClick={() => resolveWithAi(about.problems, about.findings, `${nodes.length} selected nodes`)} title={AI_NOTE_SHORT}>
              Resolve their problems with AI ({count})
            </Button>
          )}
          <Button size="sm" variant="outline" icon={<Boxes />} disabled={!sameLevel} title={sameLevel ? undefined : 'Pick nodes on the same level'} onClick={group}>
            Group into a new container
          </Button>
          <Button size="sm" variant="outline" icon={<Shapes />} disabled={!sameLevel} onClick={zone}>
            Draw a boundary around them
          </Button>
          <label className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Status</span>
            <select value="" onChange={(e) => e.target.value !== '' && setStatus(e.target.value as Status)} className="h-7 flex-1 rounded-md border bg-background px-1 text-xs">
              <option value="">Set status…</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" icon={<Trash2 />} onClick={() => deleteSelection()}>
            Delete all
          </Button>
        </div>
      )}
    </div>
  )
}
