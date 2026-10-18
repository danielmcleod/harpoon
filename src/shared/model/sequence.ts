// A flow as a sequence diagram: participants in order of first appearance, one message per step. Shared by the
// Mermaid export and the renderer's sequence view so both read a flow the same way.
import type { HxFlow, Model } from './schema.ts'

export interface SequenceMessage {
  /** Index of the step in the flow. */
  step: number
  connectorId: string
  from: string
  to: string
  /** request (sync), async (fire and forget) or reply (direction B). */
  kind: 'sync' | 'async' | 'reply'
  /** The step's note, else the channel's protocol. */
  label: string
  protocol: string
}

export interface Sequence {
  participants: { id: string; name: string }[]
  messages: SequenceMessage[]
}

/** Steps whose connector no longer exists are skipped. */
export function flowSequence(m: Model, f: HxFlow): Sequence {
  const participants: Sequence['participants'] = []
  const seen = new Set<string>()
  const messages: SequenceMessage[] = []
  f.steps.forEach((st, step) => {
    const c = m.connectors[st.connectorId]
    if (c === undefined) return
    const [from, to] = st.direction === 'A' ? [c.source, c.target] : [c.target, c.source]
    for (const id of [from, to]) {
      if (seen.has(id)) continue
      seen.add(id)
      participants.push({ id, name: m.nodes[id]?.name ?? id })
    }
    const protocol = st.direction === 'A' ? c.channelA.protocol : (c.channelB?.protocol ?? 'reply')
    messages.push({ step, connectorId: c.id, from, to, kind: st.direction === 'B' ? 'reply' : c.sync === 'async' ? 'async' : 'sync', label: st.note ?? protocol, protocol })
  })
  return { participants, messages }
}
