// Vendor CLI resolution and validation (resolve-cli(CliSpec)).
// Candidate order: configured → well-known → PATH → npm prefix → desktop bundle (last, with a warning).
// Every candidate is validated by running its version command; the first valid one wins.
import { lstatSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { access, constants, open, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ResolvedBinary, VendorId } from '../../shared/vendors.ts'
import { getEnv, sanitizeEnv } from './env.ts'
import type { EnvInput } from './env.ts'
import { splitPathList } from './path-env.ts'
import { parseShim } from './shim.ts'
import { execCapture } from './spawn.ts'
import type { CaptureResult } from './spawn.ts'

export interface CliSpecContext {
  platform: NodeJS.Platform
  home: string
  env: EnvInput
  /** %APPDATA% / %LOCALAPPDATA% on win32, else null. */
  appData: string | null
  localAppData: string | null
  pathEntries: readonly string[]
}

export interface CliSpec {
  vendor: VendorId
  /** Bare command name searched on PATH (`claude`). */
  bin: string
  wellKnown(ctx: CliSpecContext): readonly string[] | Promise<readonly string[]>
  versionArgs: readonly string[]
  /** MUST identify the product (Claude Desktop's Claude.exe also answers --version). */
  parseVersion(stdout: string, stderr: string): { version: string } | null
  /** npm JS launcher → native binary (Codex). */
  fromJsEntry?(entry: string): { exe: string; pathPrepend?: string[] } | null
  /** A JS entry needs system node at least this version. */
  minNode?: string
  /** Reject anything under …\WindowsApps\ (Claude: the Store alias launches Claude Desktop). */
  rejectWindowsApps?: boolean
  /** Desktop-bundled copies, tried last. */
  desktopBundle?(ctx: CliSpecContext): readonly string[] | Promise<readonly string[]>
  desktopBundleWarning?: string
}

export type CliKind = 'native' | 'node-entry' | 'posix-script'
export type CliSource = 'config' | 'well-known' | 'path' | 'npm-prefix' | 'desktop-bundle'

export interface ResolvedCli {
  vendor: VendorId
  /** Executable to spawn (system node for a node-entry). */
  command: string
  /** Arguments before the adapter's argv (`[<entry.js>]` for node-entry, `['run', tool]` for volta). */
  prefixArgs: string[]
  kind: CliKind
  version: string
  source: CliSource
  /** Directories to put before the resolved PATH in the child env. */
  pathPrepend: string[]
  warnings: string[]
  /** The candidate as found (configured path, PATH hit, shim). */
  path: string
  /** The file that identifies the install (native exe or JS entry); with mtime/size it keys probe-cache.json. */
  target: string
  mtimeMs: number
  size: number
}

export type RejectReason =
  | 'not-found'
  | 'windows-apps'
  | 'placeholder'
  | 'unsupported-shim'
  | 'not-executable'
  | 'node-missing'
  | 'node-too-old'
  | 'spawn-failed'
  | 'timeout'
  | 'version-unrecognized'

export interface CandidateRejection {
  path: string
  source: CliSource
  reason: RejectReason
  detail: string
}

export type ResolveResult =
  | { ok: true; cli: ResolvedCli; rejected: CandidateRejection[]; candidates: string[] }
  | { ok: false; rejected: CandidateRejection[]; candidates: string[] }

export type RunFn = (
  command: string,
  args: readonly string[],
  opts: { env: Record<string, string>; timeoutMs: number; cwd: string },
) => Promise<CaptureResult>

export interface ResolveCliOptions {
  configuredPath?: string | null
  /** Resolved PATH (path-env); defaults to the base env's PATH. */
  pathEnv?: string
  platform?: NodeJS.Platform
  /** Harpoon's own env (sanitized for the validation run). */
  env?: EnvInput
  home?: string
  /** `vendors.<id>.env` from user config, also applied to the validation run. */
  vendorEnv?: EnvInput
  timeoutMs?: number
  /** Overrides npm-prefix detection. */
  npmPrefixes?: readonly string[]
  /** cwd for validation runs (default: the user's home). */
  cwd?: string
  run?: RunFn
  retryDelayMs?: number
  /**
   * `configured`: validate only `configuredPath` (vendors.setPath checks a path the user picked; nothing else is
   * searched or spawned). Default `all`: the full candidate order.
   */
  candidates?: 'all' | 'configured'
}

export const VALIDATE_TIMEOUT_MS = 10_000
export const PLACEHOLDER_MAX_BYTES = 4096
const HEAD_BYTES = 512

// ---- small helpers ----------------------------------------------------------------------------------------

/** Numeric dotted compare; prerelease suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => (/(\d+(?:\.\d+)*)/.exec(v)?.[1] ?? '0').split('.').map(Number)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export function isWindowsAppsPath(p: string): boolean {
  return /[\\/]WindowsApps[\\/]/i.test(p)
}

const pathMod = (platform: NodeJS.Platform): typeof win32 => (platform === 'win32' ? win32 : posix)

export type BinaryFormat = 'pe' | 'elf' | 'macho' | 'shebang' | 'unknown'

export function sniffFormat(head: Uint8Array): { format: BinaryFormat; shebang?: string } {
  const b = (i: number): number => head[i] ?? -1
  if (b(0) === 0x4d && b(1) === 0x5a) return { format: 'pe' }
  if (b(0) === 0x7f && b(1) === 0x45 && b(2) === 0x4c && b(3) === 0x46) return { format: 'elf' }
  const magic = ((b(0) << 24) | (b(1) << 16) | (b(2) << 8) | b(3)) >>> 0
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) {
    return { format: 'macho' }
  }
  if (b(0) === 0x23 && b(1) === 0x21) {
    const text = Buffer.from(head).toString('utf8')
    return { format: 'shebang', shebang: (text.split(/\r?\n/)[0] ?? '').slice(2).trim() }
  }
  return { format: 'unknown' }
}

/** npm placeholder stubs: no executable magic and no shebang, or a native header under 4 KB. */
export function isPlaceholder(format: BinaryFormat, size: number): boolean {
  if (format === 'unknown') return true
  return format !== 'shebang' && size < PLACEHOLDER_MAX_BYTES
}

async function readHead(file: string): Promise<Uint8Array> {
  const handle = await open(file, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function statFile(p: string): Promise<Stats | null> {
  try {
    const s = await stat(p)
    return s.isFile() ? s : null
  } catch {
    return null
  }
}

/** WindowsApps app-execution aliases are reparse points that stat() refuses (EACCES) but lstat() sees. */
const isAppAlias = (p: string): boolean => {
  if (process.platform !== 'win32' || !isWindowsAppsPath(p)) return false
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

const isFileSync = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return isAppAlias(p)
  }
}

function pathExtensions(env: EnvInput): string[] {
  const raw = (getEnv(env, 'PATHEXT', 'win32') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => ['.exe', '.com', '.cmd', '.bat'].includes(e))
  const natives = raw.filter((e) => e === '.exe' || e === '.com')
  const scripts = raw.filter((e) => e === '.cmd' || e === '.bat')
  const order = [...natives.sort((a, b) => (a === '.exe' ? -1 : b === '.exe' ? 1 : 0)), ...scripts]
  return order.length > 0 ? order : ['.exe', '.cmd']
}

/** Every PATH hit for `bin`, in search order (win32: .exe/.com before .cmd/.bat per directory). */
export function findOnPath(
  bin: string,
  entries: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: EnvInput = process.env,
  isFile: (p: string) => boolean = isFileSync,
): string[] {
  const p = pathMod(platform)
  const out: string[] = []
  const exts = platform === 'win32' ? pathExtensions(env) : ['']
  const hasExt = platform === 'win32' && /\.(exe|com|cmd|bat)$/i.test(bin)
  for (const dir of entries) {
    if (!p.isAbsolute(dir)) continue
    for (const ext of hasExt ? [''] : exts) {
      const candidate = p.join(dir, bin + ext)
      if (isFile(candidate)) out.push(candidate)
    }
  }
  return out
}

const nodeVersionCache = new Map<string, string | null>()

async function nodeVersion(node: string, run: RunFn, env: Record<string, string>): Promise<string | null> {
  const hit = nodeVersionCache.get(node)
  if (hit !== undefined) return hit
  const r = await run(node, ['--version'], { env, timeoutMs: VALIDATE_TIMEOUT_MS, cwd: homedir() })
  const v = /v?(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null
  nodeVersionCache.set(node, v)
  return v
}

/**
 * The Node.js that runs JS-entry CLIs: the first spawnable `node` on PATH. On win32 only `.exe`/`.com` count: a
 * `node.cmd` shim (mise, some version managers) cannot be spawned without a shell. Plain Node (the CLI, tests)
 * falls back to its own execPath; Electron's execPath never is system node.
 */
export function findSystemNode(
  ctx: Pick<CliSpecContext, 'pathEntries' | 'platform' | 'env'>,
  o: { electron?: boolean; isFile?: (p: string) => boolean } = {},
): { node: string } | { reject: string } | null {
  const hits = findOnPath('node', ctx.pathEntries, ctx.platform, ctx.env, o.isFile)
  const spawnable = ctx.platform === 'win32' ? hits.filter((p) => /\.(exe|com)$/i.test(p)) : hits
  if (spawnable[0] !== undefined) return { node: spawnable[0] }
  if (!(o.electron ?? process.versions['electron'] !== undefined)) return { node: process.execPath }
  if (hits[0] !== undefined)
    return {
      reject: `Node.js is only on PATH as a shim (${hits[0]}), which Harpoon cannot run without a shell; install Node.js or put node.exe on PATH`,
    }
  return null
}

/** A ~/.npmrc larger than this is not read (a user's npm settings are a few lines). */
export const NPMRC_MAX_BYTES = 64 * 1024

/**
 * The `prefix` an .npmrc sets (`~` expanded), or undefined. No credential reads: an .npmrc
 * usually holds registry tokens (`//registry…/:_authToken=…`, `_auth`, `_password`), so only a line that sets `prefix`
 * is ever looked at; every other line is dropped unread, and nothing of the file is kept but the prefix.
 */
export function npmrcPrefix(text: string, home: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*prefix\s*=/.test(line)) continue
    const value = /^\s*prefix\s*=\s*(.+?)\s*$/.exec(line)?.[1]
    return value?.replace(/^~(?=[\\/])/, home)
  }
  return undefined
}

async function npmPrefixes(ctx: CliSpecContext): Promise<string[]> {
  const out: string[] = []
  const add = (p: string | undefined | null): void => {
    if (p !== undefined && p !== null && p.trim() !== '') out.push(p.trim())
  }
  add(getEnv(ctx.env, 'npm_config_prefix', ctx.platform))
  add(getEnv(ctx.env, 'NPM_CONFIG_PREFIX', ctx.platform))
  try {
    const rcPath = pathMod(ctx.platform).join(ctx.home, '.npmrc')
    const st = await stat(rcPath)
    if (st.isFile() && st.size <= NPMRC_MAX_BYTES) add(npmrcPrefix(await readFile(rcPath, 'utf8'), ctx.home))
  } catch {
    // no ~/.npmrc
  }
  if (ctx.platform === 'win32') {
    if (ctx.appData !== null) add(win32.join(ctx.appData, 'npm'))
    add(getEnv(ctx.env, 'PNPM_HOME', 'win32'))
  } else {
    const node = findOnPath('node', ctx.pathEntries, ctx.platform, ctx.env)[0]
    if (node !== undefined) add(posix.dirname(posix.dirname(node)))
    add('/usr/local')
    add(ctx.env['PNPM_HOME'])
  }
  return out
}

function npmPrefixBins(prefix: string, bin: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return [win32.join(prefix, `${bin}.cmd`), win32.join(prefix, `${bin}.exe`)]
  return [posix.join(prefix, 'bin', bin), posix.join(prefix, bin)]
}

// ---- classification ---------------------------------------------------------------------------------------

interface Launch {
  command: string
  prefixArgs: string[]
  kind: CliKind
  target: string
  pathPrepend: string[]
  warnings: string[]
}

type Examined = { ok: true; launch: Launch } | { ok: false; reason: RejectReason; detail: string }

const reject = (reason: RejectReason, detail: string): Examined => ({ ok: false, reason, detail })

interface ExamineCtx {
  spec: CliSpec
  ctx: CliSpecContext
  run: RunFn
  validationEnv: Record<string, string>
}

async function checkNative(file: string, platform: NodeJS.Platform): Promise<Examined | null> {
  if (platform === 'win32' && isAppAlias(file)) return null // only the version check can judge an alias
  const s = await statFile(file)
  if (s === null) return reject('not-found', `${file} does not exist`)
  const { format } = sniffFormat(await readHead(file))
  const native = format === 'pe' || format === 'elf' || format === 'macho'
  if (!native || isPlaceholder(format, s.size)) {
    return reject(
      'placeholder',
      `${file} is not a runnable ${platform === 'win32' ? 'Windows executable' : 'binary'} (${s.size} bytes; ` +
        'an npm install whose postinstall did not run leaves a stub, so reinstall the CLI)',
    )
  }
  return null
}

async function jsEntryLaunch(entry: string, localNode: string | null, ec: ExamineCtx): Promise<Examined> {
  const { spec, ctx } = ec
  const mapped = spec.fromJsEntry?.(entry) ?? null
  if (mapped !== null) {
    const bad = await checkNative(mapped.exe, ctx.platform)
    if (bad !== null) return bad
    return {
      ok: true,
      launch: {
        command: mapped.exe,
        prefixArgs: [],
        kind: 'native',
        target: mapped.exe,
        pathPrepend: mapped.pathPrepend ?? [],
        warnings: [],
      },
    }
  }
  if ((await statFile(entry)) === null) return reject('not-found', `JS entry ${entry} does not exist`)
  const found = localNode !== null ? { node: localNode } : findSystemNode(ctx)
  if (found === null) return reject('node-missing', `${spec.bin} needs Node.js, which was not found on PATH`)
  if ('reject' in found) return reject('node-missing', `${spec.bin} needs Node.js. ${found.reject}`)
  const node = found.node
  if (spec.minNode !== undefined) {
    const v = await nodeVersion(node, ec.run, ec.validationEnv)
    if (v === null || compareVersions(v, spec.minNode) < 0) {
      return reject(
        'node-too-old',
        `${spec.bin} needs Node.js ≥ ${spec.minNode}; ${node} is ${v ?? 'unknown'}`,
      )
    }
  }
  return {
    ok: true,
    launch: {
      command: node,
      prefixArgs: [entry],
      kind: 'node-entry',
      target: entry,
      pathPrepend: [],
      warnings: [],
    },
  }
}

async function examineWin32(file: string, ec: ExamineCtx, depth = 0): Promise<Examined> {
  const ext = win32.extname(file).toLowerCase()
  if (ext === '.exe' || ext === '.com') {
    const bad = await checkNative(file, 'win32')
    if (bad !== null) return bad
    return {
      ok: true,
      launch: { command: file, prefixArgs: [], kind: 'native', target: file, pathPrepend: [], warnings: [] },
    }
  }
  if (ext === '.cmd' || ext === '.bat') {
    const shim = await parseShim(file, isFileSync)
    switch (shim.kind) {
      case 'exe':
        if (ec.spec.rejectWindowsApps === true && isWindowsAppsPath(shim.path)) {
          return reject('windows-apps', `${file} forwards to ${shim.path} (WindowsApps)`)
        }
        return examineWin32(shim.path, ec, depth)
      case 'js':
        return jsEntryLaunch(shim.entry, shim.localNode, ec)
      case 'cmd':
        if (depth >= 3) return reject('unsupported-shim', `${file}: shim chain too deep`)
        return examineWin32(shim.path, ec, depth + 1)
      case 'command': {
        const command = win32.isAbsolute(shim.command)
          ? shim.command
          : findOnPath(shim.command, ec.ctx.pathEntries, 'win32', ec.ctx.env).find((p) =>
              /\.(exe|com)$/i.test(p),
            )
        if (command === undefined)
          return reject('unsupported-shim', `${file} runs ${shim.command}, not found on PATH`)
        return {
          ok: true,
          launch: {
            command,
            prefixArgs: shim.args,
            kind: 'native',
            target: file,
            pathPrepend: [],
            warnings: [],
          },
        }
      }
      case 'unknown':
        return reject('unsupported-shim', `${file}: ${shim.reason}`)
    }
  }
  if (/\.(?:c|m)?js$/i.test(ext)) return jsEntryLaunch(file, null, ec)
  return reject('not-executable', `${file} is not an .exe or .cmd`)
}

async function examinePosix(file: string, ec: ExamineCtx): Promise<Examined> {
  let real = file
  try {
    real = await realpath(file)
  } catch {
    // keep the given path
  }
  const s = await statFile(real)
  if (s === null) return reject('not-found', `${file} does not exist`)
  const { format, shebang } = sniffFormat(await readHead(real))
  if (format === 'shebang') {
    if (/(?:^|[\s/])node(?:\s|$)/.test(shebang ?? '')) return jsEntryLaunch(real, null, ec)
    try {
      await access(real, constants.X_OK)
    } catch {
      return reject('not-executable', `${file} is not executable`)
    }
    return {
      ok: true,
      launch: {
        command: file,
        prefixArgs: [],
        kind: 'posix-script',
        target: real,
        pathPrepend: [],
        warnings: [],
      },
    }
  }
  if (/\.(?:c|m)?js$/i.test(real)) return jsEntryLaunch(real, null, ec)
  const bad = await checkNative(real, ec.ctx.platform)
  if (bad !== null) return bad
  try {
    await access(real, constants.X_OK)
  } catch {
    return reject('not-executable', `${file} is not executable`)
  }
  return {
    ok: true,
    launch: { command: file, prefixArgs: [], kind: 'native', target: real, pathPrepend: [], warnings: [] },
  }
}

// ---- resolve ----------------------------------------------------------------------------------------------

function contextFor(opts: ResolveCliOptions): { ctx: CliSpecContext; env: EnvInput } {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const pathEntries = splitPathList(opts.pathEnv ?? getEnv(env, 'PATH', platform), platform)
  const win = platform === 'win32'
  return {
    env,
    ctx: {
      platform,
      home,
      env,
      appData: win ? (getEnv(env, 'APPDATA', platform) ?? win32.join(home, 'AppData', 'Roaming')) : null,
      localAppData: win
        ? (getEnv(env, 'LOCALAPPDATA', platform) ?? win32.join(home, 'AppData', 'Local'))
        : null,
      pathEntries,
    },
  }
}

const defaultRun: RunFn = (command, args, opts) =>
  execCapture(command, args, { env: opts.env, timeoutMs: opts.timeoutMs, cwd: opts.cwd })

const firstLine = (s: string): string => (s.trim().split(/\r?\n/)[0] ?? '').slice(0, 200)

export async function resolveCli(spec: CliSpec, opts: ResolveCliOptions = {}): Promise<ResolveResult> {
  const { ctx, env } = contextFor(opts)
  const p = pathMod(ctx.platform)
  const run = opts.run ?? defaultRun
  const timeoutMs = opts.timeoutMs ?? VALIDATE_TIMEOUT_MS
  const retryDelayMs = opts.retryDelayMs ?? 500
  const cwd = opts.cwd ?? ctx.home
  const baseEnvOpts = {
    purpose: 'vendor' as const,
    vendor: spec.vendor,
    platform: ctx.platform,
    path: ctx.pathEntries.join(ctx.platform === 'win32' ? ';' : ':'),
  }
  const validationEnv = sanitizeEnv(
    env,
    opts.vendorEnv === undefined ? baseEnvOpts : { ...baseEnvOpts, vendorEnv: opts.vendorEnv },
  )

  const seen = new Set<string>()
  const ordered: { path: string; source: CliSource }[] = []
  const push = (path: string, source: CliSource): void => {
    const abs = p.resolve(path)
    const key = ctx.platform === 'win32' ? abs.toLowerCase() : abs
    if (seen.has(key)) return
    seen.add(key)
    ordered.push({ path: abs, source })
  }
  const configured = opts.configuredPath?.trim()
  if (configured !== undefined && configured !== '') push(configured, 'config')
  if (opts.candidates !== 'configured') {
    for (const w of await spec.wellKnown(ctx)) push(w, 'well-known')
    for (const hit of findOnPath(spec.bin, ctx.pathEntries, ctx.platform, env)) push(hit, 'path')
    for (const prefix of opts.npmPrefixes ?? (await npmPrefixes(ctx))) {
      for (const bin of npmPrefixBins(prefix, spec.bin, ctx.platform)) push(bin, 'npm-prefix')
    }
    for (const b of (await spec.desktopBundle?.(ctx)) ?? []) push(b, 'desktop-bundle')
  }

  const rejected: CandidateRejection[] = []
  const candidates: string[] = []
  const ec: ExamineCtx = { spec, ctx, run, validationEnv }

  for (const cand of ordered) {
    const exists = isFileSync(cand.path)
    if (!exists) {
      if (cand.source === 'config') {
        rejected.push({ ...cand, reason: 'not-found', detail: `configured path ${cand.path} is not a file` })
      }
      continue
    }
    candidates.push(cand.path)
    const fail = (reason: RejectReason, detail: string): void => {
      rejected.push({ ...cand, reason, detail })
    }
    if (spec.rejectWindowsApps === true && isWindowsAppsPath(cand.path)) {
      fail('windows-apps', `${cand.path} is under WindowsApps (Claude Desktop's alias, not the CLI)`)
      continue
    }
    let examined: Examined
    try {
      examined =
        ctx.platform === 'win32' ? await examineWin32(cand.path, ec) : await examinePosix(cand.path, ec)
    } catch (err) {
      examined = reject('not-executable', `${cand.path}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!examined.ok) {
      fail(examined.reason, examined.detail)
      continue
    }
    const launch = examined.launch
    const childEnv =
      launch.pathPrepend.length === 0
        ? validationEnv
        : sanitizeEnv(validationEnv, {
            ...baseEnvOpts,
            pathPrepend: launch.pathPrepend,
            launchedFromClaude: false,
          })
    let r: CaptureResult | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      r = await run(launch.command, [...launch.prefixArgs, ...spec.versionArgs], {
        env: childEnv,
        timeoutMs,
        cwd,
      })
      const code = r.error?.code
      if (attempt === 0 && (code === 'ENOENT' || code === 'EBUSY')) {
        await delay(retryDelayMs)
        continue
      }
      break
    }
    if (r === undefined) continue
    if (r.error !== undefined) {
      fail('spawn-failed', `${launch.command}: ${r.error.code} ${r.error.message}`)
      continue
    }
    if (r.timedOut) {
      fail('timeout', `${launch.command} ${spec.versionArgs.join(' ')} did not finish in ${timeoutMs} ms`)
      continue
    }
    const parsed = spec.parseVersion(r.stdout, r.stderr)
    if (parsed === null) {
      fail(
        'version-unrecognized',
        `${cand.path} answered "${firstLine(r.stdout) || firstLine(r.stderr)}" (exit ${r.code ?? r.signal}); not ${spec.vendor}`,
      )
      continue
    }
    const warnings = [...launch.warnings]
    if (cand.source === 'desktop-bundle') {
      warnings.push(spec.desktopBundleWarning ?? 'bundled with a desktop app; it may change without notice')
    }
    const st = await statFile(launch.target)
    return {
      ok: true,
      rejected,
      candidates,
      cli: {
        vendor: spec.vendor,
        command: launch.command,
        prefixArgs: launch.prefixArgs,
        kind: launch.kind,
        version: parsed.version,
        source: cand.source,
        pathPrepend: launch.pathPrepend,
        warnings,
        path: cand.path,
        target: launch.target,
        mtimeMs: st?.mtimeMs ?? 0,
        size: st?.size ?? 0,
      },
    }
  }
  return { ok: false, rejected, candidates }
}

/** The serializable shape in ProbeResult (src/shared/vendors.ts). */
export function toResolvedBinary(cli: ResolvedCli): ResolvedBinary {
  return {
    path: cli.path,
    command: cli.command,
    argvPrefix: [...cli.prefixArgs],
    kind: cli.kind === 'posix-script' ? 'shebang' : cli.kind,
    source: cli.source === 'well-known' ? 'known' : cli.source,
    version: cli.version,
    mtimeMs: cli.mtimeMs,
    size: cli.size,
    pathPrepend: [...cli.pathPrepend],
    warnings: [...cli.warnings],
  }
}
