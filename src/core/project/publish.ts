// Where the project is published (`.harpoon/publish.json`, shared with the team): the Notion page, the Notion MCP
// server the AI uses to write it, the page ids of what was written (so the next publish updates in place), and a
// changelog of publishes.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { HarpoonError } from '../errors.ts'
import { writeJsonAtomic } from '../store/atomic.ts'
import type { PublishSettings } from '../../shared/ipc.ts'
import { codexMcpServerNames } from '../ai/codex-isolation.ts'
import { HARPOON_DIRNAME } from './files.ts'

const PublishZ = z.object({
  notion: z
    .object({
      pageUrl: z.string().max(2000).default(''),
      server: z.string().max(200).nullable().default(null),
      includeNotes: z.boolean().default(false),
      pages: z.record(z.string(), z.string().max(200)).default({}),
      log: z.array(z.object({ at: z.string(), summary: z.string().max(4000), by: z.enum(['ai', 'import', 'api']) })).max(200).default([]),
    })
    .default({ pageUrl: '', server: null, includeNotes: false, pages: {}, log: [] }),
})

const fileOf = (root: string): string => join(root, HARPOON_DIRNAME, 'publish.json')

export async function getPublish(root: string): Promise<PublishSettings> {
  try {
    return PublishZ.parse(JSON.parse(await readFile(fileOf(root), 'utf8')))
  } catch {
    return PublishZ.parse({})
  }
}

export async function setPublish(root: string, s: PublishSettings): Promise<PublishSettings> {
  const v = PublishZ.parse(s)
  await writeJsonAtomic(fileOf(root), v, { mode: 0o644 })
  return v
}

export async function logPublish(root: string, by: 'ai' | 'import' | 'api', summary: string, pages?: Record<string, string>): Promise<void> {
  const s = await getPublish(root)
  s.notion.log = [{ at: new Date().toISOString(), summary, by }, ...s.notion.log].slice(0, 200)
  if (pages !== undefined) s.notion.pages = { ...s.notion.pages, ...pages }
  await setPublish(root, s)
}

/**
 * MCP servers that look like Notion, from the CLIs' configs: Claude's user and project servers (~/.claude.json) and
 * Codex's (~/.codex/config.toml). claude.ai connectors are not in a file; "claude.ai Notion" is offered as a guess.
 */
export async function notionServers(env: Readonly<Record<string, string | undefined>> = process.env): Promise<{ claude: string[]; codex: string[] }> {
  const notion = (xs: Iterable<string>): string[] => [...new Set([...xs].filter((x) => /notion/i.test(x)))]
  const claude: string[] = []
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8')) as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> }
    claude.push(...Object.keys(cfg.mcpServers ?? {}))
    for (const p of Object.values(cfg.projects ?? {})) claude.push(...Object.keys(p.mcpServers ?? {}))
  } catch {
    // no Claude config
  }
  let codex: string[] = []
  try {
    const home = env['CODEX_HOME']?.trim() || join(homedir(), '.codex')
    codex = codexMcpServerNames(await readFile(join(home, 'config.toml'), 'utf8'))
  } catch {
    // no Codex config
  }
  return { claude: [...notion(claude), 'claude.ai Notion'], codex: notion(codex) }
}

/** A Notion server name this machine may publish through: it names Notion and the CLI configs know it. */
export async function checkNotionServer(server: string): Promise<void> {
  if (!/notion/i.test(server)) throw new HarpoonError('VALIDATION', `"${server}" does not look like a Notion MCP server; publishing only uses Notion.`)
  const known = await notionServers()
  if (![...known.claude, ...known.codex].includes(server)) throw new HarpoonError('VALIDATION', `Your CLI has no MCP server called "${server}" (Project settings → Notion).`)
}

/** A user-scope Claude MCP server's config (to copy into a run's own MCP config), or null when it has none. */
export async function claudeUserServer(server: string): Promise<Record<string, unknown> | null> {
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> }
    return cfg.mcpServers?.[server] ?? null
  } catch {
    return null
  }
}

/** Claude's tool prefix for a server: `mcp__<name with anything but letters, digits, _ and - as _>__`. */
export const claudeToolPrefix = (server: string): string => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__`

/** The 32-hex page id at the end of a Notion page URL (or the id itself), dashed. */
export function notionPageId(urlOrId: string): string | null {
  const m = /([0-9a-f]{32})(?:[?#].*)?$/i.exec(urlOrId.replace(/-/g, ''))
  const hex = m?.[1]
  if (hex === undefined) return null
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase()
}
