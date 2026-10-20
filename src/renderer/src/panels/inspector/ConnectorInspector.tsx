// A connector: its two ends, direction and sync semantics, Channel A (forward) and Channel B (return) wire specs,
// runtime policies (timeout, retries, circuit breaker) and simulation parameters. A drawn edge that merges several
// connectors (lifted to a collapsed container) lists them first.
import { ArrowLeftRight, ArrowRight, Repeat, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { PROTOCOLS } from '@shared/model/kinds.ts'
import { pathLabel } from '@shared/model/queries.ts'
import { BACKOFFS, ChannelZ, PORTS, STATUSES } from '@shared/model/schema.ts'
import type { Channel, ConnectorPatch, HxConnector } from '@shared/model/schema.ts'
import { Button } from '../../components/ui/Button.tsx'
import { cn } from '../../lib/cn.ts'
import { edit, select } from '../../state/actions.ts'
import { useModel } from '../../canvas/useScene.ts'
import { reveal } from '../ArchitectureTree.tsx'
import { deleteSelection } from '../selectionOps.ts'
import { EvidenceList } from './EvidenceList.tsx'
import { NumberInput, Row, Section, Select, TextArea, TextInput, Toggle, orNull } from './fields.tsx'
import { STATUS_LABEL } from './NodeInspector.tsx'
import { DataClassPicker, NotesEditor, PhasePicker, TeamPicker } from './governance.tsx'

function patchConn(id: string, patch: ConnectorPatch, field: string): void {
  edit([{ op: 'updateConnector', id, patch }], { coalesceKey: `conn:${id}:${field}`, label: 'edit connector' })
}

export function ConnectorInspector({ ids, readOnly }: { ids: string[]; readOnly: boolean }): React.JSX.Element {
  const model = useModel()
  const conns = ids.map((id) => model.connectors[id]).filter((c): c is HxConnector => c !== undefined)
  if (conns.length > 1) {
    return (
      <div className="p-3">
        <h3 className="mb-1 text-sm font-semibold">{conns.length} connectors</h3>
        <p className="mb-3 text-xs text-muted-foreground">These run between parts inside collapsed nodes, so they are drawn as one line. Pick one to inspect it.</p>
        <ul className="flex flex-col gap-1">
          {conns.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => select({ kind: 'connector', ids: [c.id] })} className="w-full rounded-md border px-2.5 py-2 text-left text-xs hover:bg-accent/50">
                <div className="truncate font-medium">
                  {pathLabel(model, c.source)} → {pathLabel(model, c.target)}
                </div>
                <div className="font-mono text-[10.5px] text-muted-foreground">{c.channelA.protocol}</div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  const c = conns[0]
  if (c === undefined) return <p className="p-3 text-xs text-muted-foreground">Nothing selected.</p>
  return <SingleConnector c={c} readOnly={readOnly} />
}

function SingleConnector({ c, readOnly }: { c: HxConnector; readOnly: boolean }): React.JSX.Element {
  const model = useModel()
  const [tab, setTab] = useState<'A' | 'B'>('A')
  const channel = tab === 'A' ? c.channelA : c.channelB
  const setChannel = (ch: Channel, field: string): void => patchConn(c.id, tab === 'A' ? { channelA: ch } : { channelB: ch }, `${tab}.${field}`)
  const source = model.nodes[c.source]
  const target = model.nodes[c.target]
  const sim = c.sim ?? { fanout: null, payloadKb: null }

  return (
    <div>
      <div className="border-b p-3">
        <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Connector</div>
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <button type="button" className="truncate hover:underline" onClick={() => reveal(model, c.source)}>
            {source?.name ?? c.source}
          </button>
          {c.duplex ? <ArrowLeftRight className="size-3.5 shrink-0 text-muted-foreground" /> : <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />}
          <button type="button" className="truncate hover:underline" onClick={() => reveal(model, c.target)}>
            {target?.name ?? c.target}
          </button>
        </div>
        {!readOnly && (
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" variant="outline" icon={<Repeat />} title="Swap source and target" onClick={() => edit([{ op: 'updateConnector', id: c.id, patch: { source: c.target, target: c.source, sourcePort: c.targetPort, targetPort: c.sourcePort, channelA: c.channelB ?? c.channelA, channelB: c.channelB === null ? null : c.channelA } }], { label: 'reverse connector' })}>
              Reverse
            </Button>
          </div>
        )}
      </div>

      <Section title="Semantics">
        <Row label="Duplex" hint="Two anti-parallel harpoons: requests forward, responses back">
          <Toggle
            label="Duplex"
            checked={c.duplex}
            readOnly={readOnly}
            onChange={(duplex) => patchConn(c.id, { duplex, channelB: duplex ? (c.channelB ?? ChannelZ.parse({ protocol: c.channelA.protocol })) : c.channelB }, 'duplex')}
          />
        </Row>
        <Row label="Mode">
          <Select value={c.sync} options={['sync', 'async'] as const} labels={{ sync: 'Synchronous (request/response)', async: 'Asynchronous (fire and forget)' }} readOnly={readOnly} onChange={(sync) => patchConn(c.id, { sync }, 'sync')} />
        </Row>
        <Row label="Badge" hint="Text on the line (default: Channel A's protocol)">
          <TextInput value={c.label ?? ''} placeholder={c.channelA.protocol} readOnly={readOnly} onChange={(v) => patchConn(c.id, { label: orNull(v) }, 'label')} />
        </Row>
        <Row label="Status">
          <Select value={c.status} options={STATUSES} labels={STATUS_LABEL} readOnly={readOnly} onChange={(status) => patchConn(c.id, { status }, 'status')} />
        </Row>
        <div className="mt-2">
          <TextArea value={c.description} placeholder="What travels over this connection and why." readOnly={readOnly} rows={2} onChange={(v) => patchConn(c.id, { description: v }, 'description')} />
        </div>
      </Section>

      <Section title="Wire specification">
        <div role="tablist" className="mb-2 flex rounded-md border bg-background p-0.5 text-xs">
          {(['A', 'B'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              disabled={t === 'B' && !c.duplex}
              onClick={() => setTab(t)}
              className={cn('flex-1 rounded px-2 py-1 disabled:opacity-40', tab === t ? 'bg-accent font-medium' : 'text-muted-foreground')}
            >
              {t === 'A' ? 'Channel A · forward' : 'Channel B · return'}
            </button>
          ))}
        </div>
        {channel === null ? (
          <p className="text-xs text-muted-foreground">Turn on Duplex to describe the return channel.</p>
        ) : (
          <>
            <Row label="Protocol">
              <TextInput value={channel.protocol} list="hx-conn-protocols" readOnly={readOnly} onChange={(v) => setChannel({ ...channel, protocol: v }, 'protocol')} />
            </Row>
            <Row label="Transport">
              <TextInput value={channel.transport ?? ''} placeholder="HTTP/2, TCP" readOnly={readOnly} onChange={(v) => setChannel({ ...channel, transport: orNull(v) }, 'transport')} />
            </Row>
            <Row label="Auth">
              <TextInput value={channel.auth ?? ''} placeholder="mTLS, OAuth2, API key" readOnly={readOnly} onChange={(v) => setChannel({ ...channel, auth: orNull(v) }, 'auth')} />
            </Row>
            <Row label="Encryption">
              <TextInput value={channel.encryption ?? ''} placeholder="TLS 1.3, SPIFFE" readOnly={readOnly} onChange={(v) => setChannel({ ...channel, encryption: orNull(v) }, 'encryption')} />
            </Row>
            <Row label="Serialization">
              <TextInput value={channel.serialization ?? ''} placeholder="Protobuf, JSON, Avro" readOnly={readOnly} onChange={(v) => setChannel({ ...channel, serialization: orNull(v) }, 'serialization')} />
            </Row>
            <Row label="Interval" hint="Polling or heartbeat interval">
              <TextInput value={channel.interval ?? ''} placeholder="1s" readOnly={readOnly} onChange={(v) => setChannel({ ...channel, interval: orNull(v) }, 'interval')} />
            </Row>
            <div className="py-1">
              <div className="mb-1 text-xs text-muted-foreground">Data it carries ({tab === 'A' ? 'forward' : 'return'})</div>
              <DataClassPicker value={channel.dataClasses} readOnly={readOnly} onChange={(dataClasses) => setChannel({ ...channel, dataClasses }, 'data')} />
            </div>
            <div className="mt-2">
              <TextArea value={channel.payloadSchema ?? ''} mono rows={4} placeholder="Payload schema or example" readOnly={readOnly} onChange={(v) => setChannel({ ...channel, payloadSchema: orNull(v) }, 'payload')} />
            </div>
          </>
        )}
      </Section>

      <Section title="Ownership & roadmap" defaultOpen={c.team !== null || c.phase !== null}>
        <Row label="Team">
          <TeamPicker value={c.team} readOnly={readOnly} onChange={(t, pre) => edit([...pre, { op: 'updateConnector', id: c.id, patch: { team: t } }], { label: 'set team' })} />
        </Row>
        <Row label="Phase">
          <PhasePicker value={c.phase} readOnly={readOnly} onChange={(phase) => edit([{ op: 'updateConnector', id: c.id, patch: { phase } }], { label: 'set phase' })} />
        </Row>
      </Section>

      <Section title="Notes" defaultOpen={c.notes !== ''}>
        <NotesEditor value={c.notes} readOnly={readOnly} onChange={(notes) => patchConn(c.id, { notes }, 'notes')} />
      </Section>

      <Section title="Runtime policies">
        <Row label="Timeout">
          <NumberInput value={c.policies.timeoutMs} suffix="ms" min={0} readOnly={readOnly} onChange={(v) => patchConn(c.id, { policies: { ...c.policies, timeoutMs: v } }, 'timeout')} />
        </Row>
        <Row label="Retries">
          <NumberInput value={c.policies.retries} min={0} max={20} readOnly={readOnly} onChange={(v) => patchConn(c.id, { policies: { ...c.policies, retries: v === null ? null : Math.round(v) } }, 'retries')} />
        </Row>
        <Row label="Backoff">
          <Select value={c.policies.backoff ?? 'none'} options={BACKOFFS} readOnly={readOnly} onChange={(backoff) => patchConn(c.id, { policies: { ...c.policies, backoff } }, 'backoff')} />
        </Row>
        <Row label="Circuit breaker">
          <Toggle label="Circuit breaker" checked={c.policies.circuitBreaker} readOnly={readOnly} onChange={(circuitBreaker) => patchConn(c.id, { policies: { ...c.policies, circuitBreaker } }, 'cb')} />
        </Row>
        <Row label="Dependency" hint="Soft: the caller keeps working without it (fallback, cache, queue)">
          <Select value={c.dependency} options={['hard', 'soft'] as const} labels={{ hard: 'Hard (caller fails with it)', soft: 'Soft (caller degrades)' }} readOnly={readOnly} onChange={(dependency) => patchConn(c.id, { dependency }, 'dependency')} />
        </Row>
      </Section>

      <Section title="Docking & simulation" defaultOpen={false}>
        <Row label="Source port">
          <Select value={c.sourcePort ?? 'auto'} options={['auto', ...PORTS] as const} readOnly={readOnly} onChange={(v) => patchConn(c.id, { sourcePort: v === 'auto' ? null : v }, 'sport')} />
        </Row>
        <Row label="Target port">
          <Select value={c.targetPort ?? 'auto'} options={['auto', ...PORTS] as const} readOnly={readOnly} onChange={(v) => patchConn(c.id, { targetPort: v === 'auto' ? null : v }, 'tport')} />
        </Row>
        <Row label="Fan-out" hint="Calls on this connector per request the source handles">
          <NumberInput value={sim.fanout} step={0.1} min={0} readOnly={readOnly} onChange={(v) => patchConn(c.id, { sim: { ...sim, fanout: v } }, 'fanout')} />
        </Row>
        <Row label="Payload">
          <NumberInput value={sim.payloadKb} suffix="KB" min={0} readOnly={readOnly} onChange={(v) => patchConn(c.id, { sim: { ...sim, payloadKb: v } }, 'payload')} />
        </Row>
      </Section>

      {(c.evidence.length > 0 || c.provenance !== null) && (
        <Section title="Evidence">
          <EvidenceList evidence={c.evidence} provenance={c.provenance} confidence={c.confidence} />
        </Section>
      )}

      {!readOnly && (
        <div className="p-3">
          <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" icon={<Trash2 />} onClick={() => deleteSelection()}>
            Delete connector
          </Button>
        </div>
      )}
      <datalist id="hx-conn-protocols">
        {PROTOCOLS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </div>
  )
}
