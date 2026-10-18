// Main-process constants (platform integration): app identity, window values and the https host allowlist for
// links that open externally.
import type { ResolvedTheme } from '@shared/ipc.ts'

/** Windows AUMID = electron-builder appId (the app's identity). */
export const APP_ID = 'com.harpoon.desktop'

/** BrowserWindow backgroundColor = the renderer's `--background` token, so the first paint never flashes. */
export const WINDOW_BACKGROUND: Readonly<Record<ResolvedTheme, string>> = {
  light: '#f6f7fb',
  dark: '#0b1020',
}
export const WINDOW_SIZE = { width: 1440, height: 900, minWidth: 1024, minHeight: 640 } as const
export const WINDOW_TITLE = 'Harpoon'

/** Close and quit: core.shutdown gets this long, then the process exits regardless. */
export const QUIT_BUDGET_MS = 5_000

/** https hosts links may open in the default browser. */
export { EXTERNAL_HOSTS } from '@shared/external-links.ts'
