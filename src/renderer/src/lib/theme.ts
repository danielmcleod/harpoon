// Theme application (main owns nativeTheme; the preload passes initialTheme, applied before createRoot so the first
// paint matches the window's backgroundColor). Pure DOM.
import type { ThemeState } from '@shared/ipc.ts'

/** main's ThemeState from the preload, or dark when the preload has none (tests). */
export function readInitialTheme(): ThemeState {
  const api = (window as unknown as { harpoon?: { initialTheme?: ThemeState } }).harpoon
  return api?.initialTheme ?? { theme: 'dark', resolved: 'dark' }
}

/** `.dark` + color-scheme on <html>; tokens.css does the rest. */
export function applyTheme(t: ThemeState, root: HTMLElement = document.documentElement): void {
  root.classList.toggle('dark', t.resolved === 'dark')
  root.style.colorScheme = t.resolved
}
