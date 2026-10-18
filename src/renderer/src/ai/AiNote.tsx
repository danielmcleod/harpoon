// How AI works in Harpoon, said the same way everywhere: it runs the Claude Code or Codex CLI on this computer,
// signed in to the user's own account, so the usage is theirs. Harpoon has no AI service or keys of its own.
import { Laptop } from 'lucide-react'
import { cn } from '../lib/cn.ts'

/** One line for tooltips and confirmations. */
export const AI_NOTE_SHORT = 'Runs your own Claude Code or Codex CLI on this computer; usage counts against your plan.'

export const AI_NOTE =
  'AI in Harpoon runs through Claude Code or Codex, the command-line tools you install and sign in to yourself. ' +
  'Harpoon has no AI service, servers or keys of its own. What the CLI reads is sent to Anthropic or OpenAI ' +
  'under your account, and the usage counts against your own subscription or API credits.'

export function AiNote({ className, compact = false }: { className?: string; compact?: boolean }): React.JSX.Element {
  return (
    <p className={cn('flex gap-2 rounded-md border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground', className)}>
      <Laptop className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{compact ? AI_NOTE_SHORT : AI_NOTE}</span>
    </p>
  )
}
