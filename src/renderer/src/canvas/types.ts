// React Flow node/edge data for the hex canvas.
import type { Edge, Node } from '@xyflow/react'
import type { HexStyle } from '@shared/geometry/hex.ts'
import type { ChangeKind } from '@shared/model/diff.ts'
import type { HxConnector, HxNode } from '@shared/model/schema.ts'
import type { LensMark } from './lensMarks.ts'

export type Health = 'ok' | 'warn' | 'bad'

export interface HexData extends Record<string, unknown> {
  node: HxNode
  r: number
  style: HexStyle
  expanded: boolean
  ghost: boolean
  childCount: number
  /** Dimmed (blast-radius isolation, search miss). */
  dim: boolean
  /** Diff & Merge overlay. */
  diff: ChangeKind | null
  health: Health | null
  editable: boolean
  /** A label for ghosts: where the outside node lives. */
  context: string | null
  /** Impact analysis: this node's role and distance. */
  impact: { hop: number; kind: 'origin' | 'affected' | 'needed' } | null
  /** Lens: drawn in the lens colour with a label (null: lens off). */
  lens: LensMark | null
}

export type HexFlowNode = Node<HexData, 'hex' | 'container'>

export interface HarpoonData extends Record<string, unknown> {
  connectors: HxConnector[]
  dim: boolean
  diff: ChangeKind | null
  /** Flow trace / highlight emphasis. */
  emphasis: boolean
  /** Where along the line (0..1) the badge sits, chosen so badges do not overlap. */
  badgeT: number
  health: Health | null
}

export type HarpoonFlowEdge = Edge<HarpoonData, 'harpoon'>
