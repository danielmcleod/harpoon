// The AI panel's Tools: the user's own MCP servers and connectors (Linear, GitHub, Jira…) the conversation may use,
// for follow-ups such as "create a Linear issue for this plan". Off unless picked, or set to always on in Settings →
// AI → Tools; each CLI has its own.
import { Plug, RefreshCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn.ts'
import { loadUserTools } from '../state/ai.ts'
import { alwaysOn } from './toolHints.ts'
import { setAi, useStore } from '../state/store.ts'

export function ToolsPicker({ disabled }: { disabled?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const vendor = useStore((s) => s.ai.vendor)
  const picked = useStore((s) => s.ai.tools)
  const all = useStore((s) => s.ai.userTools)
  const prefs = useStore((s) => s.prefs.ai.tools[vendor])
  const box = useRef<HTMLDivElement>(null)
  const list = (all?.[vendor] ?? []).filter((t) => prefs[t.name] !== 'off')
  const always = alwaysOn(list, prefs)
  const on = [...new Set([...picked, ...always])]

  useEffect(() => {
    if (!open) return
    if (all === null) {
      setChecking(true)
      void loadUserTools().finally(() => setChecking(false))
    }
    const close = (e: PointerEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open, all])

  const toggle = (name: string): void => setAi({ tools: picked.includes(name) ? picked.filter((x) => x !== name) : [...picked, name] })
  const label = (name: string): string => list.find((t) => t.name === name)?.label ?? name

  return (
    <div ref={box} className="relative flex min-w-0 items-center gap-1">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((x) => !x)}
        aria-expanded={open}
        title="Let this conversation use some of your own tools (Linear, GitHub, Jira…) through your CLI"
        className={cn('flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] disabled:opacity-50', on.length > 0 ? 'border-primary/60 bg-primary/10 text-foreground' : 'text-muted-foreground hover:text-foreground')}
      >
        <Plug className="size-3" />
        Tools{on.length > 0 ? ` (${on.length})` : ''}
      </button>
      {on.length > 0 && <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">{on.map(label).join(', ')}</span>}
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-80 rounded-lg border bg-popover p-2 text-xs shadow-lg">
          <div className="mb-1 flex items-center gap-2">
            <span className="flex-1 font-medium">Your tools for this conversation</span>
            <button
              type="button"
              aria-label="Check again"
              title="Ask the CLI again"
              onClick={() => {
                setChecking(true)
                void loadUserTools(true).finally(() => setChecking(false))
              }}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />
            </button>
            <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </div>
          <p className="mb-2 text-[11px] text-muted-foreground">
            The AI can act in these under your account, for example create an issue for a plan. Tick them for this conversation; Settings → AI → Tools turns
            one on for every conversation, or off.
          </p>
          {checking && list.length === 0 && <p className="text-muted-foreground">Asking your CLI…</p>}
          {!checking && list.length === 0 && (
            <p className="text-muted-foreground">
              {vendor === 'claude' ? 'Claude Code' : 'Codex'} has no MCP servers or connectors set up. Add one in the CLI (for example “claude mcp add” or a claude.ai connector), then check again.
            </p>
          )}
          <ul className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
            {list.map((t) => (
              <li key={t.name}>
                <label className={cn('flex items-center gap-2 rounded px-1 py-1 hover:bg-accent/50', !t.ok && 'opacity-60')}>
                  <input type="checkbox" checked={on.includes(t.name)} disabled={always.includes(t.name)} onChange={() => toggle(t.name)} />
                  <span className="min-w-0 flex-1 truncate">
                    {t.label}
                    {always.includes(t.name) ? <span className="text-muted-foreground"> (always)</span> : null}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{t.kind === 'connector' ? 'connector' : t.kind === 'apps' ? 'apps' : 'server'}{t.ok ? '' : ' · not connected'}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
