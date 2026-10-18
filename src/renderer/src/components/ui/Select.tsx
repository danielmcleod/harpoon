// Select (Radix), styled like Input. Profile, vendor and model pickers use it. Its list is an allowed inner scroll
// region (UI standard: one scroll region per screen): at most max-h-80, data-scroll-region="menu", and a wheel at its
// ends never scrolls the page behind it.
import { Check, ChevronDown } from 'lucide-react'
import { Select as S } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn.ts'

export const Select = S.Root
export const SelectGroup = S.Group
export const SelectValue = S.Value

export function SelectTrigger({
  className,
  children,
  size = 'md',
  ...props
}: ComponentProps<typeof S.Trigger> & { size?: 'sm' | 'md' }): React.JSX.Element {
  return (
    <S.Trigger
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground [&>span]:truncate',
        size === 'sm' ? 'h-7 text-xs' : 'h-9',
        className,
      )}
      {...props}
    >
      {children}
      <S.Icon asChild>
        <ChevronDown className="size-4 shrink-0 opacity-60" />
      </S.Icon>
    </S.Trigger>
  )
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: ComponentProps<typeof S.Content>): React.JSX.Element {
  return (
    <S.Portal>
      <S.Content
        position={position}
        className={cn(
          'relative z-50 max-h-80 min-w-32 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md',
          position === 'popper' && 'w-full min-w-[var(--radix-select-trigger-width)] translate-y-1',
          className,
        )}
        {...props}
      >
        {/* The region itself carries the cap (the content's border box holds it as well). */}
        <S.Viewport data-scroll-region="menu" className="max-h-80 overscroll-contain p-1">
          {children}
        </S.Viewport>
      </S.Content>
    </S.Portal>
  )
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof S.Item>): React.JSX.Element {
  return (
    <S.Item
      className={cn(
        'relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <S.ItemIndicator>
          <Check className="size-4" />
        </S.ItemIndicator>
      </span>
      <S.ItemText>{children}</S.ItemText>
    </S.Item>
  )
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof S.Label>): React.JSX.Element {
  return <S.Label className={cn('px-2 py-1.5 text-xs text-muted-foreground', className)} {...props} />
}

export function SelectSeparator({
  className,
  ...props
}: ComponentProps<typeof S.Separator>): React.JSX.Element {
  return <S.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}
