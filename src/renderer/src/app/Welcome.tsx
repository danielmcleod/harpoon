// No project open: start a new design (saved locally, no repository needed), open a folder or repository, open a
// single-file design, explore the sample, or reopen a recent one.
import { CircleHelp, FileJson, FilePlus2, FolderOpen, History, Laptop, Sparkles, X } from 'lucide-react'
import { openHelp } from '../help/HelpDialog.tsx'
import { Logo } from '../components/brand/Logo.tsx'
import { Button } from '../components/ui/Button.tsx'
import { invoke } from '../ipc/client.ts'
import { useState } from 'react'
import { call } from '../ipc/client.ts'
import { createLocalDesign, createSample, openDesignFile, openOrCreate, openProjectDialog } from '../state/actions.ts'
import { setState, useStore } from '../state/store.ts'

export function Welcome(): React.JSX.Element {
  const recent = useStore((s) => s.prefs.recentProjects)
  const designsDir = useStore((s) => s.prefs.designsDir)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const changeDesignsDir = async (): Promise<void> => {
    const dir = await call('dialog.pickFolder', { title: 'Where new designs are saved', defaultPath: designsDir })
    if (dir === null) return
    const r = await invoke('state.set', { designsDir: dir })
    if (r.ok) setState({ prefs: r.value })
  }

  const forget = async (path: string): Promise<void> => {
    const r = await invoke('project.forgetRecent', { path })
    if (r.ok) setState((s) => ({ prefs: { ...s.prefs, recentProjects: r.value } }))
  }

  return (
    <div className="flex h-full items-center justify-center bg-canvas p-8">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex items-center gap-3">
          <Logo className="size-11" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Harpoon</h1>
            <p className="text-sm text-muted-foreground">Map, document and plan your architecture.</p>
          </div>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => openHelp()}>
            <CircleHelp /> Help
          </Button>
        </div>

        <div className="mb-3 rounded-xl border bg-card p-4">
          {naming ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void createLocalDesign(name)
              }}
            >
              <input autoFocus aria-label="Design name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name it, e.g. Payments platform" className="h-9 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus:border-ring" />
              <Button type="submit">Create</Button>
              <Button type="button" variant="ghost" onClick={() => setNaming(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <button type="button" onClick={() => setNaming(true)} className="flex w-full items-start gap-3 text-left">
              <FilePlus2 className="mt-0.5 size-5 text-hx-green" />
              <span>
                <span className="block font-medium">New design</span>
                <span className="block text-xs text-muted-foreground">Saved on this computer as you work. No repository or git needed; you can put it in a repository later.</span>
              </span>
            </button>
          )}
          <div className="mt-2 flex items-center gap-1.5 pl-8 text-[11px] text-muted-foreground">
            <span className="truncate">Designs folder: {designsDir}</span>
            <button type="button" onClick={() => void changeDesignsDir()} className="shrink-0 text-primary hover:underline">
              Change
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <button
            type="button"
            onClick={() => void openProjectDialog()}
            className="group flex flex-col items-start gap-2 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/60 hover:bg-accent/40"
          >
            <FolderOpen className="size-5 text-hx-cyan" />
            <span className="font-medium">Open a folder or repo</span>
            <span className="text-xs text-muted-foreground">
              Harpoon opens its <code>.harpoon/</code> project, or starts one there to commit with the code.
            </span>
          </button>
          <button
            type="button"
            onClick={() => void openDesignFile()}
            className="group flex flex-col items-start gap-2 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/60 hover:bg-accent/40"
          >
            <FileJson className="size-5 text-hx-amber" />
            <span className="font-medium">Open a file</span>
            <span className="text-xs text-muted-foreground">A design saved or sent as a single <code>.harpoon.json</code> file.</span>
          </button>
          <button
            type="button"
            onClick={() => void createSample()}
            className="group flex flex-col items-start gap-2 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/60 hover:bg-accent/40"
          >
            <Sparkles className="size-5 text-hx-violet" />
            <span className="font-medium">Explore the sample</span>
            <span className="text-xs text-muted-foreground">
              A commerce platform with nested services, flows and third-party APIs, as a local design.
            </span>
          </button>
        </div>

        <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
          <Laptop className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            The AI assistant is optional and uses your own Claude Code or Codex CLI on this computer, signed in to your
            account, so usage counts against your own plan. Harpoon has no AI service of its own.{' '}
            <button type="button" className="text-primary hover:underline" onClick={() => openHelp('ai')}>
              More
            </button>
          </span>
        </p>

        {recent.length > 0 && (
          <div className="mt-8">
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              <History className="size-3.5" /> Recent
            </h2>
            <ul className="divide-y rounded-xl border bg-card">
              {recent.map((r) => (
                <li key={r.path} className="group flex items-center gap-3 px-3 py-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => void openOrCreate(r.path)}
                  >
                    <div className="truncate font-medium">{r.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{r.path}</div>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${r.name} from recent`}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => void forget(r.path)}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
