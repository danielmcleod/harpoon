// Per-OS install / login / update / pin commands (the commands table). These strings feed
// `shell_copy` recovery actions (copied, never executed) and the official-installer allowlist that the heal
// shell denylist exempts from its pipe-to-shell rule.
import type { ShellKind } from '../../shared/failure.ts'

export type OsFamily = 'win32' | 'darwin' | 'linux'

export const COMMAND_KINDS = ['install', 'login', 'update', 'pin', 'sandboxSetup', 'unsetApiKey'] as const
export type CommandKind = (typeof COMMAND_KINDS)[number]

export interface ShellCommand {
  command: string
  shell: ShellKind
  elevated?: boolean
  /** Extra UI copy, e.g. "run once and sign in". */
  note?: string
}

export function osFamily(platform: string = process.platform): OsFamily {
  return platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'
}

export const shellFor = (os: OsFamily): ShellKind => (os === 'win32' ? 'powershell' : 'sh')

const NPM_PACKAGES: Readonly<Record<string, string>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
}

/** The vendors' own npm packages (the only ones a heal's `npm install -g` may name). */
export const VENDOR_NPM_PACKAGES: readonly string[] = Object.values(NPM_PACKAGES)

type PerOs = { win32: string; posix: string }

const CLAUDE_INSTALL: PerOs = {
  win32: 'irm https://claude.ai/install.ps1 | iex',
  posix: 'curl -fsSL https://claude.ai/install.sh | bash',
}
const CODEX_INSTALL: PerOs = {
  win32: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
  posix: 'npm install -g @openai/codex@latest',
}
const GEMINI_INSTALL = 'npm install -g @google/gemini-cli@latest'
/**
 * Muse's official installer (dev.meta.ai/docs/muse-code, fetched 2026-10-11), which is also its update. Copied for
 * the user only: it is not in the official-installer list, so it stays outside the heal shell denylist's exemption.
 */
const MUSE_INSTALL: PerOs = {
  win32: 'irm https://dev.meta.ai/install.ps1 | iex',
  posix: 'curl -fsSL https://dev.meta.ai/install.sh | sh',
}
/**
 * Grok Build's official installer (xai-org/grok-build user guide 01, fetched 2026-10-11). Copied for the
 * user only, like Muse's: it is not in the official-installer list, so it stays outside the heal denylist's exemption.
 */
const GROK_INSTALL: PerOs = {
  win32: 'irm https://x.ai/cli/install.ps1 | iex',
  posix: 'curl -fsSL https://x.ai/cli/install.sh | bash',
}

