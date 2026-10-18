// Decision records as Markdown in the common ADR layout (Status, Context, Decision, Consequences, Options), for
// `docs/adr/NNNN-title.md`, the Markdown export and Notion.
import type { DecisionRecord } from '../ipc.ts'
import type { Model } from '../model/schema.ts'

export const adrNumber = (n: number): string => `ADR-${String(n).padStart(4, '0')}`

export function adrFilename(d: DecisionRecord): string {
  const slug = d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'decision'
  return `${String(d.number).padStart(4, '0')}-${slug}.md`
}

export function adrMarkdown(d: DecisionRecord, m: Model, all: readonly DecisionRecord[] = []): string {
  const ref = (id: string | null): string | null => {
    if (id === null) return null
    const x = all.find((r) => r.id === id)
    return x === undefined ? id : `${adrNumber(x.number)} ${x.title}`
  }
  const name = (id: string): string => {
    const n = m.nodes[id]
    if (n !== undefined) return n.name
    const c = m.connectors[id]
    return c === undefined ? id : `${m.nodes[c.source]?.name ?? c.source} → ${m.nodes[c.target]?.name ?? c.target}`
  }
  const phase = d.phase === null ? null : (m.meta.phases.find((p) => p.id === d.phase)?.name ?? d.phase)
  const out: string[] = [`# ${adrNumber(d.number)}: ${d.title}`, '']
  const facts = [
    `- **Status:** ${d.status}${d.supersededBy !== null ? ` (superseded by ${ref(d.supersededBy)})` : ''}`,
    `- **Date:** ${d.date}`,
    d.deciders.length > 0 ? `- **Deciders:** ${d.deciders.join(', ')}` : null,
    phase !== null ? `- **Roadmap phase:** ${phase}` : null,
    d.supersedes !== null ? `- **Supersedes:** ${ref(d.supersedes)}` : null,
    d.entityIds.length > 0 ? `- **Concerns:** ${d.entityIds.map(name).join(', ')}` : null,
  ].filter((x): x is string => x !== null)
  out.push(...facts, '')
  out.push('## Context', '', d.context.trim() || '_Not written yet._', '')
  out.push('## Decision', '', d.decision.trim() || '_Not written yet._', '')
  out.push('## Consequences', '', d.consequences.trim() || '_Not written yet._', '')
  if (d.options.length > 0) {
    out.push('## Options considered', '')
    for (const o of d.options) {
      out.push(`### ${o.title}${o.chosen ? ' (chosen)' : ''}`, '')
      if (o.summary.trim() !== '') out.push(o.summary.trim(), '')
      if (!o.chosen && o.whyNot.trim() !== '') out.push(`Why not: ${o.whyNot.trim()}`, '')
    }
  }
  if (d.links.length > 0) {
    out.push('## Links', '')
    for (const l of d.links) out.push(`- [${l.title}](${l.url})`)
    out.push('')
  }
  return `${out.join('\n')}\n`
}

/** The decision log as one Markdown section (for ARCHITECTURE.md). */
export function decisionLogMarkdown(all: readonly DecisionRecord[]): string {
  if (all.length === 0) return ''
  const rows = [...all].sort((a, b) => a.number - b.number).map((d) => `| ${adrNumber(d.number)} | ${d.title.replace(/\|/g, '\\|')} | ${d.status} | ${d.date} |`)
  return ['## Decisions', '', '| # | Decision | Status | Date |', '|---|---|---|---|', ...rows, ''].join('\n')
}
