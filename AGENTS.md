# AGENTS — session routing for helm

Canonical apparatus file (vendor-neutral). `CLAUDE.md` is a shim pointing here.
The context envelope is a design decision: what a session does NOT load is part
of its role.

## What kind of session is this?

- **Summoned role** — any request to "summon the helm orchestrator", run a
  meeting, or work the awaiting-human queue: read `HELM-ORCHESTRATOR.md`
  **whole, to its last line**, and reproduce its canary line before addressing
  any agenda. Read nothing else in this repo — not DEV.md, not src/. A meeting
  role that ingested the codebase is a worse meeting role.
- **Coding / dev session** — working on Helm itself: read `DEV.md`, then go.
- **Agent using Helm as a tool** (MCP or CLI from anywhere else): the tool
  descriptions are self-sufficient; read nothing here.

## Universal expectations

- Work is tracked in Helm itself: claim before working, note progress when
  reality changes, close with evidence — the artifact, not a claim about it.
- Cross-project context (dev sessions only): `~/projects/crew/FLEET.md`.
- `~/projects/make-ai-good` and the `mag-*` repos are **sovereign** — no
  writes, ever, by anyone here. Denials from the guard are the boundary
  working; never route around them.
