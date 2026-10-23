// What a "Plan the implementation" run is told. Native plan passes have no Harpoon tools, so the decision, the
// changes and the parts of the architecture they touch are written into the prompt.
import type { AiContext, DecisionRecord, Proposal } from '../../shared/ipc.ts'
import { implementationBrief } from '../export/docs.ts'
import { KIND_INFO } from '../../shared/model/kinds.ts'
import { ancestorsOf } from '../../shared/model/queries.ts'
import type { Model } from '../../shared/model/schema.ts'

/** A node and its links, in a few lines (where it sits, what it is, what it talks to). */
function describeNode(m: Model, id: string): string | null {
  const n = m.nodes[id]
  if (n === undefined) return null
  const path = [...ancestorsOf(m, id).reverse().map((a) => a.name), n.name].join(' › ')
  const out = [`- **${path}** (${KIND_INFO[n.kind].label.toLowerCase()}${n.techStack !== null ? `, ${n.techStack}` : ''}, ${n.status})${n.description.trim() !== '' ? `: ${n.description.trim().split('\n')[0]}` : ''}`]
  for (const c of Object.values(m.connectors)) {
    if (c.source === id) out.push(`  - calls ${m.nodes[c.target]?.name ?? c.target} over ${c.channelA.protocol}${c.sync === 'async' ? ' (async)' : ''}`)
    else if (c.target === id) out.push(`  - called by ${m.nodes[c.source]?.name ?? c.source} over ${c.channelA.protocol}`)
  }
  for (const f of n.features.slice(0, 12)) out.push(`  - provides ${f.name}${f.endpoint !== null ? ` (\`${f.endpoint}\`)` : ''}`)
  return out.join('\n')
}

export function implementContext(o: { model: Model; context: AiContext; decision: DecisionRecord | undefined; proposal: Proposal | undefined }): string {
  const { model: m, decision: d, proposal: p } = o
  const parts: string[] = []
  if (d !== undefined) {
    parts.push(
      [
        `## Decision ${String(d.number).padStart(4, '0')}: ${d.title} (${d.status})`,
        d.context.trim() !== '' ? `### Context\n${d.context.trim()}` : '',
        d.decision.trim() !== '' ? `### Decision\n${d.decision.trim()}` : '',
        d.consequences.trim() !== '' ? `### Consequences\n${d.consequences.trim()}` : '',
        d.options.length > 0 ? `### Options weighed\n${d.options.map((x) => `- ${x.chosen ? '**Chosen:** ' : ''}${x.title}${x.whyNot.trim() !== '' ? ` (not chosen: ${x.whyNot.trim()})` : ''}`).join('\n')}` : '',
      ]
        .filter((x) => x !== '')
        .join('\n\n'),
    )
  }
  if (p !== undefined) parts.push(`## The changes to build\n\n${implementationBrief(m, p).replace(/^# .*\n/, '')}`)
  const ids = new Set<string>([...(d?.entityIds ?? []), ...(p?.ops ?? []).flatMap((x) => ('id' in x ? [x.id] : x.op === 'addConnector' ? [x.connector.source, x.connector.target] : []))])
  const touched = [...ids].map((id) => describeNode(m, id)).filter((x): x is string => x !== null)
  if (touched.length > 0) parts.push(`## The parts of the architecture involved\n\n${touched.join('\n')}`)
  if (m.meta.phases.length > 0 && d?.phase != null) parts.push(`Roadmap phase: ${m.meta.phases.find((x) => x.id === d.phase)?.name ?? d.phase}.`)
  return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : ''
}
