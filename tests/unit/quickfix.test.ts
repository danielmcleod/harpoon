// One-click fixes clear their problem; problems that need judgement have none.
import { describe, expect, it } from 'vitest'
import { lintModel } from '../../src/shared/model/lint.ts'
import { applyOps } from '../../src/shared/model/ops.ts'
import type { Op } from '../../src/shared/model/ops.ts'
import { quickFix } from '../../src/shared/model/quickfix.ts'
import { ConnectorZ, FlowZ, NodeZ, emptyModel } from '../../src/shared/model/schema.ts'

const base: Op[] = [
  { op: 'addNode', node: NodeZ.parse({ id: 'web', name: 'web', kind: 'frontend' }), at: null },
  { op: 'addNode', node: NodeZ.parse({ id: 'api', name: 'api', kind: 'service', team: 'ghost-team', dataClasses: ['pii', 'made-up'] }), at: null },
  { op: 'addConnector', connector: ConnectorZ.parse({ id: 'web-api', source: 'web', target: 'api', duplex: true, channelB: null }) },
  { op: 'addFlow', flow: FlowZ.parse({ id: 'f', name: 'F', steps: [{ connectorId: 'web-api' }, { connectorId: 'gone' }] }) },
]

describe('quick fixes', () => {
  it('fix references to things that do not exist, and a missing reply channel', () => {
    let m = applyOps(emptyModel({ id: 'q', name: 'Q' }), base).model
    const fixable = ['unknown-team', 'unknown-data-class', 'flow-missing-connector', 'duplex-no-return']
    for (const code of fixable) {
      const p = lintModel(m).find((x) => x.code === code)
      if (p === undefined) throw new Error(`no ${code} problem`)
      const fix = quickFix(m, p)
      if (fix === null) throw new Error(`no fix for ${code}`)
      m = applyOps(m, fix.ops).model
    }
    const left = lintModel(m).map((p) => p.code)
    for (const code of fixable) expect(left).not.toContain(code)
    expect(m.nodes['api']?.dataClasses).toEqual(['pii'])
  })

  it('leaves judgement calls to the AI', () => {
    const m = applyOps(emptyModel({ id: 'q', name: 'Q' }), [{ op: 'addNode', node: NodeZ.parse({ id: 'lonely', name: 'lonely', kind: 'service' }), at: null }]).model
    const orphan = lintModel(m).find((p) => p.code === 'orphan')
    expect(orphan).toBeDefined()
    if (orphan !== undefined) expect(quickFix(m, orphan)).toBeNull()
  })
})
