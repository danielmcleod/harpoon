// Inspector form controls. Every change commits an op at once (optimistic); typing in one field coalesces into a
// single undo step. In Docs mode the same controls render read-only.
import { ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '../../lib/cn.ts'

export function Section({
  title,
  children,
  action,
  defaultOpen = true,
}: {
  title: string
  children: React.ReactNode
  action?: React.ReactNode
  defaultOpen?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-b last:border-b-0">
      <div className="flex h-9 items-center gap-1 px-3">
        <button type="button" onClick={() => setOpen(!open)} className="flex flex-1 items-center gap-1 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground">
          <ChevronDown className={cn('size-3 transition-transform', !open && '-rotate-90')} />
          {title}
        </button>
        {action}
      </div>
      {open && <div className="px-3 pb-3">{children}</div>}
    </section>
  )
}

export function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }): React.JSX.Element {
  return (
    <label className="grid grid-cols-[96px_1fr] items-center gap-2 py-1">
      <span className="truncate text-xs text-muted-foreground" title={hint ?? label}>
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </label>
  )
}

const inputCls =
  'h-7 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring disabled:cursor-default disabled:border-transparent disabled:bg-transparent disabled:px-0 disabled:opacity-100'

/** A text input that keeps its own draft while focused, so remote updates never fight the cursor. */
export function TextInput({
  value,
  onChange,
  placeholder,
  readOnly,
  mono,
  list,
  className,
  autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  readOnly?: boolean
  mono?: boolean
  list?: string
  className?: string
  autoFocus?: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setDraft(value)
  }, [value, focused])
  return (
    <input
      value={focused ? draft : value}
      disabled={readOnly}
      placeholder={readOnly ? '—' : placeholder}
      list={list}
      autoFocus={autoFocus}
      onFocus={() => {
        setDraft(value)
        setFocused(true)
      }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setDraft(e.target.value)
        onChange(e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
      }}
      className={cn(inputCls, mono === true && 'font-mono', className)}
    />
  )
}

export function NumberInput({
  value,
  onChange,
  placeholder,
  readOnly,
  step,
  min,
  max,
  suffix,
}: {
  value: number | null
  onChange: (v: number | null) => void
  placeholder?: string
  readOnly?: boolean
  step?: number
  min?: number
  max?: number
  suffix?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState(value === null ? '' : String(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setDraft(value === null ? '' : String(value))
  }, [value, focused])
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        inputMode="decimal"
        value={draft}
        disabled={readOnly}
        placeholder={readOnly ? '—' : placeholder}
        step={step}
        min={min}
        max={max}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setDraft(e.target.value)
          const t = e.target.value.trim()
          if (t === '') onChange(null)
          else {
            const n = Number(t)
            if (Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) onChange(n)
          }
        }}
        className={cn(inputCls, 'tabular-nums')}
      />
      {suffix !== undefined && <span className="shrink-0 text-[11px] text-muted-foreground">{suffix}</span>}
    </div>
  )
}

export function TextArea({
  value,
  onChange,
  placeholder,
  readOnly,
  mono,
  rows = 3,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  readOnly?: boolean
  mono?: boolean
  rows?: number
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setDraft(value)
  }, [value, focused])
  if (readOnly === true) {
    return value === '' ? (
      <p className="text-xs text-muted-foreground">—</p>
    ) : (
      <p className={cn('text-xs whitespace-pre-wrap selectable', mono === true && 'rounded-md bg-muted p-2 font-mono text-[11px]')}>{value}</p>
    )
  }
  return (
    <textarea
      value={focused ? draft : value}
      rows={rows}
      placeholder={placeholder}
      spellCheck={!mono}
      onFocus={() => {
        setDraft(value)
        setFocused(true)
      }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setDraft(e.target.value)
        onChange(e.target.value)
      }}
      className={cn(
        'w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:border-ring',
        mono === true && 'font-mono text-[11px] leading-relaxed',
      )}
    />
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  readOnly,
  labels,
}: {
  value: T
  options: readonly T[]
  onChange: (v: T) => void
  readOnly?: boolean
  labels?: Partial<Record<T, string>>
}): React.JSX.Element {
  if (readOnly === true) return <span className="text-xs">{labels?.[value] ?? value}</span>
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} className={cn(inputCls, 'pr-1')}>
      {options.map((o) => (
        <option key={o} value={o}>
          {labels?.[o] ?? o}
        </option>
      ))}
    </select>
  )
}

export function Toggle({ checked, onChange, readOnly, label }: { checked: boolean; onChange: (v: boolean) => void; readOnly?: boolean; label: string }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={readOnly}
      onClick={() => onChange(!checked)}
      className={cn('relative h-4 w-7 rounded-full transition-colors disabled:opacity-70', checked ? 'bg-primary' : 'bg-input')}
    >
      <span className={cn('absolute top-0.5 left-0.5 size-3 rounded-full bg-background transition-transform', checked && 'translate-x-3')} />
    </button>
  )
}

export function Chip({ children, onRemove, className }: { children: React.ReactNode; onRemove?: () => void; className?: string }): React.JSX.Element {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md border bg-muted px-1.5 py-0.5 text-[11px]', className)}>
      {children}
      {onRemove !== undefined && (
        <button type="button" aria-label="Remove" onClick={onRemove} className="text-muted-foreground hover:text-foreground">
          ×
        </button>
      )}
    </span>
  )
}

/** "" ↔ null for nullable text fields. */
export const orNull = (v: string): string | null => (v.trim() === '' ? null : v)
