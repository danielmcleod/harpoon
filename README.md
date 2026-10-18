# Harpoon

Interactive hexagonal architecture diagrams for documenting, planning and presenting software systems, with Claude
Code and Codex built in.

- **Map** services as hexagons on a 60° grid, joined by straight *harpoon* connectors: two anti-parallel lines, each
  with a single barb, for request and response (`⇌`), and protocol badges.
- **Drill down**: double-click a service to expand its inner architecture in place, or open it full-canvas, with
  outside dependencies shown as context ghosts. Connectors to inner parts lift to the nearest visible node.
- **Document**: every service has a feature catalog (endpoints, contracts, SLAs), connectors have Channel A/B wire
  specs and runtime policies, everything can carry code evidence (`file:line`), and lint flags gaps.
- **Plan with AI**: Harpoon drives your local `claude` or `codex` CLI (read-only in the project folder) with a live
  MCP connection back into the app. The agent stages changes in a draft you watch appear on the canvas, then review in
  Diff & Merge (accept, accept as planned, partial accept, or discard). Import a repository, document from code, ask
  questions, check drift, and turn a plan into an implementation brief.
- **Simulate traffic**: particles along the harpoons, capacity and latency per service, retries, timeouts, circuit
  breakers, broker backlogs and injected faults (crash, slow-down, partition, rate limit, error burst), with charts
  and flow tracing. Modelled, not measured.
- **Present and share**: saved views become a slideshow; export a self-contained HTML viewer, PNG/SVG, draw.io,
  Mermaid, PlantUML C4, `ARCHITECTURE.md`, native JSON and the LLM interchange JSON with its JSON Schema.
- **Govern**: teams and owners, regulated-data tagging (PII, PHI, PCI, CJIS, FERPA…) with scope derived along
  connectors, compliance zones, and roadmap phases; colour the diagram by status, team, data or phase. Custom rules
  (a small JSON predicate language) run with the built-in checks; guidelines steer AI designs; an AI scan suggests
  both from the code.
- **Tables**: services (a drill-down tree), connectors, endpoints, data handling, planned changes and problems; sort,
  filter, group, edit inline or in bulk, save table views, export CSV/Markdown.
- **Roadmap**: see the architecture at the end of each phase, drag work between phases on a board, present the roadmap.
- **Decide**: "Propose solutions" designs 2-4 alternatives in one AI session; compare them side by side (diagrams,
  computed facts, weighted scores), choose one, and keep the decision as an ADR (exported to `docs/adr/`).
- **Notes**: a project notebook and meeting series in Markdown, with @mentions, tasks carried over between meetings,
  AI summaries, extracted action items (each one turns into a plan, a comparison, a decision or a guideline) and
  agendas for the next meeting.
- **Projects across repositories**: link several repos (discovered from a folder); AI runs read them all.
- **Notion**: a Notion-ready import zip, AI publishing through your own Notion MCP server, and the share bundle
  attached through Notion's API.

## Develop

Requires Node ≥ 24.15 and pnpm 10.

```bash
pnpm install
pnpm dev                 # the app (electron-vite)
pnpm test                # unit tests (model ops, geometry, seed, simulator)
pnpm test:int            # integration tests (project lifecycle on disk)
pnpm lint && pnpm typecheck
pnpm e2e                 # build + one Electron smoke test
pnpm package:dir         # unpacked app in dist/
```

The renderer also runs alone in a browser with an in-memory sample project:
`npx vite --config vite.renderer.config.ts`.

Live AI checks (real CLIs, real tokens): `node scripts/ai-smoke.ts claude claude-haiku-4-5 plan` or
`node scripts/ai-smoke.ts codex - import tests/fixtures/shop`.

## Layout

| Path | What |
|---|---|
| `src/shared/model` | The domain model (zod), ops + undo, diffs, queries, lint, the sample |
| `src/shared/geometry` | Hex grid, harpoon geometry, the scene (expansion, focus, lifting, boundaries) |
| `src/shared/sim` | The traffic simulator engine |
| `src/core` | Electron-free core: projects on disk, AI runner + MCP host + tools, ingest, exports |
| `src/core/adapters`, `src/core/proc` | Claude Code / Codex CLI adapters, with Harpoon's `design` route |
| `src/main`, `src/preload` | Hardened Electron shell: `app://` renderer, CSP, typed IPC |
| `src/renderer` | React UI: canvas, panels, AI panel, simulator, presentation; `viewer-main.tsx` is the HTML viewer |

## Project files

A project lives in `.harpoon/` beside the code it describes, ready to commit:
`project.json` (semantics, rules and guidelines, sorted for clean diffs), `layout.json` (hex coordinates),
`proposals/`, `solutions/` and `decisions/` (comparisons and ADRs), `views/`, `tables/`, `scenarios/`, `notes/`
(Markdown with front matter) and `publish.json` (where it is published). Where each linked repository is cloned is
kept per machine, outside the project.

## How the AI connects

For each AI run, Harpoon opens a route on a loopback-only Streamable-HTTP MCP server, with its own path and bearer
token. The CLI starts read-only in the project folder:

- **Claude**: `--strict-mcp-config --mcp-config <file> --allowedTools mcp__harpoon__*`. The token reaches it through
  `${HARPOON_MCP_TOKEN}` expansion, so it never appears in argv or on disk.
- **Codex**: `mcp_servers.harpoon.{url, bearer_token_env_var, default_tools_approval_mode="approve"}` with a read-only
  sandbox.
- Other linked repositories are readable too (`--add-dir` for Claude; Codex's read-only sandbox reads anywhere).
- **Publishing to Notion** is the one pass that also loads the user's own Notion MCP server: no `--strict-mcp-config`,
  and `--allowedTools` lists only Harpoon's tools and that server's (Codex: every other user server stays off).

Tool inputs avoid JSON Schema tuples because OpenAI function schemas reject them. Write tools are annotated
non-destructive, since they only stage a draft.

## License

MIT, see [LICENSE](LICENSE). Third-party code and dependencies: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
