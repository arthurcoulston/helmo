# DEV — coding context for helmo

Helmo is the shared work record for a human operator and their agents: tickets
that agents write and the human reads. The human never edits — steering happens in
orchestrator meetings and the read-only view. Product intent:
`helmo-product-description.md`; design rationale: `helmo-v0-design.md`.

## Architecture (src/, ~1.5k lines, zero-dependency philosophy)

- `store.ts` — the heart: SQLite store (better-sqlite3), append-only event log
  with a global `seq` cursor (Rev's wake signal rides on it), ticket
  materialization, blocking/ready computation, actor validation. Stop
  discipline (H-55): workstream steering (goal + budget_usd, human/orchestrator
  writes only, evented as `workstream_set` under `ws:<name>`) and the ready-
  queue triage rule — a ticket is withheld from its own filer's ready queue
  until another actor touches it (scheduler instances are judged by their
  template; scheduler and `spend` events never count — clock and meter are
  not judgment, H-242), so an agent's queue is never fed solely by that agent. Since
  H-56 the claim path enforces the same rule for agent actors — takeover
  never bypasses self-triage; create-with-in_progress stays legitimate.
  Mangled-write gate (H-71): free-text fields carrying tool-call parameter
  markup are rejected at the door — that markup is the signature of a
  mis-serialized call whose later fields would be silently swallowed;
  deliberate quoting must break the tag.
- `tools.ts` — the MCP tool surface, registered identically by both entry
  points below (H-116). **Tool descriptions carry the behavioral contract for
  every agent** (triage duty, evidence rules, question quality); treat
  description edits as seriously as code — they are guidance-as-deployed, and
  they live here and only here so local and remote agents can never drift.
- `server.ts` — MCP stdio entry (local agents; thin wrapper over tools.ts).
- `remote.ts` — MCP Streamable HTTP entry (H-116): same tools, for remote
  agents reaching Helmo through the crew-mcp worker (OAuth front door) over
  cloudflared. Binds 127.0.0.1:4401 (`HELMO_REMOTE_PORT`), refuses to start
  without `HELMO_REMOTE_TOKEN` (min 24 chars) and 401s anything not bearing
  it — the tunnel is never trusted alone. Stateless per-request servers,
  POST-only. No `HELMO_ACTOR` fallback on this path: remote writes must carry
  a truthful per-call actor (H-3) or be rejected.
- `cli.ts` — programmatic write path for non-MCP writers (H-10); Rev uses
  it for wake-checks, escalations, and spend write-back (`record-spend` +
  `actor-tickets`, H-19; `actor-activity --advancing` answers "did this
  actor MOVE anything" — a note-only update is excluded, because a harness
  that counts "still blocked, nothing to do" as production re-certifies its
  loop as busy and buys another iteration, H-412; `actor-spend` lets the meter net out what the agent
  self-reported so a session lands in the totals exactly once, H-57 — negative
  spend events are reconciliations, keep accepting them; `by_ticket` lets the
  meter cancel each guess where it sits, H-187). `record-spend` floors a total
  at zero and marks the event CLAMPED — a negative total is bad arithmetic
  upstream, never a record. `spend` events are
  bookkeeping, not motion: they accept terminal tickets and never touch status
  or updated_at.
- `view.ts` — the dashboard at :4400 (H-2). The constitutional line, restated
  with Arthur in H-90: the page carries no record DATA-ENTRY (agents write
  the record), but answering an awaiting_human question is operator steering
  — the ONE mutation the page may perform, via POST /answer through
  store.answerTicket with a human actor named by HELMO_OPERATOR (unset =
  fully read-only; the env var is the deliberate switch). The route is gated
  against browser CSRF (H-145): JSON content-type + a custom header force a
  preflight the server never answers, Origin/Sec-Fetch-Site are checked when
  present, and a per-boot nonce the page carries must be echoed — friction
  against a forged one-liner, NOT a wall against local agents (same-user
  box; ward's threat model). Dashboard answers render marked as such. Everything else
  stays disclosure toggles and evidence links; add no other write affordance. Shows the
  needs-grooming strip from `store.hygiene()` (H-23) — eight deterministic
  record checks (silent_assignee, H-61, watches open reservations whose
  assignee has written nothing for 7d or never — typo/rename/retirement in one
  rule), also queryable via `helmo-cli hygiene`; hygiene is judgment-free
  by design, the judgment half of cultivation stays human/agent. Since H-81
  that judgment has a recording surface: `helmo-cli hygiene-dispose` writes an
  evented, append-once disposition for a finding on a TERMINAL ticket and the
  sweep stops re-reporting it (open tickets clear by being acted on, so
  dispositions there are refused — nothing live can be masked). Also H-81:
  done_without_evidence exempts question tickets the human closed via
  helmo_answer_ticket — the recorded answer is the closure evidence.
- Evidence ref form (H-95): commit = `repo@sha` (`crew@24e8003`), one commit
  per item; file = absolute or `repo:relative/path`, never bare-relative; url
  as-is; other/draft free text. Prose belongs in the item's `note`. The point
  is legibility, not parsing — Arthur's ruling (H-4, cancelled 2026-08-15) is
  that evidence exists for documentation and to make the closing agent ask
  "is this complete?", NOT to catch dishonesty, so there is no verifier and a
  ref that later dangles is not a defect. Evidence is a point-in-time receipt.
  The 08-06 corpus audit is archival; do not retrofit it (its rename map is in
  crew/agents/mason/workspace/h4-evidence-audit-20260806.md).
- `types.ts` — the shared vocabulary (statuses, blast radii, confidence).
- `schedule.ts` — recurring-ticket schedules (H-22): 'every N<m|h|d>' or 5-field
  cron, UTC. A ticket with `schedule` set is a TEMPLATE — standing work, never
  ready itself. Instances spawn lazily on ticket-list reads (the read path is
  the clock; no daemon), linked via parent dep, actor `helmo-scheduler`,
  always unassigned (a reserved template stalled three listens, H-171).
  Skip-if-open, checked and inserted in ONE immediate transaction (two
  readers spawned twins, H-169); after downtime only the latest missed slot
  spawns.

## Commands

- `npm run build` (tsc → dist/), `npm test` (store + e2e against a temp db).
- View: `node dist/view.js` (port via `HELMO_VIEW_PORT`, default 4400; binds
  127.0.0.1 — `HELMO_VIEW_HOST` to change). Restart it after rebuilding — the
  running process holds old code.
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
- Workstream budgets are disclosure, never enforcement: nothing in the store
  may block a write because a budget is spent — recording reality always wins.
  The agent-kind rejection in `setWorkstream` is the one hard rule (an agent
  must never steer its own stream).
- Tool-description changes deploy on the next session spawn (loops get them
  immediately; running sessions keep the old text).
- Every write transaction runs `.immediate()`, and that is load-bearing. These
  transactions read before they write (minting an id, loading a ticket), so a
  deferred begin asks for the write lock partway through — an upgrade SQLite
  refuses with an instant SQLITE_BUSY instead of waiting, so `busy_timeout`
  never applies. Drop an `.immediate()` and concurrent writers start throwing
  again under contention, with every non-contending test still green (H-134).

## The roadmap seam (H-172)

Three additions carried for helmo-roadmap (the sibling layer-above-the-ticket
at ~/projects/helmo-roadmap), each independently useful to a Helmo-only user
and together a public API commitment — resist widening past them:

- an optional `project` tag on tickets (create/update; '' clears), another
  grouping string alongside workstream and the join key for cost rollups;
- a `project` filter on the ticket query;
- the standing notice: one line of current priority with provenance, stored
  via `notice_set` events and riding on every helmo_list_tickets response the
  way workstream steering does. `helmo_set_notice` is operator steering —
  agent-kind writes rejected in the store, same rule as setWorkstream — and
  the notice is disclosure, not tasking: it never authorizes work. Helmo
  knows nothing about what writes it.

## Neighbors

Rev (formerly Capstan), a sibling project, supervises the bash loops that draw work from this
record; it consumes the helmo-cli contract and injects the MCP server into
agent sessions. Operators keep their own agent identities and estate maps
outside this repo. helmo-roadmap is a client of this repo's MCP surface and
holds no code path into it; the seam above is the whole coupling.
