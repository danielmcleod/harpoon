// Keyboard hint (`⌘↵` on macOS, `Ctrl+Enter` elsewhere). Pass a lib/keys.ts combo or literal children.
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn.ts'
import { formatCombo } from '../../lib/keys.ts'

export function Kbd({
  combo,
  className,
  children,
  ...props
}: ComponentProps<'kbd'> & { combo?: string }): React.JSX.Element {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-sans text-[11px] font-medium text-muted-foreground',
        className,
      )}
      {...props}
    >
      {combo !== undefined ? formatCombo(combo) : children}
    </kbd>
  )
}
