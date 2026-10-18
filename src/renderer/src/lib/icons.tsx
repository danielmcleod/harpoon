// Node-kind icons (KIND_INFO names → lucide components) and kind colours as CSS variables.
import {
  Activity,
  AppWindow,
  BrainCircuit,
  CircuitBoard,
  Monitor,
  Router,
  Search,
  Server,
  Smartphone,
  Warehouse,
  Workflow,
  Box,
  Boxes,
  Clock,
  Cloud,
  Cog,
  Cpu,
  Database,
  Globe,
  HardDrive,
  KeyRound,
  Layers,
  ListOrdered,
  MonitorSmartphone,
  Network,
  Waves,
  Zap,
  Puzzle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { KIND_INFO } from '@shared/model/kinds.ts'
import type { KindColor } from '@shared/model/kinds.ts'
import type { HxNode, NodeKind } from '@shared/model/schema.ts'

const ICONS: Readonly<Record<string, LucideIcon>> = {
  activity: Activity,
  box: Box,
  puzzle: Puzzle,
  boxes: Boxes,
  clock: Clock,
  cloud: Cloud,
  cog: Cog,
  cpu: Cpu,
  database: Database,
  globe: Globe,
  'hard-drive': HardDrive,
  'key-round': KeyRound,
  layers: Layers,
  'list-ordered': ListOrdered,
  'monitor-smartphone': MonitorSmartphone,
  network: Network,
  waves: Waves,
  zap: Zap,
  'app-window': AppWindow,
  smartphone: Smartphone,
  monitor: Monitor,
  'circuit-board': CircuitBoard,
  search: Search,
  'brain-circuit': BrainCircuit,
  warehouse: Warehouse,
  workflow: Workflow,
  router: Router,
  server: Server,
}

export function kindIcon(kind: NodeKind): LucideIcon {
  return ICONS[KIND_INFO[kind].icon] ?? Box
}

export const colorVar = (c: KindColor): string => `var(--hx-${c})`

/** The stroke colour of a node: external nodes are amber, others take their kind's colour. */
export function nodeColor(n: Pick<HxNode, 'kind' | 'boundary'>): string {
  return n.boundary === 'external' ? 'var(--hx-amber)' : colorVar(KIND_INFO[n.kind].color)
}
