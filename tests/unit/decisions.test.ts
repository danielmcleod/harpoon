import { describe, expect, it } from 'vitest'
import { Draft, switchableDraft } from '../../src/core/ai/draft.ts'
import { adrMarkdown } from '../../src/shared/export/adr.ts'
import type { Proposal, SolutionSet } from '../../src/shared/ipc.ts'
import { optionFacts } from '../../src/shared/model/compare.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import type { Op } from '../../src/shared/model/ops.ts'
import { sampleOps } from '../../src/shared/model/sample.ts'
import { ConnectorZ, NodeZ, emptyModel } from '../../src/shared/model/schema.ts'
import { draftFromSet } from '../../src/shared/model/decisions.ts'

const sample = () => applyOps(emptyModel({ id: 'p', name: 'P' }), sampleOps()).model

const saasOption: Op[] = [
  { op: 'addNode', node: NodeZ.parse({ id: 'sift', name: 'Sift', kind: 'saas', boundary: 'external', vendor: 'Sift', status: 'planned' }), at: { q: 6, r: 0 } },
  { op: 'addConnector', connector: ConnectorZ.parse({ id: 'pay-sift', source: 'payments-core', target: 'sift', status: 'planned', channelA: { protocol: 'HTTPS', dataClasses: ['pci'] } }) },
]

const proposal = (id: string, key: string, title: string, ops: Op[]): Proposal => ({
  id,
  runId: 'r1',
  title,
  rationale: '',
  risks: null,
  vendor: 'claude',
  mode: 'solutions',
  prompt: '',
  createdAt: 0,
  status: 'pending',
  ops,
  option: { solutionSetId: 's1', key, summary: `${title} summary`, pros: ['fast to ship'], cons: ['new vendor'], effort: 'S' },
})

describe('comparing options', () => {
  it('computes what an option changes, brings in and exposes', () => {
    const { facts } = optionFacts(sample(), saasOption)
    expect(facts.nodes.added).toBe(1)
    expect(facts.connectors.added).toBe(1)
    expect(facts.servicesTouched).toEqual(['payment-api'])
    expect(facts.newVendors).toEqual(['Sift'])
    expect(facts.dataExposure).toEqual([{ cls: 'pci', more: 3 }]) // payments-core, its container payment-api, and Sift
    expect(facts.stale).toBe(0)
  })

  it('a solutions run keeps one draft per option behind one draft handle', () => {
    const base = sample()
    const a = new Draft(base)
    const b = new Draft(base)
    let current = a
    const d = switchableDraft(() => current)
    d.apply([saasOption[0] as Op])
    current = b
    expect(d.model.nodes['sift']).toBeUndefined()
    expect(a.model.nodes['sift']).toBeDefined()
  })

  it('drafts a decision record from the chosen option and renders it as an ADR', () => {
    const m = sample()
    const set: SolutionSet = {
      id: 's1',
      title: 'Fraud scoring',
      problem: 'Score payments for fraud.',
      constraints: 'No added latency over 50 ms.',
      criteria: [{ id: 'cost', name: 'Cost', weight: 3 }],
      options: ['pa', 'pb'],
      scores: [],
      recommendation: { option: 'pa', why: 'Fastest to ship.' },
      status: 'open',
      chosen: null,
      decisionId: null,
      runId: null,
      createdAt: 0,
      source: null,
    }
    const props = { pa: proposal('pa', 'A', 'Use Sift', saasOption), pb: proposal('pb', 'B', 'Build in-house', []) }
    const rec = draftFromSet(set, 'pa', props, m, 7, 'mvp')
    expect(rec).toMatchObject({ id: 'adr-0007', status: 'accepted', title: 'Use Sift', phase: 'mvp', solutionSetId: 's1' })
    expect(rec.entityIds.sort()).toEqual(['pay-sift', 'sift'])
    expect(rec.options.map((o) => [o.title, o.chosen, o.whyNot])).toEqual([
      ['Use Sift', true, ''],
      ['Build in-house', false, 'new vendor'],
    ])
    const md = adrMarkdown(rec, m)
    expect(md).toContain('# ADR-0007: Use Sift')
    expect(md).toContain('### Build in-house')
    expect(md).toContain('Why not: new vendor')
  })
})
