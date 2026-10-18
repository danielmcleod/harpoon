// Lenses colour every node by one dimension (status, owning team, data handled, roadmap phase), with a legend whose
// entries can be hidden (nodes with no visible key dim). Pure: model in, marks and legend out.
import { dataClassCatalog, effectiveTeam, phasesInOrder } from '@shared/model/governance.ts'
import type { ScopeReason } from '@shared/model/governance.ts'
import { STATUSES } from '@shared/model/schema.ts'
import type { HxNode, Model, Status } from '@shared/model/schema.ts'

export const LENS_KINDS = ['status', 'team', 'data', 'phase'] as const
export type LensKind = (typeof LENS_KINDS)[number]

export const LENS_LABEL: Record<LensKind, string> = { status: 'Status', team: 'Team', data: 'Data', phase: 'Phase' }
export const LENS_HINT: Record<LensKind, string> = {
  status: 'Colour nodes by status (built, in progress, planned…)',
  team: 'Colour nodes by owning team (a node without one inherits its parent’s)',
  data: 'Colour nodes by the regulated data they handle; dashed: in scope through connectors or inner parts',
  phase: 'Colour nodes by the roadmap phase their change lands in',
}

export const STATUS_COLOR: Record<Status, string> = {
  existing: 'var(--hx-ok)',
  'in-progress': 'var(--hx-warn)',
  planned: 'var(--hx-blue)',
  deprecated: 'var(--hx-slate)',
  removed: 'var(--hx-bad)',
}
const STATUS_TEXT: Record<Status, string> = { existing: 'Built', 'in-progress': 'In progress', planned: 'Planned', deprecated: 'Deprecated', removed: 'Removed' }

/** Categorical order: entries past the palette fold into the neutral colour rather than inventing hues. */
const PALETTE = ['var(--hx-cyan)', 'var(--hx-violet)', 'var(--hx-amber)', 'var(--hx-green)', 'var(--hx-rose)', 'var(--hx-blue)']
const NEUTRAL = 'var(--hx-slate)'
const pick = (i: number): string => PALETTE[i] ?? NEUTRAL

export interface LensMark {
  /** Legend keys this node belongs to (it dims when all are hidden). */
  keys: string[]
  color: string
  label: string
  /** Only derived (inherited team, data in scope but not tagged). */
  derived: boolean
}

export interface LegendEntry {
  key: string
  label: string
  color: string
  count: number
}

export function computeLens(m: Model, kind: LensKind, scope: Map<string, Map<string, ScopeReason>>): { marks: Map<string, LensMark>; legend: LegendEntry[] } {
  const marks = new Map<string, LensMark>()
  const legend: LegendEntry[] = []
  const nodes = Object.values(m.nodes)
  const entry = (key: string, label: string, color: string): LegendEntry => {
    let e = legend.find((x) => x.key === key)
    if (e === undefined) legend.push((e = { key, label, color, count: 0 }))
    return e
  }
  const mark = (n: HxNode, keys: { key: string; label: string; color: string }[], derived: boolean): void => {
    for (const k of keys) entry(k.key, k.label, k.color).count++
    const first = keys[0]
    marks.set(n.id, { keys: keys.map((k) => k.key), color: first?.color ?? NEUTRAL, label: keys.map((k) => k.label).join(' · '), derived })
  }

  if (kind === 'status') {
    for (const st of STATUSES) entry(st, STATUS_TEXT[st], STATUS_COLOR[st])
    for (const n of nodes) mark(n, [{ key: n.status, label: STATUS_TEXT[n.status], color: STATUS_COLOR[n.status] }], false)
  } else if (kind === 'team') {
    const teams = m.meta.teams
    teams.forEach((t, i) => entry(t.id, t.name, t.color ?? pick(i)))
    entry('none', 'No team', NEUTRAL)
    for (const n of nodes) {
      const t = effectiveTeam(m, n.id)
      const team = t === null ? undefined : teams.find((x) => x.id === t.team)
      const i = team === undefined ? -1 : teams.indexOf(team)
      mark(n, [team === undefined ? { key: 'none', label: '', color: NEUTRAL } : { key: team.id, label: team.name, color: team.color ?? pick(i) }], t?.inherited === true)
    }
  } else if (kind === 'data') {
    const catalog = dataClassCatalog(m.meta)
    catalog.forEach((c, i) => entry(c.id, c.label, pick(i)))
    entry('none', 'No regulated data', NEUTRAL)
    for (const n of nodes) {
      const byCls = scope.get(n.id)
      const keys = catalog.flatMap((c, i) => (byCls?.has(c.id) === true ? [{ key: c.id, label: c.label, color: pick(i) }] : []))
      const own = keys.some((k) => byCls?.get(k.key)?.own === true)
      mark(n, keys.length === 0 ? [{ key: 'none', label: '', color: NEUTRAL }] : keys, keys.length > 0 && !own)
    }
    // Hide catalog entries nobody uses, so the legend stays short.
    for (let i = legend.length - 1; i >= 0; i--) if (legend[i]?.count === 0 && legend[i]?.key !== 'none') legend.splice(i, 1)
  } else {
    const phases = phasesInOrder(m.meta)
    entry('today', 'Today (no change)', NEUTRAL)
    phases.forEach((p, i) => entry(p.id, p.name, pick(i)))
    entry('unphased', 'Planned, no phase', NEUTRAL)
    for (const n of nodes) {
      const i = n.phase === null ? -1 : phases.findIndex((p) => p.id === n.phase)
      const p = phases[i]
      if (p !== undefined) mark(n, [{ key: p.id, label: p.name, color: pick(i) }], false)
      else if (n.status === 'planned' || n.status === 'in-progress') mark(n, [{ key: 'unphased', label: 'no phase', color: NEUTRAL }], false)
      else mark(n, [{ key: 'today', label: '', color: NEUTRAL }], false)
    }
  }
  return { marks, legend }
}
