// canResume for Codex (a transcript already missing at canResume gives cannot-resume): a token-free file lookup, no
// process. A thread Codex can
// resume has a rollout `${CODEX_HOME ?? ~/.codex}/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`
// (ephemeral threads have none); thread/resume on a missing one fails with "no rollout found for thread id", which is
// what this predicts without spawning. Only file names are read: never a rollout's content, never auth.json.
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EnvInput } from '../../proc/env.ts'
import { getEnv } from '../../proc/env.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `CODEX_HOME` as the child sees it (vendor env over Harpoon's), else `~/.codex`. */
export function codexHome(env: EnvInput, home: string = homedir()): string {
  const v = getEnv(env, 'CODEX_HOME')
  return v !== undefined && v.trim() !== '' ? v : join(home, '.codex')
}

/** The creation time a UUIDv7 thread id carries (ms since the epoch), else undefined. */
export function uuidV7Time(id: string): number | undefined {
  if (!UUID.test(id) || id[14] !== '7') return undefined
  const ms = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `YYYY/MM/DD` folders a rollout created at `ms` can be in (local and UTC dates, a day either side). */
export function dayFolders(ms: number): string[] {
  const out = new Set<string>()
  for (const off of [-1, 0, 1]) {
    const d = new Date(ms + off * 86_400_000)
    out.add(join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())))
    out.add(join(String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())))
  }
  return [...out]
}

const list = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

const isRollout = (name: string, id: string): boolean =>
  name.startsWith('rollout-') && name.toLowerCase().endsWith(`-${id.toLowerCase()}.jsonl`)

/** The sub-folders of `dir` whose names match `re`, newest (highest) first. */
const desc = (dir: string, re: RegExp): string[] =>
  list(dir)
    .filter((n) => re.test(n))
    .sort()
    .reverse()

/** Every `sessions/YYYY/MM/DD` folder, newest first (the fallback when the id carries no time). */
function allDayFolders(sessions: string): string[] {
  const out: string[] = []
  for (const y of desc(sessions, /^\d{4}$/))
    for (const m of desc(join(sessions, y), /^\d{2}$/))
      for (const d of desc(join(sessions, y, m), /^\d{2}$/)) out.push(join(y, m, d))
  return out
}

/** The rollout file of a thread, or undefined when Codex keeps none (never created, ephemeral, or removed). */
export function findRollout(codexHomeDir: string, threadId: string): string | undefined {
  if (!UUID.test(threadId)) return undefined
  const sessions = join(codexHomeDir, 'sessions')
  if (!existsSync(sessions)) return undefined
  const t = uuidV7Time(threadId)
  const folders = t !== undefined ? dayFolders(t) : allDayFolders(sessions)
  for (const f of folders) {
    const hit = list(join(sessions, f)).find((n) => isRollout(n, threadId))
    if (hit !== undefined) return join(sessions, f, hit)
  }
  // A clock far off when the thread started: one walk of every day folder.
  if (t !== undefined) {
    for (const f of allDayFolders(sessions)) {
      const hit = list(join(sessions, f)).find((n) => isRollout(n, threadId))
      if (hit !== undefined) return join(sessions, f, hit)
    }
  }
  return undefined
}
