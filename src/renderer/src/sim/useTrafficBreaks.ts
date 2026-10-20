// Where simulated traffic stops in the open project, and why (paths.ts), recomputed when the model changes.
import { useMemo } from 'react'
import { trafficBreaks } from '@shared/sim/paths.ts'
import type { TrafficBreak } from '@shared/sim/paths.ts'
import { useStore } from '../state/store.ts'

export function useTrafficBreaks(): TrafficBreak[] {
  const model = useStore((s) => s.project?.model)
  return useMemo(() => (model === undefined ? [] : trafficBreaks(model)), [model])
}

/** Marker text for the canvas: stops and never-reached nodes (hops are listed, not marked). */
export const BREAK_MARK: Partial<Record<TrafficBreak['kind'], { label: string; tone: 'bad' | 'warn' }>> = {
  'dead-end': { label: 'Stops', tone: 'bad' },
  reversed: { label: 'No traffic', tone: 'warn' },
  'never-reached': { label: 'Unreached', tone: 'warn' },
}
