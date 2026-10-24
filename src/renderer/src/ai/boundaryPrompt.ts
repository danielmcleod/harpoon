// The request behind "Check with AI" on a boundary zone: the zone, its members and neighbours, the links crossing it,
// what Harpoon found, and what to check in the infrastructure code.
import { lintModel } from '@shared/model/lint.ts'
import type { Model } from '@shared/model/schema.ts'

/** Past these, the AI looks the rest up itself (get_overview, get_node). */
const OTHERS_MAX = 40
const CROSSING_MAX = 25

/** The request for checking one zone (null when it is gone). */
export function boundaryCheckPrompt(m: Model, boundaryId: string): string | null {
  const b = m.boundaries[boundaryId]
  if (b === undefined) return null
  const nodeLabel = (id: string): string => {
    const n = m.nodes[id]
    return n === undefined ? id : `${n.name} (id ${n.id}, ${n.kind}${n.boundary === 'external' ? ', external' : ''})`
  }
  const where = b.parentId === null ? 'the top level' : `inside ${nodeLabel(b.parentId)}`
  const inside = new Set(b.nodeIds)
  const others = Object.values(m.nodes).filter((n) => n.parentId === b.parentId && !inside.has(n.id))
  const crossing = Object.values(m.connectors).filter((c) => inside.has(c.source) !== inside.has(c.target) && (inside.has(c.source) || inside.has(c.target)))
  const found = lintModel(m).filter((p) => p.boundaryId === b.id)
  return [
    `Check the boundary "${b.name}" (id ${b.id}, type ${b.type}), drawn on ${where}, against the infrastructure code.`,
    `Members:\n${b.nodeIds.map((id) => `- ${nodeLabel(id)}`).join('\n') || '- none'}`,
    others.length > 0 ? `Other nodes on that level, not in it:\n${others.slice(0, OTHERS_MAX).map((n) => `- ${nodeLabel(n.id)}`).join('\n')}${others.length > OTHERS_MAX ? `\n…and ${others.length - OTHERS_MAX} more (get_overview).` : ''}` : '',
    crossing.length > 0 ? `Connectors crossing it:\n${crossing.slice(0, CROSSING_MAX).map((c) => `- ${c.id}: ${m.nodes[c.source]?.name ?? c.source} → ${m.nodes[c.target]?.name ?? c.target} (${c.channelA.protocol})`).join('\n')}${crossing.length > CROSSING_MAX ? `\n…and ${crossing.length - CROSSING_MAX} more.` : ''}` : '',
    found.length > 0 ? `What Harpoon found:\n${found.map((p) => `- [${p.code}] ${p.message}`).join('\n')}` : '',
    `For each member, confirm from the code and infrastructure (Terraform or CloudFormation VPCs, subnets and security groups, Kubernetes namespaces and network policies, Helm values, docker-compose networks, cloud accounts) that it really runs in this zone. Find nodes that belong in it but are not. Then fix it with upsert_boundary: remove members that do not belong, add the ones that do, correct the type, and split it or add a nested zone where the infrastructure has one. Only change this boundary (and new zones it needs); leave the rest of the diagram alone. If the code does not settle a member, leave it and say so. In the rationale, list each member as confirmed, added, removed or unsure, with evidence.`,
  ]
    .filter((x) => x !== '')
    .join('\n\n')
}
