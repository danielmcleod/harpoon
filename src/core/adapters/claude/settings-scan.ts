// Readiness `claude-allow-rules`: shell allow-rules in the user, project or local Claude
// settings still run under `dontAsk`, so a read-only pass could execute repo scripts. When any rule is not
// clearly read-only, read-only passes disallow Bash and PowerShell.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ShellAllowRule {
  file: string
  rule: string
}

/** Command prefixes with no argument that writes files or runs other programs: safe with any arguments. */
const READ_ONLY_ANY_ARGS: readonly string[][] = [
  ['git', 'status'],
  ['git', 'blame'],
  ['git', 'ls-files'],
  ['git', 'rev-parse'],
  ['ls'],
  ['dir'],
  ['cat'],
  ['type'],
  ['head'],
  ['tail'],
  ['wc'],
  ['pwd'],
  ['echo'],
  ['which'],
  ['where'],
  ['grep'],
  ['get-childitem'],
  ['get-content'],
  ['get-location'],
  ['select-string'],
  ['test-path'],
  ['resolve-path'],
  ['measure-object'],
]

/**
 * Commands that read by default but have flags that write files or run programs (`rg --pre ./x.sh`,
 * `git diff --output=f`, `tree -o f`). Only an exact rule (no wildcard) whose arguments avoid those flags counts.
 */
const READ_ONLY_EXACT_ONLY: readonly { prefix: string[]; unsafe: RegExp }[] = [
  { prefix: ['rg'], unsafe: /^--pre(?:-glob)?(?:=|$)/ },
  // Words are lowercased: `-R` (rerun into files with -o) reads as `-r`; short-flag groups like `-ao` count.
  { prefix: ['tree'], unsafe: /^-[a-z]*[or][a-z]*$|^--output/ },
  { prefix: ['git', 'diff'], unsafe: /^--(?:output|ext-diff)(?:=|$)/ },
  { prefix: ['git', 'log'], unsafe: /^--(?:output|ext-diff)(?:=|$)/ },
  { prefix: ['git', 'show'], unsafe: /^--(?:output|ext-diff)(?:=|$)/ },
]

const CONTROL = /[;&|<>`\n\r]|\$\(/

const startsWith = (words: readonly string[], prefix: readonly string[]): boolean =>
  prefix.every((w, i) => words[i] === w)

/** True when a `Bash(...)`/`PowerShell(...)` rule can only run read-only commands. */
export function isReadOnlyShellRule(rule: string): boolean {
  const m = /^(Bash|PowerShell)(?:\((.*)\))?$/s.exec(rule.trim())
  if (m === null) return true // not a shell rule
  const content = m[2]
  if (content === undefined || content.trim() === '' || content.trim() === '*') return false
  if (CONTROL.test(content)) return false
  const body = content.replace(/(?::\*| \*)$/, '')
  const wildcard = body !== content
  if (body.includes('*')) return false
  const words = body.trim().toLowerCase().split(/\s+/)
  if (READ_ONLY_ANY_ARGS.some((p) => startsWith(words, p))) return true
  const exact = READ_ONLY_EXACT_ONLY.find((c) => startsWith(words, c.prefix))
  if (exact === undefined || wildcard) return false
  return !words.slice(exact.prefix.length).some((w) => exact.unsafe.test(w))
}

/** `permissions.allow` of one Claude settings file (none when it is absent or not JSON). Grok reads them too. */
export function allowRulesIn(file: string): string[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  try {
    const v: unknown = JSON.parse(text)
    const allow = (v as { permissions?: { allow?: unknown } } | null)?.permissions?.allow
    return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === 'string') : []
  } catch {
    return []
  }
}

export function claudeSettingsFiles(cwd: string, configDir: string): string[] {
  return [
    join(configDir, 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ]
}

/** Shell allow-rules that are not read-only, from the user, project and local settings (sync, < 1 ms). */
export function scanShellAllowRules(cwd: string, configDir: string): ShellAllowRule[] {
  const out: ShellAllowRule[] = []
  for (const file of claudeSettingsFiles(cwd, configDir)) {
    for (const rule of allowRulesIn(file)) {
      if (/^(Bash|PowerShell)\b/.test(rule.trim()) && !isReadOnlyShellRule(rule)) out.push({ file, rule })
    }
  }
  return out
}
