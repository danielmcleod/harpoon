# Harpoon: governance, tables, solutions, notes and Notion plan

> **Status (2026-10-18): all eight milestones are built** (commits 35d94e5 … M8). Where the build differs from this
> plan:
> - **Rules and guidelines live in the project file** (`meta.rules`, `meta.guidelines`) rather than `rules.json`. That
>   way they get undo, diffs and AI visibility, and the same checks run in Problems and in the AI's `validate_draft`.
>   Sharing across projects is a rule pack (import/export JSON) instead of a live `include`.
> - **Modules** (from the roles question) are a node kind: inner parts that need no connections.
> - **Notion**: the hosted Notion MCP has no file upload, so attaching the bundle uses the Notion API with a
>   token the user saves (encrypted with the OS keychain). The AI publish and the API upload are **not verified
>   live** (no Notion server or token on the build machine); the import zip, the page layout and the request sequence
>   are covered by tests.
> - Not built from the "later" list: the dependency matrix and the flow sequence view.

Scope: the October 2026 enhancement list. It covers ownership, data tagging, decision records, roadmap phases, custom rules with an AI pattern scan, multi-repo projects, table views, the AI "propose solutions" mode, notes, the meeting note taker and Notion.

Every item builds on code we already have:
- **Model edits** are ops, with undo and autosave.
- **AI changes** come in as proposals, reviewed in Diff & Merge.
- **Side records** are collections stored as files (`views/`, `scenarios/`).
- **Lenses:** the status lens.
- **Checks:** `lintModel`.
- **AI questions:** `ask_user` and the QuestionCard.

Nothing here needs a server.

---

## 0. Where things live

Rule of thumb: a fact about the architecture belongs in the **model** (`project.json`), so it gets ops, undo, diffs, proposals and AI tools. A record about the work around the architecture belongs in a **collection**: its own files under `.harpoon/`, versioned in git and read by the AI through MCP read tools.

| Data | Where | Why |
|---|---|---|
| owner/team, data classes, notes, phase on nodes/connectors | model (entity fields) | AI can set them; they show in diffs and proposals |
| teams, data-class catalog, phases | model (`meta`) | vocabulary the entities point at |
| repos | model `meta.repos` (exists), plus per-machine paths in `~/.harpoon` | paths differ per machine; remotes don't |
| solution sets, decisions (ADRs) | `.harpoon/solutions/`, `.harpoon/decisions/` | records with their own lifecycle |
| custom rules, guidelines | `.harpoon/rules.json` | shared by the team; small |
| notebooks and meeting notes | `.harpoon/notes/**.md` (Markdown + YAML front matter) | readable on GitHub and diffable |
| Notion page ids | `.harpoon/publish.json` | lets later publishes update in place |

All new model fields get defaults. Old projects load unchanged, so the schema bumps by one minor version and needs no migration.

---

## 1. General: notes on nodes and connectors

- New field `notes: Text(20000)` (markdown, default `''`) on Node and Connector. Boundaries get it too, since it costs nothing.
- **How notes differ from `description`:** the description documents what the thing *is* and goes into every export. Notes are working notes (gotchas, TODOs, links, who to ask). They stay out of exports unless "Include notes" is ticked.
- **Inspector:** a "Notes" section with a markdown textarea and preview. Edits coalesce into one undo step, as other text fields already do.
- **Canvas:** a small note glyph on hexes and edge badges that have notes.
- **AI:** `update_node` and `update_connector` accept `notes`. The prompt tells the AI to put uncertain findings in notes, never in the description.

## 2. Planning: ownership (basic)

- `meta.teams: { id, name, contact?: string, color?: string }[]`.
- New entity fields:
  - `team: Id | null`: a team from the list.
  - `owner: string | null`: free text (a person or an alias).
  - Both go on nodes. Connectors and boundaries get `team` only.
