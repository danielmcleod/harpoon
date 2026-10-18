// Multi-line input (task box, plan editor). `mono` switches to the stream font for plans and commands.
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn.ts'

export function Textarea({
  className,
  mono = false,
  ...props
}: ComponentProps<'textarea'> & { mono?: boolean }): React.JSX.Element {
  return (
    <textarea
      className={cn(
        'flex min-h-16 w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
        mono && 'stream-text',
        className,
      )}
      {...props}
    />
  )
}
