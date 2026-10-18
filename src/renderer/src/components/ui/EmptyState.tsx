// Empty state: what is missing and the one thing to do about it (plain, specific copy).
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'

export interface EmptyStateProps {
  title: string
  description?: ReactNode
  icon?: LucideIcon
  /** Usually one Button. */
  action?: ReactNode
  className?: string
}

export function EmptyState({
  title,
  description,
  icon: Icon,
  action,
  className,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {Icon !== undefined && <Icon aria-hidden className="size-8 text-muted-foreground" />}
      <p className="text-sm font-medium">{title}</p>
      {description !== undefined && (
        <div className="max-w-md text-sm text-muted-foreground">{description}</div>
      )}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  )
}
