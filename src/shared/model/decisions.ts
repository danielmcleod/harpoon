// Decision records drafted from a comparison: the chosen option's summary and trade-offs, the others with why not,
// and what it concerns. A starting point the team edits (or the AI rewrites).
import type { DecisionRecord, Proposal, SolutionSet } from '../ipc.ts'
import { touchedIds } from './ops.ts'
import type { Model } from './schema.ts'

const today = (): string => new Date().toISOString().slice(0, 10)

const bullets = (xs: readonly string[]): string => xs.map((x) => `- ${x}`).join('\n')

/** A first draft of the decision from the comparison (edit it, or have the AI rewrite it). */
export function draftFromSet(set: SolutionSet, chosenId: string | null, proposals: Record<string, Proposal>, model: Model, number: number, phase: string | null): DecisionRecord {
  const opts = set.options.map((id) => proposals[id]).filter((p): p is Proposal => p !== undefined)
  const chosen = chosenId === null ? undefined : proposals[chosenId]
  const touched = chosen === undefined ? { nodes: new Set<string>(), connectors: new Set<string>() } : touchedIds(chosen.ops)
  const crit = set.criteria.length > 0 ? `\n\nWe compared the options on: ${set.criteria.map((c) => `${c.name} (weight ${c.weight})`).join(', ')}.` : ''
  const decision =
    chosen === undefined
      ? ''
      : [`We will go with **${chosen.title}**.`, chosen.option?.summary ?? chosen.rationale, set.recommendation?.option === chosen.id && set.recommendation.why !== '' ? `This was also the recommended option: ${set.recommendation.why}` : ''].filter((x) => x.trim() !== '').join('\n\n')
  const pros = chosen?.option?.pros ?? []
  const cons = chosen?.option?.cons ?? []
  const consequences = [pros.length > 0 ? `Positive:\n${bullets(pros)}` : '', cons.length > 0 ? `Negative:\n${bullets(cons)}` : '', chosen?.risks != null && chosen.risks.trim() !== '' ? `Risks:\n${chosen.risks.trim()}` : ''].filter((x) => x !== '').join('\n\n')
  return {
    id: `adr-${String(number).padStart(4, '0')}`,
    number,
    title: chosen === undefined ? set.title : chosen.title,
    status: chosen === undefined ? 'proposed' : 'accepted',
    date: today(),
    deciders: [],
    implementationPlan: '',
    context: `${set.problem.trim()}${set.constraints.trim() !== '' ? `\n\nConstraints: ${set.constraints.trim()}` : ''}${crit}`,
    decision,
    consequences,
    options: opts.map((p) => ({
      proposalId: p.id,
      title: p.title,
      summary: p.option?.summary ?? p.rationale,
      chosen: p.id === chosenId,
      whyNot: p.id === chosenId ? '' : (p.option?.cons ?? []).join('; '),
    })),
    // What the chosen option adds or changes (not what it removes); new things exist once it is accepted.
    entityIds: [...touched.nodes, ...touched.connectors].filter((id) => !(chosen?.ops ?? []).some((o) => (o.op === 'removeNode' || o.op === 'removeConnector') && o.id === id) && (model.nodes[id] !== undefined || model.connectors[id] !== undefined || (chosen?.ops ?? []).some((o) => (o.op === 'addNode' && o.node.id === id) || (o.op === 'addConnector' && o.connector.id === id)))),
    phase,
    supersedes: null,
    supersededBy: null,
    solutionSetId: set.id,
    links: [],
    source: set.source,
    createdAt: Date.now(),
  }
}

