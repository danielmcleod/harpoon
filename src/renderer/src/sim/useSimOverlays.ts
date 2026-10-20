// Canvas overlays in Traffic Simulator mode: node and connector health from the current frame, particles, and the
// traced flow's current step. Health maps only change identity when some health actually changes, so the canvas does
// not rebuild on every tick.
import { useMemo } from 'react'
import type { Health } from '@shared/sim/engine.ts'
import type { CanvasOverlays, NodeMark } from '../canvas/overlays.ts'
import { useStore } from '../state/store.ts'
import { currentFrame, useSim } from './simStore.ts'
import { BREAK_MARK, useTrafficBreaks } from './useTrafficBreaks.ts'

export function useSimOverlays(active: boolean): CanvasOverlays | undefined {
  const healthKey = useSim((s) => {
    const f = currentFrame(s)
    if (f === null) return ''
    const n = Object.entries(f.nodes).map(([id, x]) => (x.health === 'ok' ? '' : `${id}:${x.health}`)).filter(Boolean).join('|')
    const e = Object.entries(f.edges).map(([id, x]) => (x.health === 'ok' ? '' : `${id}:${x.health}`)).filter(Boolean).join('|')
    return `${n}#${e}#${f.t > 0 ? 1 : 0}`
  })
  const trace = useSim((s) => s.trace)
  const flows = useStore((s) => s.project?.model.flows)
  const connectors = useStore((s) => s.project?.model.connectors)
  const breaks = useTrafficBreaks()

  return useMemo(() => {
    if (!active) return undefined
    const health = new Map<string, Health>()
    const edgeHealth = new Map<string, Health>()
    const [n = '', e = '', running = '0'] = healthKey.split('#')
    // Only colour things once the simulation has run; at t = 0 every node keeps its own colour.
    if (running === '1') {
      for (const part of n.split('|').filter(Boolean)) {
        const [id, h] = part.split(':')
        if (id !== undefined && (h === 'warn' || h === 'bad')) health.set(id, h)
      }
      for (const part of e.split('|').filter(Boolean)) {
        const [id, h] = part.split(':')
        if (id !== undefined && (h === 'warn' || h === 'bad')) edgeHealth.set(id, h)
      }
    }
    let emphasis: Set<string> | null = null
    let highlight: Set<string> | null = null
    if (trace !== null) {
      const step = flows?.[trace.flowId]?.steps[trace.step]
      const c = step === undefined ? undefined : connectors?.[step.connectorId]
      if (step !== undefined && c !== undefined) {
        emphasis = new Set([c.id])
        highlight = new Set([c.source, c.target])
      }
    }
    // Where traffic stops: a marker on the node (or the container it is drawn inside).
    const marks = new Map<string, NodeMark>()
    for (const b of breaks) {
      const mk = BREAK_MARK[b.kind]
      if (mk !== undefined && !marks.has(b.nodeId)) marks.set(b.nodeId, { ...mk, title: `${b.message} ${b.hint}` })
    }
    return { health, edgeHealth, particles: true, emphasis, highlight, marks }
  }, [active, healthKey, trace, flows, connectors, breaks])
}
