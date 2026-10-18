// A small append-only file logger (HARPOON_HOME/logs/main.log) that also mirrors to the console in dev. Values are
// passed through redactSecrets so tokens never land on disk. Writes are best-effort: logging never throws.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { redactText } from '../shared/redact.ts'

const redactSecrets = (s: string): string => redactText(s, { mode: 'diagnostics' }).text

export type Level = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  child(scope: string): Logger
}

const MAX_BYTES = 5 * 1024 * 1024

function serialize(data: Record<string, unknown> | undefined): string {
  if (data === undefined) return ''
  try {
    return ' ' + redactSecrets(JSON.stringify(data, (_k, v: unknown) => (v instanceof Error ? v.message : v)))
  } catch {
    return ' [unserializable]'
  }
}

export function createLogger(o: { file: string | null; console?: boolean; scope?: string }): Logger {
  let ready = false
  const write = (level: Level, scope: string | undefined, msg: string, data?: Record<string, unknown>): void => {
    const line = `${new Date().toISOString()} ${level.toUpperCase()}${scope ? ` [${scope}]` : ''} ${redactSecrets(msg)}${serialize(data)}\n`
    if (o.console === true) {
      const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      out(line.trimEnd())
    }
    if (o.file === null) return
    try {
      if (!ready) {
        mkdirSync(dirname(o.file), { recursive: true })
        ready = true
      }
      try {
        if (statSync(o.file).size > MAX_BYTES) renameSync(o.file, `${o.file}.1`)
      } catch {
        // no file yet
      }
      appendFileSync(o.file, line)
    } catch {
      // logging never throws
    }
  }
  const make = (scope: string | undefined): Logger => ({
    debug: (m, d) => write('debug', scope, m, d),
    info: (m, d) => write('info', scope, m, d),
    warn: (m, d) => write('warn', scope, m, d),
    error: (m, d) => write('error', scope, m, d),
    child: (s) => make(scope === undefined ? s : `${scope}:${s}`),
  })
  return make(o.scope)
}

/** A logger that drops everything (tests, the CLI's quiet mode). */
export const nullLogger: Logger = createLogger({ file: null })
