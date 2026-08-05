# Installing Helmo (agent-led)

You are an agent installing Helmo for a human. This is the primary install path: run it end to end, verify each step, and finish by giving the human their dashboard link and getting-started instructions (template at the bottom). Don't make the human run commands unless a step genuinely requires their credentials or a restart.

## What you are installing

Helmo is a shared work record for agent teams: a single SQLite store, an MCP server agents write through, a read-only dashboard, and a summonable orchestrator for meetings. One store serves ALL projects and repos on the machine — install once per machine, not per project. If Helmo is already installed (check `~/.helmo/helmo.db` exists and `claude mcp list` mentions helmo), skip to registering additional agents or just report status.

## Steps

### 1. Prerequisites

Node.js >= 20 (`node --version`) and git. If missing, tell the human what to install and stop.

### 2. Get and build the code

```bash
git clone <helmo-repo-url> ~/tools/helmo   # or use an existing local checkout
cd ~/tools/helmo
npm install && npm run build && npm test
```

All tests must pass before you continue. If they don't, report the failure — do not register a broken server.

### 3. Register the MCP server for the human's agent platform(s)

The server command is `node <helmo-path>/dist/server.js`. Every registration needs a `HELMO_ACTOR` env var identifying who writes — see identity rules below.

**Claude Code** (user scope, so every session on the machine gets it):

```bash
claude mcp add --scope user helmo -e 'HELMO_ACTOR={"name":"<agent-name>","kind":"agent","model":"<model-id>","version":"<harness-version>"}' -- node <helmo-path>/dist/server.js
```

**Codex / other MCP-capable harnesses** — add to their MCP config (TOML/JSON equivalent of):

```json
{
  "mcpServers": {
    "helmo": {
      "command": "node",
      "args": ["<helmo-path>/dist/server.js"],
      "env": { "HELMO_ACTOR": "{\"name\":\"<agent-name>\",\"kind\":\"agent\",\"model\":\"<model-id>\",\"version\":\"<version>\"}" }
    }
  }
}
```

**Identity rules:**
- `name`: stable, human-readable, describes the role — `codex-events-loop`, `claude-code-interactive`, `reviewer-loop`. The human will see this name in meetings; pick one they'd recognize.
- `kind`: `agent` (workers), `orchestrator` (meeting runner), `human` (never in env config).
- `model` + `version`: required for agents. For bash-loop agents these are accurate in env config. For interactive sessions the model varies day to day — the env value is a default; agents should pass the per-call `actor` override with their true model when it differs (tracked as H-3 in the helmo-dev workstream).
- Registering a bash-loop worker? Give each loop its own name and accurate model/version — provenance is the product.

### 4. Start the dashboard

```bash
cd <helmo-path> && nohup node dist/view.js > /tmp/helmo-view.log 2>&1 &
```

Serves read-only at `http://localhost:4400`, bound to 127.0.0.1 (override port with `HELMO_VIEW_PORT`, host with `HELMO_VIEW_HOST`, database with `HELMO_DB`). Verify it responds: `curl -s localhost:4400 | grep -q Helmo`. Note for the human that this doesn't survive reboot yet; a login service is a welcome contribution.

### 5. Verify end to end

```bash
node <helmo-path>/scripts/check-connection.mjs
```

Must print the 7 tools and `CONNECTION OK`. Also confirm your platform sees it (Claude Code: `claude mcp list` shows `helmo: ✔ Connected`).

### 6. Report back to the human

Deliver (adapted to what you actually set up):

> Helmo is installed and connected.
>
> - **Dashboard** (read-only): http://localhost:4400 — the "Awaiting you" section is your queue.
> - **Start a meeting**: in any agent session with Helmo connected, say **"Summon helmo orchestrator"** and have the agent load `<helmo-path>/HELMO-ORCHESTRATOR.md`. It will walk you through every ticket awaiting your decision and record your answers. Meetings end when the queue is empty.
> - **You never edit tickets directly** — agents write the record; you read the dashboard and talk to the orchestrator.
> - **Connected agents**: <list the identities you registered>. To put an agent to work, include the worker snippet below in its instructions.

**Worker snippet** (paste into any agent's constitution/prompt):

> You have Helmo MCP tools (`helmo_*`) — the shared work record. At the start of each session/iteration: `helmo_list_tickets {assignee: "<your-name>"}` to resume work you own, then `helmo_list_tickets {ready: true, workstream: "<yours>"}` for new work. Claim before working, update when reality changes, attach evidence when done, and use `helmo_return_to_human` (never a guess) when only the human can decide. The tool descriptions teach the rest.

## Notes for maintainers

- The MCP registration points at `dist/` — after changing `src/`, run `npm run build` or agents get the stale server.
- One global DB is deliberate (`~/.helmo/helmo.db`); use `HELMO_DB` only for isolated testing (e.g. the smoke suite).
