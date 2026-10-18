// Core error type and the throw → Result mapping used by IPC/CLI handlers (ResultCode, Result<T>). Handlers throw
// HarpoonError; the boundary maps any throw to `{ok:false}`.
import type { Result, ResultCode, ResultError } from '../shared/ipc.ts'

/** errno codes that mean "the disk/filesystem refused", mapped to STORAGE. */
const STORAGE_ERRNO = new Set([
  'ENOSPC',
  'EDQUOT',
  'EROFS',
  'EPERM',
  'EACCES',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'EIO',
  'EISDIR',
  'ENOTDIR',
  'ENOTEMPTY',
  'EEXIST',
])

/** errno codes that mean the disk is full (FailureCategory `disk_full`). */
export const DISK_FULL_ERRNO: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT'])

export interface HarpoonErrorOptions {
  details?: unknown
  cause?: unknown
}

export class HarpoonError extends Error {
  readonly code: ResultCode
  readonly details: unknown

  constructor(code: ResultCode, message: string, opts: HarpoonErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'HarpoonError'
    this.code = code
    this.details = opts.details
  }

  toResultError(): ResultError {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details }
  }
}

export function isHarpoonError(err: unknown): err is HarpoonError {
  return err instanceof HarpoonError
}

/** The `code` of a Node errno error (`EPERM`, `ENOENT`, …), else undefined. */
export function errnoCode(err: unknown): string | undefined {
  return err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}

/** Wrap a filesystem error as STORAGE, keeping the errno (and `disk_full` for ENOSPC/EDQUOT) in details. */
export function storageError(message: string, cause: unknown): HarpoonError {
  const errno = errnoCode(cause)
  const details: Record<string, unknown> = {}
  if (errno !== undefined) details['errno'] = errno
  if (errno !== undefined && DISK_FULL_ERRNO.has(errno)) details['category'] = 'disk_full'
  return new HarpoonError('STORAGE', `${message}: ${errorMessage(cause)}`, {
    cause,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  })
}

/** Map any thrown value to a ResultError: HarpoonError keeps its code; fs errnos → STORAGE; else INTERNAL. */
export function toResultError(err: unknown): ResultError {
  if (isHarpoonError(err)) return err.toResultError()
  const errno = errnoCode(err)
  if (errno !== undefined && STORAGE_ERRNO.has(errno))
    return storageError('storage error', err).toResultError()
  return { code: 'INTERNAL', message: errorMessage(err) }
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function fail<T = never>(code: ResultCode, message: string, details?: unknown): Result<T> {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } }
}

/** Run `fn` and map its outcome to a Result. Never rejects. */
export async function toResult<T>(fn: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn())
  } catch (err) {
    return { ok: false, error: toResultError(err) }
  }
}

/** Unwrap a Result, throwing a HarpoonError for `{ok:false}`. */
export function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value
  throw new HarpoonError(r.error.code, r.error.message, { details: r.error.details })
}
