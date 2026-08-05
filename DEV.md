# DEV — coding context for helmo

Helmo is the shared work record for a human operator and their agents: tickets
that agents write and the human reads. The human never edits — steering happens in
orchestrator meetings and the read-only view. Product intent:
`helmo-product-description.md`; design rationale: `helmo-v0-design.md`.

## Architecture (src/, ~1.5k lines, zero-dependency philosophy)

- `store.ts` — the heart: SQLite store (better-sqlite3), append-only event log
  with a global `seq` cursor (Capstan's wake signal rides on it), ticket
  materialization, blocking/ready computation, actor validation.
- `server.ts` — MCP stdio server. **Tool descriptions carry the behavioral
  contract for every agent** (triage duty, evidence rules, question quality);
  treat description edits as seriously as code — they are guidance-as-deployed.
- `cli.ts` — programmatic write path for non-MCP writers (H-10); Capstan uses
  it for wake-checks, escalations, and spend write-back (`record-spend` +
  `actor-tickets`, H-19). `spend` events are bookkeeping, not motion: they
  accept terminal tickets and never touch status or updated_at.
- `view.ts` — the read-only dashboard at :4400 (H-2). Read-only is
  constitutional: no affordance on that page may mutate anything. Shows the
  needs-grooming strip from `store.hygiene()` (H-23) — six deterministic
  record checks, also queryable via `helmo-cli hygiene`; hygiene is judgment-free
  by design, the judgment half of cultivation stays human/agent.
- `types.ts` — the shared vocabulary (statuses, blast radii, confidence).
- `schedule.ts` — recurring-ticket schedules (H-22): 'every N<m|h|d>' or 5-field
  cron, UTC. A ticket with `schedule` set is a TEMPLATE — standing work, never
  ready itself. Instances spawn lazily on ticket-list reads (the read path is
  the clock; no daemon), linked via parent dep, actor `helmo-scheduler`.
  Skip-if-open; after downtime only the latest missed slot spawns.

## Commands

- `npm run build` (tsc → dist/), `npm test` (store + e2e against a temp db).
- View: `node dist/view.js` (port via `HELMO_VIEW_PORT`, default 4400). Restart
  it after rebuilding — the running process holds old code.
- Store lives at `~/.helmo/helmo.db` (`HELMO_DB` overrides). Agent identity comes
  from `HELMO_ACTOR` env (JSON) for loops; the interactive user-scope env is
  deliberately name+kind only, so interactive writes must pass a truthful
  per-call `actor` override (name, model, harness version) or be rejected (H-3).

## Invariants that bite

- The event log is append-only; never mutate history. Everything the view and
  agents believe is derived from it.
- `blocks` deps point FROM the waiting ticket TO its prerequisite.
- Done-without-evidence is accepted but flagged — keep it that way; the flag
  is the feature.
- Tool-description changes deploy on the next session spawn (loops get them
  immediately; running sessions keep the old text).

## Neighbors

Capstan, a sibling project, supervises the bash loops that draw work from this
record; it consumes the helmo-cli contract and injects the MCP server into
agent sessions. Operators keep their own agent identities and estate maps
outside this repo.
