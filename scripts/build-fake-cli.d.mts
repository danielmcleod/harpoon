// Declarations for scripts/build-fake-cli.mjs (imported by tests/setup/global.ts and the integration tests).

export type FakeVendor = 'claude' | 'codex' | 'gemini' | 'grok' | 'muse'

/** `[command, ...args]`, ready for `spawn(command, args, { shell: false })`. */
export type FakeCliCommand = [command: string, ...args: string[]]

export interface FakeCliLaunchers {
  /** Always present: `[process.execPath, entry]`. */
  node: Record<FakeVendor, FakeCliCommand>
  /** win32 only: npm cmd-shim-format `.cmd` files (need cmd.exe or the shim resolver; never spawn without one). */
  cmd?: Record<FakeVendor, string>
  /** POSIX only: `#!/usr/bin/env node` executable copies of the entry (chmod 755). */
  sh?: Record<FakeVendor, string>
}

export interface FakeCliBuild {
  /** Output directory, `tests/.bin/<platform>/` by default. */
  dir: string
  /** Absolute path of the fake CLI entry (`<dir>/node_modules/harpoon-fake-cli/fake-cli.mjs`). */
  entry: string
  /** Build hash (fake-cli.mjs + build script + node version); unchanged hash means nothing was rewritten. */
  hash: string
  launchers: FakeCliLaunchers
}

export interface BuildFakeCliOptions {
  outDir?: string | undefined
}

export declare const FAKE_VENDORS: readonly FakeVendor[]

export declare function buildFakeCli(options?: BuildFakeCliOptions): Promise<FakeCliBuild>
