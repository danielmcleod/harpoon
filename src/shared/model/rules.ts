// Custom architecture rules: small typed predicates over the model (no code), so they are safe to share, the AI can
// write them, and Harpoon checks them on the spot. A rule picks entities (target + where) and says what must hold
// for each (require); every entity that fails becomes a problem.
//
//   { target: 'node', where: { field: 'kind', op: 'in', value: ['frontend', 'mobile'] },
//     require: { connectsTo: { dir: 'out', where: { not: { field: 'kind', op: 'eq', value: 'gateway' } } }, count: 'none' } }
//   = "frontends call nothing but a gateway"
//
// Guidelines are the prose half: conventions Harpoon cannot check (they shape AI designs and implementation briefs).
import { z } from 'zod'
import { channelEncrypted, connectorDataClasses, dataScope, effectiveTeam } from './governance.ts'
import { ancestorsOf, childrenOf } from './queries.ts'
import type { HxBoundary, HxConnector, HxNode, Model } from './schema.ts'

export const RULE_OPS = ['eq', 'ne', 'in', 'notIn', 'includes', 'excludes', 'exists', 'empty', 'matches', 'gt', 'lt'] as const
export type RuleOp = (typeof RULE_OPS)[number]
export const RULE_TARGETS = ['node', 'connector', 'boundary'] as const
export type RuleTarget = (typeof RULE_TARGETS)[number]
export const SEVERITIES = ['error', 'warn', 'info'] as const

export interface FieldTest {
  field: string
  op: RuleOp
  value?: unknown
}
export type Cond =
  | { all: Cond[] }
  | { any: Cond[] }
  | { not: Cond }
  | FieldTest
  /** Nodes: its connections (out: it calls/sends, in: it is called) to nodes matching `where`, over connectors matching `via`. */
  | { connectsTo: { dir: 'out' | 'in' | 'any'; where?: Cond; via?: Cond }; count?: 'some' | 'none' | 'all' }
  /** Nodes: inside a boundary matching `where` (directly or through a parent). */
  | { insideBoundary: { where?: Cond } }
  /** Nodes: some ancestor matches. */
  | { hasAncestor: Cond }
  /** Nodes: some direct child matches. */
  | { hasChild: Cond }
  /** Connectors: its two ends belong to different (effective) teams. */
  | { crossesTeam: boolean }
  /** Connectors: its two ends are in different boundaries, or one is external. */
  | { crossesBoundary: boolean }

/**
 * Rule regexes come from shared projects and from the AI, and run on the main thread: short patterns only, and none
 * of the nested-repetition shapes that backtrack exponentially (`(a+)+`, `(a*)*`, `(a|aa)+`).
 */
export function unsafePattern(p: string): string | null {
  if (p.length > 200) return 'is longer than 200 characters'
  if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(p)) return 'repeats a group that itself repeats'
  if (/\([^)]*\|[^)]*\)\s*[+*{]/.test(p)) return 'repeats a group of alternatives'
  if (/\\[1-9]/.test(p)) return 'uses back-references'
  try {
    new RegExp(p)
  } catch {
    return 'is not a valid regular expression'
  }
  return null
}

const FieldTestZ = z.object({ field: z.string().min(1).max(100), op: z.enum(RULE_OPS), value: z.unknown().optional() })

/**
 * The first unsafe "matches" pattern in a rule, as a message (null: none). Checked where rules come in (the AI, the
 * JSON editor, rule packs); evaluation skips unsafe patterns too, so an old or hand-edited project file cannot hang
 * the app, and it still opens.
 */
