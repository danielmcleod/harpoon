// Atomic file writes: temp file + fsync + rename, retried on Windows sharing errors. write-file-atomic is not
// installed; this is the same algorithm with its own retry policy.
// proc/atomic-lite.ts predates this module and can later delegate here.
import { randomBytes } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as fs from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HarpoonError, errnoCode, storageError } from '../errors.ts'

/** Waits before each retry of a rename that failed with EPERM/EBUSY/EACCES. */
export const ATOMIC_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800]
export const RETRYABLE_ERRNO: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])
export const DEFAULT_FILE_MODE = 0o600

/** The fs surface atomic writes use; injectable so tests can simulate Windows sharing violations. */
export interface AtomicFs {
  mkdir(path: string, opts: { recursive: true; mode?: number }): Promise<unknown>
  open(path: string, flags: string, mode?: number): Promise<fsp.FileHandle>
  rename(from: string, to: string): Promise<void>
  rm(path: string, opts: { force: true }): Promise<void>
}

export const nodeAtomicFs: AtomicFs = {
  mkdir: (path, opts) => fsp.mkdir(path, opts),
  open: (path, flags, mode) => fsp.open(path, flags, mode),
  rename: (from, to) => fsp.rename(from, to),
  rm: (path, opts) => fsp.rm(path, opts),
}

export interface AtomicWriteOptions {
  /** File mode for a new file (default 0o600). */
  mode?: number
  /** POSIX mode for parent folders created on the way (default 0o700; pass e.g. 0o755 inside a user's repo). */
  dirMode?: number
  /** fsync the temp file before rename (default true). */
  fsync?: boolean
  retryDelaysMs?: readonly number[]
  fs?: AtomicFs
}

function tempPath(file: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
}

/** The temp file an atomic write (this module's, proc/atomic-lite's) makes next to its target: `<name>.<pid>.<8 hex>.tmp`. */
export const ATOMIC_TEMP_NAME = /^.+\.(\d+)\.[0-9a-f]{8}\.tmp$/

/**
 * Chaos: remove the temp files of atomic writes a killed process left in `dir` and, `depth` levels down, its
 * folders (never through a link). A temp of this process (`pid`, default process.pid) may be mid-write and is kept;
 * any other belongs to a Harpoon that is gone (call this holding the home lock: one writable Harpoon per home).
 * Returns the paths removed; never throws.
 */
export async function removeStaleTemps(
  dir: string,
  o: { depth?: number; pid?: number } = {},
): Promise<string[]> {
  const own = String(o.pid ?? process.pid)
  const removed: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return removed
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if ((o.depth ?? 0) > 0)
        removed.push(...(await removeStaleTemps(p, { ...o, depth: (o.depth ?? 0) - 1 })))
      continue
    }
    const m = e.isFile() ? ATOMIC_TEMP_NAME.exec(e.name) : null
    if (m === null || m[1] === own) continue
    try {
      await fsp.rm(p, { force: true })
      removed.push(p)
    } catch {
      // Held by a scanner for a moment: the next start removes it.
    }
  }
  return removed
}

/**
 * Write `data` to `file` atomically: parent dirs created, temp file written and fsynced, then renamed over the
 * target. The rename (and the temp open) is retried on EPERM/EBUSY/EACCES after 50/100/200/400/800 ms; the final
 * failure, and any other fs error, throws STORAGE (details carry the errno, plus `category:'disk_full'` on ENOSPC).
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const io = opts.fs ?? nodeAtomicFs
  const delays = opts.retryDelaysMs ?? ATOMIC_RETRY_DELAYS_MS
  const retrying = async <T>(what: string, op: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await op()
      } catch (err) {
        const code = errnoCode(err)
        const wait = delays[attempt]
        if (code === undefined || !RETRYABLE_ERRNO.has(code) || wait === undefined) {
          throw storageError(`${what} ${file}`, err)
        }
        await delay(wait)
      }
    }
  }

  try {
    await io.mkdir(dirname(file), { recursive: true, mode: opts.dirMode ?? 0o700 })
  } catch (err) {
    throw storageError(`cannot create the folder for ${file}`, err)
  }
  const tmp = tempPath(file)
  try {
    const handle = await retrying('cannot create a temp file for', () =>
      io.open(tmp, 'w', opts.mode ?? DEFAULT_FILE_MODE),
    )
    try {
      await handle.writeFile(data)
      if (opts.fsync !== false) await handle.sync()
    } finally {
      await handle.close()
    }
    await retrying('cannot replace', () => io.rename(tmp, file))
  } catch (err) {
    await io.rm(tmp, { force: true }).catch(() => undefined)
    if (err instanceof HarpoonError) throw err
    throw storageError(`cannot write ${file}`, err)
  }
}

/** `JSON.stringify(value, null, 2)` + newline, written atomically. */
export async function writeJsonAtomic(
  file: string,
  value: unknown,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, opts)
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Synchronous variant for best-effort shutdown paths (Windows `session-end`, `process.on('exit')`), same retry
 * policy with blocking waits. Prefer {@link writeFileAtomic} everywhere else.
 */
export function writeFileAtomicSync(
  file: string,
  data: string | Uint8Array,
  opts: Pick<AtomicWriteOptions, 'mode' | 'dirMode' | 'fsync' | 'retryDelaysMs'> = {},
): void {
  const delays = opts.retryDelaysMs ?? ATOMIC_RETRY_DELAYS_MS
  const tmp = tempPath(file)
  try {
    fs.mkdirSync(dirname(file), { recursive: true, mode: opts.dirMode ?? 0o700 })
    const fd = fs.openSync(tmp, 'w', opts.mode ?? DEFAULT_FILE_MODE)
    try {
      fs.writeFileSync(fd, data)
      if (opts.fsync !== false) fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file)
        return
      } catch (err) {
        const code = errnoCode(err)
        const wait = delays[attempt]
        if (code === undefined || !RETRYABLE_ERRNO.has(code) || wait === undefined) throw err
        sleepSync(wait)
      }
    }
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // best effort
    }
    throw storageError(`cannot write ${file}`, err)
  }
}

export type ReadJsonResult =
  | { kind: 'missing' }
  | { kind: 'ok'; value: unknown; text: string }
  | { kind: 'corrupt'; error: string; text: string }

/** Read and parse a JSON file; never throws for a missing or unparsable file (STORAGE for other fs errors). */
export async function readJsonFile(file: string): Promise<ReadJsonResult> {
  let text: string
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (err) {
    if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR') return { kind: 'missing' }
    throw storageError(`cannot read ${file}`, err)
  }
  try {
    // A UTF-8 BOM (hand-edited on Windows) is not part of the JSON.
    return { kind: 'ok', value: JSON.parse(text.replace(/^\uFEFF/, '')) as unknown, text }
  } catch (err) {
    return { kind: 'corrupt', error: err instanceof Error ? err.message : String(err), text }
  }
}
