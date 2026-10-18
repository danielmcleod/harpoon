// A boundary zone: name, type, description and members.
import { Plus, Trash2 } from 'lucide-react'
import { BOUNDARY_TYPES } from '@shared/model/schema.ts'
import type { BoundaryPatch } from '@shared/model/schema.ts'
import { Button } from '../../components/ui/Button.tsx'
import { edit } from '../../state/actions.ts'
import { useModel } from '../../canvas/useScene.ts'
import { reveal } from '../ArchitectureTree.tsx'
import { deleteSelection } from '../selectionOps.ts'
import { Chip, Row, Section, Select, TextArea, TextInput } from './fields.tsx'
import { DataClassPicker, NotesEditor, TeamPicker } from './governance.tsx'

export const BOUNDARY_LABEL: Record<(typeof BOUNDARY_TYPES)[number], string> = {
  vpc: 'VPC',
  subnet: 'Subnet',
  'k8s-namespace': 'Kubernetes namespace',
  dmz: 'DMZ / public edge',
  compliance: 'Compliance perimeter',
  'third-party': 'Third-party',
  domain: 'Domain',
  'cloud-account': 'Cloud account / subscription',
  region: 'Region / zone',
  datacenter: 'Data centre (on-prem)',
  edge: 'Edge / site',
  other: 'Other',
}

export function BoundaryInspector({ id, readOnly }: { id: string; readOnly: boolean }): React.JSX.Element {
  const model = useModel()
  const b = model.boundaries[id]
  if (b === undefined) return <p className="p-3 text-xs text-muted-foreground">This boundary no longer exists.</p>
  const patch = (p: BoundaryPatch, field: string): void => {
    edit([{ op: 'updateBoundary', id, patch: p }], { coalesceKey: `boundary:${id}:${field}`, label: 'edit boundary' })
  }
  const candidates = Object.values(model.nodes).filter((n) => n.parentId === b.parentId && !b.nodeIds.includes(n.id))
  return (
    <div>
      <div className="border-b p-3">
        <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Boundary</div>
        <TextInput value={b.name} readOnly={readOnly} onChange={(v) => v.trim() !== '' && patch({ name: v }, 'name')} className="text-sm font-semibold" />
      </div>
      <Section title="Details">
        <Row label="Type">
          <Select value={b.type} options={BOUNDARY_TYPES} labels={BOUNDARY_LABEL} readOnly={readOnly} onChange={(type) => patch({ type }, 'type')} />
        </Row>
        <div className="mt-2">
          <TextArea value={b.description} placeholder="Network rules, compliance scope, ownership." readOnly={readOnly} onChange={(v) => patch({ description: v }, 'description')} />
        </div>
      </Section>
      <Section title="Ownership & data">
        <Row label="Team">
          <TeamPicker value={b.team} readOnly={readOnly} onChange={(t, pre) => edit([...pre, { op: 'updateBoundary', id, patch: { team: t } }], { label: 'set team' })} />
        </Row>
        <div className="py-1">
          <div className="mb-1 text-xs text-muted-foreground" title="Once a zone is approved for a data class, every node handling that class outside such a zone is flagged.">
            Approved for data
          </div>
          <DataClassPicker value={b.dataClasses} readOnly={readOnly} onChange={(dataClasses) => patch({ dataClasses }, 'dataClasses')} />
        </div>
      </Section>
      <Section title="Notes" defaultOpen={b.notes !== ''}>
        <NotesEditor value={b.notes} readOnly={readOnly} onChange={(notes) => patch({ notes }, 'notes')} />
      </Section>
      <Section title={`Members (${b.nodeIds.length})`}>
        <div className="flex flex-wrap gap-1">
          {b.nodeIds.map((nid) => (
            <Chip key={nid} {...(readOnly ? {} : { onRemove: () => patch({ nodeIds: b.nodeIds.filter((x) => x !== nid) }, 'members') })}>
              <button type="button" onClick={() => reveal(model, nid)} className="hover:underline">
                {model.nodes[nid]?.name ?? nid}
              </button>
            </Chip>
          ))}
        </div>
        {!readOnly && candidates.length > 0 && (
          <div className="mt-2 flex items-center gap-1.5">
            <Plus className="size-3.5 text-muted-foreground" />
            <select
              aria-label="Add member"
              value=""
              onChange={(e) => e.target.value !== '' && patch({ nodeIds: [...b.nodeIds, e.target.value] }, 'members')}
              className="h-7 flex-1 rounded-md border bg-background px-1 text-xs"
            >
              <option value="">Add a node…</option>
              {candidates.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </Section>
      {!readOnly && (
        <div className="p-3">
          <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" icon={<Trash2 />} onClick={() => deleteSelection()}>
            Delete boundary
          </Button>
        </div>
      )}
    </div>
  )
}
