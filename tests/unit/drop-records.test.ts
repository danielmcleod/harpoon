// Deleting a decision or a comparison leaves nothing pointing at it.
import { expect, it } from 'vitest'
import { afterDeletingComparison, afterDeletingDecision } from '../../src/shared/model/decisions.ts'
import type { DecisionRecord, SolutionSet } from '../../src/shared/ipc.ts'

const rec = (id: string, p: Partial<DecisionRecord> = {}): DecisionRecord => ({ id, number: 1, title: id, status: 'proposed', date: '2026-11-03', deciders: [], context: '', decision: '', consequences: '', options: [], entityIds: [], phase: null, supersedes: null, supersededBy: null, solutionSetId: null, links: [], source: null, implementationPlan: '', createdAt: 0, ...p })
const set = (id: string, decisionId: string | null): SolutionSet => ({ id, title: id, problem: '', constraints: '', criteria: [], options: [], scores: [], recommendation: null, status: 'decided', chosen: null, decisionId, runId: null, createdAt: 0, source: null })

it('unlinks what pointed at a deleted decision, and restores what it superseded', () => {
  const after = afterDeletingDecision(
    'dup',
    [rec('dup', { supersedes: 'old' }), rec('old', { status: 'superseded', supersededBy: 'dup' }), rec('newer', { status: 'accepted', supersedes: 'dup' }), rec('other')],
    [set('s1', 'dup'), set('s2', 'other')],
  )
  expect(after.decisions.map((d) => [d.id, d.status, d.supersedes, d.supersededBy])).toEqual([
    ['old', 'accepted', null, null],
    ['newer', 'accepted', null, null],
  ])
  expect(after.sets).toMatchObject([{ id: 's1', decisionId: null }])
})

it('makes decisions forget a deleted comparison', () => {
  expect(afterDeletingComparison('s1', [rec('a', { solutionSetId: 's1' }), rec('b', { solutionSetId: 's2' })])).toMatchObject([{ id: 'a', solutionSetId: null }])
})
