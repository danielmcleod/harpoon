// Transient messages, bottom-right.
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { cn } from '../lib/cn.ts'
import { dismissToast } from '../state/actions.ts'
import { useStore } from '../state/store.ts'

export function Toasts(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts)
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-96 flex-col gap-2">
      {toasts.map((t) => {
        const Icon = t.level === 'error' ? CircleAlert : t.level === 'warn' ? Info : CircleCheck
        return (
          <div
            key={t.id}
            role={t.level === 'error' ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto flex items-start gap-2 rounded-lg border bg-popover px-3 py-2.5 text-sm text-popover-foreground shadow-lg',
              t.level === 'error' && 'border-destructive/50',
            )}
          >
            <Icon
              aria-hidden
              className={cn(
                'mt-0.5 size-4 shrink-0',
                t.level === 'error' ? 'text-destructive' : t.level === 'warn' ? 'text-warning' : 'text-success',
              )}
            />
            <span className="min-w-0 flex-1 break-words selectable">{t.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => dismissToast(t.id)}
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
