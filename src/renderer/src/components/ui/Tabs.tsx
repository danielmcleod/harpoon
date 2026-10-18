// Tabs (Radix). The Run view's Flow · Diff · Log · Config tabs drive the route, so use them controlled.
import { Tabs as T } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn.ts'

export function Tabs({ className, ...props }: ComponentProps<typeof T.Root>): React.JSX.Element {
  return <T.Root className={cn('flex flex-col gap-2', className)} {...props} />
}

export function TabsList({ className, ...props }: ComponentProps<typeof T.List>): React.JSX.Element {
  return (
    <T.List
      className={cn('inline-flex h-9 items-center gap-1 border-b text-muted-foreground', className)}
      {...props}
    />
  )
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof T.Trigger>): React.JSX.Element {
  return (
    <T.Trigger
      className={cn(
        '-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium whitespace-nowrap transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-primary data-[state=active]:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

/**
 * A tab panel is a Tab stop of its own (Radix: tabIndex 0), so it shows the focus like every other control (without
 * it, it had none, and Tab seemed to vanish between the timeline and the panel's first control).
 */
export function TabsContent({ className, ...props }: ComponentProps<typeof T.Content>): React.JSX.Element {
  return (
    <T.Content
      className={cn(
        'min-h-0 flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className,
      )}
      {...props}
    />
  )
}
