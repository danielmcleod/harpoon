// A proposal under review: its title and rationale, counts by change kind, and every op with a checkbox (partial
// accept). The canvas shows it as a diff overlay (green added, amber changed, red removed) while it is reviewed.
import { Check, CircleDot, ClipboardList, Eye, EyeOff, Flag, Minus, Plus, X } from 'lucide-react'
import { useMemo } from 'react'
import type { Proposal } from '@shared/ipc.ts'
import type { Op } from '@shared/model/ops.ts'
import type { Model } from '@shared/model/schema.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { acceptProposal, discardProposal, reviewProposal, toggleOp } from '../state/ai.ts'
import { invoke } from '../ipc/client.ts'
import { toast } from '../state/actions.ts'
import { currentExportView } from '../panels/ExportMenu.tsx'
import { useStore } from '../state/store.ts'
import { Markdown } from './Markdown.tsx'

type Kind = 'add' | 'change' | 'remove'

function describeOp(o: Op, m: Model, all: readonly Op[]): { kind: Kind; text: string } | null {
  const added = new Map<string, string>()
  for (const x of all) if (x.op === 'addNode') added.set(x.node.id, x.node.name)
  const nm = (id: string): string => m.nodes[id]?.name ?? added.get(id) ?? id
  switch (o.op) {
    case 'addNode':
      return { kind: 'add', text: `${o.node.name}${o.node.parentId !== null ? ` in ${nm(o.node.parentId)}` : ''}` }
    case 'updateNode':
      return { kind: 'change', text: `${nm(o.id)}: ${Object.keys(o.patch).join(', ')}` }
    case 'removeNode':
      return { kind: 'remove', text: nm(o.id) }
    case 'addConnector':
      return { kind: 'add', text: `${nm(o.connector.source)} → ${nm(o.connector.target)} · ${o.connector.channelA.protocol}` }
    case 'updateConnector': {
      const c = m.connectors[o.id]
      return { kind: 'change', text: `${c !== undefined ? `${nm(c.source)} → ${nm(c.target)}` : o.id}: ${Object.keys(o.patch).join(', ')}` }
    }
    case 'removeConnector': {
      const c = m.connectors[o.id]
      return { kind: 'remove', text: c !== undefined ? `${nm(c.source)} → ${nm(c.target)}` : o.id }
    }
    case 'addBoundary':
      return { kind: 'add', text: `Boundary ${o.boundary.name}` }
    case 'updateBoundary':
      return { kind: 'change', text: `Boundary ${m.boundaries[o.id]?.name ?? o.id}` }
    case 'removeBoundary':
      return { kind: 'remove', text: `Boundary ${m.boundaries[o.id]?.name ?? o.id}` }
    case 'addFlow':
      return { kind: 'add', text: `Flow ${o.flow.name}` }
    case 'updateFlow':
      return { kind: 'change', text: `Flow ${m.flows[o.id]?.name ?? o.id}` }
    case 'removeFlow':
      return { kind: 'remove', text: `Flow ${m.flows[o.id]?.name ?? o.id}` }
    case 'updateMeta':
      return { kind: 'change', text: 'Project details' }
    case 'setLayout':
      return null
  }
}

const KIND_STYLE: Record<Kind, { icon: typeof Plus; cls: string }> = {
  add: { icon: Plus, cls: 'text-hx-add' },
  change: { icon: CircleDot, cls: 'text-hx-mod' },
  remove: { icon: Minus, cls: 'text-hx-del' },
}

