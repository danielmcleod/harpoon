// One-click fixes for problems that need no judgement and no AI: references to things that no longer exist (a team,
// phase or data class; a connector a flow step uses; a node a boundary lists) and a two-way link with no reply
// channel. Everything else goes to the AI, which checks the code first. Pure: model and problem in, ops out.
import { dataClassCatalog } from './governance.ts'
import type { Problem } from './lint.ts'
import type { Op } from './ops.ts'
import type { Model } from './schema.ts'

export interface QuickFix {
  /** Button text, e.g. "Clear the team". */
  label: string
  ops: Op[]
}

export function quickFix(m: Model, p: Problem): QuickFix | null {
  const node = p.nodeId !== undefined ? m.nodes[p.nodeId] : undefined
  const conn = p.connectorId !== undefined ? m.connectors[p.connectorId] : undefined
  const zone = p.boundaryId !== undefined ? m.boundaries[p.boundaryId] : undefined
  const flow = p.flowId !== undefined ? m.flows[p.flowId] : undefined
  switch (p.code) {
    case 'unknown-team': {
      if (node !== undefined) return { label: 'Clear the team', ops: [{ op: 'updateNode', id: node.id, patch: { team: null } }] }
      if (conn !== undefined) return { label: 'Clear the team', ops: [{ op: 'updateConnector', id: conn.id, patch: { team: null } }] }
      if (zone !== undefined) return { label: 'Clear the team', ops: [{ op: 'updateBoundary', id: zone.id, patch: { team: null } }] }
      return null
    }
    case 'unknown-phase': {
      if (node !== undefined) return { label: 'Clear the phase', ops: [{ op: 'updateNode', id: node.id, patch: { phase: null } }] }
      if (conn !== undefined) return { label: 'Clear the phase', ops: [{ op: 'updateConnector', id: conn.id, patch: { phase: null } }] }
      return null
    }
    case 'unknown-data-class': {
      const known = new Set(dataClassCatalog(m.meta).map((d) => d.id))
      const keep = (ids: string[]): string[] => ids.filter((x) => known.has(x))
      if (node !== undefined) return { label: 'Remove unknown data classes', ops: [{ op: 'updateNode', id: node.id, patch: { dataClasses: keep(node.dataClasses) } }] }
      if (conn !== undefined) {
        const patch = {
          channelA: { ...conn.channelA, dataClasses: keep(conn.channelA.dataClasses) },
          ...(conn.channelB !== null ? { channelB: { ...conn.channelB, dataClasses: keep(conn.channelB.dataClasses) } } : {}),
        }
        return { label: 'Remove unknown data classes', ops: [{ op: 'updateConnector', id: conn.id, patch }] }
      }
      if (zone !== undefined) return { label: 'Remove unknown data classes', ops: [{ op: 'updateBoundary', id: zone.id, patch: { dataClasses: keep(zone.dataClasses) } }] }
      return null
    }
    case 'flow-missing-connector':
      if (flow === undefined) return null
      return { label: 'Drop the missing steps', ops: [{ op: 'updateFlow', id: flow.id, patch: { steps: flow.steps.filter((s) => m.connectors[s.connectorId] !== undefined) } }] }
    case 'boundary-missing-node':
      if (zone === undefined) return null
      return { label: 'Drop the missing nodes', ops: [{ op: 'updateBoundary', id: zone.id, patch: { nodeIds: zone.nodeIds.filter((id) => m.nodes[id] !== undefined) } }] }
    case 'duplex-no-return':
      if (conn === undefined) return null
      // A request/response link answers on the same protocol unless someone says otherwise.
      return { label: `Add a ${conn.channelA.protocol} reply`, ops: [{ op: 'updateConnector', id: conn.id, patch: { channelB: { ...conn.channelA, description: null, payloadSchema: null, dataClasses: [] } } }] }
    default:
      return null
  }
}
