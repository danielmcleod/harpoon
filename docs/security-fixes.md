# Security review: what was fixed

An internal security review (2026-10-18) listed 14 findings and 6 items to verify. This is where each one stands.

| # | Finding | Status |
|---|---|---|
| 1 | Evidence "Open the file" ran any path through the OS shell | **Fixed.** `evidence.reveal` resolves evidence in main, inside the project or a linked repo only (relative, no `..`, real paths so links can't escape), and only *shows* the file in its folder. `shell.open` never opens files (it reveals them) and opens folders only when they are directories. The AI may only record relative evidence paths. |
| 2 / V1 / V2 | The repo's `.claude` settings loaded in design passes | **Fixed.** Design passes use `--setting-sources user`, so project and local settings never load, whether in the project or in `--add-dir` repos. |
| 3 | Working notes in the Notion export and AI publish | **Fixed.** Both strip working notes unless notes are included (the review's fix, redone on `main`). |
| 4 | The share bundle copied all of `.harpoon/` | **Fixed.** An allowlist: model, layout, README, views, scenarios, table views, comparisons, decisions, and notes when asked. Proposals and `publish.json` never go. |
| 5 | Publish mode widened the tools; the server name came from a shared file | **Fixed.** The server is chosen per machine (app state), must look like Notion and be known to the CLI, and its config is copied into the run's own MCP file, so the pass stays `--strict-mcp-config`. The only exception is the claude.ai connector: it can't be copied into a file, so that pass loads the user's servers, but none of their tools are allowed. Publish passes have no built-in tools (`--tools ""`), run with Claude only, and ask for confirmation first. |
| 6 | A shared `project.json` decided which folders the AI reads | **Fixed.** A path hint from the project is used only if it is a git repository and is not the home folder, a drive root or a folder containing the project. Otherwise Settings shows why, and Locate sets a per-machine path. |
| 7 | ReDoS through rule `matches` | **Fixed.** Patterns are limited (200 characters; no nested repetition, alternation under repetition or back-references). The checks run where rules come in (the AI, the JSON editor, rule packs) and again at evaluation, which skips unsafe patterns, so an old file still opens. Tested strings are capped at 1000 characters. |
| 8 | Design passes kept tools they don't need | **Fixed.** `--tools Read,Glob,Grep`, and the allow list is exactly argv (`CLAUDE_CODE_EVAL_CONFINED`). claude.ai connectors are off in design passes. |
| 9 | Notes followed symlinks | **Fixed.** Every note read, write and delete refuses a link anywhere on the path; a linked notes folder shows no notebooks. |
| 10 | Codex MCP isolation missed TOML shapes | **Fixed.** It now handles quoted names, comments, `[mcp_servers]` tables and top-level dotted keys. Override keys are plain names only, in both launch paths. |
| 11 | Scrubber gaps | **Fixed.** Notion, Slack, Stripe, SendGrid, npm, GitLab, Hugging Face and Azure key shapes are added, and the agent's names, endpoints, protocols, ADR titles and guideline fields are scrubbed too. |
| 12 | Zip-slip in the Notion zip | **Fixed.** `safe()` never yields `.` or `..` and drops control characters. |
| 13 | The viewer leaked the local path and history | **Fixed.** It embeds the model and version only. |
| 14 | Info items | Unknown runs now answer 401 like a bad token. The MCP server has header and request timeouts. A run's scratch folder is removed when its job ends. The token store refuses Linux's `basic_text` backend. Renderer log data is capped at 16 KB. Accepted: the token is in the child's environment; Markdown links outside the allowlist are silently blocked (UX). |

**Still to verify live** (they need a disposable repo and account):

- **V3:** whether Codex loads a repo's `.codex/config.toml`.
- **V4:** whether claude.ai connectors load in a publish pass through a claude.ai Notion connector. Their tools are not allowed either way.
- **V5:** WebFetch is now off in design passes, so this no longer applies.
- **V6:** the Codex Windows sandbox fallback.

Claude and Codex plan runs were checked live after these changes. A plain-folder repo hint was refused, so Claude could not read it; a git repo was read normally.
