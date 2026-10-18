// Theme source: main owns nativeTheme.themeSource, the preload passes the initial theme and the window's
// backgroundColor matches it. `theme` is pushed when the setting or the OS appearance changes. Electron-free:
// nativeTheme is injected.
import type { ResolvedTheme, Theme, ThemeState } from '@shared/ipc.ts'
import { WINDOW_BACKGROUND } from './constants.ts'

export function themeStateOf(theme: Theme, dark: boolean): ThemeState {
  return { theme, resolved: dark ? 'dark' : 'light' }
}

export function backgroundFor(resolved: ResolvedTheme): string {
  return WINDOW_BACKGROUND[resolved]
}

/** The part of Electron's nativeTheme the controller uses. */
export interface NativeThemeLike {
  themeSource: Theme
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
}

export class ThemeController {
  readonly #native: NativeThemeLike
  readonly #onChange: (s: ThemeState) => void
  #theme: Theme
  #lastKey: string

  constructor(o: { native: NativeThemeLike; initial: Theme; onChange: (s: ThemeState) => void }) {
    this.#native = o.native
    this.#onChange = o.onChange
    this.#theme = o.initial
    o.native.themeSource = this.#theme
    this.#lastKey = key(this.state)
    o.native.on('updated', () => this.#changed())
  }

  get state(): ThemeState {
    return themeStateOf(this.#theme, this.#native.shouldUseDarkColors)
  }

  set(theme: Theme): ThemeState {
    if (theme !== this.#theme) {
      this.#theme = theme
      this.#native.themeSource = theme
    }
    this.#changed()
    return this.state
  }

  #changed(): void {
    const s = this.state
    const k = key(s)
    if (k === this.#lastKey) return
    this.#lastKey = k
    this.#onChange(s)
  }
}

const key = (s: ThemeState): string => `${s.theme}|${s.resolved}`
