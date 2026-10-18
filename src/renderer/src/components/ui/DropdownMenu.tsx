// Dropdown menu (Radix), styled with the popover tokens. Used for ⋯ menus, Re-run ▾ and pickers. A menu taller than
// the room Radix finds for it scrolls inside itself: an allowed inner scroll region (data-scroll-region="menu") that
// never chains a wheel to the page.
import { Check } from 'lucide-react'
import { DropdownMenu as M } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn.ts'

export const DropdownMenu = M.Root
export const DropdownMenuTrigger = M.Trigger
export const DropdownMenuGroup = M.Group
export const DropdownMenuSub = M.Sub
export const DropdownMenuRadioGroup = M.RadioGroup

const item =
  'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0'

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof M.Content>): React.JSX.Element {
  return (
    <M.Portal>
      <M.Content
        sideOffset={sideOffset}
        data-scroll-region="menu"
        className={cn(
          'z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-40 overflow-x-hidden overflow-y-auto overscroll-contain rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
          className,
        )}
        {...props}
      />
    </M.Portal>
  )
}

export function DropdownMenuItem({
  className,
  variant = 'default',
  ...props
}: ComponentProps<typeof M.Item> & { variant?: 'default' | 'destructive' }): React.JSX.Element {
  return (
    <M.Item
      className={cn(item, variant === 'destructive' && 'text-destructive focus:text-destructive', className)}
      {...props}
    />
  )
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof M.CheckboxItem>): React.JSX.Element {
  return (
    <M.CheckboxItem className={cn(item, 'pl-8', className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <M.ItemIndicator>
          <Check />
        </M.ItemIndicator>
      </span>
      {children}
    </M.CheckboxItem>
  )
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof M.Label>): React.JSX.Element {
  return (
    <M.Label className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)} {...props} />
  )
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof M.Separator>): React.JSX.Element {
  return <M.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}

export function DropdownMenuShortcut({ className, ...props }: ComponentProps<'span'>): React.JSX.Element {
  return <span className={cn('ml-auto text-xs tracking-wide text-muted-foreground', className)} {...props} />
}
