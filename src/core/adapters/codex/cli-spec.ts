// How to find and validate the Codex CLI (CLI resolution: "`.cmd` → parse the shim. Codex maps to its
// native `@openai/codex-<plat>-<arch>/vendor/<triple>/bin/codex.exe`, with `codex-path` prepended to PATH").
import { statSync } from 'node:fs'
import { dirname, join, posix, win32 } from 'node:path'
import type { CliSpec, CliSpecContext } from '../../proc/resolve-cli.ts'
import { CODEX_VENDOR } from './capabilities.ts'

const VERSION_LINE = /^\s*codex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/m

/** `codex-cli 0.160.1` (the Desktop alpha prints `codex-cli 0.147.0-alpha.6.5`). */
export function parseCodexVersion(stdout: string): { version: string } | null {
  const m = VERSION_LINE.exec(stdout)
  return m?.[1] === undefined ? null : { version: m[1] }
}

/** The standalone installer's location (install.ps1 → %LOCALAPPDATA%\Programs\OpenAI\Codex\bin). */
export function codexWellKnown(ctx: Pick<CliSpecContext, 'platform' | 'home' | 'localAppData'>): string[] {
  if (ctx.platform === 'win32') {
    return ctx.localAppData !== null
      ? [win32.join(ctx.localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')]
      : []
  }
  return [posix.join(ctx.home, '.local', 'bin', 'codex')]
}

/** Codex Desktop's private copy (`~/.codex/.sandbox-bin`), tried last: an alpha that changes without notice. */
export function codexDesktopBundle(ctx: Pick<CliSpecContext, 'platform' | 'home'>): string[] {
  return ctx.platform === 'win32' ? [win32.join(ctx.home, '.codex', '.sandbox-bin', 'codex.exe')] : []
}

/** Rust target triples of the npm platform packages (@openai/codex-<plat>-<arch>). */
export const CODEX_TRIPLES: Readonly<Record<string, string>> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const LAUNCHER = /[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/i

/**
 * The npm launcher `@openai/codex/bin/codex.js` → the platform package's native binary, as the official SDK's
 * resolveNativePackage finds it: `vendor/<triple>/bin/codex[.exe]` with `vendor/<triple>/codex-path` on PATH (legacy
 * layout `vendor/<triple>/codex/codex[.exe]` with `vendor/<triple>/path`), in the package's own node_modules or
 * hoisted beside it. Any other JS entry (a fake CLI in tests) is not Codex's launcher: null, so it runs as
 * `node <entry>`. A launcher whose platform package is missing maps to the expected path, so the resolver reports
 * that file as missing (npm skipped the optional dependency) instead of running the launcher's own error.
 */
export function codexFromJsEntry(
  entry: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { exe: string; pathPrepend?: string[] } | null {
  if (!LAUNCHER.test(entry)) return null
  const key = `${platform}-${arch}`
  const triple = CODEX_TRIPLES[key]
  if (triple === undefined) return null
  const p = platform === 'win32' ? win32 : posix
  const exeName = platform === 'win32' ? 'codex.exe' : 'codex'
  const pkgRoot = dirname(dirname(entry)) // …/node_modules/@openai/codex
  const scopeDir = dirname(pkgRoot) // …/node_modules/@openai
  const platformPkg = `codex-${key}`
  const vendorDirs = [
    p.join(pkgRoot, 'node_modules', '@openai', platformPkg, 'vendor'),
    p.join(scopeDir, platformPkg, 'vendor'),
    p.join(pkgRoot, 'vendor'),
  ]
  for (const vendor of vendorDirs) {
    const tripleDir = p.join(vendor, triple)
    const current = p.join(tripleDir, 'bin', exeName)
    if (isFile(current)) {
      const extra = p.join(tripleDir, 'codex-path')
      return { exe: current, ...(isDir(extra) ? { pathPrepend: [extra] } : {}) }
    }
    const legacy = p.join(tripleDir, 'codex', exeName)
    if (isFile(legacy)) {
      const extra = p.join(tripleDir, 'path')
      return { exe: legacy, ...(isDir(extra) ? { pathPrepend: [extra] } : {}) }
    }
  }
  return { exe: p.join(vendorDirs[0] ?? join(pkgRoot, 'vendor'), triple, 'bin', exeName) }
}

export const codexCliSpec: CliSpec = {
  vendor: CODEX_VENDOR,
  bin: 'codex',
  wellKnown: codexWellKnown,
  versionArgs: ['--version'],
  parseVersion: (stdout) => parseCodexVersion(stdout),
  fromJsEntry: (entry) => codexFromJsEntry(entry),
  minNode: '20.0.0',
  desktopBundle: codexDesktopBundle,
  desktopBundleWarning:
    'This copy is bundled with Codex Desktop (an alpha that changes without notice); install the standalone Codex ' +
    'CLI to pin it.',
}