- **Inheritance is derived, not stored:** a node without a team shows its nearest ancestor's team in italics, labelled "inherited".
- **Inspector:** a team combobox; typing a new name creates the team, as one op.
- **Lens:** generalize `StatusLens` into **Lens: Status | Team | Data | Phase**. The Team lens colours hexes by team and adds a click-to-filter legend, which reuses the status lens mechanics.
- **Lint (optional built-in rule, off by default):** "service without an owner".

## 3. Planning: data and risk tagging

There are two separate ideas, and the model keeps them separate:
- **Sensitivity level** (one per entity): `public | internal | confidential | restricted`.
- **Regulated data types** (many per entity): `dataClasses: Id[]`, pointing into a catalog.

Built-in catalog, extendable in `meta.dataClasses`:

| id | Label | Typical regime |
|---|---|---|
| `pii` | Personal data | GDPR / CCPA |
| `phi` | Health data | HIPAA |
| `pci` | Cardholder data | PCI DSS |
| `cji` | Criminal justice info | CJIS |
| `ferpa` | Student records | FERPA |
| `fin` | Financial / SOX-relevant | SOX / GLBA |
| `secrets` | Credentials and keys | internal |
| `special` | GDPR special category | GDPR Art. 9 |

How it works:
- **Where tags go:**
  - Nodes say what they **store or process**.
  - Connectors say what they **carry**. Each channel gets its own `dataClasses`, because a request and its response carry different data.
  - Features may override.
- **Derived scope:** a node that receives a connector carrying `pci` is *in scope* even if nobody tagged it. The Data lens shows tagged nodes solid and in-scope nodes hatched, and "why?" lists the carrying connectors. This is a pure query in `queries.ts`, next to `impactOf`, and gets a unit test.
- **Boundaries:** compliance boundaries get a `dataClasses` field too ("PCI zone").
- **Built-in lint rules:**
  - Regulated data on a connector without encryption or auth.
  - Regulated data reaching a node outside a matching compliance boundary.
  - Regulated data reaching an external or SaaS node with no `vendor` set.
  - `restricted` data on a public-facing node.
- **Outputs:**
  - The Data lens.
  - A Data inventory table (§7).
  - A "Data flows" section in the Markdown export and the implementation brief.
  - The AI sees the catalog in `get_vocabulary`. Import tags data classes only when it has evidence (column names, schemas), and flags guesses in notes.

## 4. Planning: roadmap phases

- `meta.phases: { id, name, order, target: date|null, status: 'not-started'|'active'|'done', description }[]`.
- `phase: Id | null` on nodes, connectors and features. **It means "the phase in which this entity's status change lands":**
  - a `planned` node in Phase 2 appears in Phase 2;
  - a `deprecated` or `removed` node in Phase 3 disappears at Phase 3.
- **Phase scrubber:** a slider above the canvas: *Today → P1 → P2 → P3*. A pure projection `modelAsOf(model, phaseId)` (unit tested) shows the architecture as it will be at the end of that phase. Things that change in the selected phase are outlined.
  - It works with Present: stepping through phases is a natural roadmap presentation.
- **Roadmap view:** one column per phase listing the changes as cards (added, changed, removed), grouped by service. Drag a card to another column to change its phase.
  - Accepted decisions and solution sets show in their phase's column.
- **Accepting proposals:** "Accept as planned" asks which phase. The AI can set `phase` on staged changes when the user names one.
- **Lint:** planned entity without a phase (warning); an entity depending on something that only arrives in a later phase (error, "built before its dependency").

## 5. Planning: solution sets and decision records

### Model
- **SolutionSet** (`.harpoon/solutions/<id>.json`):
  - `{ id, title, problem, constraints, criteria: {name, weight}[], optionIds: proposalId[], scores: {optionId, criterion, score, note}[], status: 'open'|'decided'|'abandoned', decisionId, source }`
  - `source` points back to where the request came from: a note item, a chat message or a person.
