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
  deliberate quoting must break the tag. Date gate (H-732): a ticket carrying `not_before` is
  withheld from every ready queue until that instant and reported alongside
  `awaiting_triage` under `gated`, with its release date — withheld, not
  hidden. It exists because the only way to say "cannot start yet" was
  shouting it in the body, and every queue reader paid a full ticket read to
  learn it must not act (H-718 was claimed and released seven times in one
  day). The gate does NOT block the claim: a human, or an agent with cause,
  can still work it early — the queue's job is to stop offering, not to
  forbid. It also does not touch `scopeChangedSince`, deliberately: a gate
  opens on a clock tick, not an event, so a wake suppressed on gated tickets
  would never fire when the date arrives. Ready routing rule (H-661): in a
  caller's ready queue a workstream filter scopes only the unassigned pool —
  a ticket assigned to the caller is ready wherever it lives. ANDing the
  filter over the assignee clause left cross-workstream assignments invisible
  to rev loops forever: the wake fired (scopeChangedSince ORs the same
  clauses) while ready said 0. Seat holds (H-558): `seatHolds`/`seat-check`
  reports each in_progress ticket in a name with the actor that claimed it —
  the claiming actor's `session` stamp is how rev's same-seat guard tells a
  loop's own mid-flight work from a desk session sharing the crew name.
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
- **Nothing writes to the store but Helmo**, enforced (H-448). A PreToolUse
  hook, `~/.claude/hooks/protect-stores.sh`, denies write-class tool calls that
  reach into `~/.helmo` or `~/.helmo-roadmap` directly — the same shape as the
  sovereign guard, and the sole effective layer under `bypassPermissions`.
  Reads pass: a read is how you diagnose, a write is how you corrupt. The front
  doors are untouched, because they name the executable rather than the store:
  the CLI, the MCP server, and rev's own metering all go straight through. Test
  suite and a reviewable copy live in `crew/tools/store-guard/`; the hook itself
  is not in git, which is a gap noted on H-448.
- **`purge-orphan` is the only sanctioned deletion**, and it is deliberately
  narrow (H-448): it removes a ticket row ONLY if the event log has no events
  for it. That is the whole safety property — a row with no events is not a
  ticket, it is a write from outside, and removing it takes nothing from the
  log. A row with even one event is refused, at any bar; history is not deleted
  here. It requires `--confirm` and prints the removed row so the deletion can
  be undone by hand. It exists so that the answer to a corrupt row is never
  "run some SQL", which is the habit that caused the incident in the first
  place.
