// Canvas tooltips in Traffic Simulator mode: why a node is strained or failing in the frame on screen, worked out on
// hover (the text changes every tick, so it is not baked into the canvas).
import { nodeWhy } from '@shared/sim/explain.ts'
import { getState } from '../state/store.ts'
import { currentFrame, useSim } from './simStore.ts'

export function simWhy(id: string): string | null {
  const s = getState()
  if (s.ui.mode !== 'sim') return null
  const model = s.project?.model
  const frame = currentFrame(useSim.getState())
  return model === undefined || frame === null ? null : nodeWhy(model, frame, id)
}
