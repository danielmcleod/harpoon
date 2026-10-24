// The inspector's Resilience section: how a node is deployed for availability, what Harpoon makes of it, and a way
// to have the AI propose fixes. Empty fields mean "not documented", never "fine".
import { useMemo } from 'react'
import { DEPLOYMENTS, FAILOVERS, HA_MODES, ResilienceZ } from '@shared/model/schema.ts'
import type { HxNode, Resilience } from '@shared/model/schema.ts'
import { haLevel, resilienceFindings } from '@shared/model/resilience.ts'
import { ask } from '../../state/ai.ts'
import { select } from '../../state/actions.ts'
import { useModel } from '../../canvas/useScene.ts'
import { NumberInput, Row, Section, Select, TextArea, TextInput } from './fields.tsx'
import { patchNode } from './NodeInspector.tsx'

const LEVEL_TEXT = {
  region: 'Survives a region outage',
  zone: 'Survives a zone outage',
  instance: 'Survives losing an instance, not a zone',
  single: 'One copy: it goes down when it fails',
  unknown: 'Not documented',
  external: 'Run by an outside provider',
  none: 'Not run by you',
} as const

const TRI = ['unknown', 'yes', 'no'] as const
const tri = (v: boolean | null): (typeof TRI)[number] => (v === null ? 'unknown' : v ? 'yes' : 'no')
const fromTri = (v: (typeof TRI)[number]): boolean | null => (v === 'unknown' ? null : v === 'yes')

export function ResilienceSection({ node: n, readOnly }: { node: HxNode; readOnly: boolean }): React.JSX.Element {
  const model = useModel()
  const r = n.resilience ?? ResilienceZ.parse({})
  const level = haLevel(model, n.id)
  const findings = useMemo(() => resilienceFindings(model).filter((f) => f.nodeId === n.id), [model, n.id])
  const set = (patch: Partial<Resilience>, field: string): void => patchNode(n.id, { resilience: { ...r, ...patch } }, `resilience.${field}`)
  const inherited = n.resilience === null && level !== 'unknown' && level !== 'none' && level !== 'external'

  return (
    <Section title="Resilience" defaultOpen={n.resilience !== null || findings.length > 0}>
      <p className="mb-2 text-xs text-muted-foreground">
        {LEVEL_TEXT[level]}
        {inherited ? ' (from the service it runs in)' : ''}.
      </p>
      {findings.map((f, i) => (
        <p key={i} className={f.severity === 'error' ? 'mb-1 text-xs text-destructive' : 'mb-1 text-xs text-warning'}>
          {f.message} {f.fix}
        </p>
      ))}
      <Row label="Deployment">
        <Select
          value={r.deployment ?? 'unknown'}
          options={['unknown', ...DEPLOYMENTS] as const}
          labels={{ unknown: 'Not documented', single: 'Single instance', 'multi-instance': 'Several instances, one zone', 'multi-zone': 'Across zones', 'multi-region': 'Across regions' }}
          readOnly={readOnly}
          onChange={(v) => set({ deployment: v === 'unknown' ? null : v }, 'deployment')}
        />
      </Row>
      <Row label="Instances" hint="Minimum running">
        <NumberInput value={r.instances} min={0} readOnly={readOnly} onChange={(v) => set({ instances: v === null ? null : Math.round(v) }, 'instances')} />
      </Row>
      <Row label="Zones" hint="Availability zones or data centres, comma separated">
        <TextInput
          value={r.zones.join(', ')}
          readOnly={readOnly}
          placeholder="e.g. us-east-1a, us-east-1b"
          onChange={(v) => set({ zones: v.split(',').map((x) => x.trim()).filter((x) => x !== '').slice(0, 20) }, 'zones')}
        />
      </Row>
      <Row label="Failover">
        <Select value={r.failover ?? 'unknown'} options={['unknown', ...FAILOVERS] as const} labels={{ unknown: 'Not documented' }} readOnly={readOnly} onChange={(v) => set({ failover: v === 'unknown' ? null : v }, 'failover')} />
      </Row>
      <Row label="Mode">
        <Select value={r.mode ?? 'unknown'} options={['unknown', ...HA_MODES] as const} labels={{ unknown: 'Not documented' }} readOnly={readOnly} onChange={(v) => set({ mode: v === 'unknown' ? null : v }, 'mode')} />
      </Row>
      <Row label="Autoscaling">
        <Select value={tri(r.autoscaling)} options={TRI} labels={{ unknown: 'Not documented' }} readOnly={readOnly} onChange={(v) => set({ autoscaling: fromTri(v) }, 'autoscaling')} />
      </Row>
      <Row label="Backups">
        <Select value={tri(r.backups)} options={TRI} labels={{ unknown: 'Not documented' }} readOnly={readOnly} onChange={(v) => set({ backups: fromTri(v) }, 'backups')} />
      </Row>
      <Row label="RPO / RTO" hint="How much data, and how much time, a failure may cost">
        <div className="flex gap-1">
          <TextInput value={r.rpo ?? ''} readOnly={readOnly} placeholder="RPO, e.g. 5 min" onChange={(v) => set({ rpo: v.trim() === '' ? null : v }, 'rpo')} />
          <TextInput value={r.rto ?? ''} readOnly={readOnly} placeholder="RTO, e.g. 1 h" onChange={(v) => set({ rto: v.trim() === '' ? null : v }, 'rto')} />
        </div>
      </Row>
      <Row label="Notes">
        <TextArea value={r.notes ?? ''} readOnly={readOnly} onChange={(v) => set({ notes: v.trim() === '' ? null : v }, 'notes')} />
      </Row>
      {!readOnly && (findings.length > 0 || level === 'unknown') && (
        <button
          type="button"
          className="mt-1 text-xs text-primary hover:underline"
          onClick={() => {
            select({ kind: 'node', ids: [n.id] })
            void ask(
              findings.length > 0
                ? `Fix the availability gaps of ${n.name} (id ${n.id}):\n${findings.map((f) => `- ${f.message}`).join('\n')}`
                : `Find out from the code and infrastructure how ${n.name} (id ${n.id}) is deployed, record it, and propose fixes for any gap.`,
              { mode: 'resilience', scope: { nodeIds: [n.id], connectorIds: [], focusId: null } },
            )
          }}
        >
          {findings.length > 0 ? 'Propose fixes with AI' : 'Document it with AI'}
        </button>
      )}
    </Section>
  )
}