- **Proposals** gain `solutionSetId`, `pros[]`, `cons[]`, `risks[]` and `effort: 'S'|'M'|'L'|'XL'`. They already hold ops, a rationale and a base.
- **Decision (ADR)** (`.harpoon/decisions/<id>.json`):
  - `{ id, number, title, status: 'proposed'|'accepted'|'rejected'|'superseded'|'deprecated', date, deciders[], context, decision, consequences, options: {proposalId|null, title, summary, chosen, whyNot}[], entityIds[], phase, supersedes, supersededBy, links[] }`
  - `number` gives readable ids such as ADR-0007.
  - `entityIds` gives "decisions about this service" in the inspector.
  - `links` points to meeting notes and the solution set.
- A decision can exist without a solution set: "we decided this in a meeting".

### Compare view
- Opens from a solution set, or by multi-selecting proposals.
- **2–4 panes side by side**, each a read-only canvas with that option's ops overlaid on the base (`useReview` already renders one). Cameras and expansion stay in sync.
- **Below the panes, a comparison matrix:**
  - **Computed facts**, from `diffModels` plus queries, so nobody types them:
    - nodes and connectors added, changed and removed;
    - services touched;
    - new vendors and external dependencies;
    - data-class exposure added;
    - rule violations;
    - impact radius;
    - the phase.
  - **Judged rows:** criteria × options with 1–5 scores (AI-suggested, user-editable), pros, cons, risks and effort.
  - A weighted total, shown but never auto-deciding.
- **"Choose this option"** then:
  1. accepts that proposal, either as-is or as planned in a chosen phase;
  2. marks the other options rejected (kept, not deleted, so the record shows what was considered);
  3. opens the ADR editor pre-filled. The AI drafts context, decision and consequences from the set, the scores and the discussion, and the user edits and saves.
- **Stale options:** an option made before the model changed is re-applied to the current model on open. If the ops conflict, the pane shows "needs refresh", and a click asks the AI to rebase that option.

### Decisions log
- A list view with filters by status, phase and service.
- Each ADR renders as markdown and links to its options (opening Compare read-only) and to the affected entities.
- **Exports:**
  - `docs/adr/NNNN-title.md`, the standard ADR layout, so repo readers get them without Harpoon;
  - a section in the Markdown export;
  - a page in the HTML viewer.

## 6. Planning: custom rules, guidelines and the AI pattern scan

Rules split into two kinds, because many real conventions are not visible in a diagram:
- **Model rules:** checkable against the model, evaluated by `lintModel` and shown in Problems.
- **Guidelines:** prose conventions such as "data access goes through the repository layer" or "use the outbox for events". They are never checked by Harpoon. They are **fed into every AI plan and solutions pass and into implementation briefs**, so new designs follow them.

### Rule format
- A small typed predicate DSL in zod, not code. That makes it safe to share, the AI can write it and Harpoon validates it on the spot.

```jsonc
{ "id": "pci-encrypted", "name": "Cardholder data is encrypted in transit", "severity": "error", "enabled": true,
  "target": "connector",
  "where":   { "all": [ { "field": "dataClasses", "op": "includes", "value": "pci" } ] },
  "require": { "any": [ { "field": "channelA.encryption", "op": "in", "value": ["tls", "mtls"] } ] },
  "message": "{name} carries PCI data without TLS" }
```

- **Operators:**
  - field tests: `eq`, `ne`, `in`, `includes`, `exists`, `empty`, `matches`;
  - logic: `all`, `any`, `not`;
  - relations: `connectsTo` / `calledBy` with a nested `where` and a `crossesTeam` / `crossesBoundary` flag; `insideBoundary`; `hasAncestor`.
- About 15 operators cover the common rules:
  - every service has an owner;
  - frontends only call through a gateway;
  - no direct database access across teams;
  - every external connector authenticates;
  - PHI stays in the HIPAA zone;
  - queues have a dead-letter companion.
