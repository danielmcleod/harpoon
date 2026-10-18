// Where a node or connector was found in code (AI imports record file and line ranges), plus who made it.
import { Bot, FileCode2, User } from 'lucide-react'
import type { Evidence, Provenance } from '@shared/model/schema.ts'
import { invoke } from '../../ipc/client.ts'
import { toast } from '../../state/actions.ts'


export function EvidenceList({ evidence, provenance, confidence }: { evidence: Evidence[]; provenance: Provenance | null; confidence: number | null }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {provenance !== null && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {provenance.source === 'user' ? <User className="size-3" /> : <Bot className="size-3" />}
          {provenance.source === 'ai-import' ? 'Found by an AI import' : provenance.source === 'ai-plan' ? 'Proposed by AI' : provenance.source === 'seed' ? 'Seeded' : 'Added by hand'}
          {confidence !== null && <span>· {Math.round(confidence * 100)}% confidence</span>}
        </div>
      )}
      {evidence.map((ev, i) => {
        const where = `${ev.path}${ev.lines !== null ? `:${ev.lines[0]}${ev.lines[1] !== ev.lines[0] ? `-${ev.lines[1]}` : ''}` : ''}`
        return (
          <div key={i} className="rounded-md border bg-muted/40 p-1.5">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 text-left font-mono text-[11px] text-info hover:underline"
              title="Show the file in its folder"
              onClick={() => {
                void invoke('evidence.reveal', { repo: ev.repo, path: ev.path }).then((r) => {
                  if (!r.ok) toast(r.error.message, 'error')
                })
              }}
            >
              <FileCode2 className="size-3 shrink-0" />
              <span className="truncate">{where}</span>
            </button>
            {ev.snippet !== null && <pre className="mt-1 max-h-28 overflow-auto font-mono text-[10.5px] whitespace-pre-wrap text-muted-foreground selectable">{ev.snippet}</pre>}
          </div>
        )
      })}
    </div>
  )
}
