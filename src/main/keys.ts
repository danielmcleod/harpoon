// Window shortcuts main handles itself (close and quit; the UI control standards):
// Ctrl+Q quits on Windows/Linux (no menu bar there; macOS uses the app menu's Cmd+Q), F12 toggles DevTools in
// unpackaged builds, and Ctrl/Cmd with = or + (zoom in), - (zoom out) and 0 (back to 100%) zoom the page, as in a
// browser (there is no menu bar on Windows and Linux to carry those keys). Pure.
import type { Input } from 'electron'

export type ZoomAction = 'zoomIn' | 'zoomOut' | 'zoomReset'
export type KeyAction = 'quit' | 'devtools' | ZoomAction | null

export function keyAction(
  input: Pick<Input, 'type' | 'key' | 'control' | 'meta' | 'alt' | 'shift'>,
  o: { platform: NodeJS.Platform; packaged: boolean },
): KeyAction {
  if (input.type !== 'keyDown') return null
  const key = input.key.toLowerCase()
  const bare = !input.control && !input.alt && !input.shift && !input.meta
  if (o.platform !== 'darwin' && input.control && !input.alt && !input.shift && !input.meta && key === 'q') {
    return 'quit'
  }
  if (!o.packaged && key === 'f12' && bare) return 'devtools'
  // The command modifier alone (Shift allowed: "+" is Shift+= on a US keyboard); the numpad's + - 0 give the same keys.
  const command = o.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
  if (command && !input.alt) {
    if (key === '=' || key === '+') return 'zoomIn'
    if (key === '-' || key === '_') return 'zoomOut'
    if (key === '0') return 'zoomReset'
  }
  return null
}

/**
 * The zoom steps (Chromium's own presets from 50% to 200%, the range WCAG 1.4.4 asks text to resize through): Ctrl/Cmd
 * with + and - move to the next one, Ctrl/Cmd+0 goes back to 100%.
 */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const

/** Steps within this of each other are the same (a factor read back from Chromium is not exact). */
const SAME_STEP = 0.001

/** The zoom factor after a zoom key (or a Ctrl+wheel notch) at `current`. */
export function nextZoomFactor(current: number, action: ZoomAction): number {
  if (action === 'zoomReset') return 1
  if (action === 'zoomIn') return ZOOM_STEPS.find((s) => s > current + SAME_STEP) ?? ZOOM_STEPS.at(-1) ?? 1
  return ZOOM_STEPS.findLast((s) => s < current - SAME_STEP) ?? ZOOM_STEPS[0]
}