- **Ids: the table gets a vote** (H-448). `mintId` takes
  `max(next_id, highest existing H-n + 1)`. Trusting the counter alone made a
  single already-issued id unrecoverable — the INSERT collides, the transaction
  rolls back, the counter rolls back with it, and the same id is minted forever.
  Because `wake-check` materializes due recurring instances, that blocked every
  harness poll in the estate, not just writes: on 2026-08-27 one bad row took
  the whole fleet down for forty minutes. A counter found behind the table is
  reported to stderr and surfaced by the `orphan_ticket` hygiene check — a row
  with no events was not written by Helmo, and repairing someone else's write
  is a human's call, not this store's.
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
- `feed.ts` — the queue reading as JSON, served by `view.ts` at
  `GET /tickets.json` (R-11 H-832). It exists for ONE consumer, the estate
  shell, and for one reason: the shell proxies every other product view
  untouched, but Arthur's Meeting B decisions land Helmo's phone view on a
  filter and replace its answer control with a line of prose — neither of
  which you can do to someone else's HTML from outside it. So Helmo hands over
  the data and lets the shell draw it, rather than the shell opening this
  store and taking a second hand on the record. Same shape as the health page
  reading rev's loop states at :4500 rather than re-deriving them.
  **It is not an API for agents** — they have the MCP tools, which write as
  well as read and enforce the actor identity this cannot — and it is not a
  mirror of the record: no body, no evidence, no events, no answer nonce.
  Bounded at the source (everything live plus the `CLOSED_TAIL` most recently
  closed, ~12KB on Arthur's store), because closed work is history and the
  record of it is the page beside it. `asks` is keyed on the STATUS rather
  than on the question column: "asks you" is a claim about now. It needs no
  new route in the shell — `/s/helmo-view/` is already proxied GET-only, so
  the feed rides the prefix Helmo is already served at, and this port stays as
  unexposed as it was. `markFor` lives here and `view.ts` draws by it, so the
  JSON and the HTML cannot disagree about who has a face.
  That same prefix makes this page a **phone** page (H-880): the shell's Helmo
  view lands on the bounded reading, and its "whole record" tap goes to
  `/s/helmo-view/` — this HTML, at 390px. So every row here has to survive a
  phone width; the stat bar wraps and evidence refs break rather than pushing
  the document wider. Nothing checks it — the estate's route × viewport sweep
  covers the shell's own views, not the product pages it proxies — so a new
  `white-space: nowrap` or a fixed-width row is the shape to watch, and
  `node tools/shoot.mjs http://localhost:4400/ out.png --w 390 --fold` from the
  estate repo is how to see it.
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
  Skip-if-in-motion, checked and inserted in ONE immediate transaction (two
  readers spawned twins, H-169); after downtime only the latest missed slot
  spawns. An instance in_progress, awaiting_human, or carrying a human answer
  blocks the next slot; a plain open instance nobody started is superseded
  (cancelled by the scheduler) when the next slot comes due — before H-618 it
  silently stalled the schedule for as long as it sat unworked.

## Commands

- `npm run build` (tsc → dist/), `npm test` (store + e2e against a temp db).
- `npm run vendor:tokens` / `npm run vendor:avatars` refresh the vendored
  estate design tokens and crew avatar sprite; add `-- --check` to fail on
  drift instead. See below.
- View: `node dist/view.js` (port via `HELMO_VIEW_PORT`, default 4400; binds
  127.0.0.1 — `HELMO_VIEW_HOST` to change). Restart it after rebuilding — the
  running process holds old code.
- Store lives at `~/.helmo/helmo.db` (`HELMO_DB` overrides). Agent identity comes
  from `HELMO_ACTOR` env (JSON) for loops; the interactive user-scope env is
  deliberately name+kind only, so interactive writes must pass a truthful
  per-call `actor` override (name, model, harness version) or be rejected (H-3).
  The two compose rather than replace (`writingActor` in types.ts, used by both
  the MCP and CLI paths): identity is the caller's to state, but the `session`
  stamp comes from the env, because it says which PROCESS is writing and no
  agent can know its own. An override that stripped it wedged a loop for 24h
  against its own finished claim (H-687).

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
- `listTickets` sorts terminal statuses last, then priority, then age — agents
  are told to open every iteration with `{assignee: <name>}`, and a first page
  of closed tickets reads as an empty queue (H-258, then H-669). The view
  buckets by status, so it is indifferent to the key; anything new that pages
  results is not.
- Every write transaction runs `.immediate()`, and that is load-bearing. These
  transactions read before they write (minting an id, loading a ticket), so a
  deferred begin asks for the write lock partway through — an upgrade SQLite
  refuses with an instant SQLITE_BUSY instead of waiting, so `busy_timeout`
  never applies. Drop an `.immediate()` and concurrent writers start throwing
  again under contention, with every non-contending test still green (H-134).
  The tests guarding this spawn a real second process to hold the lock, and
  they wait for that process to print `HELD` rather than sleeping a fixed span.
  A sleep is a race the harness loses under load — the write then meets no lock,
  finishes in a millisecond, and the suite reports the store broken when nothing
  was tested at all (H-681). Any new contention test wants the same handshake.

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
  knows nothing about what writes it. A summoned agent relaying a decision
  the human made live in the room writes as kind "orchestrator" with the
  provenance naming the human and the session — that is what orchestrator
  means here, not a workaround (H-413; first used for roadmap R-8).

## The estate design tokens (R-11 H-714)

`src/estate-tokens.generated.ts` is a **vendored copy** of the estate shell's
`tokens/estate-tokens.css` — the source of the visual system every estate
surface shares. `scripts/vendor-estate-tokens.mjs` refreshes it (also
`--check`); `test/estate-tokens.test.ts` fails on drift.

Vendoring, not importing, is the point: Helmo is published standalone, so a
clone with no estate checkout beside it must build and run unchanged. That is
also why the drift test uses `it.skipIf` rather than an early return — with no
source to compare against it reports **skipped**, which is visible in the run
summary, where a `console.log` from a passing test is not. The runs that judge
the copy are Arthur's machine and estate CI.

The copy is verbatim, and the script refuses a source containing a backtick or
`${` rather than escaping it. If a token file ever needs translating to be
usable here, that is a change to make in the estate's generator, once — not
four times in four products.

**What was adopted, and what was not.** `view.ts` keeps every one of its own
token names and not one of its ~90 rules changed; the aliases at the top of
`CSS` are the whole seam, so a look ratified upstream restyles this page
without it being touched. Adopted: surfaces (`--page`, `--surface`), the ink
ladder, `--hairline`, and the radius ramp (`--radius-card` / `-inner` /
`-control` are the estate's `--radius` × 1 / 0.8 / 0.6). Helmo's middle ink is
mixed from the estate's two, since shadcn has no third step.

Status colours and the interactive `--link` blue were held back at first —
shadcn's neutral base ships no status ramp, and its own `--accent` is a hover
*surface*, not an interactive colour. The estate grew both of its own in H-771,
so they alias like everything else now and Helmo's dark overrides for them are
gone: the estate's ramp is themed.

Two values moved in that swap, both because Helmo renders as **text** what the
reference palette specifies as a chart mark. `--warning` was `#fab219`, 1.83:1
on white, and it is this page's headline figure and badge ink; `--serious` was
`#ec835a` at 2.64:1. Both take the estate's deepened light step. Colour still
always rides with a text label, never alone.

`test/estate-tokens.test.ts` now also asserts **no bare hex below the seam** —
every colour here is a token, so a literal is a value picked against one theme
and shown in both. Two had shipped: white on the send button, which is 3.64:1
on the dark link blue (`--interactive-foreground` fixes it), and an amber
falling back from a `--hot` that was defined nowhere in the file.

Two collisions had to be resolved, because the vendored file lands on `:root`
ahead of Helmo's own block: `--muted` and `--accent` exist in both with
*different meanings* (surface vs text; hover surface vs link). Helmo's are now
`--ink-3` and `--link`. Helmo's `--border` was folded into `--hairline` — the
estate has one border token and the two were the same value under it.

**One trap, learned adopting the same seam into the roadmap.** An alias that
comes out self-referential (`--hairline: var(--hairline)`) is
*guaranteed-invalid* in CSS: the property ends up with no value, every rule
using it is dropped, and nothing goes red — the page just quietly loses all its
borders. `test/estate-tokens.test.ts` now asserts no seam alias resolves to
itself. The same file's prefers-color-scheme assertion was also tightened: the
token file emits two dark blocks now (surfaces, and the crew mark hues since
H-713), so the loose form was satisfied by the hues alone while the surfaces
lost their dark half.

## The crew avatars (R-11 H-714)

`src/estate-avatars.generated.ts` is a second vendored copy, on the same seam
and for the same reason: the estate's `avatars/crew-avatars.svg`, refreshed by
`scripts/vendor-estate-avatars.mjs`, checked by `test/estate-avatars.test.ts`.
The sprite is inlined into the page body and referenced with
`<use href="#crew-mason-agent">`. No colours come with it — a mark is
`currentColor` over `var(--crew-<name>)`, which the vendored **token** file
already defines, so the two copies interlock and neither carries a value the
other owns.

What the module adds beyond the copy is an *index*: `AVATAR_MARKS` and
`AVATAR_KINDS` are parsed back out of the composed symbols the sprite actually
carries, never hand-listed. That matters because everything in this area fails
silently — a `<use>` at a symbol that is not there draws nothing, with no
console error, no failed request and a 200 on the page. The vendor script
refuses a sprite with no composed symbols and a sprite that is missing any
mark at any kind, for the same reason.

**Shape says kind, colour says who, and the name is always there.** The frame
comes from `actor.kind` — a rounded square for an agent or orchestrator, a
circle only for a human. Kind is *read*, never inferred from a name:
`Store.actorKinds()` answers with the kind each name last wrote under, and the
timeline passes the kind its own event recorded, which is better still. A name
Helmo has never seen write gets no mark and renders as bare text; `person` is
the fallback mark for a human with no role mark, which is why `arthur` has one
and `helmo-scheduler` does not.

The hue is a retrieval accelerator, not an identifier — the estate measured its
own set and found ten members cannot have ten mutually distinguishable hues
(H-713), so a mark must never stand without its name. That is why exactly one
function, `actor()`, draws one, and why it takes the name it prints:
`test/estate-avatars.test.ts` asserts there is only one `#crew-` reference in
`view.ts` and that it sits beside `esc(name)`. `.actor { white-space: nowrap }`
is part of the same rule, not tidiness — a mark that wrapped away from its name
would be doing the thing the measurement says does not work.

Marks appear in three places, and deliberately not everywhere: the in-motion
card's holder, the timeline's actor, and the agent chain on done rows. The
quiet rows keep their assignee as plain text. Arthur's rail on the set was "be
measured, it could go too far".

## Neighbors

Rev (formerly Capstan), a sibling project, supervises the bash loops that draw work from this
record; it consumes the helmo-cli contract and injects the MCP server into
agent sessions. The estate shell (`~/projects/estate`, :4300) is the one
reader of `GET /tickets.json`; it also owns the design tokens and avatar
sprite this repo vendors. That seam is one-way and read-only — nothing in the
estate writes here, and the shell's own 405 is what makes that structural
rather than a promise. Operators keep their own agent identities and estate maps
outside this repo. helmo-roadmap is a client of this repo's MCP surface and
holds no code path into it; the seam above is the whole coupling.
