// The AI's open questions: pick an option (or several), or write your own answer; "Send answers" continues the
// conversation. "Just decide" lets the AI choose sensible defaults and state its assumptions.
import { MessageCircleQuestion, Send } from 'lucide-react'
import { useState } from 'react'
import type { AiQuestion } from '@shared/ipc.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { invoke } from '../ipc/client.ts'
import { toast } from '../state/actions.ts'

export function QuestionCard({ runId, questions }: { runId: string; questions: AiQuestion[] }): React.JSX.Element {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)

  const answerOf = (q: AiQuestion): string => [...(picked[q.id] ?? []), ...(other[q.id]?.trim() ? [other[q.id]?.trim() ?? ''] : [])].join('; ')
  const complete = questions.every((q) => answerOf(q) !== '')

  const send = async (text: string): Promise<void> => {
    setSending(true)
    const r = await invoke('ai.send', { runId, prompt: text })
    setSending(false)
    if (!r.ok) toast(r.error.message, 'error')
  }

  return (
    <div className="rounded-xl border border-info/50 bg-info/5 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
        <MessageCircleQuestion className="size-4 text-info" />A few questions before I design this
      </div>
      <ol className="flex flex-col gap-3">
        {questions.map((q, i) => (
          <li key={q.id}>
            <div className="text-[12.5px] font-medium">
              {i + 1}. {q.question}
            </div>
            {q.why !== null && <div className="text-[11px] text-muted-foreground">{q.why}</div>}
            {q.options.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {q.options.map((o) => {
                  const on = picked[q.id]?.includes(o) === true
                  return (
                    <button
                      key={o}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setPicked((p) => {
                          const cur = p[q.id] ?? []
                          const next = q.multi ? (on ? cur.filter((x) => x !== o) : [...cur, o]) : on ? [] : [o]
                          return { ...p, [q.id]: next }
                        })
                      }
                      className={cn('rounded-md border px-2 py-1 text-[11.5px]', on ? 'border-primary bg-primary/15' : 'hover:bg-accent/60')}
                    >
                      {o}
                    </button>
                  )
                })}
              </div>
            )}
            <input
              value={other[q.id] ?? ''}
              onChange={(e) => setOther((p) => ({ ...p, [q.id]: e.target.value }))}
              placeholder={q.options.length > 0 ? 'Or answer in your own words…' : 'Your answer…'}
              className="mt-1.5 h-7 w-full rounded-md border bg-background px-2 text-xs outline-none focus:border-ring"
            />
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button
          size="sm"
          icon={<Send />}
          disabled={!complete}
          loading={sending}
          onClick={() => void send(`Answers:\n${questions.map((q, i) => `${i + 1}. ${q.question}\n   → ${answerOf(q)}`).join('\n')}\n\nNow go on with the request.`)}
        >
          Send answers
        </Button>
        <Button size="sm" variant="ghost" disabled={sending} onClick={() => void send('Just decide: pick sensible defaults for anything open, list your assumptions, and go on with the request.')}>
          Just decide
        </Button>
      </div>
    </div>
  )
}
