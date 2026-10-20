// Setting outside agents up to use Harpoon's tools: the workflow every MCP client is told (server instructions), and
// a Codex plugin (the CLI, the desktop app and the IDE extension share ~/.codex) in a local marketplace under
// HARPOON_HOME, which runs the `Harpoon --mcp` stdio bridge and carries a skill describing the workflow.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { codexCliSpec } from '../adapters/codex/cli-spec.ts'
import { resolveCli } from '../proc/resolve-cli.ts'
import { execCapture } from '../proc/spawn.ts'

/** Sent as the MCP server's instructions, so any client learns the workflow. */
export const MCP_INSTRUCTIONS = `Harpoon holds a software architecture diagram (services, data stores, queues, outside services and the connectors between them) for the project open in the Harpoon app.
- Start with get_overview; use get_node and search for details, get_vocabulary for allowed values.
- Every change goes into a draft that the user reviews in Harpoon; nothing changes until they accept it.
- Connectors point from the side that starts a request to the side that answers it. Network hops (load balancers, gateways, VPN) are nodes with connectors in and out.
- Record how things are deployed (resilience) and the main journeys as flows when you know them.
- Before finishing, call check_traffic and validate_draft and fix what you introduced, then call submit_proposal once with a short title and rationale.`

export const CODEX_MARKETPLACE = 'harpoon'
export const CODEX_PLUGIN = 'harpoon'

export interface BridgeCommand {
  command: string
  args: string[]
}

const SKILL = `---
name: harpoon
description: Read and change the architecture diagram open in the Harpoon app (services, connectors, flows, resilience) through its MCP tools; changes arrive in Harpoon as a proposal to review. Use when the user asks about their architecture, wants it documented from the code, or wants a change planned in Harpoon.
---

# Working with Harpoon

Harpoon is a desktop app that maps a system as a diagram of hexagonal nodes joined by directional connectors. The
\`harpoon\` MCP server works on the project open in the app (the app must be running, with Settings → AI → Outside
agents turned on).

## Workflow

1. Call \`get_overview\` first. Use \`get_node\`, \`search\` and \`get_vocabulary\` for details and allowed values.
2. Stage changes with the draft tools (\`add_node\`, \`update_node\`, \`add_connector\`, \`upsert_feature\`,
   \`upsert_flow\`, …). Nothing changes in the diagram until the user accepts the proposal in Harpoon.
3. Ground what you add in the code: attach evidence (file and lines) and a confidence.
4. Connectors point from the caller to the one answering; network hops (load balancers, API gateways, VPN, Direct
   Connect) are nodes with connectors in and out. Record deployment (\`resilience\`) and main journeys (flows).
5. Call \`check_traffic\` and \`validate_draft\`, fix what you introduced, then \`submit_proposal\` once with a short
   title and rationale. Tell the user to review it in Harpoon's AI panel.
`

/** Write the local marketplace with the Harpoon plugin. Returns its folder. */
export async function writeCodexMarketplace(home: string, bridge: BridgeCommand): Promise<string> {
  const root = join(home, 'codex-marketplace')
  const plugin = join(root, 'plugins', CODEX_PLUGIN)
  const files: Record<string, unknown> = {
    [join(root, '.agents', 'plugins', 'marketplace.json')]: {
      name: CODEX_MARKETPLACE,
      interface: { displayName: 'Harpoon (this computer)' },
      plugins: [{ name: CODEX_PLUGIN, source: { source: 'local', path: `./plugins/${CODEX_PLUGIN}` }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }],
    },
    [join(plugin, '.codex-plugin', 'plugin.json')]: {
      name: CODEX_PLUGIN,
      version: '0.1.0',
      description: 'Read and change the architecture diagram open in Harpoon; changes arrive as a proposal to review.',
      author: { name: 'Harpoon' },
      license: 'MIT',
      keywords: ['architecture', 'diagram', 'mcp'],
      skills: './skills/',
      mcpServers: './.mcp.json',
      interface: {
        displayName: 'Harpoon',
        shortDescription: 'Work on the architecture diagram open in Harpoon',
        longDescription: 'Use Harpoon to read the architecture of the project open in the Harpoon app, document it from the code, and plan changes that arrive in Harpoon as a proposal to review.',
        developerName: 'Harpoon',
        category: 'Developer Tools',
        capabilities: ['Read', 'Write'],
        defaultPrompt: ['Document the architecture of this repository in Harpoon'],
      },
    },
    [join(plugin, '.mcp.json')]: { mcpServers: { harpoon: { command: bridge.command, args: bridge.args } } },
  }
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
  }
  const skill = join(plugin, 'skills', 'harpoon', 'SKILL.md')
  await mkdir(dirname(skill), { recursive: true })
  await writeFile(skill, SKILL)
  return root
}

export interface SetupStep {
  command: string
  ok: boolean
  output: string
}

/** Write the marketplace, then register it and install the plugin with the Codex CLI. */
export async function installCodexPlugin(home: string, bridge: BridgeCommand): Promise<{ dir: string; steps: SetupStep[] }> {
  const dir = await writeCodexMarketplace(home, bridge)
  const r = await resolveCli(codexCliSpec)
  if (!r.ok) return { dir, steps: [{ command: 'codex', ok: false, output: 'Codex was not found. Install the Codex CLI, or run the commands below in a terminal.' }] }
  const run = async (args: string[]): Promise<SetupStep> => {
    const res = await execCapture(r.cli.command, [...r.cli.prefixArgs, ...args], { timeoutMs: 60_000 })
    const output = `${res.stdout}${res.stderr}${res.error !== undefined ? res.error.message : ''}`.trim().slice(0, 2000)
    // Adding a marketplace or plugin that is already there is fine.
    const ok = (res.code === 0 && !res.timedOut) || /already/i.test(output)
    return { command: `codex ${args.join(' ')}`, ok, output }
  }
  const steps = [await run(['plugin', 'marketplace', 'add', dir])]
  steps.push(await run(['plugin', 'add', `${CODEX_PLUGIN}@${CODEX_MARKETPLACE}`]))
  return { dir, steps }
}
