// Checkbox (Radix). Findings selection, "Don't stop after plan", reviewed marks.
import { Check, Minus } from 'lucide-react'
import { Checkbox as C } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn.ts'

export function Checkbox({ className, ...props }: ComponentProps<typeof C.Root>): React.JSX.Element {
  return (
    <C.Root
      className={cn(
        'peer inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <C.Indicator className="group flex items-center justify-center">
        <Check className="size-3.5 group-data-[state=indeterminate]:hidden" />
        <Minus className="hidden size-3.5 group-data-[state=indeterminate]:block" />
      </C.Indicator>
    </C.Root>
  )
}
