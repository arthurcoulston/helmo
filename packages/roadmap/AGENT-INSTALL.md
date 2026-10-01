# Installing Helmo Roadmap (agent-led)

You are an agent installing Helmo Roadmap for a human. This is the primary install path: run it end to end, verify each step, and finish by giving the human their view link and getting-started instructions (template at the bottom). Don't make the human run commands unless a step genuinely requires their credentials or a restart.

## What you are installing

Helmo Roadmap is the layer above the ticket: where ideas get parked, shaped, costed, ranked, and declared go. It is a SQLite store, an MCP server agents write through, and a read-only web view. One store serves ALL projects on the machine — install once per machine, not per project.

It stands alone. **No Helmo server, Crew checkout, or Estate checkout is needed to run it.** It reads as one system with [Helmo](https://github.com/arthurcoulston/helmo) when both are installed — Helmo records work being done, this records work worth doing — but neither requires the other. If Roadmap is already installed (check `~/.helmo-roadmap/roadmap.db` exists and `claude mcp list` mentions roadmap), skip to registering additional agents or just report status.

## Steps

### 1. Prerequisites

Node.js >= 20 (`node --version`) and git. If missing, tell the human what to install and stop.

The SQLite dependency (`better-sqlite3`) installs a prebuilt binary for common Node/platform pairs. If none exists for theirs, npm builds it from source and needs a C++ toolchain (Xcode Command Line Tools on macOS, `build-essential` and `python3` on Linux). Only reach for that if step 2 fails on the native build.

### 2. Get and build the code

```bash
git clone <roadmap-repo-url> ~/tools/helmo-roadmap   # or use an existing local checkout anywhere
cd ~/tools/helmo-roadmap
npm ci && npm run build && npm test
```

All tests must pass before you continue. If they don't, report the failure — do not register a broken server.

Two tests report **skipped**: `vendored estate tokens > is the estate token file verbatim` and `vendored estate avatars > is the estate sprite verbatim`. These compare the vendored design tokens and avatar sprite against their upstream Estate source, which is not part of this repo and is not something you need. Skipped is the expected result on every install; the vendored copies build and render without it. A skip here is not a failure — but a *failing* test is.

### 3. Register the MCP server for the human's agent platform(s)

The server command is `node <roadmap-path>/dist/server.js`. Every registration needs an actor identity naming who writes — the store rejects writes that don't have one.

**Claude Code** (user scope, so every session on the machine gets it):

```bash
claude mcp add --scope user roadmap -e 'ROADMAP_ACTOR={"name":"<agent-name>","kind":"agent","model":"<model-id>","version":"<harness-version>"}' -- node <roadmap-path>/dist/server.js
```

**Codex / other MCP-capable harnesses** — add to their MCP config (TOML/JSON equivalent of):

```json
{
  "mcpServers": {
    "roadmap": {
      "command": "node",
      "args": ["<roadmap-path>/dist/server.js"],
      "env": { "ROADMAP_ACTOR": "{\"name\":\"<agent-name>\",\"kind\":\"agent\",\"model\":\"<model-id>\",\"version\":\"<version>\"}" }
    }
  }
}
```

**Identity rules:**
- `name`: stable, human-readable, describes the role — the human sees it as provenance on every claim and judgment in the store.
- `kind`: `agent` (workers), `orchestrator` (meeting runner), `human` (never in env config).
- `model` + `version`: required for agents. For bash-loop agents these are accurate in env config. For interactive sessions the model varies, so the env value is a default and agents should pass the per-call `actor` override when their true model differs.
- `ROADMAP_ACTOR` is read first, then `HELMO_ACTOR` — a machine that already provisions per-agent Helmo identities needs no second variable. Set `ROADMAP_ACTOR` only when the two should differ.
- Store location is `~/.helmo-roadmap/roadmap.db`; `ROADMAP_DB` overrides it. Use the override only for isolated testing, never to give a project its own store.

### 4. Start the read-only view

```bash
cd <roadmap-path> && nohup node dist/view.js > /tmp/roadmap-view.log 2>&1 &
```

Serves read-only at `http://localhost:4410`, bound to 127.0.0.1 (override port with `ROADMAP_VIEW_PORT`, host with `ROADMAP_VIEW_HOST`, database with `ROADMAP_DB`). Verify it responds: `curl -s localhost:4410 | grep -q Roadmap`. Note for the human that this doesn't survive reboot yet; a login service is a welcome contribution.

### 5. Verify end to end

Confirm the platform sees the server and its tools (Claude Code: `claude mcp list` shows `roadmap: ✔ Connected`). Then, from an agent session that has the tools, file one throwaway project and read it back:

```
roadmap_add_project  title: "Install check", one-line description
roadmap_list_projects
```

The project must come back with a rank and a one-line explanation of that rank. Tell the human it is there so they can decide whether to keep or archive it — do not leave a synthetic record in their store without saying so.

### 6. Report back to the human

Deliver (adapted to what you actually set up):

> Helmo Roadmap is installed and connected.
>
> - **The view** (read-only): http://localhost:4410 — your projects, ranked, each rank explaining itself in one line.
> - **Getting an idea in costs nothing**: tell any connected agent "put X on the roadmap" with a title and ideally a sentence. Bad ideas belong there, ranked low.
> - **Rank is derived, never hand-set.** Facts set the tier (ship-next, in motion, ready, shaping, blocked, parked); attributed judgments of value and effort order within it. To move something up, change the judgment or the facts — there is no rank field to edit.
> - **Ship-next is yours.** Declaring a project go is a human decision an agent records, not one it makes. Several can be active at once; the count is deliberately visible.
> - **The charter is the one thing you write and agents only read** — your own document stays yours; the store holds a projection of its objectives and bets with provenance back to it. Start from `CHARTER-TEMPLATE.md` in the repo.
> - **Connected agents**: <list the identities you registered>.
> - <If you filed an install-check project: "I left a project called 'Install check' in the store as a verification — archive it whenever you like.">

**Worker snippet** (paste into any agent's constitution/prompt):

> You have Roadmap MCP tools (`roadmap_*`) — the record of work worth doing, above the ticket. Use `roadmap_list_projects` to see what is ranked and why, `roadmap_add_project` whenever an idea arrives that isn't tracked, and `roadmap_record_claim` / `roadmap_cite` to attach a judgment or a source to a project. Never argue a project up the list by editing rank — it is derived. `roadmap_set_ship_next` records the human's decision and is never your own.

## Notes for maintainers

- The MCP registration points at `dist/` — after changing `src/`, run `npm run build` or agents get the stale server.
- One global store is deliberate (`~/.helmo-roadmap/roadmap.db`); `ROADMAP_DB` is for isolated testing. Tests use temporary stores — never point them at a live DB.
- `src/estate-tokens.generated.ts` and `src/estate-avatars.generated.ts` are vendored from Estate by `npm run vendor:tokens` / `npm run vendor:avatars`. They are checked in so the product builds without that source; the two skipping tests are the drift check that runs only where the source is present.
- Back up the SQLite store before upgrades, and keep backups private.
