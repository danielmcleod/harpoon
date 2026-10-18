// Facts about one proposed option, computed from its ops so nobody has to type them: how much it changes, which
// services it touches, new vendors and data exposure, problems it introduces, and how far its impact reaches.
import { compareModels } from './diff.ts'
import { dataScope } from './governance.ts'
import { lintModel } from './lint.ts'
import { applyOps } from './ops.ts'
import type { Op } from './ops.ts'
import { ancestorsOf, blastRadius } from './queries.ts'
import type { Model } from './schema.ts'

export interface OptionFacts {
  /** Ops that no longer apply to the current model (the option needs a refresh). */
  stale: number
  nodes: { added: number; modified: number; removed: number }
  connectors: { added: number; modified: number; removed: number }
  /** Existing top-level services it changes or connects to. */
  servicesTouched: string[]
  /** New third-party vendors it brings in. */
  newVendors: string[]
  /** Data classes that reach more components than before (class → how many more). */
  dataExposure: { cls: string; more: number }[]
  /** Problems that appear with it (not there before). */
  newProblems: number
  /** Existing components that depend on what it changes (upstream impact). */
  impact: number
}

const top = (m: Model, id: string): string => {
  const chain = [...ancestorsOf(m, id)].reverse()
  return (chain.find((a) => a.kind !== 'system') ?? m.nodes[id])?.id ?? id
}

export function optionFacts(base: Model, ops: readonly Op[]): { facts: OptionFacts; after: Model } {
  let after = base
  let stale = 0
  for (const o of ops) {
    try {
      after = applyOps(after, [o]).model
    } catch {
      stale++
    }
  }
  const sum = compareModels(base, after)
  const count = (xs: { kind: 'added' | 'modified' | 'removed' }[]): OptionFacts['nodes'] => ({
    added: xs.filter((x) => x.kind === 'added').length,
    modified: xs.filter((x) => x.kind === 'modified').length,
    removed: xs.filter((x) => x.kind === 'removed').length,
  })

  const touched = new Set<string>()
  for (const c of sum.nodes) if (c.kind !== 'added' && base.nodes[c.id] !== undefined) touched.add(top(base, c.id))
  for (const c of sum.connectors) {
    const k = after.connectors[c.id] ?? base.connectors[c.id]
    if (k === undefined) continue
    for (const end of [k.source, k.target]) if (base.nodes[end] !== undefined) touched.add(top(base, end))
  }

  const vendorsBefore = new Set(Object.values(base.nodes).map((n) => n.vendor?.toLowerCase()).filter((v): v is string => v !== undefined))
  const newVendors = [...new Set(Object.values(after.nodes).flatMap((n) => (n.vendor !== null && !vendorsBefore.has(n.vendor.toLowerCase()) ? [n.vendor] : [])))]

  const reach = (m: Model): Map<string, number> => {
    const out = new Map<string, number>()
    for (const byCls of dataScope(m).values()) for (const cls of byCls.keys()) out.set(cls, (out.get(cls) ?? 0) + 1)
    return out
  }
  const before = reach(base)
  const dataExposure = [...reach(after)].flatMap(([cls, n]) => (n > (before.get(cls) ?? 0) ? [{ cls, more: n - (before.get(cls) ?? 0) }] : []))

  const key = (p: { code: string; nodeId?: string; connectorId?: string }): string => `${p.code}|${p.nodeId ?? ''}|${p.connectorId ?? ''}`
  const had = new Set(lintModel(base).map(key))
  const newProblems = lintModel(after).filter((p) => !had.has(key(p))).length

  const impacted = new Set<string>()
  for (const c of [...sum.nodes, ...sum.connectors]) {
    const ids = base.nodes[c.id] !== undefined ? [c.id] : base.connectors[c.id] !== undefined ? [base.connectors[c.id]?.target ?? ''] : []
    for (const id of ids) if (id !== '') for (const x of blastRadius(base, id, 'upstream')) if (x !== id) impacted.add(x)
  }

  return {
    after,
    facts: {
      stale,
      nodes: count(sum.nodes),
      connectors: count(sum.connectors),
      servicesTouched: [...touched].map((id) => base.nodes[id]?.name ?? id).sort(),
      newVendors,
      dataExposure,
      newProblems,
      impact: impacted.size,
    },
  }
}
