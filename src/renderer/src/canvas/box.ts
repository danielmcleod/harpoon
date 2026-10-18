// The DOM box React Flow lays out for each hex, and where the hexagon's centre sits inside it. Edges and particles
// read node centres back through this, so the box and the drawing must agree.
import { ISO_DEPTH, ISO_SQUASH, SQRT3 } from '@shared/geometry/hex.ts'
import type { HexStyle, Point } from '@shared/geometry/hex.ts'

export interface NodeBox {
  width: number
  height: number
  /** Footprint centre inside the box. */
  center: Point
  /** Vertical squash of the footprint (iso nodes). */
  squash: number
}

/** Room under an isometric prism for its label. */
export const ISO_LABEL_H = 30

export function nodeBox(r: number, style: HexStyle, container: boolean): NodeBox {
  if (container || style === 'flat') {
    return { width: 2 * r, height: SQRT3 * r, center: { x: r, y: (SQRT3 * r) / 2 }, squash: 1 }
  }
  const face = SQRT3 * r * ISO_SQUASH
  return { width: 2 * r, height: face + ISO_DEPTH + ISO_LABEL_H, center: { x: r, y: face / 2 }, squash: ISO_SQUASH }
}
