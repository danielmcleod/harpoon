// Plan-file hygiene: Claude's plan mode writes
// `${CLAUDE_CONFIG_DIR ?? ~/.claude}/plans/<slug>.md` on every native Plan pass (C06, and C07 without a host).
// Once Harpoon has captured the plan, the copy Claude left behind is deleted, but only when it is provably this
// pass's own copy of the captured text: under `<config>/plans/`, modified at or after the pass's spawn, and with
// the same content. Anything else is left in place and reported in a `planFiles` meta note.
import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterSignal, PlanCaptureSource } from '../../../shared/events.ts'
import { normalizePath } from '../allow-cache.ts'

/** Meta signal key: `{deleted: string[], kept: {path, reason}[]}` (paths `~`-relative where possible). */
export const META_PLAN_FILES = 'planFiles'

/** The plan a Claude plan pass captured, and where Claude said it wrote it (ExitPlanMode `planFilePath`). */
export interface PlanCapture {
  markdown: string
  source: Extract<PlanCaptureSource, 'exitPlanMode' | 'final-message'>
  planFilePath?: string
}

export interface PlanFileStat {
  mtimeMs: number
  /** A regular file (symlinks and directories are never deleted). */
  isFile: boolean
}

/** File operations the hygiene needs (test seam); the default is node:fs. */
export interface PlanFileOps {
  /** lstat; undefined when the path does not exist. */
  stat(path: string): PlanFileStat | undefined
  read(path: string): string | undefined
  /** Entry names in `dir`; [] when it does not exist. */
  list(dir: string): string[]
  /** Throws when the file cannot be removed. */
  remove(path: string): void
}

export const nodePlanFileOps: PlanFileOps = {
  stat(path) {
    try {
      const s = lstatSync(path)
      return { mtimeMs: s.mtimeMs, isFile: s.isFile() }
    } catch {
      return undefined
    }
  },
  read(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  },
  list(dir) {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  remove(path) {
    unlinkSync(path)
  },
}

export type PlanFileKeptReason =
  'outside-plans-dir' | 'older-than-pass' | 'content-differs' | 'not-a-file' | 'unreadable' | 'delete-failed'

export interface PlanHygieneResult {
  /** Absolute paths that were deleted. */
  deleted: string[]
  /** Candidates left in place, with why. A missing planFilePath is not reported (nothing was left behind). */
  kept: { path: string; reason: PlanFileKeptReason }[]
}

export interface PlanHygieneInput {
  capture: PlanCapture
  /** `${CLAUDE_CONFIG_DIR ?? <home>/.claude}/plans`, as the child saw it. */
  plansDir: string
  /** Resolves `~` in a reported planFilePath. */
  home: string
  /** The pass's spawn time (ms since the epoch, same clock as file mtimes). */
  spawnAtMs: number
  ops?: PlanFileOps
  platform?: NodeJS.Platform
}

/** Plan text equality, tolerant only of line endings and surrounding whitespace. */
export function samePlanText(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/\r\n?/g, '\n').trim()
  return norm(a) === norm(b)
}

/**
 * `file` resolves (`~`, `.`, `..` folded) to a path strictly inside `dir`. Case-insensitive on win32, where
 * the CLI and Harpoon may spell the same profile path differently.
 */
export function isUnderDir(
  file: string,
  dir: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const abs = normalizePath(file, { home })
  const base = normalizePath(dir, { home }).replace(/\/+$/, '')
  const ci = platform === 'win32'
  const a = ci ? abs.toLowerCase() : abs
  const d = ci ? base.toLowerCase() : base
  return a.startsWith(`${d}/`) && a.length > d.length + 1
}

/**
 * Delete the plan file(s) this pass left behind. ExitPlanMode capture with a `planFilePath`: only that file.
 * Otherwise (final-message capture without ExitPlanMode, e.g. C07, or an ExitPlanMode without a path): every
 * `*.md` directly in the plans dir modified since the spawn whose content equals the captured plan; newer files
 * with other content are reported, older ones are not this pass's and are never mentioned. Never throws.
 */
export function cleanPlanFiles(i: PlanHygieneInput): PlanHygieneResult {
  const ops = i.ops ?? nodePlanFileOps
  const platform = i.platform ?? process.platform
  const out: PlanHygieneResult = { deleted: [], kept: [] }

  /** Why `path` must stay, or undefined when it is this pass's copy of the plan. */
  const keepReason = (path: string, reportOlder: boolean): PlanFileKeptReason | 'skip' | undefined => {
    const st = ops.stat(path)
    if (st === undefined) return 'skip'
    if (!st.isFile) return 'not-a-file'
    if (!(st.mtimeMs >= i.spawnAtMs)) return reportOlder ? 'older-than-pass' : 'skip'
    const text = ops.read(path)
    if (text === undefined) return 'unreadable'
    return samePlanText(text, i.capture.markdown) ? undefined : 'content-differs'
  }
  const consider = (path: string, reportOlder: boolean): void => {
    const reason = keepReason(path, reportOlder)
    if (reason === 'skip') return
    if (reason !== undefined) {
      out.kept.push({ path, reason })
      return
    }
    try {
      ops.remove(path)
      out.deleted.push(path)
    } catch {
      out.kept.push({ path, reason: 'delete-failed' })
    }
  }

  try {
    const reported = i.capture.source === 'exitPlanMode' ? i.capture.planFilePath : undefined
    if (reported !== undefined && reported.trim() !== '') {
      const abs = normalizePath(reported, { home: i.home })
      if (!isUnderDir(reported, i.plansDir, i.home, platform))
        out.kept.push({ path: abs, reason: 'outside-plans-dir' })
      else consider(abs, true)
      return out
    }
    for (const name of ops.list(i.plansDir).sort()) {
      if (!name.toLowerCase().endsWith('.md')) continue
      consider(join(i.plansDir, name), false)
    }
  } catch {
    // Hygiene never fails a pass.
  }
  return out
}

/** `~`-relative spelling for notes (no user name in run state). */
export function displayPath(
  path: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const p = normalizePath(path, { home })
  const h = normalizePath(home, {}).replace(/\/+$/, '')
  const ci = platform === 'win32'
  const starts = ci ? p.toLowerCase().startsWith(`${h.toLowerCase()}/`) : p.startsWith(`${h}/`)
  return starts ? `~${p.slice(h.length)}` : p
}

/** The `planFiles` meta note, or undefined when there was nothing to clean or report. */
export function planFilesNote(
  r: PlanHygieneResult,
  home: string,
  platform: NodeJS.Platform = process.platform,
): AdapterSignal | undefined {
  if (r.deleted.length === 0 && r.kept.length === 0) return undefined
  return {
    type: 'meta',
    key: META_PLAN_FILES,
    value: {
      deleted: r.deleted.map((p) => displayPath(p, home, platform)),
      kept: r.kept.map((k) => ({ path: displayPath(k.path, home, platform), reason: k.reason })),
    },
  }
}
