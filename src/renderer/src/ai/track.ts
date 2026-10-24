// Tracking planned work outside Harpoon: the issues (stories, tickets) linked to planned nodes, features and
// connectors, and an AI run that creates the missing ones in the user's tracker through their own tools.
import type { IssueLink, Model } from '@shared/model/schema.ts'
import { toast } from '../state/actions.ts'
import { ask, loadUserTools } from '../state/ai.ts'
import { getState, setAi } from '../state/store.ts'
import { useRecords } from '../records/recordsStore.ts'
import { TRACKER } from './toolHints.ts'

export interface TrackTarget {
  kind: 'node' | 'connector' | 'feature'
  id: string
  /** Features: the node they belong to. */
  nodeId?: string
}

/** The issues linked to a target (none for something unknown). */
export function issuesOf(m: Model, t: TrackTarget): IssueLink[] {
  if (t.kind === 'connector') return m.connectors[t.id]?.issues ?? []
  if (t.kind === 'feature') return m.nodes[t.nodeId ?? '']?.features.find((f) => f.id === t.id)?.issues ?? []
  return m.nodes[t.id]?.issues ?? []
}

const phaseName = (m: Model, id: string): string => m.meta.phases.find((p) => p.id === id)?.name ?? id

const planned = (s: string | undefined): boolean => s === 'planned' || s === 'in-progress'

/** Planned or in-progress work, without an issue yet, among these. */
export function untracked(m: Model, targets: readonly TrackTarget[]): TrackTarget[] {
  return targets.filter((t) => {
    const status = t.kind === 'connector' ? m.connectors[t.id]?.status : t.kind === 'feature' ? m.nodes[t.nodeId ?? '']?.features.find((f) => f.id === t.id)?.status : m.nodes[t.id]?.status
    return planned(status) && issuesOf(m, t).length === 0
  })
}

/** One compact line per item: what it is, its phase, its decision, what it says, and any issues it has. */
function itemLine(m: Model, t: TrackTarget): string {
  const decision = useRecords.getState().decisions.find((d) => d.entityIds.includes(t.kind === 'feature' ? (t.nodeId ?? '') : t.id))
  const tail = (status: string, phase: string | null, description: string): string =>
    [`${status}`, phase !== null ? `phase ${phaseName(m, phase)}` : '', decision !== undefined ? `decision ${decision.id} "${decision.title}"` : '', description.split('\n')[0]?.slice(0, 200) ?? '']
      .filter((x) => x !== '')
      .join('; ')
  const has = issuesOf(m, t)
  const issues = has.length > 0 ? ` Issues: ${has.map((i) => `${i.key} ${i.url}`).join(', ')}.` : ''
  if (t.kind === 'connector') {
    const c = m.connectors[t.id]
    if (c === undefined) return ''
    return `- connector ${c.id}: ${m.nodes[c.source]?.name ?? c.source} → ${m.nodes[c.target]?.name ?? c.target} (${c.channelA.protocol}; ${tail(c.status, c.phase, c.description)}).${issues}`
  }
  const n = m.nodes[t.kind === 'feature' ? (t.nodeId ?? '') : t.id]
  if (n === undefined) return ''
  if (t.kind === 'feature') {
    const f = n.features.find((x) => x.id === t.id)
    return f === undefined ? '' : `- feature ${f.id} "${f.name}" of node ${n.id} "${n.name}" (${f.endpoint ?? f.category}; ${tail(f.status, f.phase, f.description)}).${issues}`
  }
  return `- node ${n.id} "${n.name}" (${n.kind}; ${tail(n.status, n.phase, n.description)}).${issues}`
}

/**
 * Create (or check) the issues for this work in the user's tracker. The conversation gets the trackers the user has
 * not turned off; without any, it says what to set up instead of starting.
 */
export async function trackWithAi(targets: readonly TrackTarget[]): Promise<void> {
  const m = getState().project?.model
  if (m === undefined || targets.length === 0) return
  const st = getState()
  if (st.ai.userTools === null) await loadUserTools()
  const vendor = getState().ai.vendor
  const prefs = getState().prefs.ai.tools[vendor]
  const trackers = (getState().ai.userTools?.[vendor] ?? []).filter((t) => t.ok && prefs[t.name] !== 'off' && (TRACKER.test(`${t.name} ${t.label}`) || t.kind === 'apps'))
  if (trackers.length === 0) {
    toast(`${vendor === 'claude' ? 'Claude Code' : 'Codex'} has no issue tracker connected (Linear, GitHub, Jira…). Add its MCP server or connector in the CLI, then check Settings → AI → Tools.`, 'error')
    return
  }
  const lines = targets.slice(0, 40).map((t) => itemLine(m, t)).filter((x) => x !== '')
  const more = targets.length > 40 ? `\n…and ${targets.length - 40} more: do these first, then say what is left.` : ''
  setAi((ai) => ({ tools: [...new Set([...ai.tools, ...trackers.map((t) => t.name)])] }))
  await ask(`Track this planned work in the issue tracker (${trackers.map((t) => t.label).join(', ')}):\n${lines.join('\n')}${more}`, { mode: 'track' })
}
