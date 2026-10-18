// Identifiers and path-safe keys. Pure TS: no Node built-ins (uses Web Crypto via globalThis).

const HEX = '0123456789abcdef'

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2))
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!
  return out.slice(0, length)
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** Run id: `YYYYMMDDTHHMMSSZ-xxxx` (UTC, sortable, unique enough per home). */
export function newRunId(now: Date = new Date()): string {
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  return `${stamp}-${randomHex(4)}`
}

export const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/

/** Opaque request/correlation id. */
export function newRequestId(prefix = 'req'): string {
  return `${prefix}_${randomHex(16)}`
}

/** RFC 4122 v4 UUID (used to pre-assign vendor session ids). */
export function newUuid(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * Make a step key or snapshot label safe for use in a file name.
 * `:` would create an NTFS alternate data stream on Windows (e.g. `verify:1`).
 */
export function fileSafe(key: string): string {
  return key.replace(/[:<>"|?*\\/]/g, '-')
}
