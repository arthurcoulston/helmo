# DEV — coding context for helm

Helm is the shared work record for Arthur's agents and himself: tickets that
agents write and the human reads. The human never edits — steering happens in
orchestrator meetings and the read-only view. Product intent:
`helm-product-description.md`; design rationale: `helm-v0-design.md`.

## Architecture (src/, ~1.5k lines, zero-dependency philosophy)

- `store.ts` — the heart: SQLite store (better-sqlite3), append-only event log
  with a global `seq` cursor (Capstan's wake signal rides on it), ticket
  materialization, blocking/ready computation, actor validation.
- `server.ts` — MCP stdio server. **Tool descriptions carry the behavioral
  contract for every agent** (triage duty, evidence rules, question quality);
  treat description edits as seriously as code — they are guidance-as-deployed.
- `cli.ts` — programmatic write path for non-MCP writers (H-10); Capstan uses
  it for wake-checks and escalations.
- `view.ts` — the read-only dashboard at :4400 (H-2). Read-only is
  constitutional: no affordance on that page may mutate anything.
- `types.ts` — the shared vocabulary (statuses, blast radii, confidence).

## Commands

- `npm run build` (tsc → dist/), `npm test` (store + e2e against a temp db).
- View: `node dist/view.js` (port via `HELM_VIEW_PORT`, default 4400). Restart
  it after rebuilding — the running process holds old code.
- Store lives at `~/.helm/helm.db` (`HELM_DB` overrides). Agent identity comes
  from `HELM_ACTOR` env (JSON) for loops; the interactive user-scope env is
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

Capstan supervises the loops that work this record (`~/projects/capstan`);
agent identities live in `~/projects/crew`. Map: `~/projects/crew/FLEET.md`.
