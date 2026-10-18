// canResume: the transcript must exist at
// `${CLAUDE_CONFIG_DIR ?? ~/.claude}/projects/<cwd with non-alphanumerics → '-'>/<id>.jsonl`.
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/** Claude truncates longer encoded names and appends a hash (internal), so those cannot be checked. */
export const PROJECT_DIR_MAX = 200
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, 'projects', encodeProjectDir(cwd), `${sessionId}.jsonl`)
}

export type TranscriptCheck =
  | { ok: true; path: string }
  | { ok: false; reason: 'invalid-id' | 'missing'; paths: string[] }
  | { ok: true; unverifiable: true }

/** Looks for the transcript under the cwd as given and its realpath (macOS /var → /private/var). */
export function findTranscript(
  configDir: string,
  cwd: string,
  sessionId: string,
  exists: (p: string) => boolean = existsSync,
): TranscriptCheck {
  if (!SESSION_ID.test(sessionId)) return { ok: false, reason: 'invalid-id', paths: [] }
  const cwds = [cwd]
  try {
    const real = realpathSync.native(cwd)
    if (real !== cwd) cwds.push(real)
  } catch {
    // keep the given cwd
  }
  if (cwds.every((c) => encodeProjectDir(c).length > PROJECT_DIR_MAX)) return { ok: true, unverifiable: true }
  const paths = cwds.map((c) => transcriptPath(configDir, c, sessionId))
  const hit = paths.find((p) => exists(p))
  return hit !== undefined ? { ok: true, path: hit } : { ok: false, reason: 'missing', paths }
}
