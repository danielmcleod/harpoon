// Codex loads every MCP server in the user's ~/.codex/config.toml, and its app-server has no switch to skip that
// file. Harpoon's design passes should see only Harpoon's tools, so the user's servers are named here and switched
// off for the pass (`mcp_servers.<name>.enabled = false`), leaving the file itself untouched.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * MCP server names in a Codex config.toml, in the shapes TOML allows: `[mcp_servers.<name>]` (and its sub-tables),
 * with bare, "double" or 'single' quoted names and trailing comments; a `[mcp_servers]` table whose keys are servers
 * (`<name> = { … }`, `<name>.command = …`); and dotted keys at the top level (`mcp_servers.<name>.command = …`).
 * Missing one would leave that server running in a Harpoon pass.
 */
export function codexMcpServerNames(toml: string): string[] {
  const names = new Set<string>()
  const key = String.raw`(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))`
  const header = new RegExp(String.raw`^\s*\[\s*mcp_servers\s*\.\s*${key}`)
  const tableKey = new RegExp(String.raw`^\s*${key}\s*[.=]`)
  const dotted = new RegExp(String.raw`^\s*mcp_servers\s*\.\s*${key}\s*[.=]`)
  let table: 'root' | 'servers' | 'other' = 'root'
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/^\s*#.*$/, '')
    const pick = (m: RegExpExecArray | null): void => {
      const n = m?.[1] ?? m?.[2] ?? m?.[3]
      if (n !== undefined) names.add(n)
    }
    if (/^\s*\[/.test(line)) {
      const h = header.exec(line)
      pick(h)
      table = h !== null ? 'other' : /^\s*\[\s*mcp_servers\s*\]/.test(line) ? 'servers' : 'other'
      continue
    }
    if (table === 'servers') pick(tableKey.exec(line))
    else if (table === 'root') pick(dotted.exec(line))
  }
  return [...names]
}

export function userCodexMcpServers(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const home = env['CODEX_HOME']?.trim() || join(homedir(), '.codex')
  try {
    return codexMcpServerNames(readFileSync(join(home, 'config.toml'), 'utf8'))
  } catch {
    return []
  }
}
