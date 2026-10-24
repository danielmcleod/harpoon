// The scene for the current model and view state, memoized; and the highlight set (blast radius, search).
import { useMemo } from 'react'
import { computeScene } from '@shared/geometry/scene.ts'
import type { Scene } from '@shared/geometry/scene.ts'
import { ancestorsOf, impactOf } from '@shared/model/queries.ts'
import { failureImpact } from '@shared/model/resilience.ts'
import type { FailureScope } from '@shared/model/resilience.ts'
import { emptyModel } from '@shared/model/schema.ts'
import type { Model } from '@shared/model/schema.ts'
import { useStore } from '../state/store.ts'

const EMPTY: Model = emptyModel({ id: 'x', name: 'x' })

export function useModel(): Model {
  return useStore((s) => s.project?.model ?? EMPTY)
}

export function useScene(model: Model): Scene {
  const expanded = useStore((s) => s.ui.expanded)
  const focusId = useStore((s) => s.ui.focusId)
  const style = useStore((s) => s.prefs.nodeStyle)
  const detail = useStore((s) => s.ui.detail)
  return useMemo(
    () => computeScene(model, { expanded: new Set(Object.keys(expanded)), focusId, style, detail }),
    [model, expanded, focusId, style, detail],
  )
}

/** Impact analysis of the node in `ui.blast` (what breaks if it fails, what it needs), or null. */
export function useImpact(model: Model): ReadonlyMap<string, ImpactMark> | null {
  const blast = useStore((s) => s.ui.blast)
  return useMemo(() => {
    if (blast === null || model.nodes[blast.id] === undefined) return null
    if (blast.failure == null) return impactOf(model, blast.id, blast.dir, blast.hops)
    return failureMarks(model, blast.id, blast.failure)
  }, [model, blast])
}

/** Nodes that stay bright (impact analysis or search); null when nothing is isolated. */
export function useHighlight(model: Model): ReadonlySet<string> | null {
  const blast = useStore((s) => s.ui.blast)
  const search = useStore((s) => s.ui.search)
  const aiHighlight = useStore((s) => s.ai.highlight)
  return useMemo(() => {
    let ids: Set<string> | null = null
    if (aiHighlight !== null && aiHighlight.nodeIds.length > 0) ids = new Set(aiHighlight.nodeIds.filter((id) => model.nodes[id] !== undefined))
    if (blast !== null && model.nodes[blast.id] !== undefined) ids = new Set((blast.failure == null ? impactOf(model, blast.id, blast.dir, blast.hops) : failureMarks(model, blast.id, blast.failure)).keys())
    const q = search.trim().toLowerCase()
    if (q !== '') {
      const hits = new Set<string>()
      for (const n of Object.values(model.nodes)) {
        const hay = [n.name, n.id, n.techStack ?? '', n.vendor ?? '', ...n.tags, ...n.features.map((f) => f.name)].join(' ').toLowerCase()
        if (hay.includes(q)) hits.add(n.id)
      }
      ids = ids === null ? hits : new Set([...ids].filter((x) => hits.has(x)))
    }
    if (ids === null) return null
    // Keep the containers of highlighted nodes bright too.
    const out = new Set(ids)
    for (const id of ids) for (const a of ancestorsOf(model, id)) out.add(a.id)
    return out
  }, [model, blast, search, aiHighlight])
}

/** A failure's effect as impact marks: the start, what goes down (red) and what degrades (amber). */
export function failureMarks(model: Model, id: string, scope: FailureScope): Map<string, ImpactMark> {
  const out = new Map<string, ImpactMark>([[id, { hop: 0, kind: 'origin' }]])
  for (const [nid, e] of failureImpact(model, id, scope)) if (nid !== id) out.set(nid, { hop: 0, kind: e === 'down' ? 'affected' : 'degraded' })
  return out
}

export type ImpactMark = { hop: number; kind: 'origin' | 'affected' | 'needed' | 'degraded' }
