// A service (any node): identity, description, its feature catalog (master list; the detail opens beside it),
// connections, inner architecture, evidence and simulation parameters.
import { openNote } from '../../notes/noteActions.ts'
import { useNotes } from '../../notes/notesStore.ts'
import { adrNumber } from '@shared/export/adr.ts'
import { openRecord } from '../../records/decide.ts'
import { useRecords } from '../../records/recordsStore.ts'
import { ArrowDownRight, ArrowUpLeft, Cable, Crosshair, Maximize2, Minimize2, Plus, Trash2 } from 'lucide-react'
import { effectiveTeam } from '@shared/model/governance.ts'
import { HOSTING_LABEL, KIND_INFO } from '@shared/model/kinds.ts'
import { uniqueId } from '@shared/model/ids.ts'
import { childrenOf, descendantIds, pathLabel, subtreeNeighbours } from '@shared/model/queries.ts'
import { FEATURE_CATEGORIES, FeatureZ, HOSTINGS, NODE_KINDS, SENSITIVITIES, STATUSES } from '@shared/model/schema.ts'
import type { HxNode, NodePatch, NodeSim } from '@shared/model/schema.ts'
import { Button } from '../../components/ui/Button.tsx'
import { cn } from '../../lib/cn.ts'
import { kindIcon, nodeColor } from '../../lib/icons.tsx'
import { completeConnect, edit, focus, startConnect, toggleExpanded } from '../../state/actions.ts'
import { setUi, useStore } from '../../state/store.ts'
import { useModel } from '../../canvas/useScene.ts'
import { reveal } from '../ArchitectureTree.tsx'
import { IMPACT_MODES, useImpactCounts } from '../../canvas/ImpactBanner.tsx'
import { deleteSelection } from '../selectionOps.ts'
import { EvidenceList } from './EvidenceList.tsx'
import { Chip, NumberInput, Row, Section, Select, TextArea, TextInput, orNull } from './fields.tsx'
import { DataClassPicker, NotesEditor, PhasePicker, TeamPicker, useDataScope } from './governance.tsx'

export const STATUS_LABEL: Record<HxNode['status'], string> = {
  existing: 'Existing',
  planned: 'Planned',
  'in-progress': 'In progress',
  deprecated: 'Deprecated',
  removed: 'Removed',
}

export const SENSITIVITY_LABEL: Record<(typeof SENSITIVITIES)[number], string> = {
  public: 'Public',
  internal: 'Internal',
  confidential: 'Confidential',
  restricted: 'Restricted',
}

export function patchNode(id: string, patch: NodePatch, field: string): void {
  edit([{ op: 'updateNode', id, patch }], { coalesceKey: `node:${id}:${field}`, label: 'edit node' })
}

const KIND_LABELS = Object.fromEntries(NODE_KINDS.map((k) => [k, KIND_INFO[k].label])) as Record<HxNode['kind'], string>

