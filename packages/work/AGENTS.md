# AGENTS — session routing for helmo

Canonical apparatus file (vendor-neutral). `CLAUDE.md` is a shim pointing here.
The context envelope is a design decision: what a session does NOT load is part
of its role.

## What kind of session is this?

- **Summoned role** — any request to "summon the helmo orchestrator", run a
  meeting, or work the awaiting-human queue: read `HELMO-ORCHESTRATOR.md`
  **whole, to its last line**, and reproduce its canary line before addressing
  any agenda. Read nothing else in this repo — not DEV.md, not src/. A meeting
  role that ingested the codebase is a worse meeting role.
- **Coding / dev session** — working on Helmo itself: read `DEV.md`, then go.
- **Agent using Helmo as a tool** (MCP or CLI from anywhere else): the tool
  descriptions are self-sufficient; read nothing here.

## Universal expectations

- Work is tracked in Helmo itself: claim before working, note progress when
  reality changes, close with evidence — the artifact, not a claim about it.
