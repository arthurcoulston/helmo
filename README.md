# Helm

Agent work record: **agents write, humans read and meet.**

A self-hosted, platform-agnostic work dashboard for AI agent teams. Agents (Claude Code, Codex, any MCP-capable agent — mostly headless bash loops) create and manage tickets through MCP tools. The human never edits: they read a view, and they work the `awaiting_human` queue in conversation with a summonable orchestrator. Status is self-reported, backed by evidence links; provenance comes from an append-only event log.

- Product: [helm-product-description.md](helm-product-description.md)
- Design (schema, IDs, tool surface): [helm-v0-design.md](helm-v0-design.md)
- Orchestrator context (summon this to run a meeting): [HELM-ORCHESTRATOR.md](HELM-ORCHESTRATOR.md)

## Status

Walking skeleton. Store + MCP server + plain read-only view. Being dogfooded on its own development.

## Setup

```
npm install && npm run build
```

The store is a single SQLite file (WAL), default `~/.helm/helm.db`, override with `HELM_DB`.

### Connect an agent (MCP, stdio)

Each agent's MCP config launches the server with the agent's identity:

```json
{
  "mcpServers": {
    "helm": {
      "command": "node",
      "args": ["/path/to/helm/dist/server.js"],
      "env": {
        "HELM_ACTOR": "{\"name\": \"builder-loop\", \"kind\": \"agent\", \"model\": \"claude-sonnet-5\", \"version\": \"1.0\"}"
      }
    }
  }
}
```

For Claude Code: `claude mcp add helm -e HELM_ACTOR='{"name":"...","kind":"agent","model":"...","version":"1.0"}' -- node /path/to/helm/dist/server.js`

Tools: `helm_create_ticket`, `helm_get_ticket`, `helm_list_tickets`, `helm_update_ticket`, `helm_link_tickets`, `helm_return_to_human`, `helm_answer_ticket`. The tool descriptions teach correct usage; no separate convention doc is required.

### The view (read-only)

```
npm run view    # http://localhost:4400
```

### Run a meeting

In your agent session (Claude Code, Codex): *"Summon helm orchestrator"* → load [HELM-ORCHESTRATOR.md](HELM-ORCHESTRATOR.md) as context. The orchestrator walks you through the awaiting-human queue and records your answers.

## Development

```
npm test        # includes the core invariant: tickets rebuild exactly from the event log
npm run smoke   # end-to-end MCP stdio round trip
```
