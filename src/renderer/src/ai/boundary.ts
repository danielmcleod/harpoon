// "Check with AI" on a boundary zone: a Sync with code scoped to that zone. The AI confirms each member from the
// infrastructure code (VPCs, subnets, security groups, namespaces…), moves what is misplaced and fixes the type.
import { ask } from '../state/ai.ts'
import { getState } from '../state/store.ts'
import { boundaryCheckPrompt } from './boundaryPrompt.ts'

export function checkBoundaryWithAi(boundaryId: string): void {
  const m = getState().project?.model
  const prompt = m === undefined ? null : boundaryCheckPrompt(m, boundaryId)
  if (prompt !== null) void ask(prompt, { mode: 'drift' })
}
