// A one-click suggestion under the message box when what the user types names one of their own tools ("create a
// Linear issue") that this conversation does not have yet. Settings → AI → Tools decides which tools may be suggested.
import { Plus } from 'lucide-react'
import { useEffect } from 'react'
import { loadUserTools } from '../state/ai.ts'
import { setAi, useStore } from '../state/store.ts'
import { suggestTools } from './toolHints.ts'

export function ToolHint({ text }: { text: string }): React.JSX.Element | null {
  const vendor = useStore((s) => s.ai.vendor)
  const all = useStore((s) => s.ai.userTools)
  const picked = useStore((s) => s.ai.tools)
  const prefs = useStore((s) => s.prefs.ai.tools)
  const typed = text.trim().length >= 6
  useEffect(() => {
    if (typed && all === null) void loadUserTools()
  }, [typed, all])
  if (!typed || all === null) return null
  const hits = suggestTools(text, all[vendor] ?? [], prefs[vendor] ?? {}).filter((t) => !picked.includes(t.name)).slice(0, 2)
  if (hits.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 pb-1 text-[10.5px] text-muted-foreground">
      {hits.map((t) => (
        <button
          key={t.name}
          type="button"
          onClick={() => setAi((ai) => ({ tools: [...ai.tools, t.name] }))}
          className="flex items-center gap-1 rounded-full border border-info/50 bg-info/10 px-1.5 py-0.5 text-foreground hover:bg-info/20"
          title="Lets this conversation use it, under your account"
        >
          <Plus className="size-3" />
          Use {t.label} for this conversation
        </button>
      ))}
    </div>
  )
}
