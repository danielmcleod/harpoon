// Tooltip (Radix). `Tooltip` is the one-liner most callers want; the primitives are re-exported for custom layouts.
// App mounts one TooltipProvider so every tooltip shares the open delay.
import { Tooltip as T } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'

export function TooltipProvider({
  delayDuration = 300,
  ...props
}: ComponentProps<typeof T.Provider>): React.JSX.Element {
  return <T.Provider delayDuration={delayDuration} {...props} />
}

export const TooltipRoot = T.Root
export const TooltipTrigger = T.Trigger

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentProps<typeof T.Content>): React.JSX.Element {
  return (
    <T.Portal>
      <T.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-xs rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
          className,
        )}
        {...props}
      >
        {children}
      </T.Content>
    </T.Portal>
  )
}

export interface TooltipProps {
  /** Tooltip text; nothing is rendered around the child when it is empty. */
  content: ReactNode
  /** A single focusable element (it becomes the trigger). */
  children: React.ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  className?: string
}

export function Tooltip({ content, children, side, align, className }: TooltipProps): React.JSX.Element {
  if (content === null || content === undefined || content === '') return children
  return (
    <T.Root>
      {/* data-tooltip: the element says more on hover (the layout guards accept it for text cut with an ellipsis). */}
      <T.Trigger asChild data-tooltip="">
        {children}
      </T.Trigger>
      <TooltipContent
        {...(side !== undefined ? { side } : {})}
        {...(align !== undefined ? { align } : {})}
        {...(className !== undefined ? { className } : {})}
      >
        {content}
      </TooltipContent>
    </T.Root>
  )
}
