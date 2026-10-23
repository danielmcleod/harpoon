// Planning the implementation: what the plan pass is told, and where the plan ends up.
import { describe, expect, it } from 'vitest'
import type { DecisionRecord, Proposal } from '../../src/shared/ipc.ts'
import { implementContext } from '../../src/core/ai/implement.ts'
import { adrMarkdown } from '../../src/shared/export/adr.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import { sampleOps } from '../../src/shared/model/sample.ts'
import { ConnectorZ, NodeZ, emptyModel } from '../../src/shared/model/schema.ts'

const model = applyOps(emptyModel({ id: 'p', name: 'Commerce Platform' }), sampleOps()).model
const decision: DecisionRecord = {
  id: 'adr-0001', number: 1, title: 'Score fraud asynchronously', status: 'accepted', date: '2026-10-22', deciders: [],
  context: 'Chargebacks doubled.', decision: 'Add a fraud scorer on payment events.', consequences: '',
  options: [{ proposalId: 'p-1', title: 'Async scorer', summary: '', chosen: true, whyNot: '' }, { proposalId: null, title: 'Inline check', summary: '', chosen: false, whyNot: 'Adds latency.' }],
  entityIds: ['payment-events'], phase: null, supersedes: null, supersededBy: null, solutionSetId: null, links: [], source: null,
  implementationPlan: '', createdAt: 0,
}
const proposal: Proposal = {
  id: 'p-1', runId: 'r', title: 'Async scorer', rationale: 'Keep checkout fast.', risks: null, vendor: 'claude', mode: 'plan', prompt: '', createdAt: 0, status: 'accepted', source: null, option: null,
  ops: [
    { op: 'addNode', node: NodeZ.parse({ id: 'fraud-scorer', name: 'fraud-scorer', kind: 'service', status: 'planned' }), at: null },
    { op: 'addConnector', connector: ConnectorZ.parse({ id: 'events-fraud', source: 'payment-events', target: 'fraud-scorer', sync: 'async', duplex: false, channelA: { protocol: 'Kafka' } }) },
  ],
}

describe('plan the implementation', () => {
  it('tells the plan pass the decision, the changes and the parts involved', () => {
    const text = implementContext({ model, context: { decisionId: 'adr-0001' }, decision, proposal })
    expect(text).toContain('Add a fraud scorer on payment events.')
    expect(text).toContain('Inline check (not chosen: Adds latency.)')
    expect(text).toContain('fraud-scorer')
    expect(text).toContain('payment-events')
    expect(text).toContain('over **Kafka** (async)')
  })

  it('keeps the plan in the decision record’s Markdown', () => {
    const md = adrMarkdown({ ...decision, implementationPlan: '# Plan\n\n## Step 1\n- [ ] Add the consumer' }, model, [decision])
    expect(md).toContain('## Implementation plan')
    expect(md).toContain('### Plan')
    expect(md).toContain('#### Step 1')
  })
})
