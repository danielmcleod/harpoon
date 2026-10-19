// Model and effort pickers for one CLI: the models it lists (with the full id an alias stands for), any other model
// id typed in (a model newer than the CLI's list, or a pinned version), and the effort levels the model accepts.
import { useState } from 'react'
import type { ProviderView } from '@shared/ipc.ts'
import { cn } from '../lib/cn.ts'

export interface ModelPick {
  model: string | null
  effort: string | null
}

const CUSTOM = '__custom'
const MODEL_ID = /^[A-Za-z0-9._:/@[\]-]+$/

/** "Opus 5.5 · claude-opus-5-5": the label, plus the id when it says more than the label. */
function optionText(m: ProviderView['models'][number]): string {
  const id = m.resolved ?? (m.id !== m.label ? m.id : null)
  return id !== null && id !== m.label ? `${m.label} · ${id}` : m.label
}

/** The effort levels to offer: the picked model's, the CLI default's, or every level any model lists. */
export function effortsFor(provider: ProviderView | undefined, model: string | null): string[] {
  const models = provider?.models ?? []
  const m = model === null ? (models.find((x) => x.isDefault) ?? models[0]) : models.find((x) => x.id === model || x.resolved === model)
  if (m !== undefined && m.efforts.length > 0) return m.efforts
  return [...new Set(models.flatMap((x) => x.efforts))]
}

export function ModelPicker({
  provider,
  value,
  onChange,
  className,
  selectClass = 'h-7 rounded-md border bg-background px-1.5 text-xs',
}: {
  provider: ProviderView | undefined
  value: ModelPick
  onChange: (v: ModelPick) => void
  className?: string
  selectClass?: string
}): React.JSX.Element {
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const models = provider?.models ?? []
  const listed = value.model === null || models.some((m) => m.id === value.model)
  const efforts = effortsFor(provider, value.model)

  const pickModel = (model: string | null): void => {
    // An effort the new model does not take goes back to the default.
    const keep = value.effort !== null && effortsFor(provider, model).includes(value.effort)
    onChange({ model, effort: keep ? value.effort : null })
  }

  if (typing) {
    const ok = MODEL_ID.test(text.trim())
    const done = (): void => {
      if (ok) pickModel(text.trim())
      setTyping(false)
    }
    return (
      <form
        className={cn('flex items-center gap-1', className)}
        onSubmit={(e) => {
          e.preventDefault()
          done()
        }}
      >
        <input
          autoFocus
          aria-label="Model id"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setTyping(false)}
          placeholder={provider?.id === 'codex' ? 'e.g. gpt-6-luna' : 'e.g. claude-opus-5-5'}
          className={cn(selectClass, 'w-44 font-mono')}
        />
        <button type="submit" disabled={!ok} className="rounded-md border px-2 py-1 text-xs disabled:opacity-50">
          Use
        </button>
        <button type="button" onClick={() => setTyping(false)} className="px-1 text-xs text-muted-foreground hover:text-foreground">
          Cancel
        </button>
      </form>
    )
  }

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <select
        aria-label="Model"
        title="Models your CLI lists; pick “Other model id…” for one it does not list yet"
        value={value.model ?? ''}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setText(value.model ?? '')
            setTyping(true)
          } else pickModel(e.target.value === '' ? null : e.target.value)
        }}
        className={cn(selectClass, 'max-w-48')}
      >
        <option value="">Default model</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {optionText(m)}
          </option>
        ))}
        {!listed && value.model !== null && <option value={value.model}>{value.model}</option>}
        <option value={CUSTOM}>Other model id…</option>
      </select>
      <select
        aria-label="Effort"
        title="How hard the model thinks (more effort: slower, uses more of your plan)"
        value={value.effort ?? ''}
        onChange={(e) => onChange({ ...value, effort: e.target.value === '' ? null : e.target.value })}
        disabled={efforts.length === 0 && value.effort === null}
        className={cn(selectClass, 'max-w-28')}
      >
        <option value="">Default effort</option>
        {efforts.map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
        {value.effort !== null && !efforts.includes(value.effort) && <option value={value.effort}>{value.effort}</option>}
      </select>
    </div>
  )
}
