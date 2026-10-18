// Edits on the current selection (Delete key, inspector buttons, context menu).
import { removeNodeOps } from '@shared/model/ops.ts'
import type { Op } from '@shared/model/ops.ts'
import { edit, select, toast } from '../state/actions.ts'
import { getState } from '../state/store.ts'

export function deleteSelection(): void {
  const s = getState()
  const m = s.project?.model
  const sel = s.ui.selection
  if (m === undefined || sel === null || s.ui.mode !== 'edit') return
  const ops: Op[] = []
  if (sel.kind === 'node') {
    const seen = new Set<string>()
    for (const id of sel.ids) {
      for (const o of removeNodeOps(m, id)) {
        const key = `${o.op}:${'id' in o ? o.id : ''}`
        if (seen.has(key)) continue
        seen.add(key)
        ops.push(o)
      }
    }
  } else if (sel.kind === 'connector') {
    for (const id of sel.ids) if (m.connectors[id] !== undefined) ops.push({ op: 'removeConnector', id })
  } else {
    for (const id of sel.ids) if (m.boundaries[id] !== undefined) ops.push({ op: 'removeBoundary', id })
  }
  // A node removal can already include connectors/boundaries listed twice when several selected nodes share them.
  if (ops.length === 0) return
  if (edit(ops, { label: 'delete' })) {
    select(null)
    toast(`Deleted. ${navigator.platform.includes('Mac') ? '⌘Z' : 'Ctrl+Z'} to undo.`)
  }
}
