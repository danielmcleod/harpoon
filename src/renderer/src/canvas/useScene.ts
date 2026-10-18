// The scene for the current model and view state, memoized; and the highlight set (blast radius, search).
import { useMemo } from 'react'
import { computeScene } from '@shared/geometry/scene.ts'
import type { Scene } from '@shared/geometry/scene.ts'
import { ancestorsOf, impactOf } from '@shared/model/queries.ts'
import type { ImpactHit } from '@shared/model/queries.ts'
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
  return useMemo(
    () => computeScene(model, { expanded: new Set(Object.keys(expanded)), focusId, style }),
    [model, expanded, focusId, style],
  )
}

/** Impact analysis of the node in `ui.blast` (what breaks if it fails, what it needs), or null. */
export function useImpact(model: Model): ReadonlyMap<string, ImpactHit> | null {
  const blast = useStore((s) => s.ui.blast)
  return useMemo(() => (blast === null || model.nodes[blast.id] === undefined ? null : impactOf(model, blast.id, blast.dir, blast.hops)), [model, blast])
}

/** Nodes that stay bright (impact analysis or search); null when nothing is isolated. */
export function useHighlight(model: Model): ReadonlySet<string> | null {
  const blast = useStore((s) => s.ui.blast)
  const search = useStore((s) => s.ui.search)
  const aiHighlight = useStore((s) => s.ai.highlight)
  return useMemo(() => {
    let ids: Set<string> | null = null
    if (aiHighlight !== null && aiHighlight.nodeIds.length > 0) ids = new Set(aiHighlight.nodeIds.filter((id) => model.nodes[id] !== undefined))
    if (blast !== null && model.nodes[blast.id] !== undefined) ids = new Set(impactOf(model, blast.id, blast.dir, blast.hops).keys())
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
