# AGENTS — session routing for helmo

Canonical apparatus file (vendor-neutral). `CLAUDE.md` is a shim pointing here.
The context envelope is a design decision: what a session does NOT load is part
of its role.

One repository holds three products — Work, Roadmap and Runtime — plus the
`core` they share. A session reads the routing below, then the one file its
role names, then that area's `DEV.md`. Nothing else here.

## What kind of session is this?

- **Summoned role — meetings and the awaiting-human queue.** Any request to
  "summon the helmo orchestrator", run a meeting, or work the awaiting-human
  queue: read `packages/work/HELMO-ORCHESTRATOR.md` **whole, to its last
  line**, and reproduce its canary line before addressing any agenda. Read
  nothing else in this repository — not `DEV.md`, not `src/`. A meeting role
  that ingested the codebase is a worse meeting role.
- **Summoned role — the running machine.** "Summon the watch officer", or any
  request to inspect or control running loops: read
  `packages/runtime/WATCH-OFFICER.md` **whole, to its last line**, and
  reproduce its canary line before acting. Read nothing else here — the watch
  officer operates sentinels and reads state; it does not need the TypeScript.
- **Coding / dev session** — working on Helmo itself: read `DEV.md` for what
  the whole product shares, then the `DEV.md` of the area you are changing
  (`packages/work`, `packages/roadmap`, `packages/runtime`, `packages/core`).
  Before designing, prototyping, implementing or reviewing any Helmo UI, also
  read `UI.md`. shadcn/ui is the required component foundation across the app;
  matching its colors or tokens alone is not component adoption.
- **Agent using Helmo as a tool** (MCP or CLI from anywhere else): the tool
  descriptions are self-sufficient; read nothing here.
- **Loop sessions** never start here — Runtime launches them in their own
  loop's cwd with their constitution injected; if that's you, your constitution
  already governs.

## Universal expectations

- Work is tracked in Helmo itself: claim before working, note progress when
  reality changes, close with evidence — the artifact, not a claim about it.
- Cross-project context (dev sessions only): load the host estate's project map
  when its enclosing instructions provide one.
- A project marked **sovereign** by its own or the enclosing instructions is
  read-only. Guard denials are the boundary working; never route around them.
