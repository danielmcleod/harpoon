// Switch (Radix). `tone="auto"` is the composer's Auto switch: amber when on.
import { Switch as S } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn.ts'

export function Switch({
  className,
  tone = 'default',
  ...props
}: ComponentProps<typeof S.Root> & { tone?: 'default' | 'auto' }): React.JSX.Element {
  return (
    <S.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-input transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
        tone === 'auto' ? 'data-[state=checked]:bg-auto' : 'data-[state=checked]:bg-primary',
        className,
      )}
      {...props}
    >
      <S.Thumb className="pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
    </S.Root>
  )
}
