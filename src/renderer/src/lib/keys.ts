// Global keyboard shortcuts with scoping. One window keydown listener dispatches to the
// newest matching registration. Combos are lower-case `mod+shift+d` strings where `mod` is ⌘ on macOS and Ctrl
// elsewhere. Single keys (A, ⇧A, D, J, K, R, S, ?) need a `scope`: they fire only while focus is inside an element
// with a matching `data-key-scope`, and never while typing in an input (a symbol such as `?` may be global). A scope
// stops at a menu, a listbox, a dialog or the toasts (SCOPE_BARRIER): their typeahead and buttons keep their keys, so
// a letter typed in an open menu never also fires a scope set on an element around it (the Diff tab's on <body>).
// Modifier combos fire anywhere, inputs included , unless
// `allowInInputs` is false. A held key's auto-repeat fires nothing unless the registration opts in with `repeat`.
import { useEffect, useRef } from 'react'

/** The app's key table. Use these names rather than literal combos so the keyboard sheet and hints agree. */
export const KEYS = {
  /** The command palette: reserved, so nothing else can take it by accident. */
  palette: 'mod+k',
  undo: 'mod+z',
  redo: 'mod+shift+z',
  redoAlt: 'mod+y',
  save: 'mod+s',
  open: 'mod+o',
  find: 'mod+f',
  ai: 'mod+i',
  toggleMode: 'mod+e',
  focusNode: 'mod+enter',
  up: 'backspace',
  del: 'delete',
  fit: 'f',
  keyboardSheet: '?',
} as const

const RESERVED = new Set<string>([KEYS.palette])

export interface ShortcutOptions {
  /** Required for single-key shortcuts: the `data-key-scope` value of the region that opts in. */
  scope?: string
  /** Modifier combos default to true; single keys are always ignored in editable fields. */
  allowInInputs?: boolean
  /** For the keyboard sheet. */
  description?: string
  /** Required to register a reserved combo (⌘/Ctrl+K). */
  reserved?: boolean
  /** Also fire on a held key's auto-repeat (for stepping through a list). Off by default. */
  repeat?: boolean
}

type Handler = (e: KeyboardEvent) => void

interface Registration {
  id: number
  combo: ParsedCombo
  text: string
  handler: Handler
  scope: string | undefined
  allowInInputs: boolean
  description: string | undefined
  repeat: boolean
}

export interface ShortcutInfo {
  combo: string
  scope?: string
  description?: string
}

interface ParsedCombo {
  key: string
  mod: boolean
  shift: boolean
  alt: boolean
}

let isMac: boolean | null = null
let nextId = 1
const registry: Registration[] = []
let listening = false

/** ⌘ on macOS, Ctrl elsewhere (the preload's platform first, then the user agent). */
export function platformIsMac(): boolean {
  if (isMac === null) {
    const p = (window as unknown as { harpoon?: { platform?: unknown } }).harpoon?.platform
    isMac = p !== undefined ? p === 'darwin' : /Mac|iPhone|iPad/.test(navigator.userAgent)
  }
  return isMac
}

/** Tests: force the platform. */
export function setMacForTests(mac: boolean | null): void {
  isMac = mac
}

export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split('+')
  // `mod++` style is not supported; a trailing empty part means the key itself is "+".
  const key = parts.at(-1) === '' ? '+' : (parts.at(-1) ?? '')
  const mods = new Set(parts.slice(0, -1))
  return { key, mod: mods.has('mod'), shift: mods.has('shift'), alt: mods.has('alt') }
}

const isLetter = (k: string): boolean => /^[a-z]$/.test(k)
const isDigit = (k: string): boolean => /^[0-9]$/.test(k)

function eventKey(e: KeyboardEvent): string {
  const k = e.key.toLowerCase()
  // With a modifier some layouts report another character for digits; the physical key is what users mean.
  if (/^Digit[0-9]$/.test(e.code) && !isDigit(k)) return e.code.slice(5)
  return k
}

export function matches(c: ParsedCombo, e: KeyboardEvent): boolean {
  const mac = platformIsMac()
  const mod = mac ? e.metaKey : e.ctrlKey
  const otherMod = mac ? e.ctrlKey : e.metaKey
  if (c.mod !== mod || otherMod || c.alt !== e.altKey) return false
  const key = eventKey(e)
  if (key !== c.key) return false
  // Shift is part of a letter/digit/named-key combo; for symbols (`?`, `.`) the character already encodes it.
  if (isLetter(c.key) || isDigit(c.key) || c.key.length > 1) return c.shift === e.shiftKey
  return true
}

export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = (t as HTMLInputElement).type
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type)
}

/**
 * Where a scope stops: focus inside one of these is never in a scope set outside it. Menus and listboxes (Radix
 * typeahead uses letters and does not prevent them), dialogs (the palette, the keyboard sheet) and anything marked
 * `data-key-scope-stop` (the toasts).
 */
export const SCOPE_BARRIER =
  '[role="menu"],[role="menubar"],[role="listbox"],[role="dialog"],[role="alertdialog"],[data-radix-popper-content-wrapper],[data-key-scope-stop]'

