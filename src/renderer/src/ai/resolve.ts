// Resolving problems with AI, from wherever they show: one problem, the ones ticked, all of them, or everything about
// some nodes (a right-click, a multi-selection). The AI gets the exact problems and checks the code before fixing.
import { lintModel } from '@shared/model/lint.ts'
import type { Problem } from '@shared/model/lint.ts'
import { descendantIds } from '@shared/model/queries.ts'
import { resilienceFindings } from '@shared/model/resilience.ts'
import type { ResilienceFinding } from '@shared/model/resilience.ts'
import type { Model } from '@shared/model/schema.ts'
import { ask } from '../state/ai.ts'
import { getState } from '../state/store.ts'

/** Problems named in the request; past this the AI looks the rest up (list_problems). */
const RESOLVE_LINES_MAX = 25

/** A problem as a line for the AI, with the ids it is about. */
function line(p: Problem): string {
  const at = [p.nodeId !== undefined ? `node ${p.nodeId}` : '', p.connectorId !== undefined ? `connector ${p.connectorId}` : '', p.boundaryId !== undefined ? `boundary ${p.boundaryId}` : '', p.flowId !== undefined ? `flow ${p.flowId}` : '']
    .filter((x) => x !== '')
    .join(', ')
  return `- [${p.code}] ${p.message}${at !== '' ? ` (${at})` : ''}`
}

function findingLine(f: ResilienceFinding): string {
  const at = [f.nodeId !== null ? `node ${f.nodeId}` : '', f.connectorId !== null ? `connector ${f.connectorId}` : ''].filter((x) => x !== '').join(', ')
  return `- [availability: ${f.kind}] ${f.message}${at !== '' ? ` (${at})` : ''}`
}

/** Problems and availability gaps about these nodes (and their inner parts), or about the connectors touching them. */
export function problemsAbout(m: Model, nodeIds: readonly string[]): { problems: Problem[]; findings: ResilienceFinding[] } {
  const ids = new Set(nodeIds.flatMap((id) => [id, ...descendantIds(m, id)]))
  const touches = (c: string | null | undefined): boolean => c != null && (ids.has(m.connectors[c]?.source ?? '') || ids.has(m.connectors[c]?.target ?? ''))
  return {
    problems: lintModel(m).filter((p) => (p.nodeId !== undefined && ids.has(p.nodeId)) || touches(p.connectorId)),
    findings: resilienceFindings(m).filter((f) => f.severity !== 'info' && ((f.nodeId !== null && ids.has(f.nodeId)) || touches(f.connectorId))),
  }
}

/** Start an AI run that resolves these problems (and availability gaps). */
export function resolveWithAi(problems: readonly Problem[], findings: readonly ResilienceFinding[] = [], scope: string | null = null): void {
  if (getState().project === null) return
  const lines = [...problems.map(line), ...findings.map(findingLine)]
  const head = scope !== null ? `Resolve the problems with ${scope}:` : lines.length === 1 ? 'Resolve this problem:' : `Resolve these ${lines.length} problems:`
  const shown = lines.slice(0, RESOLVE_LINES_MAX)
  const more = lines.length > shown.length ? `\n…and ${lines.length - shown.length} more: call list_problems for them all.` : ''
  void ask(`${head}\n${shown.join('\n')}${more}`, { mode: 'resolve' })
}

/** Everything Harpoon reports (problems and availability gaps), in one run. */
export function resolveAll(m: Model): void {
  resolveWithAi(lintModel(m), resilienceFindings(m).filter((f) => f.severity !== 'info'))
}
