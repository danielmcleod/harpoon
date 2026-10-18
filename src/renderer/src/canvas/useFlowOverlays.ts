// A selected flow (project overview → Flows) is drawn on the canvas: its connectors emphasized, everything off its
// path dimmed.
import { useMemo } from 'react'
import { ancestorsOf } from '@shared/model/queries.ts'
import { useStore } from '../state/store.ts'
import type { CanvasOverlays } from './overlays.ts'

export function useFlowOverlays(active: boolean): CanvasOverlays | undefined {
  const flowId = useStore((s) => s.ui.flowId)
  const model = useStore((s) => s.project?.model)
  return useMemo(() => {
    if (!active || flowId === null || model === undefined) return undefined
    const flow = model.flows[flowId]
    if (flow === undefined || flow.steps.length === 0) return undefined
    const emphasis = new Set<string>()
    const highlight = new Set<string>()
    for (const st of flow.steps) {
      const c = model.connectors[st.connectorId]
      if (c === undefined) continue
      emphasis.add(c.id)
      for (const id of [c.source, c.target]) {
        highlight.add(id)
        for (const a of ancestorsOf(model, id)) highlight.add(a.id)
      }
    }
    return { emphasis, highlight }
  }, [active, flowId, model])
}
