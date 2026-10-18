// HARPOON_HOME resolution and every path under it. App-level state only; project data lives in each project's
// `.harpoon/` folder (core/project).
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { storageError } from './errors.ts'

export const HOME_ENV = 'HARPOON_HOME'
export const DEFAULT_HOME_DIRNAME = '.harpoon'
/** POSIX mode for directories Harpoon creates under home. */
export const HOME_DIR_MODE = 0o700

export interface ResolveHomeOptions {
  env?: Readonly<Record<string, string | undefined>>
  userHome?: string
  cwd?: string
}

/** `HARPOON_HOME` (`~` expanded, made absolute), else `<user home>/.harpoon`. */
export function resolveHome(opts: ResolveHomeOptions = {}): string {
  const env = opts.env ?? process.env
  const userHome = opts.userHome ?? homedir()
  const raw = env[HOME_ENV]?.trim()
  if (raw === undefined || raw === '') return join(userHome, DEFAULT_HOME_DIRNAME)
  let p = raw
  if (p === '~') p = userHome
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = join(userHome, p.slice(2))
  return isAbsolute(p) ? resolve(p) : resolve(opts.cwd ?? process.cwd(), p)
}

export interface HomePaths {
  home: string
  state: string
  logsDir: string
  mainLog: string
  /** Per-AI-run scratch folders (MCP config files, structured-output schemas). */
  runsDir: string
  tmpDir: string
  /** Electron userData under home, so everything Harpoon writes stays in one place. */
  electronUserData: string
}

export function homePaths(home: string): HomePaths {
  const h = resolve(home)
  return {
    home: h,
    state: join(h, 'state.json'),
    logsDir: join(h, 'logs'),
    mainLog: join(h, 'logs', 'main.log'),
    runsDir: join(h, 'runs'),
    tmpDir: join(h, 'tmp'),
    electronUserData: join(h, 'electron-user-data'),
  }
}

/** mkdir -p with 0o700 on POSIX (Windows ignores the mode). */
export async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: HOME_DIR_MODE })
  } catch (err) {
    throw storageError(`cannot create ${dir}`, err)
  }
}

export async function ensureHome(paths: HomePaths): Promise<void> {
  for (const dir of [paths.home, paths.logsDir, paths.runsDir, paths.tmpDir]) await ensureDir(dir)
}
