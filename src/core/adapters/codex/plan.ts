// Plan text for a Codex Plan pass (the first that applies): a plan item → the
// `<proposed_plan>` block of the final message → the final message itself, with a warning.
import type { PlanCaptureSource } from '../../../shared/events.ts'

const PROPOSED = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/g

/** The last `<proposed_plan>…</proposed_plan>` block's body, trimmed; undefined when there is none or it is empty. */
export function proposedPlanBlock(text: string): string | undefined {
  let last: string | undefined
  for (const m of text.matchAll(PROPOSED)) last = m[1]
  const body = last?.trim()
  return body !== undefined && body !== '' ? body : undefined
}

export const FINAL_MESSAGE_PLAN_WARNING =
  'Codex finished without a proposed plan, so Harpoon used its final message as the plan.'

export interface PlanCapture {
  markdown: string
  source: PlanCaptureSource
  warning?: string
}

export function choosePlan(o: {
  planItem?: string | undefined
  finalMessage: string
}): PlanCapture | undefined {
  const item = o.planItem?.trim()
  if (item !== undefined && item !== '')
    return { markdown: proposedPlanBlock(item) ?? item, source: 'proposed_plan' }
  const block = proposedPlanBlock(o.finalMessage)
  if (block !== undefined) return { markdown: block, source: 'proposed_plan' }
  const text = o.finalMessage.trim()
  if (text === '') return undefined
  return { markdown: text, source: 'final-message', warning: FINAL_MESSAGE_PLAN_WARNING }
}
