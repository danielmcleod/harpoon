// Nothing selected: the project itself (name, description, linked repositories, counts) and its flows.
import { FolderGit2, ListChecks, Milestone, ShieldCheck, Users } from 'lucide-react'
import { openSettings } from '../../settings/ProjectSettings.tsx'
import { edit } from '../../state/actions.ts'
import { useModel } from '../../canvas/useScene.ts'
import { FlowList } from '../FlowList.tsx'
import { Problems, useProblems } from '../Problems.tsx'
import { Section, TextArea, TextInput } from './fields.tsx'

export function ProjectOverview({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const model = useModel()
  const m = model.meta
  const problems = useProblems()
  const nodes = Object.values(model.nodes)
  const counts = {
    services: nodes.filter((n) => n.boundary === 'internal').length,
    external: nodes.filter((n) => n.boundary === 'external').length,
    connectors: Object.keys(model.connectors).length,
    planned: nodes.filter((n) => n.status === 'planned').length,
  }

  return (
    <div>
      <div className="border-b p-3">
        <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Project</div>
        <TextInput value={m.name} readOnly={readOnly} className="text-sm font-semibold" onChange={(v) => v.trim() !== '' && edit([{ op: 'updateMeta', patch: { name: v } }], { coalesceKey: 'meta:name' })} />
        <div className="mt-2">
          <TextArea value={m.description} readOnly={readOnly} placeholder="What this system is and who it serves." onChange={(v) => edit([{ op: 'updateMeta', patch: { description: v } }], { coalesceKey: 'meta:description' })} />
        </div>
        <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
          {(
            [
              ['Internal', counts.services],
              ['External', counts.external],
              ['Links', counts.connectors],
              ['Planned', counts.planned],
            ] as const
          ).map(([label, n]) => (
            <div key={label} className="rounded-md border bg-background py-1.5">
              <dd className="text-base font-semibold tabular-nums">{n}</dd>
              <dt className="text-[10px] text-muted-foreground uppercase">{label}</dt>
            </div>
          ))}
        </dl>
      </div>

      <Section title={`Problems (${problems.length})`} defaultOpen={problems.some((x) => x.severity !== 'info')}>
        <Problems />
      </Section>

      <Section title="Flows">
        <FlowList readOnly={readOnly} />
      </Section>

      <Section title="Settings">
        <ul className="flex flex-col gap-0.5 text-xs">
          {(
            [
              ['repos', FolderGit2, 'Repositories', m.repos.length === 0 ? 'none linked: AI reads the project folder only' : m.repos.map((r) => r.name).join(', ')],
              ['teams', Users, 'Teams', m.teams.length === 0 ? 'none yet' : m.teams.map((t) => t.name).join(', ')],
              ['phases', Milestone, 'Roadmap phases', m.phases.length === 0 ? 'none yet' : [...m.phases].sort((a, b) => a.order - b.order).map((x) => x.name).join(' → ')],
              ['data', ShieldCheck, 'Data classes', `${8 + m.dataClasses.length} (built in${m.dataClasses.length > 0 ? ' + your own' : ''})`],
              ['rules', ListChecks, 'Rules', m.rules.length + m.guidelines.length === 0 ? 'none yet' : `${m.rules.filter((r) => r.enabled).length} rules, ${m.guidelines.filter((g) => g.enabled).length} guidelines`],
            ] as const
          ).map(([tab, Icon, label, detail]) => (
            <li key={tab}>
              <button type="button" onClick={() => openSettings(tab)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-accent/60">
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="w-28 shrink-0 font-medium">{label}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{detail}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <p className="px-3 py-4 text-xs text-muted-foreground">
        Select a node or connector to inspect it. Double-click a service to expand its inner architecture.
      </p>
    </div>
  )
}
