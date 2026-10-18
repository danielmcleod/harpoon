// A feature's technical contract: endpoint or signature, protocol, contract body (OpenAPI, proto, JSON Schema,
// example code), SLA and status.
import { Copy, Trash2, X } from 'lucide-react'
import { CONTRACT_KINDS, FEATURE_CATEGORIES, STATUSES } from '@shared/model/schema.ts'
import type { Feature, HxNode } from '@shared/model/schema.ts'
import { PROTOCOLS } from '@shared/model/kinds.ts'
import { Button } from '../../components/ui/Button.tsx'
import { edit, toast } from '../../state/actions.ts'
import { setUi } from '../../state/store.ts'
import { EvidenceList } from './EvidenceList.tsx'
import { NumberInput, Row, Section, Select, TextArea, TextInput, orNull } from './fields.tsx'
import { STATUS_LABEL } from './NodeInspector.tsx'
import { PhasePicker } from './governance.tsx'

const CATEGORY_LABEL: Record<Feature['category'], string> = {
  api: 'API',
  async: 'Async worker',
  data: 'Data store',
  security: 'Security guard',
  ui: 'UI',
  job: 'Job',
  integration: 'Integration',
  other: 'Other',
}

const CONTRACT_LABEL: Record<NonNullable<Feature['contract']>['kind'], string> = {
  openapi: 'OpenAPI',
  proto: 'Protobuf',
  'json-schema': 'JSON Schema',
  graphql: 'GraphQL',
  example: 'Code',
  text: 'Text',
}

export function FeatureDetail({ node, feature: f, readOnly }: { node: HxNode; feature: Feature; readOnly: boolean }): React.JSX.Element {
  const patch = (p: Partial<Feature>, field: string): void => {
    const features = node.features.map((x) => (x.id === f.id ? { ...x, ...p } : x))
    edit([{ op: 'updateNode', id: node.id, patch: { features } }], { coalesceKey: `feature:${node.id}:${f.id}:${field}`, label: 'edit feature' })
  }
  const sla = f.sla ?? { p50Ms: null, p99Ms: null, maxRps: null }
  const contract = f.contract ?? { kind: 'example' as const, body: '' }

  return (
    <div>
      <div className="flex h-12 items-center gap-2 border-b px-3">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">Feature details</h3>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Close feature" onClick={() => setUi({ featureId: null })}>
          <X />
        </Button>
      </div>
      <Section title="Contract">
        <Row label="Name">
          <TextInput value={f.name} readOnly={readOnly} onChange={(v) => v.trim() !== '' && patch({ name: v }, 'name')} />
        </Row>
        <Row label="Category">
          <Select value={f.category} options={FEATURE_CATEGORIES} labels={CATEGORY_LABEL} readOnly={readOnly} onChange={(category) => patch({ category }, 'category')} />
        </Row>
        <Row label="Protocol">
          <TextInput value={f.protocol ?? ''} list="hx-protocols" placeholder="gRPC, HTTPS…" readOnly={readOnly} onChange={(v) => patch({ protocol: orNull(v) }, 'protocol')} />
        </Row>
        <Row label="Endpoint" hint="Route or method signature">
          <TextInput value={f.endpoint ?? ''} mono placeholder="POST /v1/charge" readOnly={readOnly} onChange={(v) => patch({ endpoint: orNull(v) }, 'endpoint')} />
        </Row>
        <Row label="Status">
          <Select value={f.status} options={STATUSES} labels={STATUS_LABEL} readOnly={readOnly} onChange={(status) => patch({ status }, 'status')} />
        </Row>
        <Row label="Phase">
          <PhasePicker value={f.phase} readOnly={readOnly} onChange={(phase) => patch({ phase }, 'phase')} />
        </Row>
        <div className="mt-2">
          <TextArea value={f.description} placeholder="What it does and for whom." readOnly={readOnly} rows={2} onChange={(v) => patch({ description: v }, 'description')} />
        </div>
      </Section>

      <Section
        title="Code & schema"
        action={contract.body !== '' && (
          <Button variant="ghost" size="icon" className="size-6" aria-label="Copy" onClick={() => void navigator.clipboard.writeText(contract.body).then(() => toast('Copied'))}>
            <Copy />
          </Button>
        )}
      >
        {!readOnly && (
          <div className="mb-1.5">
            <Select value={contract.kind} options={CONTRACT_KINDS} labels={CONTRACT_LABEL} onChange={(kind) => patch({ contract: { ...contract, kind } }, 'contract.kind')} />
          </div>
        )}
        <TextArea
          value={contract.body}
          mono
          rows={8}
          readOnly={readOnly}
          placeholder={contract.kind === 'proto' ? 'rpc ValidateToken(TokenReq) returns (Claims);' : contract.kind === 'openapi' ? 'paths:\n  /v1/charge:\n    post: …' : 'Contract, schema or example code'}
          onChange={(body) => patch({ contract: body === '' ? null : { ...contract, body } }, 'contract.body')}
        />
      </Section>

      <Section title="Performance & SLA">
        <Row label="Latency p50">
          <NumberInput value={sla.p50Ms} suffix="ms" min={0} readOnly={readOnly} onChange={(v) => patch({ sla: { ...sla, p50Ms: v } }, 'sla.p50')} />
        </Row>
        <Row label="Latency p99">
          <NumberInput value={sla.p99Ms} suffix="ms" min={0} readOnly={readOnly} onChange={(v) => patch({ sla: { ...sla, p99Ms: v } }, 'sla.p99')} />
        </Row>
        <Row label="Throughput">
          <NumberInput value={sla.maxRps} suffix="rps" min={0} readOnly={readOnly} onChange={(v) => patch({ sla: { ...sla, maxRps: v } }, 'sla.rps')} />
        </Row>
      </Section>

      {f.codeRef !== null && (
        <Section title="Code reference">
          <EvidenceList evidence={[f.codeRef]} provenance={null} confidence={null} />
        </Section>
      )}

      {!readOnly && (
        <div className="p-3">
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            icon={<Trash2 />}
            onClick={() => {
              edit([{ op: 'updateNode', id: node.id, patch: { features: node.features.filter((x) => x.id !== f.id) } }], { label: 'delete feature' })
              setUi({ featureId: null })
            }}
          >
            Delete feature
          </Button>
        </div>
      )}
      <datalist id="hx-protocols">
        {PROTOCOLS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </div>
  )
}