export function NodeInspector({ node: n, readOnly }: { node: HxNode; readOnly: boolean }): React.JSX.Element {
  const model = useModel()
  const featureId = useStore((s) => s.ui.featureId)
  const expanded = useStore((s) => s.ui.expanded[n.id] === true)
  const Icon = kindIcon(n.kind)
  const kids = childrenOf(model, n.id)
  const { upstream, downstream, connectors: crossing } = subtreeNeighbours(model, n.id)
  const sim: NodeSim = n.sim ?? { capacityRps: null, latencyMs: null, errorRate: null, entryRps: null }
  const scope = useDataScope().get(n.id)
  const team = effectiveTeam(model, n.id)

  const addFeature = (): void => {
    const id = uniqueId('feature', (x) => n.features.some((f) => f.id === x))
    const f = FeatureZ.parse({ id, name: 'New feature' })
    edit([{ op: 'updateNode', id: n.id, patch: { features: [...n.features, f] } }], { label: 'add feature' })
    setUi({ featureId: id })
  }

  return (
    <div>
      <div className="flex items-start gap-2.5 border-b p-3">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border" style={{ borderColor: nodeColor(n), color: nodeColor(n) }}>
          <Icon className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <TextInput value={n.name} readOnly={readOnly} onChange={(v) => v.trim() !== '' && patchNode(n.id, { name: v }, 'name')} className="h-7 text-sm font-semibold disabled:text-sm" />
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{KIND_INFO[n.kind].label}</span>
            {n.role !== null && <span>· {n.role}</span>}
            <span className={cn('ml-auto rounded px-1.5 py-px text-[10px] font-medium', n.status === 'existing' ? 'bg-success/15 text-success' : n.status === 'planned' ? 'bg-info/15 text-info' : 'bg-warning/15 text-warning')}>
              {STATUS_LABEL[n.status]}
            </span>
          </div>
        </div>
      </div>

      <Section title="Details">
        <Row label="Kind">
          <Select value={n.kind} options={NODE_KINDS} labels={KIND_LABELS} readOnly={readOnly} onChange={(kind) => patchNode(n.id, { kind }, 'kind')} />
        </Row>
        <Row label="Status">
          <Select value={n.status} options={STATUSES} labels={STATUS_LABEL} readOnly={readOnly} onChange={(status) => patchNode(n.id, { status }, 'status')} />
        </Row>
        <Row label="Boundary">
          <Select value={n.boundary} options={['internal', 'external'] as const} labels={{ internal: 'Internal', external: 'External / third-party' }} readOnly={readOnly} onChange={(boundary) => patchNode(n.id, { boundary }, 'boundary')} />
        </Row>
        {n.boundary === 'external' && (
          <Row label="Vendor">
            <TextInput value={n.vendor ?? ''} placeholder="Stripe, Twilio…" readOnly={readOnly} onChange={(v) => patchNode(n.id, { vendor: orNull(v) }, 'vendor')} />
          </Row>
        )}
        <Row label="Hosting">
          <Select value={n.hosting ?? 'unset'} options={['unset', ...HOSTINGS] as const} labels={{ unset: '—', ...HOSTING_LABEL }} readOnly={readOnly} onChange={(v) => patchNode(n.id, { hosting: v === 'unset' ? null : v }, 'hosting')} />
        </Row>
        <Row label="Provider" hint="AWS, Azure, GCP, a data centre, an MDM…">
          <TextInput value={n.provider ?? ''} placeholder="AWS, Azure, on-prem DC…" readOnly={readOnly} onChange={(v) => patchNode(n.id, { provider: orNull(v) }, 'provider')} />
        </Row>
        <Row label="Region">
          <TextInput value={n.region ?? ''} placeholder="eu-west-1" readOnly={readOnly} onChange={(v) => patchNode(n.id, { region: orNull(v) }, 'region')} />
        </Row>
        <Row label="Tech stack">
          <TextInput value={n.techStack ?? ''} placeholder="Go, PostgreSQL…" readOnly={readOnly} onChange={(v) => patchNode(n.id, { techStack: orNull(v) }, 'techStack')} />
        </Row>
        <Row label="Role">
          <TextInput value={n.role ?? ''} placeholder="Go microservice" readOnly={readOnly} onChange={(v) => patchNode(n.id, { role: orNull(v) }, 'role')} />
        </Row>
        <div className="mt-2">
          <TextArea value={n.description} placeholder="What this does, what it owns, who runs it." readOnly={readOnly} rows={3} onChange={(v) => patchNode(n.id, { description: v }, 'description')} />
        </div>
        <TagEditor tags={n.tags} readOnly={readOnly} onChange={(tags) => patchNode(n.id, { tags }, 'tags')} />
      </Section>

      <Section title="Ownership, data & roadmap">
        <Row label="Team">
          <TeamPicker
            value={n.team}
            inherited={team?.inherited === true ? team.team : null}
            readOnly={readOnly}
            onChange={(t, pre) => edit([...pre, { op: 'updateNode', id: n.id, patch: { team: t } }], { label: 'set team' })}
          />
        </Row>
        <Row label="Owner" hint="A person or alias">
          <TextInput value={n.owner ?? ''} placeholder="Who to ask" readOnly={readOnly} onChange={(v) => patchNode(n.id, { owner: orNull(v) }, 'owner')} />
        </Row>
        <Row label="Sensitivity">
          <Select
            value={n.sensitivity ?? 'unset'}
            options={['unset', ...SENSITIVITIES] as const}
            labels={{ unset: '—', ...SENSITIVITY_LABEL }}
            readOnly={readOnly}
            onChange={(v) => patchNode(n.id, { sensitivity: v === 'unset' ? null : v }, 'sensitivity')}
          />
        </Row>
        <div className="py-1">
          <div className="mb-1 text-xs text-muted-foreground" title="Regulated data it stores or processes. Dashed: in scope because a connector carries it or a part inside handles it.">
            Data it handles
          </div>
          <DataClassPicker value={n.dataClasses} derived={scope} readOnly={readOnly} onChange={(dataClasses) => patchNode(n.id, { dataClasses }, 'dataClasses')} />
        </div>
        <Row label="Phase" hint="The roadmap phase in which this lands (planned) or goes away (deprecated/removed)">
          <PhasePicker value={n.phase} readOnly={readOnly} onChange={(phase) => edit([{ op: 'updateNode', id: n.id, patch: { phase } }], { label: 'set phase' })} />
        </Row>
      </Section>

      <Section title="Notes" defaultOpen={n.notes !== ''}>
        <NotesEditor value={n.notes} readOnly={readOnly} onChange={(notes) => patchNode(n.id, { notes }, 'notes')} />
      </Section>

      <RelatedDecisions id={n.id} />
      <MentionedIn id={n.id} />

      <Section
        title={`Features (${n.features.length})`}
        action={!readOnly && (
          <Button variant="ghost" size="icon" className="size-6" aria-label="Add feature" onClick={addFeature}>
            <Plus />
          </Button>
        )}
      >
        {n.features.length === 0 ? (
          <p className="text-xs text-muted-foreground">No features catalogued. Add the APIs, workers, data stores and guards this service provides.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {FEATURE_CATEGORIES.flatMap((cat) => n.features.filter((f) => f.category === cat)).map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => setUi({ featureId: featureId === f.id ? null : f.id })}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors',
                    featureId === f.id ? 'border-primary/60 bg-primary/10' : 'hover:bg-accent/50',
                  )}
                >
                  <span className={cn('size-1.5 shrink-0 rounded-full', f.status === 'existing' ? 'bg-success' : f.status === 'planned' ? 'bg-info' : 'bg-warning')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{f.name}</span>
                    {f.endpoint !== null && <span className="block truncate font-mono text-[10.5px] text-muted-foreground">{f.endpoint}</span>}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground uppercase">{f.protocol ?? f.category}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Connections (${crossing.length})`}>
        {!readOnly && (
          <div className="mb-2 flex items-center gap-1.5">
            <Button size="sm" variant="outline" icon={<Cable />} title="Then click the target node on the canvas" onClick={() => startConnect(n.id)}>
              Connect to…
            </Button>
            <select
              aria-label="Add a connection to"
              value=""
              onChange={(e) => {
                if (e.target.value === '') return
                startConnect(n.id)
                completeConnect(e.target.value)
              }}
              className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1 text-xs"
            >
              <option value="">or pick a target…</option>
              {Object.values(model.nodes)
                .filter((x) => x.id !== n.id)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {pathLabel(model, x.id)}
                  </option>
                ))}
            </select>
          </div>
        )}
        <NeighbourList title="Called by" icon={<ArrowUpLeft className="size-3" />} nodes={upstream} />
        <NeighbourList title="Depends on" icon={<ArrowDownRight className="size-3" />} nodes={downstream} />
        <ImpactControls id={n.id} />
      </Section>

      <Section title={`Inner architecture (${kids.length})`} defaultOpen={kids.length > 0}>
        {kids.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-1">
            {kids.map((k) => (
              <li key={k.id}>
                <button type="button" onClick={() => reveal(model, k.id)} className="rounded-md border px-1.5 py-0.5 text-[11px] hover:bg-accent">
                  {k.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" icon={expanded ? <Minimize2 /> : <Maximize2 />} onClick={() => toggleExpanded(n.id)}>
            {expanded ? 'Collapse' : kids.length > 0 ? 'Expand in place' : 'Map inner parts'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => focus(n.id)}>
            Open inside
          </Button>
        </div>
      </Section>

      {(n.evidence.length > 0 || n.provenance !== null) && (
        <Section title="Evidence" defaultOpen={n.evidence.length > 0}>
          <EvidenceList evidence={n.evidence} provenance={n.provenance} confidence={n.confidence} />
        </Section>
      )}

      <Section title="Simulation" defaultOpen={false}>
        <Row label="Capacity" hint="Requests per second before it saturates">
          <NumberInput value={sim.capacityRps} suffix="rps" min={0} readOnly={readOnly} onChange={(v) => patchNode(n.id, { sim: { ...sim, capacityRps: v } }, 'sim.capacity')} />
        </Row>
        <Row label="Latency" hint="Base service time">
          <NumberInput value={sim.latencyMs} suffix="ms" min={0} readOnly={readOnly} onChange={(v) => patchNode(n.id, { sim: { ...sim, latencyMs: v } }, 'sim.latency')} />
        </Row>
        <Row label="Error rate" hint="Fraction of requests that fail on their own (0–1)">
          <NumberInput value={sim.errorRate} step={0.001} min={0} max={1} readOnly={readOnly} onChange={(v) => patchNode(n.id, { sim: { ...sim, errorRate: v } }, 'sim.error')} />
        </Row>
        <Row label="Generates" hint="Load this node creates as an entry point">
          <NumberInput value={sim.entryRps} suffix="rps" min={0} readOnly={readOnly} onChange={(v) => patchNode(n.id, { sim: { ...sim, entryRps: v } }, 'sim.entry')} />
        </Row>
      </Section>

      {!readOnly && (
        <div className="p-3">
          <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" icon={<Trash2 />} onClick={() => deleteSelection()}>
            Delete {kids.length > 0 ? 'with inner parts' : ''}
          </Button>
        </div>
      )}
    </div>
  )
}

function ImpactControls({ id }: { id: string }): React.JSX.Element {
  const model = useModel()
  const blast = useStore((s) => s.ui.blast)
  const active = blast?.id === id
  const counts = useImpactCounts(active ? id : null, blast?.dir ?? 'both', blast?.hops ?? Infinity)
  return (
    <div className="mt-2 rounded-md border bg-background/60 p-2">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium">
        <Crosshair className="size-3.5 text-primary" />
        Impact analysis
      </div>
      <p className="mb-1.5 text-[11px] text-muted-foreground">See what breaks if this fails, or what it needs to work. The canvas highlights them.</p>
      <div className="flex flex-wrap gap-1">
        {IMPACT_MODES.map((m) => {
          const on = active && blast.dir === m.dir
          return (
            <Button key={m.dir} size="sm" variant={on ? 'default' : 'outline'} title={m.hint} onClick={() => setUi({ blast: on ? null : { id, dir: m.dir, hops: blast?.hops ?? Infinity } })}>
              {m.label}
            </Button>
          )
        })}
      </div>
      {active && (
        <div className="mt-2 flex flex-col gap-1 text-[11px]">
          {counts.affected.length > 0 && (
            <div>
              <span className="text-[var(--hx-bad)]">Breaks if it fails:</span> {counts.affected.map((x) => model.nodes[x]?.name ?? x).join(', ')}
            </div>
          )}
          {counts.needed.length > 0 && (
            <div>
              <span className="text-[var(--hx-blue)]">It needs:</span> {counts.needed.map((x) => model.nodes[x]?.name ?? x).join(', ')}
            </div>
          )}
          {counts.affected.length === 0 && counts.needed.length === 0 && <div className="text-muted-foreground">Nothing connected in this direction.</div>}
        </div>
      )}
    </div>
  )
}

function NeighbourList({ title, icon, nodes }: { title: string; icon: React.ReactNode; nodes: HxNode[] }): React.JSX.Element {
  const model = useModel()
  return (
    <div className="mb-1.5">
      <div className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
        {icon}
        {title}
      </div>
      {nodes.length === 0 ? (
        <span className="text-xs text-muted-foreground">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {nodes.map((x) => (
            <button key={x.id} type="button" onClick={() => reveal(model, x.id)} className="rounded-md border px-1.5 py-0.5 text-[11px] hover:bg-accent" style={{ borderColor: `color-mix(in oklab, ${nodeColor(x)} 50%, transparent)` }}>
              {x.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TagEditor({ tags, readOnly, onChange }: { tags: string[]; readOnly: boolean; onChange: (t: string[]) => void }): React.JSX.Element {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {tags.map((t) => (
        <Chip key={t} {...(readOnly ? {} : { onRemove: () => onChange(tags.filter((x) => x !== t)) })}>
          {t}
        </Chip>
      ))}
      {!readOnly && (
        <input
          placeholder="+ tag"
          aria-label="Add tag"
          className="h-6 w-20 rounded-md border border-dashed bg-transparent px-1.5 text-[11px] outline-none focus:border-ring"
          onKeyDown={(e) => {
            const v = e.currentTarget.value.trim()
            if (e.key === 'Enter' && v !== '' && !tags.includes(v)) {
              onChange([...tags, v])
              e.currentTarget.value = ''
            }
          }}
        />
      )}
    </div>
  )
}

/** Decision records about this node (or anything inside it). */
export function RelatedDecisions({ id }: { id: string }): React.JSX.Element | null {
  const model = useModel()
  const decisions = useRecords((s) => s.decisions)
  const inside = new Set([id, ...descendantIds(model, id)])
  const related = decisions.filter((d) => d.entityIds.some((x) => inside.has(x)))
  if (related.length === 0) return null
  return (
    <Section title={`Decisions (${related.length})`}>
      <ul className="flex flex-col gap-1">
        {related.map((d) => (
          <li key={d.id}>
            <button type="button" onClick={() => openRecord('decision', d.id)} className="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent/50">
              <span className="font-mono text-[10.5px] text-muted-foreground">{adrNumber(d.number)}</span>
              <span className="min-w-0 flex-1 truncate">{d.title}</span>
              <span className="text-[10px] text-muted-foreground">{d.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** Notes that mention this node. */
function MentionedIn({ id }: { id: string }): React.JSX.Element | null {
  const notes = useNotes((s) => s.mentions[id])
  if (notes === undefined || notes.length === 0) return null
  return (
    <Section title={`Mentioned in notes (${notes.length})`} defaultOpen={false}>
      <ul className="flex flex-col gap-1">
        {notes.map((x) => (
          <li key={x.path}>
            <button type="button" onClick={() => openNote(x.path)} className="w-full truncate rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent/50">
              {x.title}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  )
}
