// Declarations for the helpers tests/fake-cli/fake-cli.mjs exports (the matchers scripts and tests reuse).

export type MatchResult =
  | { ok: true; binds: Record<string, unknown> }
  | { ok: false; diffs: { path: string; expected: unknown; actual: unknown; reason?: string }[] }

/** Partial deep match (objects a subset of keys; "$var", "$_", {"$regex"}, {"$oneOf"}, {"$not"}, {"$absent"}, {"$optional"}). */
export function matchPartial(
  pattern: unknown,
  actual: unknown,
  vars?: Record<string, unknown>,
  normalize?: (s: string) => string,
): MatchResult

/** The argv value of a flag (`-o <v>`, `--out=<v>`); `flags` is one spelling or a list. */
export function argvValue(argv: readonly string[], flags: string | readonly string[]): string | undefined

/** Full compare of a recorded frame with what the host sent (volatile ids masked, recorded → actual ids collected). */
export function compareRecorded(
  expected: unknown,
  actual: unknown,
  options?: { normalize?: (s: string) => string; idMap?: Map<unknown, unknown> },
): { path: string; expected: unknown; actual: unknown; reason?: string }[]

/** What a JSON-RPC message is, by its members. */
export function rpcKind(msg: Record<string, unknown>): 'request' | 'notification' | 'response' | 'invalid'

export function getPath(value: unknown, path: string): unknown
export function substituteValue(value: unknown, vars: Record<string, unknown>): unknown
export function substituteText(template: string, vars: Record<string, unknown>): string
export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false }
