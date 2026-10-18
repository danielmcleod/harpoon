// The save indicator and the History popover beside undo/redo. Every change is saved automatically; the indicator
// says so (Saving… → Saved), and History lists recent changes: click one to go back to just after it, or forward
// again through undone steps.
import { Popover } from 'radix-ui'
import { Bot, Check, CircleAlert, CloudUpload, GitBranch, History, Redo2, User } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { HistoryEntry } from '@shared/ipc.ts'
import { cn } from '../lib/cn.ts'
import { stepHistory } from '../state/actions.ts'
import { useStore } from '../state/store.ts'

function ago(at: number | null, now: number): string {
  if (at === null) return ''
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function useNow(ms = 10_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function SaveStatus(): React.JSX.Element {
  const save = useStore((s) => s.save)
  const now = useNow()
  const root = useStore((s) => s.project?.root ?? '')
  return (
    <span
      className={cn('flex items-center gap-1 text-[11px]', save.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}
      title={save.status === 'error' ? (save.error ?? 'Save failed') : `Saved automatically to ${root}/.harpoon`}
      aria-live="polite"
    >
      {save.status === 'saving' ? <CloudUpload className="size-3.5 animate-pulse" /> : save.status === 'error' ? <CircleAlert className="size-3.5" /> : <Check className="size-3.5 text-success" />}
      {save.status === 'saving' ? 'Saving…' : save.status === 'error' ? 'Save failed' : save.at === null ? 'All changes saved' : `Saved ${ago(save.at, now)}`}
    </span>
  )
}

const SOURCE_ICON = { user: User, undo: History, redo: Redo2, ai: Bot, import: Bot, external: GitBranch } as const

export function HistoryMenu(): React.JSX.Element {
  const history = useStore((s) => s.project?.history)
  const now = useNow()
  const undo = history?.undo ?? []
  const redo = history?.redo ?? []
  const row = (e: HistoryEntry, steps: number, done: boolean, key: string): React.JSX.Element => {
    const Icon = SOURCE_ICON[e.source]
    return (
      <li key={key}>
        <button
          type="button"
          disabled={steps === 0}
          onClick={() => void stepHistory(steps)}
          className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent', !done && 'text-muted-foreground')}
          title={steps < 0 ? `Undo back to this change (${-steps} step${steps === -1 ? '' : 's'})` : steps > 0 ? `Redo up to this change (${steps} step${steps === 1 ? '' : 's'})` : 'The current state'}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className={cn('min-w-0 flex-1 truncate first-letter:uppercase', !done && 'line-through')}>{e.label}</span>
          {steps === 0 && <span className="rounded bg-primary/15 px-1 text-[10px] text-primary">now</span>}
          <span className="shrink-0 text-[10px] text-muted-foreground">{ago(e.at, now)}</span>
        </button>
      </li>
    )
  }
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" aria-label="History" title="History of changes" className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          <History className="size-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="z-50 w-80 rounded-lg border bg-popover p-1 shadow-lg">
          <div className="px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">History</div>
          {undo.length === 0 && redo.length === 0 ? (
            <p className="px-2 pb-2 text-xs text-muted-foreground">No changes yet in this session. Every change is saved automatically and can be undone here.</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {/* Undone steps (redo-able), furthest first. */}
              {redo.map((e, i) => row(e, redo.length - i, false, `r${i}`))}
              {/* Done steps, newest first; the newest is the current state. */}
              {[...undo].reverse().map((e, i) => row(e, -i, true, `u${i}`))}
            </ul>
          )}
          <p className="border-t px-2 pt-1.5 pb-1 text-[10.5px] text-muted-foreground">Clicking a change undoes everything after it. History lasts for this session; the project itself is in git-friendly files.</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
