// Issue links (planned work tracked outside Harpoon): which tracker a link belongs to.
import type { IssueLink } from './schema.ts'

/** The tracker an issue URL belongs to. */
export function trackerOf(url: string): IssueLink['tracker'] {
  const host = /^https:\/\/([^/]+)/i.exec(url)?.[1]?.toLowerCase() ?? ''
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github'
  if (host === 'linear.app') return 'linear'
  if (host.endsWith('.atlassian.net') || host.includes('jira')) return 'jira'
  if (host === 'gitlab.com' || host.includes('gitlab')) return 'gitlab'
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) return 'azure'
  return 'other'
}

/** The key a tracker shows for an issue URL (`#42`, `LIN-123`, `PAY-7`), or the URL's last part. */
export function keyOf(url: string): string {
  const path = url.replace(/[?#].*$/, '').replace(/\/+$/, '')
  const key = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(path)?.[1]
  if (key !== undefined) return key
  const num = /\/(?:issues|pull|merge_requests|_workitems\/edit)\/(\d+)$/.exec(path)?.[1]
  if (num !== undefined) return `#${num}`
  return path.split('/').at(-1) ?? url
}
