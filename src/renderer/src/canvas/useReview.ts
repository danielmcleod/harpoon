// Diff & Merge: the model the canvas shows while a proposal (or a run's live draft) is reviewed: the current model
// with the change applied, plus whatever the change removes kept in place so it can be drawn in red.
import { useMemo } from 'react'
import { compareModels } from '@shared/model/diff.ts'
import type { ChangeSummary } from '@shared/model/diff.ts'
import { applyOps } from '@shared/model/ops.ts'
import type { Op } from '@shared/model/ops.ts'
import type { Model } from '@shared/model/schema.ts'
import { useStore } from '../state/store.ts'

export interface ReviewView {
  model: Model
  summary: ChangeSummary
  ops: Op[]
  /** Ops that could not be applied on top of the current model (it changed since). */
  skipped: number
}

/** Apply what applies; an op that no longer fits is skipped rather than failing the whole preview. */
function applyLenient(base: Model, ops: readonly Op[]): { model: Model; skipped: number } {
  let model = base
  let skipped = 0
  for (const o of ops) {
    try {
      model = applyOps(model, [o]).model
    } catch {
      skipped++
    }
  }
  return { model, skipped }
}

/** The proposed model plus the removed nodes/connectors (so they can be drawn struck in red). */
export function reviewModel(base: Model, ops: readonly Op[]): ReviewView {
  const { model: after, skipped } = applyLenient(base, ops)
  const summary = compareModels(base, after)
  const union: Model = {
    ...after,
    nodes: { ...after.nodes },
    connectors: { ...after.connectors },
    layout: { ...after.layout },
  }
  for (const c of summary.nodes) {
    if (c.kind !== 'removed') continue
    const n = base.nodes[c.id]
    if (n === undefined) continue
    // A removed node keeps its place; if its parent went too, it still has a valid parent in the union.
    union.nodes[c.id] = n
    const at = base.layout[c.id]
    if (at !== undefined) union.layout[c.id] = at
  }
  for (const c of summary.connectors) {
    if (c.kind !== 'removed') continue
    const k = base.connectors[c.id]
    if (k !== undefined && union.nodes[k.source] !== undefined && union.nodes[k.target] !== undefined) union.connectors[c.id] = k
  }
  return { model: union, summary, ops: [...ops], skipped }
}

export function useReview(): ReviewView | null {
  const base = useStore((s) => s.project?.model)
  const review = useStore((s) => s.ai.review)
  const proposals = useStore((s) => s.ai.proposals)
  const drafts = useStore((s) => s.ai.drafts)
  const excluded = useStore((s) => s.ai.excluded)
  return useMemo(() => {
    if (base === undefined || review === null) return null
    let ops: Op[] | undefined
    if (review.kind === 'proposal') {
      const p = proposals[review.id]
      if (p === undefined || p.status !== 'pending') return null
      ops = p.ops.filter((_, i) => excluded[i] !== true)
    } else ops = drafts[review.runId]
    if (ops === undefined || ops.length === 0) return null
    return reviewModel(base, ops)
  }, [base, review, proposals, drafts, excluded])
}