- **Existing lint checks are rewritten in this DSL where they fit.** That proves the format and keeps one evaluator.
- **Rule packs:** `rules.json` can `include` another file by path (for example a shared `org-rules.json` in a platform repo), so an organization's standards can live in one place.
- **UI:** Settings → Rules.
  - A list with enable toggles and severity.
  - A form-based editor (target → where → require), with raw JSON available.
  - "Test against this project" shows the matches inline before saving.

### AI pattern scan (optional)
- A new AI mode, **Scan for patterns**. It is read-only and runs over the configured repos (§6.1).
- **Tools:**
  - `suggest_rule`: validated against the DSL. Harpoon evaluates it at once and returns "matches 11/12 services; the 1 exception is billing" to the AI, so it can tighten or drop the rule.
  - `suggest_guideline`: prose plus evidence (file and line ranges) and how widespread the pattern is.
- **Output:** a review list with three columns: *Rule* (checkable), *Guideline* (prose), *Existing deviations*.
  - Accept or dismiss each entry. Accepted entries go to `rules.json`.
  - Deviations can become notes on the offending node or a "fix" proposal.
- **Re-runnable:** a later scan diffs against the existing rules and only suggests new ones.

### 6.1 Projects across many repos (project settings, not just rules)
- **Shared vs per-machine:** `meta.repos` exists (`RepoRefZ`). Each entry gets `remote` (git URL), `role` (`service | infra | shared-lib | frontend | docs | other`), `defaultBranch` and `include` / `exclude` globs. The **local path lives per machine** in `~/.harpoon/state` keyed by project id and repo id, because paths differ between teammates. The relative path in the file is only a hint.
- **Project Settings dialog** (new), with tabs:
  - General (name, description);
  - **Repositories**;
  - Teams;
  - Data classes;
  - Phases;
  - Rules;
  - Notion.
  - The Teams, Data classes and Phases tabs edit `meta` through ops.
- **Repository discovery** offers three sources, and the user ticks which to add:
  1. **Folder scan:** pick a parent folder and list the git repos below it with their remotes.
  2. **From the model:** evidence paths and compose/k8s image names that point at repos not yet listed.
  3. **AI suggestion**, during import: "the payments service clones `acme/ledger-client`; add that repo?"