const TABLE: Readonly<Record<string, Partial<Record<CommandKind, PerOs | string>>>> = {
  claude: {
    install: CLAUDE_INSTALL,
    login: 'claude auth login',
    update: 'claude update',
    unsetApiKey: {
      win32:
        "[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'User'); Remove-Item Env:ANTHROPIC_API_KEY",
      posix: 'unset ANTHROPIC_API_KEY',
    },
  },
  codex: {
    install: CODEX_INSTALL,
    login: 'codex login',
    // Codex has no self-update command; reinstalling the latest release is the update.
    update: CODEX_INSTALL,
  },
  gemini: {
    install: GEMINI_INSTALL,
    login: 'gemini',
    update: GEMINI_INSTALL,
  },
  // `grok login` (user guide 02: a browser sign-in; XAI_API_KEY also works) and `grok update` (user
  // guide 01; a WinGet install prints its own upgrade command instead).
  grok: {
    install: GROK_INSTALL,
    login: 'grok login',
    update: 'grok update',
  },
  // Run `muse` once and sign in (dev.meta.ai/docs/muse-code/auth); META_API_KEY also works.
  muse: {
    install: MUSE_INSTALL,
    login: 'muse',
    update: MUSE_INSTALL,
  },
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * The command for `kind` on `os`, or null when the vendor has none. `pin` needs `version` (the adapter's
 * `testedUpTo`). Commands are copied to the clipboard, never executed.
 */
export function commandFor(
  kind: CommandKind,
  vendor: string,
  os: OsFamily,
  version?: string,
): ShellCommand | null {
  const shell = shellFor(os)
  if (kind === 'pin') {
    const pkg = NPM_PACKAGES[vendor]
    if (!pkg || !version || !SEMVER.test(version)) return null
    return { command: `npm install -g ${pkg}@${version}`, shell }
  }
  if (kind === 'sandboxSetup') {
    if (vendor !== 'codex' || os !== 'win32') return null
    return { command: 'codex sandbox setup --elevated --current-user', shell, elevated: true }
  }
  const entry = TABLE[vendor]?.[kind]
  if (entry === undefined) return null
  const command = typeof entry === 'string' ? entry : os === 'win32' ? entry.win32 : entry.posix
  const out: ShellCommand = { command, shell }
  if ((vendor === 'gemini' || vendor === 'muse') && kind === 'login') out.note = 'Run it once and sign in.'
  if (kind === 'unsetApiKey')
    out.note = 'Also remove the variable from your shell profile, then restart Harpoon.'
  return out
}

/** The git install row; Linux has no single command, so the apt form is shown with a note. */
export function gitInstallCommand(os: OsFamily): ShellCommand {
  if (os === 'win32') return { command: 'winget install --id Git.Git -e', shell: 'powershell' }
  if (os === 'darwin') return { command: 'xcode-select --install', shell: 'sh' }
  return {
    command: 'sudo apt-get install git',
    shell: 'sh',
    note: "Or use your distribution's package manager.",
  }
}

export const GIT_COMMAND_KINDS = [
  'safeDirectory',
  'abort',
  'worktreePrune',
  'longPaths',
  'lfsInstall',
  'ollamaServe',
  // Run branch (branch prep, end of run): what the user runs when Harpoon may not act itself.
  'checkoutBranch',
  'checkoutDetach',
  'deleteBranch',
] as const
export type GitCommandKind = (typeof GIT_COMMAND_KINDS)[number]

const GIT_OPS = ['merge', 'rebase', 'cherry-pick', 'revert', 'am', 'bisect'] as const

/**
 * A branch name (or `refs/heads/<name>`) as one shell word, or null when it is not a plausible branch name. Names
 * made only of `[A-Za-z0-9._/-]` stay bare; anything else is single-quoted (POSIX `'\''`, PowerShell `''`).
 */
function branchWord(arg: string | undefined, os: OsFamily): string | null {
  if (arg === undefined) return null
  const name = arg.startsWith('refs/heads/') ? arg.slice('refs/heads/'.length) : arg
  // git's own rules forbid these anywhere in a ref name; a leading '-' would read as an option.
  const control = [...name].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  if (name === '' || name.startsWith('-') || control || /[\s~^:?*[\\]/.test(name)) return null
  if (/^[A-Za-z0-9._/-]+$/.test(name)) return name
  return os === 'win32' ? `'${name.replace(/'/g, "''")}'` : `'${name.replace(/'/g, "'\\''")}'`
}

/** Repair commands for git_state, worktree_failed and local_server. `arg`: path, git op, branch or sha. */
export function repairCommand(kind: GitCommandKind, os: OsFamily, arg?: string): ShellCommand | null {
  const shell = shellFor(os)
  switch (kind) {
    case 'checkoutBranch': {
      const word = branchWord(arg, os)
      return word === null ? null : { command: `git checkout ${word}`, shell }
    }
    case 'checkoutDetach':
      if (arg === undefined || !/^[0-9a-f]{7,64}$/.test(arg)) return null
      return { command: `git checkout --detach ${arg}`, shell }
    case 'deleteBranch': {
      const word = branchWord(arg, os)
      return word === null ? null : { command: `git branch -d ${word}`, shell }
    }
    case 'safeDirectory': {
      if (!arg || /["\r\n]/.test(arg)) return null
      return { command: `git config --global --add safe.directory "${arg.replace(/\\/g, '/')}"`, shell }
    }
    case 'abort':
      if (!arg || !(GIT_OPS as readonly string[]).includes(arg)) return null
      return { command: arg === 'bisect' ? 'git bisect reset' : `git ${arg} --abort`, shell }
    case 'worktreePrune':
      return { command: 'git worktree prune', shell }
    case 'longPaths':
      return { command: 'git config --global core.longpaths true', shell }
    case 'lfsInstall':
      return { command: 'git lfs install', shell }
    case 'ollamaServe':
      return { command: 'ollama serve', shell }
  }
}

// ---- official installers (heal shell denylist exemption) ----------------------------------------------------

/** The only pipe-to-shell commands the heal denylist lets through (exact strings, whitespace-normalized). */
export const OFFICIAL_INSTALLERS: readonly string[] = [
  CLAUDE_INSTALL.win32,
  CLAUDE_INSTALL.posix,
  CODEX_INSTALL.win32,
  CODEX_INSTALL.posix,
  GEMINI_INSTALL,
  'winget install --id Git.Git -e',
  'xcode-select --install',
]

const PINNED_INSTALL = new RegExp(
  `^npm install -g (?:${Object.values(NPM_PACKAGES)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
    .join('|')})@(?:latest|\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)$`,
)

const squash = (s: string): string => s.trim().replace(/\s+/g, ' ')

/** Exact match against {@link OFFICIAL_INSTALLERS} or a pinned/latest npm install of a known vendor package. */
export function isOfficialInstaller(command: string): boolean {
  const c = squash(command)
  return OFFICIAL_INSTALLERS.some((i) => squash(i) === c) || PINNED_INSTALL.test(c)
}

// ---- docs (open_docs: https + host allowlist) --------------------------------------------------------------

export const DOCS_HOSTS: readonly string[] = [
  'code.claude.com',
  'github.com',
  'developers.openai.com',
  'dev.meta.ai',
]

const DOCS: Readonly<Record<string, string>> = {
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://github.com/openai/codex',
  gemini: 'https://github.com/google-gemini/gemini-cli',
  grok: 'https://github.com/xai-org/grok-build',
  muse: 'https://dev.meta.ai/docs/muse-code',
}

/** Install/troubleshooting docs for a vendor, or null. */
export function docsUrlFor(vendor: string): string | null {
  return DOCS[vendor] ?? null
}

export function isAllowedDocsUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && DOCS_HOSTS.includes(u.hostname.toLowerCase())
  } catch {
    return false
  }
}
