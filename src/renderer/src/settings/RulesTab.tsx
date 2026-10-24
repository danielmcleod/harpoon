// Rules and guidelines. Rules are checked against the diagram (failures show in Problems with the built-in checks);
// guidelines are conventions in prose that the AI follows when it designs. Start from a template, build conditions
// in a form (or JSON), test against this project, share as a rule pack, or let the AI scan the code for patterns.
import { cellText } from '../tables/rows.ts'
import { ChevronRight, Download, FileUp, Plus, ScanSearch, Trash2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { RULE_OPS, RULE_TARGETS, RULE_TEMPLATES, RulePackZ, RuleZ, SEVERITIES, ruleProblem, testRule } from '@shared/model/rules.ts'
import type { Cond, FieldTest, Guideline, Rule, RuleOp, RuleTarget } from '@shared/model/rules.ts'
import { uniqueId } from '@shared/model/ids.ts'
import { Button } from '../components/ui/Button.tsx'
import { cn } from '../lib/cn.ts'
import { invoke } from '../ipc/client.ts'
import { edit, toast } from '../state/actions.ts'
import { AI_NOTE_SHORT } from '../ai/AiNote.tsx'
import { ask, setAiMode } from '../state/ai.ts'
import { setUi } from '../state/store.ts'
import { useModel } from '../canvas/useScene.ts'
import { reveal } from '../panels/ArchitectureTree.tsx'
import { TextArea, TextInput, Toggle } from '../panels/inspector/fields.tsx'

const FIELDS: Record<RuleTarget, string[]> = {
  node: ['kind', 'status', 'boundary', 'name', 'team', 'ownTeam', 'owner', 'hosting', 'provider', 'region', 'techStack', 'tags', 'dataClasses', 'sensitivity', 'phase', 'description', 'vendor', 'inbound', 'outbound', 'children', 'features.count', 'boundaries', 'parent.kind'],
  connector: ['protocol', 'auth', 'encrypted', 'sync', 'duplex', 'dataClasses', 'status', 'team', 'phase', 'label', 'description', 'source.kind', 'target.kind', 'source.team', 'target.team', 'source.boundary', 'target.boundary', 'source.hosting', 'target.hosting'],
  boundary: ['type', 'name', 'dataClasses', 'team'],
}
const OP_LABEL: Record<RuleOp, string> = { eq: 'is', ne: 'is not', in: 'is one of', notIn: 'is none of', includes: 'contains any of', excludes: 'contains none of', exists: 'is set', empty: 'is empty', matches: 'matches', gt: '>', lt: '<' }
const LIST_OPS = new Set<RuleOp>(['in', 'notIn', 'includes', 'excludes'])

const parseValue = (op: RuleOp, raw: string): unknown => {
  if (op === 'exists' || op === 'empty') return undefined
  if (LIST_OPS.has(op)) return raw.split(',').map((x) => x.trim()).filter(Boolean)
  if (op === 'gt' || op === 'lt') return Number(raw)
  if (raw === 'true' || raw === 'false') return raw === 'true'
  return raw
}
const showValue = (v: unknown): string => cellText(v)

/** A condition the form can edit: field tests joined by all/any (anything else is edited as JSON). */
function flat(c: Cond | null): { mode: 'all' | 'any'; tests: FieldTest[] } | null {
  if (c === null) return { mode: 'all', tests: [] }
  if ('field' in c) return { mode: 'all', tests: [c] }
  if ('all' in c && c.all.every((x) => 'field' in x)) return { mode: 'all', tests: c.all }
  if ('any' in c && c.any.every((x) => 'field' in x)) return { mode: 'any', tests: c.any }
  return null
}
const unflat = (mode: 'all' | 'any', tests: FieldTest[]): Cond => (tests.length === 1 && mode === 'all' && tests[0] !== undefined ? tests[0] : mode === 'all' ? { all: tests } : { any: tests })

export function RulesTab({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const model = useModel()
  const rules = model.meta.rules
  const guidelines = model.meta.guidelines
  const [open, setOpen] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const results = useMemo(() => new Map(rules.map((r) => [r.id, testRule(model, r)])), [model, rules])
  const setRules = (next: Rule[], key?: string): void => void edit([{ op: 'updateMeta', patch: { rules: next } }], key !== undefined ? { coalesceKey: key } : { label: 'edit rules' })
  const setGuidelines = (next: Guideline[], key?: string): void => void edit([{ op: 'updateMeta', patch: { guidelines: next } }], key !== undefined ? { coalesceKey: key } : { label: 'edit guidelines' })
  const freshId = (base: string): string => uniqueId(base, (x) => rules.some((r) => r.id === x))

  const addRule = (r: Rule): void => {
    const id = freshId(r.id)
    setRules([...rules, { ...r, id }])
    setOpen(id)
  }
  const importPack = async (f: File): Promise<void> => {
    try {
      const pack = RulePackZ.parse(JSON.parse(await f.text()))
      const unsafe = pack.rules.find((r) => ruleProblem(r) !== null)
      if (unsafe !== undefined) throw new Error(`rule "${unsafe.name}": ${ruleProblem(unsafe) ?? ''}`)
      const newRules = pack.rules.filter((r) => !rules.some((x) => x.id === r.id))
      const newGl = pack.guidelines.filter((g) => !guidelines.some((x) => x.id === g.id))
      edit([{ op: 'updateMeta', patch: { rules: [...rules, ...newRules], guidelines: [...guidelines, ...newGl] } }], { label: 'import rule pack' })
      toast(`Imported ${newRules.length} rules and ${newGl.length} guidelines${pack.name !== '' ? ` from ${pack.name}` : ''}.`)
    } catch (err) {
      toast(`Not a Harpoon rule pack: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`, 'error')
    }
  }
  const exportPack = async (): Promise<void> => {
    const content = `${JSON.stringify({ harpoonRulePack: 1, name: model.meta.name, rules, guidelines }, null, 2)}\n`
    const r = await invoke('export.save', { filename: `${model.meta.name.replace(/[^\w.-]+/g, '-')}-rules.json`, content })
    if (!r.ok) toast(r.error.message, 'error')
  }

  const unused = RULE_TEMPLATES.filter((t) => !rules.some((r) => r.id === t.id || r.name === t.name))
  return (
    <div className="flex flex-col gap-5">
      <section>
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <h3 className="mr-auto text-sm font-semibold">Rules</h3>
          {!readOnly && (
            <>
              <Button
                size="sm"
                variant="outline"
                icon={<ScanSearch />}
                title={`The AI reads the linked repositories and suggests rules and guidelines from the patterns it finds. ${AI_NOTE_SHORT}`}
                onClick={() => {
                  setUi({ settings: null, aiOpen: true })
                  setAiMode('scan')
                  void ask('', { mode: 'scan' })
                }}
              >
                Scan code for patterns
              </Button>
              <Button
                size="sm"
                variant="outline"
                icon={<Plus />}
                onClick={() => addRule({ id: 'rule', name: 'New rule', description: '', severity: 'warn', enabled: true, target: 'node', where: null, require: { field: 'description', op: 'exists' }, message: '' })}
              >
                New rule
              </Button>
              <Button size="sm" variant="ghost" icon={<FileUp />} onClick={() => fileRef.current?.click()}>
                Import pack…
              </Button>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => e.target.files?.[0] !== undefined && void importPack(e.target.files[0])} />
            </>
          )}
          <Button size="sm" variant="ghost" icon={<Download />} disabled={rules.length + guidelines.length === 0} onClick={() => void exportPack()}>
            Export pack…
          </Button>
        </div>
        <p className="mb-2 max-w-prose text-xs text-muted-foreground">
          A rule picks things (which nodes or connectors) and says what must hold for them. Whatever breaks it shows in Problems, and the AI checks its designs against it.
        </p>
        {rules.length === 0 && <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">No rules yet. Start from a template below.</p>}
        <ul className="flex flex-col gap-1.5">
          {rules.map((r) => {
            const res = results.get(r.id)
            const isOpen = open === r.id
            return (
              <li key={r.id} className="rounded-lg border">
                <div className="flex items-center gap-2 px-2.5 py-2">
                  <button type="button" aria-label={isOpen ? 'Collapse' : 'Edit rule'} onClick={() => setOpen(isOpen ? null : r.id)} className="text-muted-foreground hover:text-foreground">
                    <ChevronRight className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')} />
                  </button>
                  <Toggle label={`Enable ${r.name}`} checked={r.enabled} readOnly={readOnly} onChange={(enabled) => setRules(rules.map((x) => (x.id === r.id ? { ...x, enabled } : x)))} />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{r.name}</span>
                  <span className="text-[10.5px] text-muted-foreground">{r.target}s</span>
                  <span className={cn('rounded px-1.5 text-[10.5px] tabular-nums', res === undefined || res.violations.length === 0 ? 'bg-success/15 text-success' : r.severity === 'error' ? 'bg-destructive/15 text-destructive' : 'bg-warning/15 text-warning')}>
                    {res === undefined ? '' : res.violations.length === 0 ? `${res.applies} pass` : `${res.violations.length} of ${res.applies} fail`}
                  </span>
                  <select
                    aria-label="Severity"
                    disabled={readOnly}
                    value={r.severity}
                    onChange={(e) => setRules(rules.map((x) => (x.id === r.id ? { ...x, severity: e.target.value as Rule['severity'] } : x)))}
                    className="h-6 rounded border bg-background px-0.5 text-[11px] disabled:border-transparent"
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  {!readOnly && (
                    <button type="button" aria-label={`Delete ${r.name}`} onClick={() => setRules(rules.filter((x) => x.id !== r.id))} className="text-muted-foreground hover:text-destructive">
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
                {isOpen && <RuleForm rule={r} readOnly={readOnly} onChange={(nr, key) => setRules(rules.map((x) => (x.id === r.id ? nr : x)), key)} />}
              </li>
            )
          })}
        </ul>
        {!readOnly && unused.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">Templates</div>
            <div className="flex flex-wrap gap-1.5">
              {unused.map((t) => (
                <button key={t.id} type="button" title={t.description} onClick={() => addRule(t)} className="rounded-md border border-dashed px-2 py-1 text-[11.5px] hover:bg-accent/60">
                  + {t.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center gap-1.5">
          <h3 className="mr-auto text-sm font-semibold">Guidelines</h3>
          {!readOnly && (
            <Button size="sm" variant="outline" icon={<Plus />} onClick={() => setGuidelines([...guidelines, { id: uniqueId('guideline', (x) => guidelines.some((g) => g.id === x)), title: 'New guideline', text: '', enabled: true, evidence: '' }])}>
              New guideline
            </Button>
          )}
        </div>
        <p className="mb-2 max-w-prose text-xs text-muted-foreground">
          Conventions Harpoon cannot check in a diagram (“data access goes through the repository layer”, “events use the outbox”). The AI follows the enabled ones when it designs, and implementation briefs list them.
        </p>
        {guidelines.length === 0 && <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">No guidelines yet.</p>}
        <ul className="flex flex-col gap-1.5">
          {guidelines.map((g) => (
            <li key={g.id} className="rounded-lg border p-2.5">
              <div className="flex items-center gap-2">
                <Toggle label={`Enable ${g.title}`} checked={g.enabled} readOnly={readOnly} onChange={(enabled) => setGuidelines(guidelines.map((x) => (x.id === g.id ? { ...x, enabled } : x)))} />
                <div className="min-w-0 flex-1">
                  <TextInput value={g.title} readOnly={readOnly} onChange={(title) => title.trim() !== '' && setGuidelines(guidelines.map((x) => (x.id === g.id ? { ...x, title } : x)), `gl:${g.id}:title`)} className="font-medium" />
                </div>
                {!readOnly && (
                  <button type="button" aria-label={`Delete ${g.title}`} onClick={() => setGuidelines(guidelines.filter((x) => x.id !== g.id))} className="text-muted-foreground hover:text-destructive">
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
              <div className="mt-1.5">
                <TextArea value={g.text} rows={2} placeholder="What to do, and when it applies." readOnly={readOnly} onChange={(text) => setGuidelines(guidelines.map((x) => (x.id === g.id ? { ...x, text } : x)), `gl:${g.id}:text`)} />
              </div>
              {g.evidence !== '' && <p className="mt-1 text-[10.5px] text-muted-foreground">Seen in: {g.evidence}</p>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function RuleForm({ rule, readOnly, onChange }: { rule: Rule; readOnly: boolean; onChange: (r: Rule, key?: string) => void }): React.JSX.Element {
  const model = useModel()
  const [json, setJson] = useState(false)
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const res = useMemo(() => testRule(model, rule), [model, rule])
  const set = (p: Partial<Rule>, key?: string): void => onChange({ ...rule, ...p }, key)
  const where = flat(rule.where)
  const req = flat(rule.require)
  const formable = where !== null && req !== null
  const entityName = (id: string): string => {
    const n = model.nodes[id]
    if (n !== undefined) return n.name
    const c = model.connectors[id]
    if (c !== undefined) return `${model.nodes[c.source]?.name ?? c.source} → ${model.nodes[c.target]?.name ?? c.target}`
    return model.boundaries[id]?.name ?? id
  }

  return (
    <div className="flex flex-col gap-2.5 border-t px-3 py-2.5 text-xs">
      <div className="grid grid-cols-[90px_1fr] items-center gap-x-2 gap-y-1.5">
        <span className="text-muted-foreground">Name</span>
        <TextInput value={rule.name} readOnly={readOnly} onChange={(name) => name.trim() !== '' && set({ name }, `rule:${rule.id}:name`)} />
        <span className="text-muted-foreground">Why</span>
        <TextInput value={rule.description} readOnly={readOnly} placeholder="Why the rule exists" onChange={(description) => set({ description }, `rule:${rule.id}:desc`)} />
        <span className="text-muted-foreground">Applies to</span>
        <select aria-label="Applies to" disabled={readOnly || json} value={rule.target} onChange={(e) => set({ target: e.target.value as RuleTarget })} className="h-7 w-40 rounded-md border bg-background px-1 text-xs">
          {RULE_TARGETS.map((t) => (
            <option key={t} value={t}>
              {t}s
            </option>
          ))}
        </select>
      </div>

      {formable && !json ? (
        <>
          <Conditions label="Where" hint="Which ones the rule is about (none: all of them)" target={rule.target} mode={where.mode} tests={where.tests} readOnly={readOnly} onChange={(mode, tests) => set({ where: tests.length === 0 ? null : unflat(mode, tests) })} />
          <Conditions label="Must have" hint="What has to be true for each of them" target={rule.target} mode={req.mode} tests={req.tests} readOnly={readOnly} onChange={(mode, tests) => set({ require: unflat(mode, tests) })} />
        </>
      ) : (
        <div>
          <textarea
            aria-label="Rule as JSON"
            readOnly={readOnly}
            value={json ? draft : JSON.stringify({ target: rule.target, where: rule.where, require: rule.require }, null, 2)}
            onFocus={() => {
              if (!json) {
                setDraft(JSON.stringify({ target: rule.target, where: rule.where, require: rule.require }, null, 2))
                setJson(true)
              }
            }}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            className="w-full rounded-md border bg-background p-2 font-mono text-[11px] outline-none focus:border-ring"
          />
          {err !== null && <p className="text-[11px] text-destructive">{err}</p>}
          {!formable && !json && <p className="text-[11px] text-muted-foreground">This rule uses relations (connections, boundaries, teams), so it is edited as JSON.</p>}
        </div>
      )}
      <div className="flex items-center gap-2">
        {!readOnly && (
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => {
              if (!json) {
                setDraft(JSON.stringify({ target: rule.target, where: rule.where, require: rule.require }, null, 2))
                setJson(true)
                return
              }
              try {
                const parsed = JSON.parse(draft) as { target: unknown; where: unknown; require: unknown }
                const r = RuleZ.parse({ ...rule, target: parsed.target, where: parsed.where ?? null, require: parsed.require })
                const problem = ruleProblem(r)
                if (problem !== null) throw new Error(problem)
                onChange(r)
                setErr(null)
                setJson(false)
              } catch (e) {
                setErr(e instanceof Error ? e.message.slice(0, 300) : String(e))
              }
            }}
          >
            {json ? 'Apply JSON' : 'Edit as JSON'}
          </button>
        )}
      </div>

      <div className="grid grid-cols-[90px_1fr] items-center gap-2">
        <span className="text-muted-foreground">Message</span>
        <TextInput value={rule.message} readOnly={readOnly} placeholder="{name} … ({source}, {target} for connectors)" onChange={(message) => set({ message }, `rule:${rule.id}:msg`)} />
      </div>

      <div className="rounded-md bg-muted/40 p-2">
        <div className="mb-1 font-medium">
          Against this project: applies to {res.applies}, {res.violations.length === 0 ? 'all pass' : `${res.violations.length} fail`}
        </div>
        <div className="flex flex-wrap gap-1">
          {res.violations.slice(0, 20).map((v) => (
            <button key={v.id} type="button" onClick={() => model.nodes[v.id] !== undefined && reveal(model, v.id)} className="rounded border bg-background px-1.5 py-0.5 text-[11px] hover:bg-accent" title={v.message}>
              {entityName(v.id)}
            </button>
          ))}
          {res.violations.length > 20 && <span className="text-[11px] text-muted-foreground">+{res.violations.length - 20} more</span>}
        </div>
      </div>
    </div>
  )
}

function Conditions({
  label,
  hint,
  target,
  mode,
  tests,
  readOnly,
  onChange,
}: {
  label: string
  hint: string
  target: RuleTarget
  mode: 'all' | 'any'
  tests: FieldTest[]
  readOnly: boolean
  onChange: (mode: 'all' | 'any', tests: FieldTest[]) => void
}): React.JSX.Element {
  const listId = `fields-${label}-${target}`
  const set = (i: number, t: FieldTest): void => onChange(mode, tests.map((x, j) => (j === i ? t : x)))
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium">{label}</span>
        {tests.length > 1 && (
          <select aria-label={`${label}: all or any`} disabled={readOnly} value={mode} onChange={(e) => onChange(e.target.value as 'all' | 'any', tests)} className="h-6 rounded border bg-background px-0.5 text-[11px]">
            <option value="all">all of</option>
            <option value="any">any of</option>
          </select>
        )}
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      </div>
      <datalist id={listId}>
        {FIELDS[target].map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <ul className="flex flex-col gap-1">
        {tests.map((t, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <input
              aria-label="Field"
              list={listId}
              readOnly={readOnly}
              value={t.field}
              onChange={(e) => set(i, { ...t, field: e.target.value })}
              className="h-7 w-36 rounded-md border bg-background px-1.5 font-mono text-[11px] outline-none focus:border-ring"
            />
            <select aria-label="Test" disabled={readOnly} value={t.op} onChange={(e) => set(i, { ...t, op: e.target.value as RuleOp, value: parseValue(e.target.value as RuleOp, showValue(t.value)) })} className="h-7 rounded-md border bg-background px-1 text-[11px]">
              {RULE_OPS.map((o) => (
                <option key={o} value={o}>
                  {OP_LABEL[o]}
                </option>
              ))}
            </select>
            {t.op !== 'exists' && t.op !== 'empty' && (
              <input
                aria-label="Value"
                readOnly={readOnly}
                defaultValue={showValue(t.value)}
                placeholder={LIST_OPS.has(t.op) ? 'a, b, c' : 'value'}
                onBlur={(e) => set(i, { ...t, value: parseValue(t.op, e.target.value) })}
                className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-[11px] outline-none focus:border-ring"
              />
            )}
            {!readOnly && (
              <button type="button" aria-label="Remove condition" onClick={() => onChange(mode, tests.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive">
                <Trash2 className="size-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <button type="button" onClick={() => onChange(mode, [...tests, { field: FIELDS[target][0] ?? 'name', op: 'eq', value: '' }])} className="mt-1 text-[11px] text-primary hover:underline">
          + condition
        </button>
      )}
    </div>
  )
}
