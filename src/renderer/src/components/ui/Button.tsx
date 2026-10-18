// Button (shadcn idiom: cva variants + cn). UI control standard: a button never changes
// size when its text or state changes.
//
// - `icon`: the leading icon slot. `loading` swaps the icon for a spinner IN that slot, so a busy button keeps its
//   width and its label ("No spinners that hide content").
// - `kbd`: a keyboard-hint chip after the label (a lib/keys.ts combo). With `loading` and no `icon`, the spinner
//   covers the chip's box (a hint, not content) instead of adding width.
// - With `loading` and neither slot, there is no spinner: the button is disabled and aria-busy, and the caller shows
//   the state as text beside it (see components/ui/StableLabel.tsx for the "status beside" and "reserved label"
//   patterns).
// - `labels`: when the label itself must change (Copy → Copied, Pause → Resume), pass every label it can show. The
//   button keeps the width of its widest label (StableLabel's grid cell), and the icon, the label and the key hint sit
//   together in the middle of it: the room a shorter label leaves goes to both ends, never between the label and its
//   icon or hint.
// - `asChild` renders the child as is: `icon`, `kbd`, `labels` and `loading` do not apply to it.
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { Slot } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'
import { formatCombo } from '../../lib/keys.ts'
import { Kbd } from './Kbd.tsx'

export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      // The filled variants carry outline's 1 px border, transparent, so a button that turns from primary to outline
      // (a snag's Ask AI once the AI answered) keeps its size.
      variant: {
        default: 'border border-transparent bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'border border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        destructive:
          'border border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'h-auto px-0 text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs [&_svg]:size-3.5',
        md: 'h-9 px-3.5 [&_svg]:size-4',
        icon: 'size-8 [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
)

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element (e.g. an <a>) with button styling. */
    asChild?: boolean
    /** Busy: disabled and aria-busy; the spinner takes the `icon` slot (else covers the `kbd` chip, else none). */
    loading?: boolean | undefined
    /** Leading icon slot (aria-hidden lucide icon). `loading` shows the spinner here instead. */
    icon?: ReactNode
    /** Keyboard hint chip after the label (a lib/keys.ts combo). */
    kbd?: string | undefined
    /** Every label the button can show: reserves the widest so a label change never resizes it. */
    labels?: readonly string[] | undefined
  }

const spinner = (className?: string): React.JSX.Element => (
  <Loader2 aria-hidden data-spinner="" className={cn('animate-spin motion-reduce:animate-none', className)} />
)

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  icon,
  kbd,
  labels,
  disabled,
  children,
  type,
  ...props
}: ButtonProps): React.JSX.Element {
  const classes = cn(buttonVariants({ variant, size }), className)
  if (asChild) {
    return (
      <Slot.Root className={classes} {...props}>
        {children}
      </Slot.Root>
    )
  }
  const hasIcon = icon !== undefined && icon !== null && icon !== false
  const spinInKbd = loading && !hasIcon && kbd !== undefined
  const lead = hasIcon && (loading ? spinner() : icon)
  const hint = kbd !== undefined && (
    <span className="relative inline-flex">
      <Kbd aria-hidden combo={kbd} className={cn(spinInKbd && 'invisible')} />
      {spinInKbd && spinner('absolute inset-0 m-auto')}
    </span>
  )
  return (
    <button
      type={type ?? 'button'}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {labels === undefined ? (
        <>
          {lead}
          {children}
          {hint}
        </>
      ) : (
        <ReservedContent labels={labels} icon={hasIcon ? icon : null} kbd={kbd}>
          {lead}
          {children}
          {hint}
        </ReservedContent>
      )}
    </button>
  )
}

/**
 * The button's content in one grid cell with a copy of it for every label it can show (StableLabel's way: unseen,
 * aria-hidden, the label drawn as CSS generated content, so text queries and the accessible name see only the real
 * one). The cell is as wide as the widest copy, and the real content sits in its middle as one row.
 */
function ReservedContent({
  labels,
  icon,
  kbd,
  children,
}: {
  labels: readonly string[]
  icon: ReactNode
  kbd: string | undefined
  children: ReactNode
}): React.JSX.Element {
  return (
    <span
      data-stable-label=""
      className="inline-grid justify-items-center whitespace-nowrap *:col-start-1 *:row-start-1"
    >
      <span className="inline-flex items-center gap-1.5">{children}</span>
      {[...new Set(labels)].map((l) => (
        <span
          key={l}
          aria-hidden
          className="pointer-events-none invisible inline-flex items-center gap-1.5 select-none"
        >
          {icon}
          <span aria-hidden data-label={l} className="invisible after:content-[attr(data-label)]" />
          {kbd !== undefined && (
            <Kbd
              aria-hidden
              data-kbd-label={formatCombo(kbd)}
              className="after:content-[attr(data-kbd-label)]"
            />
          )}
        </span>
      ))}
    </span>
  )
}
