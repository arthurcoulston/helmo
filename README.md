# Helmo

Agent work record: **agents write, humans read and meet.**

A self-hosted, platform-agnostic work dashboard for AI agent teams. Agents (Claude Code, Codex, any MCP-capable agent — mostly headless bash loops) create and manage tickets through MCP tools. The human never edits: they read a view, and they work the `awaiting_human` queue in conversation with a summonable orchestrator. Status is self-reported, backed by evidence links; provenance comes from an append-only event log.

![The Helmo view: a question awaiting the human with options and an agent recommendation, a hygiene flag, workstream steering, and work in motion](docs/dashboard.png)

That view is the whole interface. Helmo exists for the moment your agents outrun your ability to re-read everything they did: what needs you is at the top, "done" without an evidence link surfaces as a flagged claim, and every line traces to who wrote it — which agent, which model, at what cost.

- Product: [helmo-product-description.md](helmo-product-description.md)
- Design (schema, IDs, tool surface): [helmo-v0-design.md](helmo-v0-design.md)
- Orchestrator context (summon this to run a meeting): [HELMO-ORCHESTRATOR.md](HELMO-ORCHESTRATOR.md)

## Status

MVP. The store, MCP server, read-only view, smoke test, and explicit product
acceptance gate are dogfooded on Helmo's own development. The MVP gate is
`npm run build`, `npm test`, and `npm run smoke`; publication is a separate
release decision.

## Install

**Agent-led install is the primary path.** Tell your agent: *"I want to use Helmo — install it and set it up."* and point it at [AGENT-INSTALL.md](AGENT-INSTALL.md). It runs the install end to end and returns your dashboard link and meeting instructions.

Manual setup, if you prefer:

```
git clone https://github.com/arthurcoulston/helmo.git
cd helmo
npm ci
npm run build
npm test
npm run smoke
```

That is the isolated cold setup: it needs no sibling project and the smoke uses
a fresh temporary database. Two design-source drift comparisons report skipped
when the private estate source is absent; the vendored copies are still tested.
Helmo requires Node.js 20 or newer.

The store is a single SQLite file (WAL), default `~/.helmo/helmo.db`, override with `HELMO_DB`.

### Connect an agent (MCP, stdio)

Each agent's MCP config launches the server with the agent's identity:

```json
{
  "mcpServers": {
    "helmo": {
      "command": "node",
      "args": ["/path/to/helmo/dist/server.js"],
      "env": {
        "HELMO_ACTOR": "{\"name\": \"builder-loop\", \"kind\": \"agent\", \"model\": \"claude-sonnet-5\", \"version\": \"1.0\"}"
      }
    }
  }
}
```

For Claude Code: `claude mcp add helmo -e HELMO_ACTOR='{"name":"...","kind":"agent","model":"...","version":"1.0"}' -- node /path/to/helmo/dist/server.js`

Tools include ticket creation, reading, updates, links, human questions and
answers, workstream steering, plus
`helmo_record_product_completion`, `helmo_record_acceptance_verdict`, and
`helmo_check_product_acceptance`. The tool descriptions teach correct usage;
no separate convention doc is required.

### Product acceptance

Product acceptance is an explicit gate, separate from ordinary ticket status
and review type. A builder records the exact source under review as
`repo@<full 40-character commit>` with each commit's author. A non-author
reviewer records PASS or FAIL against exactly those refs. A missing or failed
verdict blocks acceptance; a new completion after remediation makes the old
verdict stale and requires a new handback. Closing a ticket or writing “PASS”
in prose does not satisfy this gate, while generic review tickets keep their
normal lifecycle.

Release scripts can require the intended manifest directly:

```
helmo-cli acceptance-check --ticket H-42 \
  --refs '["helmo@0123456789abcdef0123456789abcdef01234567"]'
```

The command exits zero only for an independent PASS on that exact manifest.
Actor names, models, harness versions, and authors are provenance asserted by
the callers; Helmo records and checks those assertions but does not authenticate
their real-world identities.

### The view (read-only)

```
npm run view    # http://localhost:4400
```

### Run a meeting

In your agent session (Claude Code, Codex): *"Summon helmo orchestrator"* → load [HELMO-ORCHESTRATOR.md](HELMO-ORCHESTRATOR.md) as context. The orchestrator walks you through the awaiting-human queue and records your answers.

## Development

```
npm test        # includes the core invariant: tickets rebuild exactly from the event log
npm run smoke   # asserted MCP lifecycle + a deliberate rejected CLI operation
npm run demo    # stage the fictional board behind the screenshot above, in a throwaway db
```

Note: `better-sqlite3` uses a prebuilt binary when one matches your Node
version; otherwise it compiles from source, which needs a C toolchain and
Python ≥ 3.8 (node-gyp). If install fails in `node-gyp rebuild`, an old
`python3` on your PATH is the usual culprit — on macOS,
`PYTHON=/usr/bin/python3 npm install` fixes it.

## Prior art

Helmo sits in a small family of agent work-trackers and owes a nod to
[beads](https://github.com/steveyegge/beads), Steve Yegge's git-backed issue
graph that gives coding agents long-horizon memory of their own work. If what
you want is agent memory — epics, dependency graphs, issues that travel with
the repo — use beads; it is excellent at that.

Helmo's center of gravity is the other side of the table: the human who has to
trust the work without re-reading it. Agents write; the human reads a view and
answers a queue. Hence the append-only event log with full actor provenance
(who wrote, which model, which harness), "done" without an evidence link
surfacing as a flagged claim rather than a fact, an `awaiting_human` queue
designed to protect the operator's attention, and per-ticket metering of what
the work actually cost. Same genus, different optimization.

## License

[MIT](LICENSE)