export function ruleProblem(r: { where: Cond | null; require: Cond }): string | null {
  const walk = (c: Cond | null | undefined): string | null => {
    if (c === null || c === undefined) return null
    if ('field' in c) {
      const bad = c.op === 'matches' ? unsafePattern(String(c.value)) : null
      return bad === null ? null : `The pattern for ${c.field} ${bad}.`
    }
    if ('all' in c) return c.all.map(walk).find((x) => x !== null) ?? null
    if ('any' in c) return c.any.map(walk).find((x) => x !== null) ?? null
    if ('not' in c) return walk(c.not)
    if ('connectsTo' in c) return walk(c.connectsTo.where) ?? walk(c.connectsTo.via)
    if ('insideBoundary' in c) return walk(c.insideBoundary.where)
    if ('hasAncestor' in c) return walk(c.hasAncestor)
    if ('hasChild' in c) return walk(c.hasChild)
    return null
  }
  return walk(r.where) ?? walk(r.require)
}
export const CondZ: z.ZodType<Cond> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(CondZ).max(20) }),
    z.object({ any: z.array(CondZ).max(20) }),
    z.object({ not: CondZ }),
    z.object({ connectsTo: z.object({ dir: z.enum(['out', 'in', 'any']), where: CondZ.optional(), via: CondZ.optional() }), count: z.enum(['some', 'none', 'all']).optional() }),
    z.object({ insideBoundary: z.object({ where: CondZ.optional() }) }),
    z.object({ hasAncestor: CondZ }),
    z.object({ hasChild: CondZ }),
    z.object({ crossesTeam: z.boolean() }),
    z.object({ crossesBoundary: z.boolean() }),
    FieldTestZ,
  ]),
) as z.ZodType<Cond>

export const RuleZ = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  severity: z.enum(SEVERITIES).default('warn'),
  enabled: z.boolean().default(true),
  target: z.enum(RULE_TARGETS),
  where: CondZ.nullable().default(null),
  require: CondZ,
  /** Shown per failing entity; {name}, {kind}, {source} and {target} are filled in. */
  message: z.string().max(500).default(''),
})
export type Rule = z.infer<typeof RuleZ>

export const GuidelineZ = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  title: z.string().min(1).max(200),
  text: z.string().max(5000).default(''),
  enabled: z.boolean().default(true),
  /** Where the pattern was seen (a scan's evidence), free text. */
  evidence: z.string().max(2000).default(''),
})
export type Guideline = z.infer<typeof GuidelineZ>

/** A rule pack file: rules and guidelines to share between projects. */
export const RulePackZ = z.object({ harpoonRulePack: z.literal(1), name: z.string().max(200).default(''), rules: z.array(RuleZ).max(500).default([]), guidelines: z.array(GuidelineZ).max(500).default([]) })
export type RulePack = z.infer<typeof RulePackZ>

// ---- evaluation --------------------------------------------------------------------------------------------

type Entity = { kind: 'node'; v: HxNode } | { kind: 'connector'; v: HxConnector } | { kind: 'boundary'; v: HxBoundary }

/** Cached per-model derived data the conditions use. */
interface Ctx {
  m: Model
  scope: ReturnType<typeof dataScope>
  boundariesOf: Map<string, HxBoundary[]>
}

function ctxOf(m: Model): Ctx {
  const boundariesOf = new Map<string, HxBoundary[]>()
  for (const b of Object.values(m.boundaries)) for (const id of b.nodeIds) boundariesOf.set(id, [...(boundariesOf.get(id) ?? []), b])
  return { m, scope: dataScope(m), boundariesOf }
}

/** Boundaries a node is in, directly or through a parent. */
const zonesOf = (c: Ctx, id: string): HxBoundary[] => [id, ...ancestorsOf(c.m, id).map((a) => a.id)].flatMap((x) => c.boundariesOf.get(x) ?? [])

