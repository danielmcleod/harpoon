// AI runs started from the simulator and the flow list: why traffic stops (around one node, or everywhere), fixing what
// fails in the running simulation (one root cause, or all of them), and a review of the flows (one, or all of them).
import { lintModel } from '@shared/model/lint.ts'
import { failureReport, failureText } from '@shared/sim/explain.ts'
import { trafficBreaks } from '@shared/sim/paths.ts'
import { currentFrame, useSim } from './simStore.ts'
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

/**
 * Fix what fails in the simulation as it stands (one root cause by its report key, or all of them). The AI gets the
 * report and the scenario, reproduces it with the simulate tool, and proposes changes that make it pass.
 */
export function fixFailures(rootKey: string | null): void {
  const model = getState().project?.model
  const s = useSim.getState()
  const frame = currentFrame(s)
  if (model === undefined || frame === null) return
  const report = failureReport(model, frame)
  const root = rootKey === null ? undefined : report.roots.find((r) => r.key === rootKey)
  const { faults, multiplier, profile, healthy } = s.scenario
  const scenario = JSON.stringify({
    multiplier,
    profile,
    faults: faults.map(({ type, target, value, from, until }) => ({ type, target, value, from, until })),
    healthy: healthy ?? [],
    seconds: Math.max(5, Math.ceil(frame.t)),
  })
  const focus =
    root === undefined
      ? 'Fix what fails in the running traffic simulation.'
      : `Fix what fails in the running traffic simulation at ${root.name} (${root.ref.kind} ${root.ref.id}): ${root.reasons.map((r) => r.text).join('; ')}.`
  const prompt = `${focus}

Call simulate with this scenario first to reproduce it: ${scenario}

${failureText(model, frame)}

Injected faults are the drill: do not remove them. Make the architecture survive them and carry the load instead, as the real system could: more instances, zones or capacity (resilience fields, and the node's simulation settings when the real capacity is known or planned), timeouts, retries with backoff and circuit breakers, a soft dependency with a fallback, a cache, or a queue to decouple. Ground what you claim about the real system in the code and infrastructure; mark new things and changed settings planned. Call simulate again with the same scenario to check your changes, then submit_proposal with a rationale that names each root cause and how it is fixed (or why it is left).`
  const ids = rootKey === null ? report.roots.filter((r) => r.ref.kind === 'node').map((r) => r.ref.id) : root?.ref.kind === 'node' ? [root.ref.id] : []
  const connectorIds = rootKey === null ? report.roots.filter((r) => r.ref.kind === 'connector').map((r) => r.ref.id) : root?.ref.kind === 'connector' ? [root.ref.id] : []
  void ask(prompt, { mode: 'resilience', ...(ids.length + connectorIds.length > 0 ? { scope: { nodeIds: ids, connectorIds, focusId: null } } : {}) })
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
