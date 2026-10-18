// Project settings: name and description, the repositories the project spans (linked in the project file, located
// per machine), teams, roadmap phases and data classes. Later milestones add rules and publishing here.
import { NotionTab } from './NotionTab.tsx'
import { RulesTab } from './RulesTab.tsx'
import { Dialog } from 'radix-ui'
import { FolderGit2, FolderSearch, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { DiscoveredRepo, ResolvedRepo } from '@shared/ipc.ts'
import { uniqueId } from '@shared/model/ids.ts'
import { REPO_ROLES, RepoRefZ } from '@shared/model/schema.ts'
import type { RepoRef } from '@shared/model/schema.ts'
import { Button } from '../components/ui/Button.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/Tabs.tsx'
import { cn } from '../lib/cn.ts'
import { call, invoke } from '../ipc/client.ts'
import { edit, toast } from '../state/actions.ts'
import { setUi, useStore } from '../state/store.ts'
import { useModel } from '../canvas/useScene.ts'
import { TextArea, TextInput } from '../panels/inspector/fields.tsx'
import { DataClassesEditor, PhasesEditor, TeamsEditor } from '../panels/inspector/ProjectVocab.tsx'

export const SETTINGS_TABS = ['general', 'repos', 'teams', 'phases', 'data', 'rules', 'notion'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]
const TAB_LABEL: Record<SettingsTab, string> = { general: 'General', repos: 'Repositories', teams: 'Teams', phases: 'Roadmap phases', data: 'Data classes', rules: 'Rules & guidelines', notion: 'Notion' }

export function openSettings(tab: SettingsTab = 'general'): void {
  setUi({ settings: tab })
}

export function ProjectSettings(): React.JSX.Element | null {
  const tab = useStore((s) => s.ui.settings)
  const readOnly = useStore((s) => s.ui.mode !== 'edit')
  if (tab === null) return null
  return (
    <Dialog.Root open onOpenChange={(o) => !o && setUi({ settings: null })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex h-[min(720px,90vh)] w-[min(860px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-popover shadow-2xl outline-none">
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <Dialog.Title className="flex-1 text-sm font-semibold">Project settings</Dialog.Title>
            <Dialog.Description className="sr-only">Repositories, teams, phases and data classes of this project.</Dialog.Description>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close settings">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <Tabs value={tab} onValueChange={(t) => setUi({ settings: t as SettingsTab })} className="min-h-0 flex-1 px-4 pb-4">
            <TabsList>
              {SETTINGS_TABS.map((t) => (
                <TabsTrigger key={t} value={t}>
                  {TAB_LABEL[t]}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="min-h-0 flex-1 overflow-y-auto pt-2">
              {readOnly && <p className="mb-2 text-xs text-muted-foreground">Read-only in Docs mode. Switch to Editor to change settings.</p>}
              <TabsContent value="general">
                <General readOnly={readOnly} />
              </TabsContent>
              <TabsContent value="repos">
                <Repositories readOnly={readOnly} />
              </TabsContent>
              <TabsContent value="teams">
                <Intro>Who owns what. A node without a team inherits its parent’s. The Team lens on the canvas colours nodes by team.</Intro>
                <TeamsEditor readOnly={readOnly} />
              </TabsContent>
              <TabsContent value="phases">
                <Intro>Split planned work into phases, then set a phase on planned nodes, connectors and features. Problems flags work planned before something it depends on.</Intro>
                <PhasesEditor readOnly={readOnly} />
              </TabsContent>
              <TabsContent value="notion">
                <NotionTab readOnly={readOnly} />
              </TabsContent>
              <TabsContent value="rules">
                <RulesTab readOnly={readOnly} />
              </TabsContent>
              <TabsContent value="data">
                <Intro>Regulated data you tag on nodes (stored or processed) and connectors (in transit). Approve a boundary for a data class to have Problems flag anything handling it outside.</Intro>
                <DataClassesEditor readOnly={readOnly} />
              </TabsContent>
            </div>
          </Tabs>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Intro({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="mb-3 max-w-prose text-xs text-muted-foreground">{children}</p>
}

function General({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const m = useModel().meta
  const root = useStore((s) => s.project?.root ?? '')
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Name</span>
        <TextInput value={m.name} readOnly={readOnly} onChange={(v) => v.trim() !== '' && edit([{ op: 'updateMeta', patch: { name: v } }], { coalesceKey: 'meta:name' })} />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Description</span>
        <TextArea value={m.description} rows={4} readOnly={readOnly} placeholder="What this system is and who it serves." onChange={(v) => edit([{ op: 'updateMeta', patch: { description: v } }], { coalesceKey: 'meta:description' })} />
      </label>
      <div className="text-xs">
        <div className="text-muted-foreground">Saved in</div>
        <div className="mt-0.5 font-mono text-[11px] selectable">{root}</div>
        <Storage root={root} />
      </div>
    </div>
  )
}

/** How the design is stored: a local design, in a git repository, or in a plain folder; and what to do next. */
function Storage({ root }: { root: string }): React.JSX.Element | null {
  const [info, setInfo] = useState<{ isGitRepo: boolean; isLocalDesign: boolean } | null>(null)
  useEffect(() => {
    void invoke('project.inspect', { dir: root }).then((r) => r.ok && setInfo(r.value))
  }, [root])
  if (info === null) return null
  return (
    <p className="mt-1.5 max-w-prose text-[11.5px] text-muted-foreground">
      {info.isGitRepo
        ? 'In a git repository: changes are saved here as you work; commit the .harpoon folder to version and share them.'
        : info.isLocalDesign
          ? 'A local design, saved on this computer as you work (no repository needed). To share it, save it as a single file or save a copy into a repository (project menu).'
          : 'In a folder, saved as you work. Git is optional; put the folder under version control or on a shared drive if you want history or sharing.'}
    </p>
  )
}

/** A path relative to `from` when they share a drive/root (`../payments`), else the absolute path. */
export function relativePath(from: string, to: string): string {
  const split = (p: string): string[] => p.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  const a = split(from)
  const b = split(to)
  if (a[0]?.toLowerCase() !== b[0]?.toLowerCase()) return to.replace(/\\/g, '/')
  let i = 0
  while (i < a.length && i < b.length && a[i]?.toLowerCase() === b[i]?.toLowerCase()) i++
  const rel = [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
  return rel === '' ? '.' : rel
}

const ROLE_LABEL: Record<RepoRef['role'], string> = { service: 'Services', infra: 'Infrastructure', 'shared-lib': 'Shared library', frontend: 'Frontend', docs: 'Docs', other: 'Other' }

function Repositories({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const model = useModel()
  const root = useStore((s) => s.project?.root ?? '')
  const repos = model.meta.repos
  const [resolved, setResolved] = useState<ResolvedRepo[]>([])
  const [found, setFound] = useState<DiscoveredRepo[] | null>(null)
  const [scanning, setScanning] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const r = await invoke('repo.resolve')
    if (r.ok) setResolved(r.value)
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh, repos])

  const isLinked = (d: DiscoveredRepo): boolean =>
    repos.some((r) => resolved.find((x) => x.id === r.id)?.path?.toLowerCase() === d.path.toLowerCase() || (r.remote !== null && d.remote !== null && r.remote === d.remote))

  const link = (ds: DiscoveredRepo[]): void => {
    let next = [...repos]
    for (const d of ds) {
      if (isLinked(d)) continue
      const id = uniqueId(
        d.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'repo',
        (x) => next.some((r) => r.id === x),
      )
      next = [...next, RepoRefZ.parse({ id, name: d.name, path: relativePath(root, d.path), remote: d.remote, defaultBranch: d.branch })]
    }
    if (next.length !== repos.length) edit([{ op: 'updateMeta', patch: { repos: next } }], { label: 'link repositories' })
  }

  const scan = async (): Promise<void> => {
    const dir = await call('dialog.pickFolder', { title: 'A repository, or a folder that contains several', defaultPath: root })
    if (dir === null) return
    setScanning(true)
    const r = await invoke('repo.scan', { dir })
    setScanning(false)
    if (!r.ok) return toast(r.error.message, 'error')
    if (r.value.length === 0) return toast('No git repositories in that folder.', 'warn')
    // One repo picked directly: link it. A folder of repos: let the user tick which.
    if (r.value.length === 1 && r.value[0] !== undefined && r.value[0].path.toLowerCase() === dir.toLowerCase()) link(r.value)
    else setFound(r.value)
  }

  const locate = async (repo: RepoRef): Promise<void> => {
    const dir = await call('dialog.pickFolder', { title: `Where is ${repo.name} on this machine?`, defaultPath: root })
    if (dir === null) return
    const r = await invoke('repo.setLocalPath', { repoId: repo.id, path: dir })
    if (r.ok) setResolved(r.value)
    else toast(r.error.message, 'error')
  }
  const forgetLocal = async (repo: RepoRef): Promise<void> => {
    const r = await invoke('repo.setLocalPath', { repoId: repo.id, path: null })
    if (r.ok) setResolved(r.value)
  }
  const update = (id: string, p: Partial<RepoRef>, key: string): void => {
    edit([{ op: 'updateMeta', patch: { repos: repos.map((r) => (r.id === id ? { ...r, ...p } : r)) } }], { coalesceKey: `repo:${id}:${key}` })
  }

  // Evidence that names repos the project does not link (an import from another machine, a renamed repo).
  const unknownRepoIds = [...new Set(Object.values(model.nodes).flatMap((n) => n.evidence.map((e) => e.repo)).filter((x): x is string => x !== null && !repos.some((r) => r.id === x)))]

  return (
    <div>
      <Intro>
        A project can span many repositories. AI import, documentation and planning read all of them. The project file records each repo and its
        remote; where it is cloned is remembered per machine, so teammates can keep their clones anywhere.
      </Intro>
      {!readOnly && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          <Button size="sm" icon={<FolderSearch />} loading={scanning} onClick={() => void scan()}>
            Add or discover repositories…
          </Button>
        </div>
      )}

      {found !== null && (
        <Discovered
          found={found}
          isLinked={isLinked}
          onLink={(ds) => {
            link(ds)
            setFound(null)
          }}
          onClose={() => setFound(null)}
        />
      )}

      {repos.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">No repositories linked. Until you add some, AI runs read the project folder only.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {repos.map((r) => {
            const where = resolved.find((x) => x.id === r.id)
            return (
              <li key={r.id} className="rounded-lg border p-2.5">
                <div className="flex items-center gap-2">
                  <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                  <div className="w-48 shrink-0">
                    <TextInput value={r.name} readOnly={readOnly} onChange={(v) => v.trim() !== '' && update(r.id, { name: v }, 'name')} className="font-medium" />
                  </div>
                  <select
                    aria-label="Role"
                    disabled={readOnly}
                    value={r.role}
                    onChange={(e) => update(r.id, { role: e.target.value as RepoRef['role'] }, 'role')}
                    className="h-7 rounded-md border bg-background px-1 text-xs disabled:border-transparent"
                  >
                    {REPO_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABEL[role]}
                      </option>
                    ))}
                  </select>
                  <span className="font-mono text-[10.5px] text-muted-foreground">id {r.id}</span>
                  <span className="flex-1" />
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label={`Unlink ${r.name}`}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => edit([{ op: 'updateMeta', patch: { repos: repos.filter((x) => x.id !== r.id) } }], { label: 'unlink repository' })}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
                <div className="mt-1.5 grid grid-cols-[80px_1fr] items-center gap-x-2 gap-y-1 pl-6 text-[11.5px]">
                  <span className="text-muted-foreground">Remote</span>
                  <TextInput value={r.remote ?? ''} mono placeholder="git@github.com:org/repo.git" readOnly={readOnly} onChange={(v) => update(r.id, { remote: v.trim() === '' ? null : v.trim() }, 'remote')} />
                  <span className="text-muted-foreground">On this machine</span>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-px text-[10px] font-medium',
                        where?.source === 'missing' ? 'bg-warning/15 text-warning' : where?.source === 'machine' ? 'bg-info/15 text-info' : 'bg-success/15 text-success',
                      )}
                    >
                      {where === undefined ? '…' : where.source === 'missing' ? 'not found here' : where.source === 'machine' ? 'set on this machine' : 'found'}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground" title={where?.note ?? where?.path ?? r.path}>
                      {where?.note ?? where?.path ?? `expected at ${r.path}`}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => void locate(r)}>
                      Locate…
                    </Button>
                    {where?.source === 'machine' && (
                      <Button size="sm" variant="ghost" onClick={() => void forgetLocal(r)}>
                        Reset
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {unknownRepoIds.length > 0 && !readOnly && (
        <div className="mt-3 rounded-md border border-dashed p-2.5 text-xs">
          <div className="mb-1 font-medium">Evidence points at repositories that are not linked</div>
          <div className="flex flex-wrap gap-1.5">
            {unknownRepoIds.map((id) => (
              <Button
                key={id}
                size="sm"
                variant="outline"
                icon={<Plus />}
                onClick={() => edit([{ op: 'updateMeta', patch: { repos: [...repos, RepoRefZ.parse({ id, name: id, path: '' })] } }], { label: 'link repository' })}
              >
                {id}
              </Button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">Add one, then Locate it on this machine.</p>
        </div>
      )}
    </div>
  )
}

function Discovered({ found, isLinked, onLink, onClose }: { found: DiscoveredRepo[]; isLinked: (d: DiscoveredRepo) => boolean; onLink: (d: DiscoveredRepo[]) => void; onClose: () => void }): React.JSX.Element {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(found.filter((d) => !isLinked(d)).map((d) => d.path)))
  return (
    <div className="mb-3 rounded-lg border border-primary/40 bg-primary/5 p-2.5">
      <div className="mb-1.5 flex items-center text-xs font-medium">
        <span className="flex-1">Found {found.length} repositories. Tick the ones this project spans.</span>
        <button type="button" aria-label="Close" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
        {found.map((d) => {
          const linked = isLinked(d)
          return (
            <li key={d.path}>
              <label className={cn('flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent/50', linked && 'opacity-60')}>
                <input
                  type="checkbox"
                  disabled={linked}
                  checked={linked || picked.has(d.path)}
                  onChange={(e) =>
                    setPicked((p) => {
                      const n = new Set(p)
                      if (e.target.checked) n.add(d.path)
                      else n.delete(d.path)
                      return n
                    })
                  }
                />
                <span className="w-40 shrink-0 truncate font-medium">{d.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">{d.remote ?? d.path}</span>
                {linked && <span className="text-[10px] text-muted-foreground">linked</span>}
              </label>
            </li>
          )
        })}
      </ul>
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" disabled={picked.size === 0} onClick={() => onLink(found.filter((d) => picked.has(d.path)))}>
          Link {picked.size} {picked.size === 1 ? 'repository' : 'repositories'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