export function ProposalCard({ proposal: p }: { proposal: Proposal }): React.JSX.Element {
  const model = useStore((s) => s.project?.model)
  const review = useStore((s) => s.ai.review)
  const excluded = useStore((s) => s.ai.excluded)
  const reviewing = review?.kind === 'proposal' && review.id === p.id
  const rows = useMemo(
    () => (model === undefined ? [] : p.ops.map((o, i) => ({ i, d: describeOp(o, model, p.ops) })).filter((r) => r.d !== null)),
    [p.ops, model],
  )
  const counts = { add: 0, change: 0, remove: 0 }
  for (const r of rows) if (r.d !== null) counts[r.d.kind]++
  const pending = p.status === 'pending'

  return (
    <div className={cn('rounded-xl border bg-card', reviewing && 'border-primary/60')}>
      <div className="border-b p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Proposal</div>
            <div className="text-sm font-semibold">{p.title}</div>
          </div>
          {p.status !== 'pending' && (
            <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', p.status === 'accepted' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground')}>
              {p.status}
            </span>
          )}
        </div>
        {p.status === 'accepted' && (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Follow up below, for example “write an implementation brief” or, with <strong className="font-medium text-foreground">Tools</strong> turned on, “create a Linear issue for this plan”.
          </p>
        )}
        <div className="mt-1.5 flex gap-3 text-[11px]">
          <span className="text-hx-add">+{counts.add} added</span>
          <span className="text-hx-mod">~{counts.change} changed</span>
          <span className="text-hx-del">−{counts.remove} removed</span>
        </div>
        {p.rationale.trim() !== '' && (
          <div className="mt-2 max-h-40 overflow-y-auto text-muted-foreground">
            <Markdown text={p.rationale} />
          </div>
        )}
        {p.risks !== null && p.risks.trim() !== '' && (
          <div className="mt-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px]">
            <strong>Risks:</strong> {p.risks}
          </div>
        )}
      </div>

      {pending && reviewing && (
        <ul className="max-h-64 overflow-y-auto p-2">
          {rows.map(({ i, d }) => {
            if (d === null) return null
            const K = KIND_STYLE[d.kind]
            const on = excluded[i] !== true
            return (
              <li key={i}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[11.5px] hover:bg-accent/50">
                  <input type="checkbox" checked={on} onChange={() => toggleOp(i)} className="accent-[var(--primary)]" />
                  <K.icon className={cn('size-3.5 shrink-0', K.cls)} />
                  <span className={cn('min-w-0 flex-1 truncate', !on && 'text-muted-foreground line-through')}>{d.text}</span>
                </label>
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex flex-wrap gap-1.5 px-3 pt-2">
        <Button
          size="sm"
          variant="ghost"
          icon={<ClipboardList />}
          title="A task list for building this change (paste it into Claude Code or Codex)"
          onClick={() =>
            void invoke('export.render', { format: 'brief', view: currentExportView(), proposalId: p.id }).then(async (r) => {
              if (!r.ok) return toast(r.error.message, 'error')
              await navigator.clipboard.writeText(r.value.content)
              toast('Implementation brief copied.')
            })
          }
        >
          Copy implementation brief
        </Button>
      </div>
      {pending && (
        <div className="flex flex-wrap gap-1.5 p-3 pt-2">
          <Button size="sm" variant={reviewing ? 'secondary' : 'outline'} icon={reviewing ? <EyeOff /> : <Eye />} onClick={() => reviewProposal(reviewing ? null : p.id)}>
            {reviewing ? 'Hide diff' : 'Review on canvas'}
          </Button>
          <Button size="sm" icon={<Check />} onClick={() => void acceptProposal(p.id, false)}>
            Accept
          </Button>
          <AcceptPlanned id={p.id} />
          <Button size="sm" variant="ghost" icon={<X />} onClick={() => void discardProposal(p.id)}>
            Discard
          </Button>
        </div>
      )}
    </div>
  )
}

const NO_PHASES: never[] = []

/** Accept as planned work, optionally straight into a roadmap phase. */
function AcceptPlanned({ id }: { id: string }): React.JSX.Element {
  const phases = useStore((s) => s.project?.model.meta.phases) ?? NO_PHASES
  const sorted = [...phases].sort((a, b) => a.order - b.order)
  if (sorted.length === 0) {
    return (
      <Button size="sm" variant="outline" icon={<Flag />} title="Add it as a planned roadmap layer" onClick={() => void acceptProposal(id, true)}>
        Accept as planned
      </Button>
    )
  }
  return (
    <label className="flex items-center rounded-md border">
      <span className="flex items-center gap-1 px-2 text-xs">
        <Flag className="size-3.5" />
        Accept as planned in
      </span>
      <select
        aria-label="Accept as planned in phase"
        value=""
        onChange={(e) => e.target.value !== '' && void acceptProposal(id, true, e.target.value === '-' ? null : e.target.value)}
        className="h-7 rounded-r-md border-l bg-background px-1 text-xs"
      >
        <option value="">phase…</option>
        {sorted.map((ph) => (
          <option key={ph.id} value={ph.id}>
            {ph.name}
          </option>
        ))}
        <option value="-">no phase yet</option>
      </select>
    </label>
  )
}
