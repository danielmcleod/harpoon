import { expect, it } from 'vitest'
import { codexMcpServerNames } from '../../src/core/ai/codex-isolation.ts'

it('finds the user Codex MCP servers, not their sub-tables', () => {
  const toml = '[mcp_servers.node_repl]\ncommand = "x"\n[mcp_servers.node_repl.env]\nA = "1"\n[mcp_servers."my server"]\nurl = "y"\n[profiles.fast]\n'
  expect(codexMcpServerNames(toml)).toEqual(['node_repl', 'my server'])
})

it('finds servers in the other TOML shapes too (comments, quotes, tables, dotted keys)', () => {
  const toml = [
    'mcp_servers.top.command = "a"',
    "[mcp_servers.'single'] # quoted with a comment",
    'url = "x"',
    '[mcp_servers]',
    'inline = { command = "b" }',
    'dotted.command = "c"',
    '[profiles.fast]',
    'model = "m"',
  ].join('\n')
  expect(codexMcpServerNames(toml).sort()).toEqual(['dotted', 'inline', 'single', 'top'])
})
