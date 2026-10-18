// Readable, collision-free ids: a slug of the name plus a short random suffix only when needed
// (`order-ledger`, `order-ledger-2`). Ids are stable once created; renaming never changes them.
import { ID_PATTERN } from './schema.ts'

export function slugify(name: string, max = 48): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return s === '' ? 'item' : s
}

/** A fresh id for `name` that is not in `taken` (`prefix-` is prepended when given: `conn-a-b`). */
export function uniqueId(name: string, taken: (id: string) => boolean, prefix = ''): string {
  const base = (prefix === '' ? '' : `${prefix}-`) + slugify(name)
  if (!taken(base)) return base
  for (let i = 2; i < 10_000; i++) {
    const id = `${base}-${i}`
    if (!taken(id)) return id
  }
  return `${base}-${Math.random().toString(36).slice(2, 8)}`
}

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id)
}
