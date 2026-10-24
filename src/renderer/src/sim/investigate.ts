// AI runs started from the simulator and the flow list: why traffic stops (around one node, or everywhere), and a
// review of the flows (one, or all of them).
import { lintModel } from '@shared/model/lint.ts'
import { trafficBreaks } from '@shared/sim/paths.ts'
import { select } from '../state/actions.ts'
import { ask } from '../state/ai.ts'
import { getState } from '../state/store.ts'

export function investigateTraffic(nodeId: string | null): void {
  const model = getState().project?.model
  if (model === undefined) return
  const breaks = trafficBreaks(model).filter((b) => nodeId === null || b.nodeId === nodeId)
  const name = nodeId === null ? null : (model.nodes[nodeId]?.name ?? nodeId)
  const at = (b: (typeof breaks)[number]): string => {
    const ids = [b.nodeId !== null ? `node ${b.nodeId}` : '', 'connectorId' in b && typeof b.connectorId === 'string' ? `connector ${b.connectorId}` : ''].filter((x) => x !== '')
    return ids.length > 0 ? ` (${ids.join(', ')})` : ''
  }
  const found = breaks.length > 0 ? `\n\nWhat Harpoon found:\n${breaks.slice(0, 25).map((b) => `- ${b.message}${at(b)}`).join('\n')}${breaks.length > 25 ? `\n…and ${breaks.length - 25} more (check_traffic lists them all).` : ''}` : ''
  const prompt = name === null ? `Find out why simulated traffic stops, and fix the links.${found}` : `Simulated traffic does not get through at ${name} (id ${nodeId}). Find out how requests really travel there and fix the links.${found}`
  if (nodeId !== null) select({ kind: 'node', ids: [nodeId] })
  void ask(prompt, { mode: 'investigate', ...(nodeId !== null ? { scope: { nodeIds: [nodeId], connectorIds: [], focusId: null } } : {}) })
}

export function reviewFlows(flowId: string | null): void {
  const model = getState().project?.model
  if (model === undefined) return
  const f = flowId === null ? undefined : model.flows[flowId]
  const problems = lintModel(model).filter((p) => p.code.startsWith('flow-') && (f === undefined || p.flowId === f.id))
  const found = problems.length > 0 ? `\n\nWhat Harpoon found:\n${problems.slice(0, 25).map((p) => `- [${p.code}] ${p.message}${p.flowId !== undefined ? ` (flow ${p.flowId})` : ''}`).join('\n')}${problems.length > 25 ? `\n…and ${problems.length - 25} more (validate_draft lists them all).` : ''}` : ''
  const prompt = f === undefined ? `Review all flows: fix broken ones, complete partial ones and add the main journeys that have none.${found}` : `Review the flow "${f.name}" (id ${f.id}): make every step link up and run the way requests travel, and extend it to where the request really ends.${found}`
  void ask(prompt, { mode: 'flows' })
}
