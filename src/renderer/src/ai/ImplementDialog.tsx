// "Implement this plan": where the CLI works, how much it asks before acting, and what Harpoon does with git first.
// Starts from this computer's defaults (Settings → AI → Implementing); "Remember" keeps the choice.
import { Dialog } from 'radix-ui'
import { Hammer, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { GitPolicy } from '@shared/ipc.ts'
import type { Approvals } from '@shared/run.ts'
import { Button } from '../components/ui/Button.tsx'
import { Checkbox } from '../components/ui/Checkbox.tsx'
import { cn } from '../lib/cn.ts'
import { implementPlan } from '../state/ai.ts'
import { setAi, useStore } from '../state/store.ts'
import { AI_NOTE_SHORT } from './AiNote.tsx'

export const APPROVAL_INFO: Record<Approvals, { label: string; hint: string }> = {
  manual: { label: 'Manual', hint: 'Asks you before every file edit and command.' },
  acceptEdits: { label: 'Accept edits', hint: 'Edits files freely and asks before commands, like Claude Code’s accept-edits mode.' },
  auto: { label: 'Auto', hint: 'The CLI decides what is safe and asks only when unsure (Claude Code’s auto mode, Codex’s approve-for-me reviewer).' },
}

export const GIT_INFO: Record<GitPolicy, { label: string; hint: string }> = {
  repo: { label: 'Follow the repository’s instructions', hint: 'CLAUDE.md, AGENTS.md and skills decide branches and commits; Harpoon runs no git. Without instructions it uses a new branch named from the template.' },
  branch: { label: 'Create a branch first', hint: 'Harpoon creates and switches to a new branch (from the template) before the run.' },
  worktree: { label: 'Separate worktree', hint: 'A new git worktree beside the repository, on a new branch; your own checkout stays untouched.' },
  none: { label: 'Work in place', hint: 'No branch and no git instruction: the CLI works on whatever is checked out.' },
}

/** One empty list for "no project" (a new array per render would re-render forever). */
const NO_REPOS: never[] = []

export function ImplementDialog(): React.JSX.Element | null {
  const target = useStore((s) => s.ai.implementing)
  const defaults = useStore((s) => s.prefs.implement)
  const repos = useStore((s) => s.project?.model.meta.repos ?? NO_REPOS)
  const vendor = useStore((s) => s.ai.vendor)
  const model = useStore((s) => s.ai.model)
  const [repoId, setRepoId] = useState<string | null>(null)
  const [approvals, setApprovals] = useState<Approvals>(defaults.approvals)
  const [git, setGit] = useState<GitPolicy>(defaults.git)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ message: string; dirty: boolean } | null>(null)

  // Each time it opens: this computer's defaults, and the first linked repository.
  useEffect(() => {
    if (target === null) return
    setApprovals(defaults.approvals)
    setGit(defaults.git)
    setRepoId(repos[0]?.id ?? null)
    setRemember(false)
    setProblem(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  if (target === null) return null
  const close = (): void => setAi({ implementing: null })
  const go = async (force: boolean): Promise<void> => {
    setBusy(true)
    const err = await implementPlan({ ...target, repoId, approvals, git, remember, ...(force ? { force } : {}) })
    setBusy(false)
    if (err !== null) setProblem({ message: err.message, dirty: err.code === 'CONFLICT' && err.message.includes('uncommitted') })
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[min(560px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-popover text-xs shadow-2xl outline-none">
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <Dialog.Title className="flex-1 text-sm font-semibold">Implement this plan</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
            <Dialog.Description className="text-muted-foreground">
              {vendor === 'claude' ? 'Claude Code' : 'Codex'}
              {model !== null ? ` (${model})` : ''} edits the code to carry out the plan, following the repository’s own conventions. {AI_NOTE_SHORT}
            </Dialog.Description>

            <label className="flex flex-col gap-1">
              <span className="font-medium">Work in</span>
              <select value={repoId ?? ''} onChange={(e) => setRepoId(e.target.value === '' ? null : e.target.value)} className="h-8 rounded-md border bg-background px-1.5">
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.role})
                  </option>
                ))}
                <option value="">The project folder</option>
              </select>
              {repos.length > 1 && <span className="text-muted-foreground">The other repositories stay readable.</span>}
            </label>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 font-medium">Before it acts</legend>
              {(Object.keys(APPROVAL_INFO) as Approvals[]).map((a) => (
                <label key={a} className={cn('flex cursor-pointer items-start gap-2 rounded-lg border p-2', approvals === a && 'border-primary/60 bg-primary/5')}>
                  <input type="radio" name="approvals" className="mt-0.5" checked={approvals === a} onChange={() => setApprovals(a)} />
                  <span>
                    <span className="font-medium">{APPROVAL_INFO[a].label}</span>
                    <span className="block text-muted-foreground">{APPROVAL_INFO[a].hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <label className="flex flex-col gap-1">
              <span className="font-medium">Git</span>
              <select value={git} onChange={(e) => setGit(e.target.value as GitPolicy)} className="h-8 rounded-md border bg-background px-1.5">
                {(Object.keys(GIT_INFO) as GitPolicy[]).map((g) => (
                  <option key={g} value={g}>
                    {GIT_INFO[g].label}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground">
                {GIT_INFO[git].hint}
                {git !== 'none' ? ` Branch template: ${defaults.branchTemplate}.` : ''} Nothing is pushed unless the repository’s instructions say so.
              </span>
            </label>

            <label className="flex items-center gap-2">
              <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
              Remember these choices on this computer
            </label>

            {problem !== null && <div className="rounded-md border border-destructive/50 bg-destructive/10 px-2.5 py-1.5 selectable">{problem.message}</div>}
          </div>
          <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            {problem?.dirty === true && (
              <Button variant="outline" disabled={busy} onClick={() => void go(true)}>
                Continue anyway
              </Button>
            )}
            <Button icon={<Hammer />} disabled={busy} onClick={() => void go(false)}>
              Implement
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
