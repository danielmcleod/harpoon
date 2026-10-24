// Which of the user's own tools a message seems to need ("create a Linear issue", "open a PR"), for a one-click
// suggestion; and which ones are on for every conversation (Settings → AI → Tools).
import type { ToolUse, UserTool } from '@shared/ipc.ts'

/** Words that name a kind of tool, and how to recognise such a tool by its name. */
const HINTS: { says: RegExp; tool: RegExp }[] = [
  { says: /\blinear\b/i, tool: /linear/i },
  { says: /\b(jira|atlassian|confluence)\b/i, tool: /atlassian|jira|confluence/i },
  { says: /\b(github|pull requests?|gh issue)\b|\bPRs?\b/, tool: /github/i },
  { says: /\b(gitlab|merge requests?)\b/i, tool: /gitlab/i },
  { says: /\bnotion\b/i, tool: /notion/i },
  { says: /\bslack\b/i, tool: /slack/i },
  { says: /\basana\b/i, tool: /asana/i },
  { says: /\bsentry\b/i, tool: /sentry/i },
  { says: /\b(azure devops|work items?)\b/i, tool: /azure|devops/i },
]

/** Issue trackers (for "create an issue", and the Track work runs). */
export const TRACKER = /linear|jira|atlassian|github|gitlab|asana|azure|devops|shortcut|clickup|youtrack/i
const ASKS_FOR_ISSUES = /\b(issues?|tickets?|stor(y|ies)|epics?|backlog|tasks? in)\b/i

const useOf = (prefs: Readonly<Record<string, ToolUse>>, name: string): ToolUse => prefs[name] ?? 'suggest'

/** Tools the message points at, among those that may be suggested (not off, not already always on). */
export function suggestTools(text: string, tools: readonly UserTool[], prefs: Readonly<Record<string, ToolUse>>): UserTool[] {
  const usable = tools.filter((t) => t.ok && useOf(prefs, t.name) === 'suggest')
  const words = text.toLowerCase()
  const named = usable.filter((t) => {
    const id = `${t.name} ${t.label}`
    // The tool's own name in the message ("ask sentry…"), or a word that names its kind.
    const own = t.name.replace(/^claude\.ai /i, '').toLowerCase()
    return (own.length >= 3 && new RegExp(`\\b${own.replace(/[^a-z0-9]+/g, '\\W?')}\\b`).test(words)) || HINTS.some((h) => h.says.test(text) && h.tool.test(id))
  })
  if (named.length > 0) return named
  // "Create issues for these": any tracker they have (and Codex's connected apps), unless the message names one.
  if (ASKS_FOR_ISSUES.test(text) && !HINTS.some((h) => h.says.test(text))) return usable.filter((t) => TRACKER.test(`${t.name} ${t.label}`) || t.kind === 'apps')
  return []
}

/** Tools on for every conversation with this CLI. */
export function alwaysOn(tools: readonly UserTool[] | undefined, prefs: Readonly<Record<string, ToolUse>>): string[] {
  return (tools ?? []).filter((t) => useOf(prefs, t.name) === 'always').map((t) => t.name)
}
