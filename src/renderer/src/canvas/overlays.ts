// What other modes lay over the canvas: the Diff & Merge colours (AI proposals), simulation health, and emphasis
// (flow traces, AI highlights).
import type { ChangeSummary } from '@shared/model/diff.ts'
import type { Health } from './types.ts'

export interface CanvasOverlays {
  diff?: ChangeSummary | null
  health?: ReadonlyMap<string, Health> | null
  edgeHealth?: ReadonlyMap<string, Health> | null
  emphasis?: ReadonlySet<string> | null
  /** Draw traffic particles (simulator). */
  particles?: boolean
  /** Overrides the blast/search highlight. */
  highlight?: ReadonlySet<string> | null
}