function inScope(scope: string, target: EventTarget | null): boolean {
  let el: Element | null = target instanceof Element ? target : document.activeElement
  for (; el !== null; el = el.parentElement) {
    const s = el.getAttribute('data-key-scope')
    if (s !== null && s.split(/\s+/).includes(scope)) return true
    if (el.matches(SCOPE_BARRIER)) return false
  }
  return false
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing) return
  const editable = isEditableTarget(e.target)
  // Newest first; a scoped registration beats a global one for the same combo.
  const candidates = registry.filter((r) => matches(r.combo, e))
  if (candidates.length === 0) return
  const pick =
    candidates.findLast(
      (r) => r.scope !== undefined && inScope(r.scope, e.target) && (!editable || r.allowInInputs),
    ) ?? candidates.findLast((r) => r.scope === undefined && (!editable || r.allowInInputs))
  if (pick === undefined) return
  e.preventDefault()
  // An auto-repeat is not a new decision: a held A would otherwise answer every ask that comes to the front.
  if (e.repeat && !pick.repeat) return
  pick.handler(e)
}

function ensureListening(): void {
  if (listening) return
  window.addEventListener('keydown', onKeyDown)
  listening = true
}

/** Register a shortcut; returns the unregister function. */
export function registerShortcut(combo: string, handler: Handler, opts: ShortcutOptions = {}): () => void {
  const parsed = parseCombo(combo)
  const single = !parsed.mod && !parsed.alt
  if (single && (isLetter(parsed.key) || isDigit(parsed.key)) && opts.scope === undefined) {
    throw new Error(`Single-key shortcut "${combo}" needs a scope (a focused region must opt in).`)
  }
  const text = combo.toLowerCase()
  if (RESERVED.has(text) && opts.reserved !== true) {
    throw new Error(`"${combo}" is reserved (command palette); pass reserved: true to bind it.`)
  }
  const reg: Registration = {
    id: nextId++,
    combo: parsed,
    text,
    handler,
    scope: opts.scope,
    allowInInputs: single ? false : (opts.allowInInputs ?? true),
    description: opts.description,
    repeat: opts.repeat === true,
  }
  registry.push(reg)
  ensureListening()
  return () => {
    const i = registry.findIndex((r) => r.id === reg.id)
    if (i !== -1) registry.splice(i, 1)
  }
}

/** What is registered right now (the keyboard sheet). */
export function registeredShortcuts(): ShortcutInfo[] {
  return registry.map((r) => ({
    combo: r.text,
    ...(r.scope !== undefined ? { scope: r.scope } : {}),
    ...(r.description !== undefined ? { description: r.description } : {}),
  }))
}

/** Register while mounted. The latest `handler` is always called; `enabled` false unregisters. */
export function useShortcut(
  combo: string,
  handler: Handler,
  opts: ShortcutOptions & { enabled?: boolean } = {},
): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  const { scope, allowInInputs, description, reserved, repeat, enabled = true } = opts
  useEffect(() => {
    if (!enabled) return
    return registerShortcut(combo, (e) => ref.current(e), {
      ...(scope !== undefined ? { scope } : {}),
      ...(allowInInputs !== undefined ? { allowInInputs } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(reserved !== undefined ? { reserved } : {}),
      ...(repeat !== undefined ? { repeat } : {}),
    })
  }, [combo, scope, allowInInputs, description, reserved, repeat, enabled])
}

const KEY_NAMES: Readonly<Record<string, { mac: string; other: string; aria: string }>> = {
  enter: { mac: '↵', other: 'Enter', aria: 'Enter' },
  escape: { mac: 'Esc', other: 'Esc', aria: 'Escape' },
  '.': { mac: '.', other: '.', aria: 'Period' },
  arrowup: { mac: '↑', other: '↑', aria: 'ArrowUp' },
  arrowdown: { mac: '↓', other: '↓', aria: 'ArrowDown' },
}

/** Display text for a combo: `⌘↵` / `Ctrl+Enter`, `⇧A`, `⌘⇧D` / `Ctrl+Shift+D`. */
export function formatCombo(combo: string): string {
  const c = parseCombo(combo)
  const mac = platformIsMac()
  const name = KEY_NAMES[c.key]
  const key = name !== undefined ? (mac ? name.mac : name.other) : c.key.toUpperCase()
  if (mac) return `${c.mod ? '⌘' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${key}`
  const parts = [c.mod ? 'Ctrl' : '', c.alt ? 'Alt' : '', c.shift ? 'Shift' : '', key].filter((p) => p !== '')
  // A lone ⇧ on a single letter reads better as the symbol everywhere (`⇧A`).
  if (!c.mod && !c.alt && c.shift) return `⇧${key}`
  return parts.join('+')
}

/** `aria-keyshortcuts` value: `Meta+Enter` / `Control+Enter`, `Shift+A`. */
export function ariaKeyShortcuts(combo: string): string {
  const c = parseCombo(combo)
  const name = KEY_NAMES[c.key]
  const key = name !== undefined ? name.aria : c.key.length === 1 ? c.key.toUpperCase() : c.key
  return [
    c.mod ? (platformIsMac() ? 'Meta' : 'Control') : '',
    c.alt ? 'Alt' : '',
    c.shift ? 'Shift' : '',
    key,
  ]
    .filter((p) => p !== '')
    .join('+')
}

/** Tests: drop every registration. */
export function resetShortcuts(): void {
  registry.length = 0
}