/** A field of an entity, including derived ones (team = effective team, dataClasses = data scope…). */
export function fieldValue(c: Ctx, e: Entity, path: string): unknown {
  const [head, ...rest] = path.split('.')
  if (e.kind === 'connector' && (head === 'source' || head === 'target')) {
    const n = c.m.nodes[head === 'source' ? e.v.source : e.v.target]
    return n === undefined ? undefined : fieldValue(c, { kind: 'node', v: n }, rest.join('.'))
  }
  if (e.kind === 'node') {
    const n = e.v
    switch (path) {
      case 'team':
        return effectiveTeam(c.m, n.id)?.team ?? null
      case 'ownTeam':
        return n.team
      case 'dataClasses':
        return [...(c.scope.get(n.id)?.keys() ?? [])]
      case 'ownDataClasses':
        return n.dataClasses
      case 'inbound':
        return Object.values(c.m.connectors).filter((x) => x.target === n.id).length
      case 'outbound':
        return Object.values(c.m.connectors).filter((x) => x.source === n.id).length
      case 'children':
        return childrenOf(c.m, n.id).length
      case 'parent.kind':
        return n.parentId === null ? null : (c.m.nodes[n.parentId]?.kind ?? null)
      case 'features.count':
        return n.features.length
      case 'boundaries':
        return zonesOf(c, n.id).map((b) => b.type)
    }
  }
  if (e.kind === 'connector') {
    const k = e.v
    switch (path) {
      case 'protocol':
        return k.channelA.protocol
      case 'auth':
        return k.channelA.auth
      case 'encrypted':
        return channelEncrypted(k.channelA) && (k.channelB === null || channelEncrypted(k.channelB))
      case 'dataClasses':
        return connectorDataClasses(k)
    }
  }
  let cur: unknown = e.v
  for (const p of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

const isEmpty = (v: unknown): boolean => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
const lower = (v: unknown): unknown => (typeof v === 'string' ? v.toLowerCase() : v)
const eq = (a: unknown, b: unknown): boolean => lower(a) === lower(b)

function test(c: Ctx, e: Entity, t: FieldTest): boolean {
  const v = fieldValue(c, e, t.field)
  const list = Array.isArray(t.value) ? t.value : [t.value]
  switch (t.op) {
    case 'eq':
      return eq(v, t.value)
    case 'ne':
      return !eq(v, t.value)
    case 'in':
      return list.some((x) => eq(v, x))
    case 'notIn':
      return !list.some((x) => eq(v, x))
    case 'includes':
      return Array.isArray(v) && list.some((x) => v.some((y) => eq(y, x)))
    case 'excludes':
      return !Array.isArray(v) || !list.some((x) => v.some((y) => eq(y, x)))
    case 'exists':
      return !isEmpty(v)
    case 'empty':
      return isEmpty(v)
    case 'matches':
      // Checked again here: a rule can reach evaluation without passing the schema (an old file, a test).
      if (typeof v !== 'string' || unsafePattern(String(t.value)) !== null) return false
      try {
        return new RegExp(String(t.value), 'i').test(v.slice(0, 1000))
      } catch {
        return false
      }
    case 'gt':
      return typeof v === 'number' && v > Number(t.value)
    case 'lt':
      return typeof v === 'number' && v < Number(t.value)
  }
}

export function holds(c: Ctx, e: Entity, cond: Cond): boolean {
  if ('all' in cond) return cond.all.every((x) => holds(c, e, x))
  if ('any' in cond) return cond.any.some((x) => holds(c, e, x))
  if ('not' in cond) return !holds(c, e, cond.not)
  if ('field' in cond) return test(c, e, cond)
  if ('crossesTeam' in cond) {
    if (e.kind !== 'connector') return false
    const a = effectiveTeam(c.m, e.v.source)?.team ?? null
    const b = effectiveTeam(c.m, e.v.target)?.team ?? null
    return (a !== null && b !== null && a !== b) === cond.crossesTeam
  }
  if ('crossesBoundary' in cond) {
    if (e.kind !== 'connector') return false
    const s = c.m.nodes[e.v.source]
    const t = c.m.nodes[e.v.target]
    if (s === undefined || t === undefined) return false
    const zs = new Set(zonesOf(c, s.id).map((b) => b.id))
    const zt = new Set(zonesOf(c, t.id).map((b) => b.id))
    const differ = s.boundary !== t.boundary || zs.size !== zt.size || [...zs].some((z) => !zt.has(z))
    return differ === cond.crossesBoundary
  }
  if (e.kind !== 'node') return false
  const n = e.v
  if ('connectsTo' in cond) {
    const { dir, where, via } = cond.connectsTo
    const links = Object.values(c.m.connectors).flatMap((k) => {
      const out = k.source === n.id && dir !== 'in' ? k.target : null
      const inn = k.target === n.id && dir !== 'out' ? k.source : null
      return [out, inn].filter((x): x is string => x !== null).map((other) => ({ k, other }))
    })
    const ok = links.filter(({ k, other }) => {
      const o = c.m.nodes[other]
      return o !== undefined && (where === undefined || holds(c, { kind: 'node', v: o }, where)) && (via === undefined || holds(c, { kind: 'connector', v: k }, via))
    })
    const count = cond.count ?? 'some'
    if (count === 'none') return ok.length === 0
    if (count === 'all') return links.length > 0 && ok.length === links.length
    return ok.length > 0
  }
  if ('insideBoundary' in cond) return zonesOf(c, n.id).some((b) => cond.insideBoundary.where === undefined || holds(c, { kind: 'boundary', v: b }, cond.insideBoundary.where))
  if ('hasAncestor' in cond) return ancestorsOf(c.m, n.id).some((a) => holds(c, { kind: 'node', v: a }, cond.hasAncestor))
  if ('hasChild' in cond) return childrenOf(c.m, n.id).some((k) => holds(c, { kind: 'node', v: k }, cond.hasChild))
  return false
}

export interface RuleHit {
  rule: Rule
  entity: 'node' | 'connector' | 'boundary'
  id: string
  message: string
}

const entitiesOf = (m: Model, target: RuleTarget): Entity[] =>
  target === 'node'
    ? Object.values(m.nodes).filter((n) => n.status !== 'removed').map((v) => ({ kind: 'node' as const, v }))
    : target === 'connector'
      ? Object.values(m.connectors).filter((k) => k.status !== 'removed').map((v) => ({ kind: 'connector' as const, v }))
      : Object.values(m.boundaries).map((v) => ({ kind: 'boundary' as const, v }))

function messageFor(m: Model, r: Rule, e: Entity): string {
  const nm = (id: string): string => m.nodes[id]?.name ?? id
  const name = e.kind === 'connector' ? `${nm(e.v.source)} → ${nm(e.v.target)}` : e.v.name
  const tpl = r.message.trim() !== '' ? r.message : `{name} breaks the rule “${r.name}”.`
  return tpl
    .replace(/\{name\}/g, name)
    .replace(/\{kind\}/g, e.kind === 'node' ? e.v.kind : e.kind)
    .replace(/\{source\}/g, e.kind === 'connector' ? nm(e.v.source) : '')
    .replace(/\{target\}/g, e.kind === 'connector' ? nm(e.v.target) : '')
}

/** Everything the rules flag; `matched` counts the entities each rule applies to (for "11 of 12 follow it"). */
export function evaluateRules(m: Model, rules: readonly Rule[]): { hits: RuleHit[]; matched: Map<string, number> } {
  const c = ctxOf(m)
  const hits: RuleHit[] = []
  const matched = new Map<string, number>()
  for (const r of rules) {
    if (!r.enabled) continue
    let n = 0
    for (const e of entitiesOf(m, r.target)) {
      if (r.where !== null && !holds(c, e, r.where)) continue
      n++
      if (!holds(c, e, r.require)) hits.push({ rule: r, entity: e.kind, id: e.v.id, message: messageFor(m, r, e) })
    }
    matched.set(r.id, n)
  }
  return { hits, matched }
}

/** One rule against the model: how many entities it applies to and which break it (the "test" button, the scan). */
export function testRule(m: Model, r: Rule): { applies: number; violations: RuleHit[] } {
  const { hits, matched } = evaluateRules(m, [{ ...r, enabled: true }])
  return { applies: matched.get(r.id) ?? 0, violations: hits }
}

/** Ready-made rules to start from (the Rules tab's templates). */
export const RULE_TEMPLATES: readonly Rule[] = [
  {
    id: 'owner-required',
    name: 'Every service has an owning team',
    description: 'Someone to call when it breaks.',
    severity: 'warn',
    enabled: true,
    target: 'node',
    where: { all: [{ field: 'kind', op: 'in', value: ['service', 'worker', 'function', 'gateway', 'frontend'] }, { field: 'boundary', op: 'eq', value: 'internal' }] },
    require: { field: 'team', op: 'exists' },
    message: '{name} has no owning team.',
  },
  {
    id: 'frontends-via-gateway',
    name: 'Clients call only through a gateway',
    description: 'Frontends, mobile and desktop apps reach the backend through a gateway or BFF.',
    severity: 'warn',
    enabled: true,
    target: 'node',
    where: { field: 'kind', op: 'in', value: ['frontend', 'mobile', 'desktop', 'client'] },
    require: { connectsTo: { dir: 'out', where: { all: [{ field: 'kind', op: 'notIn', value: ['gateway', 'cdn', 'identity'] }, { field: 'boundary', op: 'eq', value: 'internal' }] } }, count: 'none' },
    message: '{name} calls a backend directly instead of through a gateway.',
  },
  {
    id: 'no-shared-databases',
    name: 'No database access across teams',
    description: 'A team’s data stores are reached through its services, not directly by other teams.',
    severity: 'error',
    enabled: true,
    target: 'connector',
    where: { all: [{ field: 'target.kind', op: 'in', value: ['database', 'warehouse', 'search'] }, { crossesTeam: true }] },
    // Nothing satisfies an empty "any": every matching connector is flagged.
    require: { any: [] },
    message: '{source} reads another team’s database ({target}).',
  },
  {
    id: 'external-authenticated',
    name: 'Links that leave the system authenticate',
    description: 'Every connector to or from a third party names its auth.',
    severity: 'warn',
    enabled: true,
    target: 'connector',
    where: { crossesBoundary: true },
    require: { field: 'auth', op: 'exists' },
    message: '{name} crosses a boundary without auth.',
  },
  {
    id: 'encrypted-in-transit',
    name: 'Everything is encrypted in transit',
    description: 'TLS or mTLS on every connector.',
    severity: 'info',
    enabled: true,
    target: 'connector',
    where: null,
    require: { field: 'encrypted', op: 'eq', value: true },
    message: '{name} is not encrypted in transit.',
  },
  {
    id: 'queues-have-dlq',
    name: 'Queues have a dead-letter queue',
    description: 'Every queue has a dead-letter companion (a queue it sends failed messages to, or tagged "dlq").',
    severity: 'info',
    enabled: true,
    target: 'node',
    where: { all: [{ field: 'kind', op: 'eq', value: 'queue' }, { field: 'tags', op: 'excludes', value: ['dlq'] }] },
    require: { any: [{ connectsTo: { dir: 'out', where: { field: 'tags', op: 'includes', value: ['dlq'] } } }, { field: 'name', op: 'matches', value: 'dlq|dead' }] },
    message: '{name} has no dead-letter queue.',
  },
  {
    id: 'services-documented',
    name: 'Services are described',
    description: 'Every internal service has a description.',
    severity: 'info',
    enabled: true,
    target: 'node',
    where: { all: [{ field: 'kind', op: 'in', value: ['service', 'worker', 'gateway'] }, { field: 'boundary', op: 'eq', value: 'internal' }] },
    require: { field: 'description', op: 'exists' },
    message: '{name} has no description.',
  },
]
