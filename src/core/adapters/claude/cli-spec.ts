// How to find and validate the Claude Code CLI (CLI resolution, and the Claude probe).
import { readdirSync, statSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import type { CliSpec, CliSpecContext } from '../../proc/resolve-cli.ts'
import { compareVersions } from '../../proc/resolve-cli.ts'
import { CLAUDE_VENDOR } from './capabilities.ts'

const VERSION_LINE = /^\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+\(Claude Code\)\s*$/m

/** `2.1.289 (Claude Code)`; Claude Desktop's Claude.exe also answers --version, so the product name is required. */
export function parseClaudeVersion(stdout: string): { version: string } | null {
  const m = VERSION_LINE.exec(stdout)
  return m?.[1] === undefined ? null : { version: m[1] }
}

export function claudeWellKnown(ctx: Pick<CliSpecContext, 'platform' | 'home'>): string[] {
  return ctx.platform === 'win32'
    ? [win32.join(ctx.home, '.local', 'bin', 'claude.exe')]
    : [posix.join(ctx.home, '.local', 'bin', 'claude')]
}

const listDirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** `%APPDATA%\Claude\claude-code\<version>\<build>\claude.exe`, newest version first (win32 only). */
export function claudeDesktopBundle(ctx: Pick<CliSpecContext, 'platform' | 'appData'>): string[] {
  if (ctx.platform !== 'win32' || ctx.appData === null) return []
  const root = join(ctx.appData, 'Claude', 'claude-code')
  const versions = listDirs(root)
    .filter((v) => /^\d+\.\d+\.\d+/.test(v))
    .sort((a, b) => compareVersions(b, a))
  const out: string[] = []
  for (const v of versions) {
    const dir = join(root, v)
    const direct = join(dir, 'claude.exe')
    if (isFile(direct)) out.push(direct)
    for (const build of listDirs(dir)) {
      const exe = join(dir, build, 'claude.exe')
      if (isFile(exe)) out.push(exe)
    }
  }
  return out
}

export const claudeCliSpec: CliSpec = {
  vendor: CLAUDE_VENDOR,
  bin: 'claude',
  wellKnown: claudeWellKnown,
  versionArgs: ['--version'],
  parseVersion: (stdout) => parseClaudeVersion(stdout),
  rejectWindowsApps: true,
  minNode: '20.0.0',
  desktopBundle: claudeDesktopBundle,
  desktopBundleWarning:
    'This copy is bundled with Claude Desktop and may change without notice; install Claude Code to pin it.',
}
