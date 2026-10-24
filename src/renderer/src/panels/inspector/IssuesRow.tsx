// The issues tracking a planned node or connector: open one, unlink it, add a link by hand, or have the AI create the
// issue in the user's tracker. Only shown for planned and in-progress work, or when links exist.
import { CircleDot, Link2, Sparkles, X } from 'lucide-react'
import type { IssueLink, Status } from '@shared/model/schema.ts'
import { IssueLinkZ } from '@shared/model/schema.ts'
import { invoke } from '../../ipc/client.ts'
import { toast } from '../../state/actions.ts'
import { trackWithAi } from '../../ai/track.ts'
import type { TrackTarget } from '../../ai/track.ts'
import { AI_NOTE_SHORT } from '../../ai/AiNote.tsx'
import { keyOf, trackerOf } from '@shared/model/issues.ts'
import { useState } from 'react'
import { Row } from './fields.tsx'

export function IssuesRow({ target, status, issues, readOnly, onChange }: { target: TrackTarget; status: Status; issues: IssueLink[]; readOnly: boolean; onChange: (issues: IssueLink[]) => void }): React.JSX.Element | null {
  const [adding, setAdding] = useState<string | null>(null)
  const plannedWork = status === 'planned' || status === 'in-progress'
  if (!plannedWork && issues.length === 0) return null
  const add = (raw: string): void => {
    const url = raw.trim()
    setAdding(null)
    if (url === '') return
    if (!/^https:\/\/[^\s]+$/i.test(url)) return toast('Paste the issue’s https:// link.', 'error')
    onChange([...issues.filter((i) => i.url !== url), IssueLinkZ.parse({ url, key: keyOf(url), tracker: trackerOf(url) })])
  }
  return (
    <Row label="Tracked" hint="The issues (stories, tickets) tracking this work outside Harpoon">
      <span className="flex flex-wrap items-center gap-1 text-xs">
        {issues.length === 0 && <span className="text-muted-foreground">Not tracked</span>}
        {issues.map((i) => (
          <span key={i.url} className="flex items-center gap-0.5 rounded-full border px-1.5" title={`${i.title}${i.state !== null ? ` (${i.state})` : ''}`}>
            <CircleDot className={i.state === 'closed' ? 'size-3 text-success' : 'size-3 text-info'} />
            <button type="button" className="hover:underline" onClick={() => void invoke('shell.open', { target: 'url', url: i.url }).then((r) => !r.ok && toast(r.error.message, 'error'))}>
              {i.key}
            </button>
            {!readOnly && (
              <button type="button" aria-label={`Unlink ${i.key}`} className="text-muted-foreground hover:text-foreground" onClick={() => onChange(issues.filter((x) => x.url !== i.url))}>
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {adding !== null && (
          <input
            autoFocus
            value={adding}
            placeholder="Paste the issue link (https://…)"
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add(adding)
              else if (e.key === 'Escape') setAdding(null)
            }}
            onBlur={() => add(adding)}
            className="h-6 w-full rounded border bg-background px-1.5 text-xs outline-none focus:border-ring"
          />
        )}
        {!readOnly && adding === null && (
          <>
            <button type="button" className="flex items-center gap-0.5 text-muted-foreground hover:text-foreground" onClick={() => setAdding('')} title="Link an existing issue">
              <Link2 className="size-3" />
              Link
            </button>
            {plannedWork && issues.length === 0 && (
              <button type="button" className="flex items-center gap-0.5 text-primary hover:underline" onClick={() => void trackWithAi([target])} title={`Create the issue in your tracker and link it. ${AI_NOTE_SHORT}`}>
                <Sparkles className="size-3" />
                Create with AI
              </button>
            )}
          </>
        )}
      </span>
    </Row>
  )
}
