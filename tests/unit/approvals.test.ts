// Implement's three approval modes reach each CLI as its own nearest setting, and never as bypass or full access.
import { expect, it } from 'vitest'
import { buildArgv } from '../../src/core/adapters/claude/launch.ts'
import { execArgv } from '../../src/core/adapters/codex/launch.ts'
import { threadStartParams } from '../../src/core/adapters/codex/params.ts'
import type { Approvals } from '../../src/shared/run.ts'

const claudeMode = (approvals: Approvals): string | undefined => {
  const a = buildArgv({ route: 'edit', mode: 'autoedit', step: 'implement', approvals })
  const i = a.findIndex((x) => x.startsWith('--permission-mode'))
  return a[i]?.includes('=') ? a[i]?.split('=')[1] : a[i + 1]
}

it('maps each mode to Claude’s permission mode', () => {
  expect(claudeMode('manual')).toBe('manual')
  expect(claudeMode('acceptEdits')).toBe('acceptEdits')
  expect(claudeMode('auto')).toBe('auto')
})

it('maps each mode to Codex’s sandbox, approval policy and reviewer', () => {
  const p = (approvals: Approvals) => threadStartParams({ step: 'implement', mode: 'full', approvals, cwd: '/repo' })
  expect(p('manual')).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'untrusted', approvalsReviewer: 'user' })
  expect(p('acceptEdits')).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' })
  expect(p('auto')).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' })
  expect(execArgv({ step: 'implement', mode: 'full', approvals: 'auto', cwd: '/repo', outFile: 'out.txt' }).join(' ')).toContain('approvals_reviewer="auto_review"')
})
