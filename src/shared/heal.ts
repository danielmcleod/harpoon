// Healing a request the IPC check rejected: when every problem has an obvious, safe fix (a field the other side does not
// know, text or a list over its limit, a number past its range), repair a copy and say what changed. Anything else
// (a wrong kind of value, a missing field, a value not in a list) is not guessed at: it returns null.
//
// The renderer sends the repaired request only after it passes the same check (parseRequest), so a heal can never
// get past validation; it can only drop or trim what would have been refused.

/** A validation problem as zod reports it (what crosses IPC in a VALIDATION error's details). */
export interface CheckIssue {
  code: string
  path: readonly PropertyKey[]
  message?: string
  keys?: readonly string[]
  origin?: string
  maximum?: number | bigint
  minimum?: number | bigint
  inclusive?: boolean
}

export interface Healed<T> {
  value: T
  /** What was changed, in words. */
  changes: string[]
}

export function isCheckIssue(v: unknown): v is CheckIssue {
  return typeof v === 'object' && v !== null && typeof (v as { code?: unknown }).code === 'string' && Array.isArray((v as { path?: unknown }).path)
}

export function pathText(path: readonly PropertyKey[]): string {
  return path.length === 0 ? 'the request' : path.map((p, i) => (typeof p === 'number' ? `[${p}]` : `${i > 0 ? '.' : ''}${String(p)}`)).join('')
}

const isObj = (v: unknown): v is Record<PropertyKey, unknown> => typeof v === 'object' && v !== null

function at(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root
  for (const p of path) {
    if (!isObj(cur)) return undefined
    cur = cur[p as string]
  }
  return cur
}

function put(root: unknown, path: readonly PropertyKey[], value: unknown): boolean {
  const parent = at(root, path.slice(0, -1))
  const key = path.at(-1)
  if (!isObj(parent) || key === undefined) return false
  parent[key as string] = value
  return true
}

/** Repair `raw` for `issues`, or null when any of them has no safe fix. */
export function healRequest<T>(raw: T, issues: readonly unknown[]): Healed<T> | null {
  if (issues.length === 0 || !issues.every(isCheckIssue)) return null
  const value = structuredClone(raw)
  const changes: string[] = []
  for (const i of issues) {
    const where = pathText(i.path)
    if (i.code === 'unrecognized_keys') {
      const target = at(value, i.path)
      if (!isObj(target) || i.keys === undefined || i.keys.length === 0) return null
      for (const k of i.keys) delete target[k]
      changes.push(`dropped ${i.keys.map((k) => `“${k}”`).join(', ')} from ${where}`)
      continue
    }
    const cur = at(value, i.path)
    if (i.code === 'too_big' && typeof i.maximum === 'number') {
      if (typeof cur === 'string' && i.origin === 'string') {
        if (!put(value, i.path, cur.slice(0, i.maximum))) return null
        changes.push(`cut ${where} to ${i.maximum} characters`)
        continue
      }
      if (Array.isArray(cur) && i.origin === 'array') {
        if (!put(value, i.path, cur.slice(0, i.maximum))) return null
        changes.push(`kept the first ${i.maximum} of ${cur.length} in ${where}`)
        continue
      }
      if (typeof cur === 'number' && i.origin === 'number' && i.inclusive !== false) {
        if (!put(value, i.path, i.maximum)) return null
        changes.push(`lowered ${where} to ${i.maximum}`)
        continue
      }
      return null
    }
    if (i.code === 'too_small' && typeof i.minimum === 'number' && typeof cur === 'number' && i.origin === 'number' && i.inclusive !== false) {
      if (!put(value, i.path, i.minimum)) return null
      changes.push(`raised ${where} to ${i.minimum}`)
      continue
    }
    return null
  }
  return { value, changes }
}
