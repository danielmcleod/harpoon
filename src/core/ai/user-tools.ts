// The user's own MCP tools a conversation may be given (Linear, GitHub, Jira…): Claude's user-scope servers and its
// claude.ai connectors, Codex's servers and the apps connected to its account. Harpoon's AI passes see none of them
// unless the user picks some for a conversation; then those (and only those) are let through.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UserTool, UserTools } from '../../shared/ipc.ts'
import { claudeCliSpec } from '../adapters/claude/cli-spec.ts'
import { isClaudeAiConnector } from '../adapters/claude/launch.ts'
import { CODEX_APPS } from '../adapters/codex/launch.ts'
import { resolveCli } from '../proc/resolve-cli.ts'
import { execCapture } from '../proc/spawn.ts'
import { codexMcpServerNames } from './codex-isolation.ts'

/** `claude mcp list` checks every server's health, which takes a while: reuse its answer for a few minutes. */
const CACHE_MS = 3 * 60_000
let cached: { at: number; value: UserTools } | null = null

/** `claude.ai Linear: https://mcp.linear.app/mcp - ✔ Connected` → the connectors and whether they are connected. */
export function parseClaudeMcpList(text: string): { name: string; ok: boolean }[] {
  const out: { name: string; ok: boolean }[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^(claude\.ai [^:]+):\s.*\s-\s(.+)$/.exec(line.trim())
    if (m?.[1] === undefined) continue
    out.push({ name: m[1].trim(), ok: /✔|connected/i.test(m[2] ?? '') && !/✗|failed|needs/i.test(m[2] ?? '') })
  }
  return out
}

async function claudeTools(): Promise<UserTool[]> {
  const tools: UserTool[] = []
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8')) as { mcpServers?: Record<string, unknown> }
    for (const name of Object.keys(cfg.mcpServers ?? {})) tools.push({ name, label: name, kind: 'server', ok: true })
  } catch {
    // no Claude config
  }
  const r = await resolveCli(claudeCliSpec)
  if (r.ok) {
    const res = await execCapture(r.cli.command, [...r.cli.prefixArgs, 'mcp', 'list'], { timeoutMs: 45_000 })
    for (const c of parseClaudeMcpList(`${res.stdout}\n${res.stderr}`)) if (!tools.some((t) => t.name === c.name)) tools.push({ name: c.name, label: c.name.replace(/^claude\.ai /, ''), kind: 'connector', ok: c.ok })
  }
  return tools
}

async function codexTools(env: Readonly<Record<string, string | undefined>>): Promise<UserTool[]> {
  const tools: UserTool[] = []
  try {
    const home = env['CODEX_HOME']?.trim() || join(homedir(), '.codex')
    for (const name of codexMcpServerNames(await readFile(join(home, 'config.toml'), 'utf8'))) tools.push({ name, label: name, kind: 'server', ok: true })
  } catch {
    // no Codex config
  }
  tools.push({ name: CODEX_APPS, label: 'Apps connected to your account (Linear, GitHub…)', kind: 'apps', ok: true })
  return tools
}

export async function listUserTools(force = false, env: Readonly<Record<string, string | undefined>> = process.env): Promise<UserTools> {
  if (!force && cached !== null && Date.now() - cached.at < CACHE_MS) return cached.value
  const [claude, codex] = await Promise.all([claudeTools().catch(() => []), codexTools(env).catch(() => [])])
  const value = { claude, codex }
  cached = { at: Date.now(), value }
  return value
}

/** Only names the CLI really has, and in a form safe to pass on (connectors carry spaces). */
export async function checkUserTools(vendor: 'claude' | 'codex', names: readonly string[]): Promise<string[]> {
  if (names.length === 0) return []
  const known = (await listUserTools())[vendor]
  const bad = names.filter((n) => !known.some((t) => t.name === n))
  if (bad.length > 0) throw new Error(`${vendor === 'claude' ? 'Claude Code' : 'Codex'} has no tool called ${bad.map((b) => `"${b}"`).join(', ')}. Check again in the AI panel's Tools.`)
  return names.filter((n) => vendor === 'codex' || isClaudeAiConnector(n) || /^[A-Za-z0-9_-]+$/.test(n))
}
