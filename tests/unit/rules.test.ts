import { describe, expect, it } from 'vitest'
import { lintModel } from '../../src/shared/model/lint.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import { RULE_TEMPLATES, RuleZ, testRule } from '../../src/shared/model/rules.ts'
import type { Rule } from '../../src/shared/model/rules.ts'
import { sampleOps } from '../../src/shared/model/sample.ts'
import { ConnectorZ, NodeZ, emptyModel } from '../../src/shared/model/schema.ts'

const sample = () => applyOps(emptyModel({ id: 'p', name: 'P' }), sampleOps()).model
const tpl = (id: string): Rule => {
  const r = RULE_TEMPLATES.find((x) => x.id === id)
  if (r === undefined) throw new Error(id)
  return r
}
const names = (m: ReturnType<typeof sample>, r: Rule): string[] => testRule(m, r).violations.map((v) => m.nodes[v.id]?.name ?? v.id).sort()

describe('custom rules', () => {
  it('every template is a valid rule', () => {
    for (const r of RULE_TEMPLATES) expect(RuleZ.safeParse(r).success).toBe(true)
  })

  it('field tests: owners, with the team inherited from the parent', () => {
    const m = applyOps(sample(), [
      { op: 'updateMeta', patch: { teams: [{ id: 'id', name: 'Identity', contact: null, color: null }] } },
      { op: 'updateNode', id: 'auth-service', patch: { team: 'id' } },
    ]).model
    const r = testRule(m, tpl('owner-required'))
    expect(r.applies).toBeGreaterThan(3)
    expect(r.violations.some((v) => v.id === 'auth-worker')).toBe(false) // inherits Identity
    expect(r.violations.some((v) => v.id === 'payment-api')).toBe(true)
  })

  it('relations: clients that bypass the gateway', () => {
    const m = applyOps(sample(), [
      { op: 'addNode', node: NodeZ.parse({ id: 'admin', name: 'Admin app', kind: 'frontend' }), at: { q: -5, r: 0 } },
      { op: 'addConnector', connector: ConnectorZ.parse({ id: 'admin-users', source: 'admin', target: 'user-service' }) },
    ]).model
    expect(names(m, tpl('frontends-via-gateway'))).toEqual(['Admin app'])
  })

  it('crossing teams: one team reading another team’s database', () => {
    const m = applyOps(sample(), [
      { op: 'updateMeta', patch: { teams: [{ id: 'a', name: 'A', contact: null, color: null }, { id: 'b', name: 'B', contact: null, color: null }] } },
      { op: 'updateNode', id: 'auth-service', patch: { team: 'a' } },
      { op: 'updateNode', id: 'payment-api', patch: { team: 'b' } },
      { op: 'addConnector', connector: ConnectorZ.parse({ id: 'sneaky', source: 'payments-core', target: 'user-db', channelA: { protocol: 'SQL' } }) },
    ]).model
    const v = testRule(m, tpl('no-shared-databases')).violations
    expect(v.map((x) => x.id)).toEqual(['sneaky'])
    expect(v[0]?.message).toBe('payments-core reads another team’s database (user-db).')
  })

  it('enabled project rules show up as problems', () => {
    const m = applyOps(sample(), [{ op: 'updateMeta', patch: { rules: [tpl('services-documented')] } }]).model
    expect(lintModel(m).filter((p) => p.code === 'rule:services-documented').length).toBeGreaterThan(0)
    const off = applyOps(m, [{ op: 'updateMeta', patch: { rules: [{ ...tpl('services-documented'), enabled: false }] } }]).model
    expect(lintModel(off).some((p) => p.code.startsWith('rule:'))).toBe(false)
  })
})

describe('rule regexes', () => {
  it('refuses patterns that can backtrack forever, and long ones', async () => {
    const { unsafePattern } = await import('../../src/shared/model/rules.ts')
    expect(unsafePattern('^(a+)+$')).not.toBeNull()
    expect(unsafePattern('(a|aa)*')).not.toBeNull()
    expect(unsafePattern('x'.repeat(201))).not.toBeNull()
    expect(unsafePattern('dlq|dead')).toBeNull()
    const { ruleProblem, testRule } = await import('../../src/shared/model/rules.ts')
    const evil = RuleZ.parse({ id: 'r', name: 'r', target: 'node', require: { field: 'name', op: 'matches', value: '^(a+)+$' } })
    expect(ruleProblem(evil)).toContain('repeats')
    // Still opens and evaluates (as "no match") without hanging.
    expect(testRule(sample(), evil).violations.length).toBeGreaterThan(0)
  })
})