- **Missing repos:** a repo with no local path on this machine shows "not cloned here" with a Locate… button. AI runs skip it and say so.
- **AI runs across repos:**
  - cwd is the primary repo (or the `.harpoon` folder);
  - Claude gets `--add-dir <path>` for each other repo (confirmed in the current CLI);
  - Codex runs read-only and can read outside cwd; the repo list goes in the prompt (its `--add-dir` grants *write* access, which we don't want).
- **Import across repos:** the seed runs per repo, deep dives run per service with the right repo as cwd, and evidence records the repo id (it already has the field). Drift checks and the pattern scan use the same list.

---

## 7. Usability: table views with drill-down

A **Tables** workspace mode next to Designer and Simulator. It is the same project and the same selection, with the same inspector on the right.

| Table | Rows | Notable columns |
|---|---|---|
| Services | nodes as a **tree table** (expand rows to drill into children, like double-click on the canvas) | kind, status, team/owner, hosting/provider/region, data classes, phase, #features, #in/#out, problems |
| Connectors | connectors (lifted or real, toggle) | from → to, protocol A/B, sync, auth, encryption, data classes, phase |
| Endpoints | features across all services | service, category, protocol, endpoint, SLA, contract yes/no |
| Data inventory | one row per (data class × entity), including derived scope | stored or in transit, encryption, boundary, rule status |
| Changes | everything not `existing`, grouped by phase | the roadmap as a list |
| Decisions | ADRs | number, status, date, phase, entities |
| Problems | lint and rule hits | severity, rule, entity, message |

Behaviour:
- **Interaction:**
  - sort, filter (per column and free text), group by any column, choose columns, freeze the name column;
  - **inline edit** through the same `edit()` ops as the inspector, so undo works;
  - **multi-select bulk edit** for team, phase, status, data classes and tags.
- **Drill-down:**
  - click a row to show it in the inspector;
  - double-click to drill in (Services) or open the record;
  - "Show on canvas" switches to Designer with the item focused and selected;
  - a cell that counts things (for example `#out`) opens a filtered Connectors table.
- **Split view:** a table under the canvas with synced selection, which is handy when reviewing.
- **Saved table views** (columns, filters, grouping) go into the existing `views/` collection with `kind: 'table'`.
- **Export:** CSV and Markdown of the current table.
- **HTML viewer:** gets read-only tables.
- **Implementation:** TanStack Table plus TanStack Virtual (headless, handles 1000+ rows, about 15 kB). The rows come from pure selectors over the model, which are easy to test.
- **Other views from the gap analysis**, in later milestones:
  - **dependency matrix** (service × service, cells coloured by protocol or problems; good for spotting coupling);
  - **flow sequence view** (a flow as a sequence diagram, the same data as the Mermaid sequence export).

## 8. AI: "Propose solutions for X"

A new mode, **Propose solutions**, next to Plan / Import / Document / Explain.

1. **Prompt:** the user describes the goal ("We need fraud scoring on checkout"). Optional constraints and evaluation criteria come from presets (cost, complexity, time to deliver, operability, vendor lock-in, compliance), with editable weights.
2. **Clarify:** the existing `ask_user` round (up to 4 questions), now also covering criteria ("is a managed SaaS acceptable?"). "Just decide" still works.
3. **Generate 2–4 options in one session** so they truly contrast:
   - A new tool, `begin_option(title, approach)`, switches the active draft. Each option is its own `Draft`.
   - The existing write tools stage into the active draft.
   - `submit_solutions(problem, criteria, options: {draftKey, summary, pros, cons, risks, effort, scores})` ends the run.
   - The prompt requires options to differ in *approach* (for example in-process vs async service vs SaaS), not just naming, and to respect guidelines and rules. `validate_draft` reports rule violations per option.
4. **Result:** a SolutionSet with one proposal per option. It opens in **Compare** (§5), and the AI panel shows a short summary card.
5. **Refine:** follow-ups resume the session, scoped by an option picker:
   - "Make option B use SQS instead of Kafka" edits only B;
   - "Add a fourth option without new vendors" adds one;
   - "Drop A" abandons it.
6. **Decide:** **Choose** then **ADR**, as in §5.

Why one session rather than N parallel runs: the options are written knowing about each other, so the trade-off text is honest and the scores are comparable. N parallel runs stay possible later ("more diverse ideas"), at extra cost.

## 9. General: project note taker

### Structure
- **Project notebook:** one rolling notes page for the project (`notes/project.md`).
- **Meeting series:** for example "Architecture review (bi-weekly)" or "Payments sync".
  - Front matter: title, cadence, default attendees, template.
  - Each occurrence is a file `notes/<series>/<yyyy-mm-dd>.md`.
- **One-off meetings** are a series with one entry.
- **File format:** Markdown with YAML front matter (`yaml` is already a dependency), so notes read well on GitHub and in any editor. Harpoon watches the folder like `project.json`.

### Editor
- CodeMirror 6 with markdown highlighting. It is light, and the file stays the source of truth.
- **Mentions:** `@` autocompletes nodes, connectors, decisions and solution sets. A mention is stored as `[@Payments](harpoon:node/abc)` and is clickable: it selects the item on the canvas. Inspectors show "Mentioned in N notes".
- **Tasks:** `- [ ]` lines are tasks; `@person` and `due:2026-11-02` are parsed optionally.
- **Meeting template:**
  - Attendees / Agenda / Discussion / Decisions / Action items.
  - **Open action items from the previous occurrence carry over** automatically for a recurring series.
- **Open items panel:** unchecked tasks across all notes, filterable by series or person.

### AI on notes: what makes sense
Rather than a fixed button per action, one **Extract** pass reads the note and classifies each item into a suggested action. The user clicks to run one.

| AI button | What it does | Output |
|---|---|---|
| **Summarize** | Summarizes this note, or a series over a date range ("since last review") | A summary block inserted at the top for the user to accept; text only |
| **Extract** | Finds tasks, decisions, open questions and mentioned services, via a new tool `record_note_items` | An "Items" side list, each with a suggested action |
| **Prep next meeting** | Builds an agenda from carried-over items, pending proposals, open solution sets, new problems and phase status | A draft agenda for the next occurrence |

Suggested actions per item. Each one runs an existing mode, prefilled with the item plus the note as context:

| Item looks like… | Suggested action | Runs |
|---|---|---|
| "We need X / how should we do Y?" (open, with alternatives) | **Propose solutions** | §8 solutions mode |
| "Let's add X to Y" (clear change) | **Plan this change** | Plan mode, giving one proposal |
| "Payments now uses SQS" (a fact the diagram lacks) | **Update the diagram** | Document mode, giving a proposal |
| "We decided to go with Postgres" | **Record decision** | ADR draft, with no model change |
| "All new services must emit OTel" | **Add rule / guideline** | `suggest_rule` flow |
| "Ana owns search now" | **Set owner/phase/tag** | A small ops proposal, no AI run needed when it parses |
| Plain to-do | **Keep as task** | Nothing |

- **Backlinks:** every artifact made from a note keeps `source: {noteId, itemId}`. The note item then shows its status (proposal pending or accepted, ADR-0007, rule added), and the proposal or decision links back to the meeting. That gives traceability from discussion to diagram for free.
- **Never automatic:** AI never runs on its own when a note is saved. Each action is one click and lands as a proposal or draft to review.
- **Privacy:** notes are excluded from exports, the viewer and Notion unless ticked per publish. Meetings capture people's words.

## 10. Collaboration: Notion (no server)

Three steps, cheapest first.

1. **Notion-ready export (deterministic):** a "Notion" option in Share produces:
   - a Markdown page tree that Notion imports cleanly: Overview, Services, Data flows, Roadmap, Decisions (one subpage per ADR) and optionally Meeting notes;
   - PNG diagrams;
   - the full zip bundle as an attachment.

   The user drags it into Notion's Import. No accounts are involved.
2. **AI publish through the user's own Notion MCP:** the action **Publish to Notion…** asks for the target page URL and runs a **publish pass** with:
   - Harpoon's read tools (overview, decisions, roadmap, changes since the last publish);
   - the user's Notion MCP server, the one configured in their Claude or Codex setup. This is the one pass that does *not* use `--strict-mcp-config` and does not turn off that server.

   The AI updates managed sections in place: the "Architecture" summary, the decision log table, roadmap and changelog. It never touches content outside those sections. Page ids go in `publish.json`, so the next run updates rather than duplicates.
   - **Spike first:** can the hosted Notion MCP attach files? If not, the zip goes up in step 3 or the page links to the repo copy.
3. **Direct Notion API (optional, only if the spike says so):** the user pastes an internal-integration token in Settings → Notion. It is stored with Electron `safeStorage`, and the user enters it themselves. A deterministic publisher uploads the zip through Notion's file-upload API and attaches it, then lets the AI pass (or a template) fill the text.

Each publish adds a small changelog entry ("ADR-0009 accepted, 3 services added in Phase 2") to the Notion page and to `publish.json`.

---

## 11. AI and MCP changes, in one place

- **`update_node` / `update_connector` / `add_*`** gain:
  - `notes`, `team`, `owner`, `sensitivity`, `dataClasses`, `phase`;
  - for connectors, per-channel `dataClasses`.
- **`get_vocabulary`** adds teams, the data-class catalog, phases, rules and guidelines.
- **New read tools:** `get_rules`, `get_decisions`, `get_solution_set`, `get_notes(range)`.
- **New write tools, per mode:**

  | Mode | Tools |
  |---|---|
  | solutions | `begin_option`, `submit_solutions` |
  | scan | `suggest_rule`, `suggest_guideline` |
  | ADR drafting | `draft_decision` |
  | note extract | `record_note_items` |

- **Prompts:** guidelines and enabled rules are added to `SYSTEM_BRIEF` for plan and solutions passes, and to implementation briefs.
- **Multi-repo:** `--add-dir` for Claude; the repo list goes in the prompt for Codex.

## 12. Milestones

Each milestone ships on its own and is committed separately.

1. **Fields and lenses:**
   - notes on nodes and connectors;
   - team/owner and the teams list;
   - sensitivity, data classes and the catalog, with derived scope;
   - phases in `meta` and the `phase` field;
   - inspector sections;
   - the generalized Lens (Status, Team, Data, Phase);
   - built-in lint for data and phases;
   - MCP fields;
   - exports updated.
2. **Project Settings and multi-repo:** the settings dialog and its tabs, repo discovery, per-machine paths, `--add-dir`, multi-repo import.
3. **Tables:** Services (tree), Connectors, Endpoints, Data inventory, Changes and Problems, with inline and bulk edit, drill-down, split view, saved table views and CSV.
4. **Roadmap:** the phase scrubber and `modelAsOf`, the Roadmap view, accept-into-phase, and presenting by phase.
5. **Solutions and decisions:**
   - SolutionSet and Decision collections;
   - the solutions AI mode;
   - the Compare view with computed facts and the matrix;
   - Choose then ADR;
   - the decisions log and table;
   - ADR markdown export.
6. **Rules:**
   - the DSL, evaluator and rewritten built-ins;
   - the Rules settings UI and test-against-project;
   - guidelines in prompts;
   - the AI pattern scan.
7. **Notes:**
   - notebooks and series;
   - CodeMirror editor, mentions and tasks;
   - carry-over and the open items panel;
   - Summarize, Extract and actions, and Prep next meeting.
8. **Notion:** the export (step 1), the MCP spike, the AI publish (step 2), then the API (step 3) if needed.

Dependencies:
- Milestone 1 underpins the rest.
- Milestone 3 is better after 1 and 2.
- Milestone 5 is needed before Notion's decision log.
- Milestone 7's actions use milestones 5 and 6 when present and degrade gracefully when they aren't.

New dependencies: `@tanstack/react-table` and `@tanstack/react-virtual` (milestone 3), CodeMirror 6 (milestone 7). Nothing else.

## 13. Testing (light, where it pays)

- **Unit tests:**
  - the rule evaluator, with about 6 rules on the sample model, including relational operators;
  - derived data-class scope;
  - `modelAsOf`;
  - the "built before its dependency" lint;
  - note front matter and mention round trip;
  - table row selectors (one test).
- **Integration tests:**
  - choosing a solution-set option accepts it, rejects its siblings and writes an ADR;
  - multi-repo per-machine path resolution.
- **E2E:** extend the smoke test with one step: open Tables, edit a team inline, see it in the inspector.
- **Live checks per milestone:**
  - solutions mode with both CLIs on the shop fixture;
  - a pattern scan on the shop fixture;
  - a Notion publish to a scratch page.

## 14. Open decisions (recommended defaults in bold)

1. Notion route: **export first, then AI through the user's Notion MCP**; direct API token only if attachments need it.
2. Rule format: **typed JSON predicate DSL**, rather than CEL or JS expressions (safer to share, and the AI can write it).
3. Notes format: **Markdown with front matter**, rather than JSON.
4. ADR storage: **JSON in `.harpoon/decisions/`, plus a generated `docs/adr/*.md`**.
5. Notes in exports, the viewer and Notion: **off by default, ticked per export**.
6. Solutions: **one session with multiple drafts**, rather than parallel runs.
