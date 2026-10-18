// Windows .cmd shim parsing (npm cmd-shim, pnpm, yarn classic, volta), so shims can be spawned without a shell.
import { open } from 'node:fs/promises'
import { win32 } from 'node:path'

export const MAX_SHIM_BYTES = 64 * 1024

export type ShimManager = 'npm' | 'pnpm' | 'yarn' | 'volta' | 'unknown'

export type ShimTarget =
  /** A native executable the shim forwards to. */
  | { kind: 'exe'; path: string; manager: ShimManager }
  /** A JS entry run by node; `localNode` is the shim directory's node.exe the shim prefers when present. */
  | { kind: 'js'; entry: string; localNode: string | null; manager: ShimManager }
  /** Another shim the shim forwards to (yarn classic chains `.cmd` files). */
  | { kind: 'cmd'; path: string; manager: ShimManager }
  /** A forwarding command (`volta run <tool> %*`): spawn `command` (found on PATH) with `args` first. */
  | { kind: 'command'; command: string; args: string[]; manager: ShimManager }
  | { kind: 'unknown'; reason: string }

const DP0 = /^(?:%~dp0|%dp0%)\\?/i
const ABS = /^(?:[A-Za-z]:\\|\\\\)/
const JS_EXT = /\.(?:c|m)?js$/i
const EXE_EXT = /\.(?:exe|com)$/i
const CMD_EXT = /\.(?:cmd|bat)$/i
/** Program tokens that mean "run the following path with node". */
const NODE_PROG = /(?:"%_prog%"|"?(?:%~dp0|%dp0%)\\?node\.exe"?|(?:^|[\s&(@])node(?:\.exe)?)\s+$/i

function detectManager(text: string): ShimManager {
  if (/^\s*@?volta(?:\.exe)?\s+run\b/im.test(text) || /volta-shim/i.test(text)) return 'volta'
  if (/NODE_PATH=/i.test(text) || /\.tools\\pnpm/i.test(text) || /\\\.pnpm\\/i.test(text)) return 'pnpm'
  if (/\\Yarn\\|\\yarn\\|\\Data\\global\\node_modules/i.test(text)) return 'yarn'
  if (/:find_dp0|%dp0%|%~dp0/i.test(text)) return 'npm'
  return 'unknown'
}

function toPath(token: string, shimDir: string): string | null {
  const t = token.trim()
  if (DP0.test(t)) return win32.resolve(shimDir, t.replace(DP0, ''))
  if (ABS.test(t)) return win32.normalize(t)
  return null
}

const isNodeExe = (p: string): boolean => /(?:^|\\)node\.exe$/i.test(p)

interface Token {
  value: string
  /** Text on the same line before the token. */
  before: string
}

function tokens(text: string): Token[] {
  const out: Token[] = []
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*@?(?:rem\b|::)/i.test(line)) continue
    const re = /"([^"\r\n]*)"|((?:%~dp0|%dp0%)[^\s"&|<>()]*)/gi
    for (let m = re.exec(line); m !== null; m = re.exec(line)) {
      out.push({ value: m[1] ?? m[2] ?? '', before: line.slice(0, m.index) })
    }
  }
  return out
}

/**
 * Parse shim text. `exists` decides between candidates (the first existing .exe wins, then the first JS entry);
 * by default every candidate is assumed to exist.
 */
export function parseShimText(
  text: string,
  shimPath: string,
  exists: (p: string) => boolean = () => true,
): ShimTarget {
  const shimDir = win32.dirname(shimPath)
  const manager = detectManager(text)

  const volta = /^\s*@?(volta(?:\.exe)?)\s+run\s+("[^"]+"|\S+)\s+%\*/im.exec(text)
  if (volta !== null) {
    const tool = (volta[2] ?? '').replace(/"/g, '').replace(/%~n0/i, win32.parse(shimPath).name)
    return { kind: 'command', command: volta[1] ?? 'volta', args: ['run', tool], manager: 'volta' }
  }

  const exes: string[] = []
  const entries: string[] = []
  const chained: string[] = []
  let localNode: string | null = null
  for (const tok of tokens(text)) {
    if (/^[A-Za-z_]+=/.test(tok.value)) continue // SET "NAME=value"
    const p = toPath(tok.value, shimDir)
    if (p === null) continue
    if (isNodeExe(p)) {
      if (DP0.test(tok.value.trim())) localNode = p
      continue
    }
    if (EXE_EXT.test(p)) exes.push(p)
    else if (CMD_EXT.test(p)) {
      if (p.toLowerCase() !== win32.resolve(shimPath).toLowerCase()) chained.push(p)
    } else if (JS_EXT.test(p) || NODE_PROG.test(tok.before)) entries.push(p)
  }
  if (localNode !== null && !exists(localNode)) localNode = null

  const exe = exes.find(exists)
  if (exe !== undefined) return { kind: 'exe', path: exe, manager }
  const entry = entries.find(exists)
  if (entry !== undefined) return { kind: 'js', entry, localNode, manager }
  const next = chained.find(exists)
  if (next !== undefined) return { kind: 'cmd', path: next, manager }
  const all = [...exes, ...entries, ...chained]
  if (all.length > 0) return { kind: 'unknown', reason: `shim target missing: ${all.join(', ')}` }
  return { kind: 'unknown', reason: 'no executable or JS entry found in shim' }
}

/** Read at most 64 KB of a shim. */
export async function readShimText(shimPath: string): Promise<string> {
  const handle = await open(shimPath, 'r')
  try {
    const buf = Buffer.alloc(MAX_SHIM_BYTES)
    const { bytesRead } = await handle.read(buf, 0, MAX_SHIM_BYTES, 0)
    return buf.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

export async function parseShim(shimPath: string, exists: (p: string) => boolean): Promise<ShimTarget> {
  return parseShimText(await readShimText(shimPath), shimPath, exists)
}
