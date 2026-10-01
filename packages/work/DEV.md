# DEV — coding context for helmo

Helmo is the shared work record for a human operator and their agents: tickets
that agents write and the human reads. The human never edits — steering happens in
orchestrator meetings and the read-only view. Product intent:
`helmo-product-description.md`; design rationale: `helmo-v0-design.md`.

## Architecture (src/, ~1.5k lines, zero-dependency philosophy)

Shared installation and qualified-reference mechanics live in `packages/core`.
Every Helmo-family surface accepts `ROADMAP_LABEL`, `HELMO_LABEL`, then
`REV_LABEL`; multiple set keys must carry the same value or startup refuses.

- `store.ts` — the heart: SQLite store (better-sqlite3), append-only event log
  with a global `seq` cursor (Rev's wake signal rides on it), ticket
  materialization, blocking/ready computation, actor validation. Stop
  Workflow enforcement has an additive, instance-local persistence seam
  (H-429): immutable JSON definition revisions plus normalized run, attempt,
  manifest, requirement, decision, admission and terminal-outcome tables.
  Definition insertion rejects empty/duplicate stages, unknown prerequisites,
  cycles and revision replacement. These tables do not alter ordinary ticket
  semantics. The bounded decision seam (H-430) writes immutable manifests and
  requirements against one definition revision, then records decisions from
  the store-resolved actor only. Requirements bind one exact subject manifest,
  exact actor name + kind authorities, allowed verdicts and optional creator
  independence; mismatched manifests, aliases, self-review and cross-scope or
  repeated revocations refuse. Decision identity is bound when the service
  opens the store from its trusted runtime actor; the decision call and MCP
  schema accept no caller-supplied identity, and an unbound/remote service
  refuses the write. H-431 binds a ticket immutably to an optional
  `workflow_attempt_id`. Ordinary tickets remain unchanged; a bound ticket can
  enter execution only through one store-side admission transaction.
  Create-in-progress, claim, handoff, decision-answer resume and action-report
  resume all read the exact definition, stage prerequisites and current scoped
  decisions, record the admission, mark the attempt running and commit the
  ticket event under the same IMMEDIATE lock. The `launch-admit` CLI command
  applies that transaction before Rev starts a model session, returns ordinary
  ready work without synthesizing workflow state, and binds a workflow
  admission to one idempotent launch id. Missing, revoked/stale and failed
  requirements are returned as separate structured arrays. A racing revocation
  commits first and is observed, or the admission commits first; no queued
  snapshot can authorize the later write. Retry/outcome and invalidation
  behavior remain later slices. H-509 adds the recovery half of that protocol:
  `launch-receipt` resolves both immutable identities and expands only the
  captured requirement/manifest/decision evidence; `launch-revalidate` checks
  that exact authority and the attempt's complete current same-revision
  requirement set under one IMMEDIATE snapshot; and `launch-quarantine`
  idempotently invalidates only that exact launch attempt. Missing, mismatched,
  corrupt, superseded, or revoked evidence fails closed. H-433 makes terminal
  outcomes mutually exclusive and idempotent, and permits only rejected or quarantined attempts
  to create a new evidence-bound successor which must pass fresh admission.
  Explicitly named installations claim `meta.installation_name` atomically
  with their first event. Every writer, including a derived one, must match
  that claim; the path-derived `dev.helmo[.*]` name and shared `dev.rev[.*]`
  name are aliases only when the resolved home derives that exact pair. Other
  names refuse; reads remain available. Derived-only stores do not claim a
  durable name, preserving single-install use.
  discipline (H-55): workstream steering (budget_usd + seat, human/orchestrator
  writes only, evented as `workstream_set` under `ws:<name>`; numbers and
  names only — the prose `goal` was retired in H-1186, see the roadmap seam
  below) and the ready-
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
  would never fire when the date arrives. Capacity holds are the separate
  deliberate-spending gate: reason, authorization provenance, and a concrete
  reconsideration condition travel with the ticket. Held work remains visible
  under `capacity_held`, but is excluded from ready/wake counts and direct
  claims until a separate recorded update releases it; priority is unchanged.
  A later priority change releases the hold so changed urgency cannot remain
  concealed by an older spending judgment. A finite manual batch leaves that
  hold in place and adds a release carrying a shared batch id, expiry, stop
  conditions, and operator reserve. Only tickets explicitly given that release
  become ready; expiry makes open work held again without disturbing work
  already claimed. Date/dependency/human/reviewer gates remain independent.
  Human sittings (H-1028) are typed separately from questions: an open ticket
  with `needs_human` stays open, is withheld from every agent ready queue and
  reported under `with_human`; both Helmo readings place it below questions in
  “Awaiting you” — but only while the operator can actually reach it. An open
  blocker, a future `not_before` or an active capacity hold is the primary
  status, and the sitting falls to Blocked as a later step behind it (H-202):
  "if something is blocked and will need me after it is blocked, the block is
  the primary status, not the waiting for me". A live bounded release restores
  it, as does the last blocker closing; none of this clears its human-needed
  state. This is presence needed, not a decision waiting for relay.
  A question in `awaiting_human` is not demoted this way even with an open
  blocker: answering it is how the operator clears the block, so it stays where
  he can act on it.
  A caller that is about to return a concrete external operation may name an
  immutable `operation_manifest_id`. An operation manifest is complete only
  when it fixes target, recipient, tenant, data class, visibility, cost,
  effect, test-tenant evidence and registry-recipient evidence. If the exact
  operation is a verified test tenant and registry recipient using synthetic
  data, private visibility, no cost and a non-destructive effect, and a
  trusted, unrevoked workflow decision with scope `test_authority` stands on
  that exact manifest, Helmo records
  `human_return_covered` and leaves the ticket open instead of spending a
  human decision. Missing, changed, revoked or failed evidence follows the
  ordinary `awaiting_human` path. The manifest is authority for the described
  act only; it does not turn missing deployment or provider preparation into
  a permission question.

  `needs_human` is that sitting's one line, not a flag (H-1761): it takes the
  string saying what the sitting is for and roughly what it costs him, stored as
  `sitting` and rendered as the card's ask; `false` clears both, and
  `sitting_with` alongside it names the agent to sit with (R-42 I13) and clears
  with them. A bare `true`
  is refused, the way `return_to_human` refuses a return with no question — a
  marker with nothing to say drew a row that read like backlog, and five
  sittings went unnoticed. The line is a field and never the body's first
  paragraph: across every ticket that carried the marker, that paragraph was
  "why this exists" background, so scraping it prints the wrong thing
  confidently. Each of the three renders as its own hero card, and each NAMES
  its kind in words beside a glyph and a hue, because colour alone cannot carry
  three meanings to a reader who has not learned the palette (H-713): a
  decision is `.qcard` in amber with Ratify and its offered choices, an action
  is `.acard` in rust with "I've done it" and nothing that could read as
  approval, a sitting is `.scard` in blue naming `sitting_with` and carrying no
  control at all — the response to a sitting happens in the sitting. They are
  drawn in ascending cost to the operator: a word, his hands, his diary. The
  section splits `awaiting_human` on whether `action` is set rather than on the
  status, and everything that is not an action takes the decision path, so a
  row awaiting him with no readable request draws a card saying so instead of
  being counted in "awaits you" and drawn nowhere.
  Three kinds of request (R-42 I13, H-2521): the harness can ask the operator
  to DECIDE something, to DO something, or to sit down with an agent. It could
  not tell them apart, and the confusion was in the field as well as the prose
  — `parseSitting` asked for "what the human does", which is an action's line,
  while the desk-claim guard below reads the same flag as "the human is
  present", so H-2164 carries a sitting line saying no sitting is needed.
  An action sits on the `awaiting_human` axis, because a pending request with
  the claim released is what that status means. The one stored request column
  carries `kind`; a request without one reads as the decision it was, so no
  existing row is rewritten or reinterpreted. `Ticket` splits that column into
  `question` — the pending decision, unchanged in type and meaning — and
  `action`. External `get_ticket` consumers therefore keep the old decision
  shape. That split is what stops a reader knowing only
  about questions from offering Ratify on an action. `questionFingerprint`
  names its fields rather than serialising the request, so `kind` did not move
  the hash a dashboard built before kinds already drew. The dashboard answer
  route accepts either the old `{ratify: true}` or one letter produced by
  `presentation.ask`; it resolves that letter against the current stored
  options after checking the fingerprint. Labels, free text, invented letters,
  mixed answers and resolution changes are not an input shape, so exposing all
  offered choices does not restore the broad write capability removed in H-1053.
  `requestAction` requires `why_human`: an asker who cannot say why their own
  hands will not serve owes a decision instead. `reportAction` takes what the
  operator did and nothing else — no resolution, no chosen option — so by shape
  it resumes the work to the workstream seat but can never close a ticket,
  grant anything, or stand in for an agent's later verification. The two paths
  refuse each other rather than discarding the pending request: answering was
  once the only route and would have set `question = NULL` over the action.
  The dashboard's cards landed first, deliberately (H-2530): no tool or CLI
  door reaches either method yet, so no action request exists in any store —
  and had a door landed first, a pending action would have reached a renderer
  that drew nothing for it. `helmo_request_action` / CLI `action` now create
  that request; `helmo_report_action` / CLI `action-report` record a completion
  reported in conversation without asking for a second dashboard click. Create
  and update expose `sitting_with` beside `needs_human`; the decision door tells
  an asker whose question has no form-actionable recommendation to name that
  sitting and agent instead.
  Desk claim guard (H-1056): an agent actor with no `session` may file and
  update work but cannot claim an unmarked ticket, including by creating it
  `in_progress`; if it needs a ticket, the build belongs to a loop. Marking an
  open ticket `needs_human` in a separate update is the explicit sitting path.
  Remote MCP callers deliberately have no machine identity or session, so the
  same rule treats remote steering as desk work rather than a loop bypass.
  Ready routing rule (H-661): in a
  caller's ready queue a workstream filter scopes only the unassigned pool —
  a ticket assigned to the caller is ready wherever it lives. ANDing the
  filter over the assignee clause left cross-workstream assignments invisible
  to rev loops forever: the wake fired (scopeChangedSince ORs the same
  clauses) while ready said 0. Releasing a claim (H-954) keeps that routing:
  `status: 'open'` drops the claim and leaves the assignee standing, so a seat
  that puts unfinished work down finds it again next session. Clearing it made
  H-661's own fix moot for one iteration — H-952 was released for a fresh
  session, fell back to a pool nobody watched, and the seat idled on its own
  work. Returning to the unassigned pool is still real and now explicit:
  `handoff_to: ''`, spelled the way `project`/`not_before` already clear.
  Workstream seats (H-1026, H-1096): a workstream may carry a `seat` — operator
  steering like the budget, set by `workstream-set --seat` — and every
  unassigned filing in it, recurring instances included, is reserved to that
  seat at creation. Clearing a named receiver, resuming a human-returned ticket,
  or moving unassigned work into a seated stream applies the same default; the
  recorded assignment makes replay exact. An explicit assignee on a recurring
  template is deliberate instance routing and wins over the stream default;
  assignee-list reads omit the template itself and return its spawned instances,
  because the route is not a reservation of the standing work. The reason is the loop
  side: a rev loop draws only from
  its bound workstream's pool plus tickets in its name, so a pool in a stream
  nobody is bound to was ready to no one (fourteen clean tickets sat for days,
  H-1024). Seats do not bypass self-triage — the filer's own ticket still waits
  for another actor's touch. Hygiene reports `unseated_pool` once per stream
  that has unassigned open work and no seat, counting only work a seat could
  actually run: a pool entirely held for capacity or gated to a future date is
  withheld from every loop for a stronger reason, and asking for a routing
  decision there is a demand on the operator he has already answered (H-2556).
  Both gates are self-clearing, so the finding returns on its own. `seat: ''`
  clears it. Templates
  themselves stay unassigned (the H-171 stall was an inherited reservation to
  a loopless seat; a seat is a deliberate binding to a looped one).
  Human direction relayed by an orchestrator is judgment even when the relay
  carries the same agent name that filed the ticket (H-829); otherwise the
  name-only self-triage check makes Arthur's recorded answer invisible.
  Budget zero is the explicit uncapped sentinel (H-267): measured spend remains
  disclosed, `remaining_usd` is null because no finite remainder exists, and
  pressure checks leave runnable work runnable. Positive budgets retain finite
  remaining arithmetic and exhaustion guidance.
  Seat holds (H-558): `seatHolds`/`seat-check`
  reports each in_progress ticket in a name with the actor that claimed it —
  the claiming actor's `session` stamp is how rev's same-seat guard tells a
  loop's own mid-flight work from a desk session sharing the crew name.
  Product acceptance (H-884) is a second, explicitly invoked read over that
  event log: `product_completed` names immutable full `repo@commit` refs and
  their authors; `acceptance_verdict` records a non-author PASS or FAIL against
  exactly the latest refs. A new completion makes every older verdict stale.
  The projection itself lives in `acceptance.ts`, not here, because the replay
  that gates its rollout has to run the real decision rather than a copy.
  Ticket status and type are deliberately outside this calculation, so generic
  reviews can close normally and neither `done` nor prose saying PASS can stand
  in for product acceptance. Both events may be appended to terminal tickets;
  they never reopen or rewrite history. Caller identities and authors are
  provenance assertions, not authenticated identities. Body edits have two
  preserving modes alongside deliberate whole-field replacement:
  `body_append` adds exact text, while `body_patch` replaces one unique literal
  anchor and refuses a missing or repeated anchor before an event is written.
  Terminal tickets remain closed state: `updateTicket` accepts only append-only
  notes and evidence on them; every other field still refuses without changing
  the record (R-39 Q3/Q4, H-2439).
- `tools.ts` — the MCP tool surface, registered identically by both entry
  points below (H-116). **Tool descriptions carry the behavioral contract for
  every agent** (triage duty, evidence rules, question quality); treat
  description edits as seriously as code — they are guidance-as-deployed, and
  they live here and only here so local and remote agents can never drift.
  Every tool's arguments go through `strict()`, so an undeclared key is refused
  during validation instead of stripped (R-39 Q9): handed a raw shape the SDK
  wraps it in a plain object, and `capacity_hold` on a create or a misspelled
  `projekt` returned a new ticket ID with the field quietly unset. The refusal
  happens before the handler, so the record is untouched — and `tools-surface`
  fails if any tool is left off the rule. It is the same rule `cli.ts` enforces
  over its flags; a strict schema also publishes `additionalProperties: false`
  in `listTools`, which is what an agent reads before it guesses at a field.
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
- `cli.ts` — programmatic write path for non-MCP writers (H-10). Its flag
  parser refuses a value-taking flag written bare and a bare flag written with
  a value (H-1783): `--needs-human` last on the line used to read as undefined,
  indistinguishable from never passed, so the write landed with the field
  silently unset and the failure looked exactly like success for a day (H-1782).
  A value that itself begins with `--` must therefore use `--flag=value`, which
  is what the callers passing free text do (`crew:tools/estate/memo-drain.mjs`,
  `crew:tools/github-listen.mjs`). `COMMAND_FLAGS` closes the other half of the
  same silence (R-39 Q9): a flag the command has no field for is refused before
  anything is read, because `flag()` returns undefined for a flag nobody
  declared and undefined is what "not passed" looks like — `create --project
  R-41` filed an untagged ticket and `update --assinee mason` reserved nobody,
  both exiting 0. The lock runs both ways, so the table cannot drift behind the
  code: `flag()`/`has()` refuse a name their own command does not declare, which
  reddens in the suite rather than in front of a caller. There are still fields
  the MCP surface takes and this one cannot (`capacity_hold`, `confidence` on
  create, an edge — H-2225); the refusal now says so instead of dropping them. Rev uses
  it for wake-checks, escalations, and spend write-back (`record-spend` +
  `actor-tickets`, H-19; their optional `--session` filter lets Rev isolate
  its stamped loop session from desk work under the same actor name (H-878);
  `actor-activity --advancing` answers "did this
  actor MOVE anything" — a note-only update is excluded, because a harness
  that counts "still blocked, nothing to do" as production re-certifies its
  loop as busy and buys another iteration, H-412; `actor-spend` lets the meter net out what the agent
  self-reported so a session lands in the totals exactly once, H-57; it carries
  the same session filter — negative
  spend events are reconciliations, keep accepting them; `by_ticket` lets the
  meter cancel each guess where it sits, H-187). `record-spend` floors a total
  at zero and marks the event CLAMPED — a negative total is bad arithmetic
  upstream, never a record. `spend` events are
  bookkeeping, not motion: they accept terminal tickets and never touch status
  or updated_at. `answers --since-seq N [--session S]` replays recorded
  answers from a cursor and returns `max_seq` from the same read, so a caller
  advances its checkpoint without a second query: it exists so ward's daily
  sweep can audit dashboard-session answers — the one channel that writes as
  the human without a meeting — through this front door instead of opening
  helmo.db with sqlite3 (H-143 detection, H-936 boundary).
  `verdicts --since-seq N [--actor A] [--workstream W]` is the same replay for
  the other write that can let work through unread: an acceptance verdict is
  recorded in the reviewer's name by a caller-supplied actor, so every one is
  shown back to the reviewer it names (H-1830). Oldest first, `max_seq` from
  the same read, `note` truncated like `answers`. The join to tickets is a LEFT
  one on purpose — a verdict whose ticket row has been deleted underneath it is
  the loudest thing this read can find, and an inner join would make the tidiest
  forgery the quietest. `--actor` here is a reviewer's NAME, not the identity
  JSON every other command reads from that flag; an identity passed by habit is
  refused rather than silently matching nobody.
  The Store's bounded `newlyReadySince` read supports the event-driven half of
  wake-check: it intersects the canonical current-ready set (up to 1,000 IDs)
  with readiness-causing events after the cursor, plus date gates that crossed
  after that event's timestamp. Two indexed event queries cover direct route /
  gate changes and blocker closure; notes, spend, unrelated close-out, and
  self-filed untouched work cannot enter through that intersection. The first
  non-meter touch by another actor (or a human/orchestrator relay) is also an
  edge: it releases self-triage for the filing or its recurring template;
  subsequent notes stay inert. `wake-check`
  exposes both sets as `ready_ids`/`ready_count` and
  `newly_ready_ids`/`newly_ready_count`; Rev uses the edge for immediate wakes
  and the current set for periodic reconciliation. Existing `max_seq`,
  `held_count`, and `changed_since` fields remain compatible (H-1098).
  All of it comes from `Store.wakeCheck`, one IMMEDIATE transaction over one
  ready read. Assembled as separate statements it was not one snapshot: each
  took its own WAL view, and a handoff committing partway through appeared in
  some fields and not others — rev logged a wake whose line read `ready=0`, and
  a `max_seq` read after the ready set can send a seat back to idle at a cursor
  past the handoff, which is the wake lost outright (H-1895). Anything added
  here belongs inside that transaction, derived from the ready set already in
  hand rather than re-queried.
  `acceptance-check --ticket H-n --refs '["repo@<40hex>"]'` is the release
  process seam: it exits zero only when an independent PASS covers that exact
  manifest. `product-complete` and `acceptance-verdict` record the two halves.
- `view.ts` — the dashboard at :4400 (H-2). The constitutional line, restated
  with Arthur in H-90: the page carries no record DATA-ENTRY (agents write
  the record), but answering an awaiting_human question is operator steering
  — via POST /answer through
  store.answerTicket with a human actor named by HELMO_OPERATOR (unset =
  fully read-only; the env var is the deliberate switch). Since H-2530 there is
  a second, and only a second: POST /acted (`acted.ts`, `test/acted.test.ts`)
  records that a pending ACTION was carried out. It stays a separate endpoint
  rather than a branch of the first, because collapsing them would put the
  free-text capability H-1053 removed back within reach of whichever branch was
  written less carefully. Its whole payload is `{ticket_id, done: true,
  action_fingerprint}` — it cannot carry an answer, a resolution, a chosen
  option or any words, so the `did` it stores is written by the route: it says
  the report came from the dashboard with no words added and quotes the request
  as asked, which is the most a click can honestly claim. Both routes are gated
  against browser CSRF (H-145): JSON content-type + a custom header force a
  preflight the server never answers, Origin/Sec-Fetch-Site are checked when
  present, and a per-boot nonce the page carries must be echoed — friction
  against a forged one-liner, NOT a wall against local agents (same-user
  box; ward's threat model). The route itself lives in `answer.ts` so its
  refusals are testable without a socket (`test/answer.test.ts`), and since
  H-1053 it can record only an answer the current decision card itself offers:
  the old `{ticket_id, ratify: true, question_fingerprint}` remains the default,
  and `{ticket_id, choice: <letter>, question_fingerprint}` selects from the
  stored options through `presentation.ask`'s shared lettering. The
  free-text/resolution payload of the removed form stays gone, because a
  route reachable from the phone that can close or cancel a ticket as Arthur
  is a capability the UI's shape does not narrow (ward's review). The
  fingerprint (`feed.questionFingerprint`, carried in `asks.fingerprint`) is
  the ask the clicker was looking at; `answerTicket` re-checks it INSIDE the
  write transaction, so a card answered and re-asked while it sat on a phone
  cannot answer the new question in the human's name. A response outside the
  offered set is still a meeting. Dashboard answers render marked as such. Everything else
  stays disclosure toggles and evidence links; add no other write affordance. Shows the
  needs-grooming strip from `store.hygiene()` (H-23) — twelve deterministic
  record checks. `awaiting_second_eyes` (H-1069) makes every currently ready,
  self-filed ticket visible store-wide until another actor judges it; this
  closes the gap where reservation to the filer hid the work from both the
  filer and the cultivating seat. `silent_assignee` (H-61) watches unblocked
  open reservations whose assignee has written nothing for 7d or never —
  typo/rename/retirement in one rule. A live blocker already explains the lack
  of motion; when it closes, an untouched reservation becomes visible to the
  check automatically (H-1900). Findings are also queryable via
  `helmo-cli hygiene`; hygiene is judgment-free
  by design, the judgment half of cultivation stays human/agent. Since H-81
  that judgment has a recording surface: `helmo-cli hygiene-dispose` writes an
  evented, append-once disposition for a finding on a TERMINAL ticket and the
  sweep stops re-reporting it. Open tickets clear by being acted on, so
  dispositions there are refused — with one exception, `spend_anomaly`
  (H-1715). Every other check reports a state that either holds or does not,
  and masking one on live work could hide a real problem indefinitely; spend
  is a number that only grows, and "this cost is accounted for" stays true
  until the number moves. So a live acknowledgement records the figure it
  answered for (`hygiene_dispositions.at_cost`) and the finding returns on its
  own once the ticket has cost `SPEND_ACK_REGROWTH` times that — then it can
  be acknowledged afresh, which is the one case where the row is updated
  rather than appended. Without it a long-lived blocked ticket that trips the
  check re-surfaces every sweep, and each re-reading is itself metered onto
  the ticket: H-1570 took thirteen near-identical "accounted for" notes in a
  day, from several harnesses, because a note is not something the check can
  read. Also H-81:
  done_without_evidence exempts question tickets the human closed via
  helmo_answer_ticket — the recorded answer is the closure evidence.
  H-758 exposes both halves to loop agents as `helmo_hygiene` and
  `helmo_dispose_hygiene_finding`; they need neither shell access nor a second
  path into the store. `spend_anomaly` compares one-off tickets only: recurring
  templates accumulate every run's cost indefinitely, so they are neither
  candidates nor peers for a per-ticket norm (H-1124). `unaccounted_work`
  (H-1126) lists every startable open ticket carrying no `project` tag, no
  `obj:OBJ-n` label and no stream that accounts for itself (`security`;
  recurring instances, whose template holds the why) — so a sweeping agent
  starts from a list instead of reading the queue. It judges nothing further:
  whether the accounting is honest, and how it sits against roadmap status,
  is the sweeper's call from a roadmap Helmo deliberately cannot see. The
  finding clears the moment the ticket is tagged, labelled, held, returned to
  the human, blocked or gated.
  Ready and Blocked are the queue's reading, not a second one (H-2321): a
  ticket is offered only when no open blocker, no future `not_before` and no
  active capacity hold stands in front of it — and a hold is lifted only by a
  bounded release that has not expired, exactly as `store.ts` tests it at the
  queue and at the claim. Held work falls to Blocked carrying its reason as a
  badge: withheld, not hidden. Reading the hold differently here (Ready did
  not test it at all) drew H-1817 as ready while every agent queue correctly
  withheld it, and Arthur read that gap as a fleet ignoring its backlog.
  `test/view-ready.test.ts` drives the whole page across indefinite holds,
  live and expired releases, date gates, dependencies and sittings.
  The same three gates decide "Awaiting you" (H-202). A sitting standing behind
  one is drawn under Blocked, where the badge order puts the impediment first
  and the sitting last as `🪑 then a sitting`, with its line retained inside the
  row. It is also what stops a held sitting vanishing: it was excluded from the
  operator queue for being held and from the agent sections for needing a human,
  and `view-section.test.ts` had recorded that absence as if it were the rule.
  `test/view-blocked-sitting.test.ts` drives the operator's whole matrix: one
  and several prerequisites, a blocker clearing, a date gate, a hold, work that
  is genuinely his now, an unanswered question, and a terminal record.
- `presentation.ts` — the dashboard's shared presentation rules: actor marks,
  option letters, question fingerprints, and the bounded terminal tail.
  `view.ts` owns the only reading. The estate shell frames that HTML whole at
  `/s/helmo-view/` and embeds its `?section=awaiting` section on the landing;
  it does not fetch, redraw, or interpret Helmo tickets (H-1066). The same
  question renderer, per-boot answer nonce, relative ratification route,
  refresh behavior, and CSS therefore serve both places.
  The section's body and hero expose `data-count`; while framed, it posts
  `helmo:section-size` with the count and document height to its same-origin
  parent, and tracks later disclosure/refresh height changes with a
  `ResizeObserver`. The shell sizes the iframe from that contract and never
  reads ticket markup.
  This page is phone-first (H-880): every row must survive 390px, and an
  explicit `.light` or `.dark` class wins over the system preference so the
  shell keeps an embedded page in theme. `npm run smoke` in the estate repo
  drives this page and the other products at 390px in both themes. Run it
  after touching this file's HTML or CSS.
  Every string on the page is store text carrying paths, refs and URLs, so
  `:root { overflow-wrap: anywhere; }` lets any of them break — declared once
  rather than per selector, because three selectors had it and `.situation` did
  not, and one path in a phone-width column dragged the whole document to
  420px (H-1176). Anything that must stay on one line says
  `white-space: nowrap`, which still wins. `view-responsive.test.ts` asserts
  the rule directly: the estate smoke only sees the defect while some live
  ticket happens to carry a long path.
  `test/view-release-floor.test.ts` is the only test that reads the DOCUMENT
  rather than this file: it spawns the view over a seeded store and checks the
  four release-floor axes against what a browser would receive — every link
  resolves (fragments to ids in the same document, internal links to the one
  route this server has, external ones to absolute http(s)), a measured byte
  and render budget with no subresource at all, no declared width wider than
  the narrowest viewport it can apply at, and an accessibility pass over the
  served markup plus WCAG contrast for the inks Helmo composes on the surfaces
  it draws them on. It found six dead links on the live dashboard: the
  grooming strip names tickets the hygiene sweep found anywhere in the store,
  and the current record draws only the newest `CLOSED_TAIL` closed, so a
  finding against an older closed ticket linked to a row that was not on the
  page. `groomStrip` now takes the set this document actually drew and sends
  the rest to `?whole=1#H-n`.
  Its budget is measured on a record at least as heavy as a deployed one, and
  that is a checked property, not a claim: `test/support/served-record.ts`
  seeds 244 rows to the shape of a real store — body lengths, an evidence tail
  that reaches 118 items on one ticket, 64-character digests — and the first
  assertion in the budget block refuses to measure anything until the fixture
  exceeds the numbers in `src/floor.ts`'s `REAL_RECORD` in total text, in
  bytes per row and in the longest unbreakable run it draws. It warms each
  document once, then requires the slowest of three bounded warm
  responses to meet the 400 ms budget so one fast sample cannot mask a miss.
  The budget it shipped with before did none of that: 300,000 bytes asserted over 80
  one-line tickets while the record it was shipped against served 2,718,020,
  nine times the ceiling, green the whole time (H-202).
  Nothing in that file opens a browser, so it cannot measure real geometry or
  paint; `test/view-viewport-render.test.ts` does, and `scripts/live-floor.mjs`
  does both against a deployed service. See Commands.
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
- `install.ts` — which installation this process is (H-2472). All four entry
  points resolve it here rather than each reading `HELMO_DB` on its own, so
  they cannot disagree about the target. `HELMO_HOME` names the installation
  and `HELMO_DB` names its store; either one alone determines the other, so a
  bare `HELMO_DB` (Rev's roster) and a bare default both keep working. Both set
  and disagreeing is refused BEFORE the store is opened, naming both
  candidates — a silent precedence rule is the bug, and an inherited value
  quietly beating an explicit one is the worst case. The installation's NAME is
  not a registry: `REV_LABEL` is the identity rev's supervisor derives from its
  own home and writes into the service environment (rev:src/service.ts,
  H-2452), so everything Rev spawns agrees for free; `HELMO_LABEL` overrides it
  for a Helmo standing without Rev; failing both it is derived from Helmo's own
  home by the same rule, keyed on the password database rather than on a `$HOME`
  the installation itself could have written. `requireInstallation(env, report, requested)`
  takes the reporter because the CLI's contract is that every failure it prints
  is one JSON object.
  A pinned installation sets `INSTALLATION_RELEASE` to its `ADOPTED.json`.
  Resolution verifies the Rev/Helmo/Roadmap commit set against `RELEASE.json`
  and that this process runs from the selected Helmo directory; a mixed set or
  shared-checkout fallback refuses before the store is opened.
  H-2474 adds the naming discipline on top. Every entry point says which
  installation it is about: the CLI puts `installation` IN each result object
  and in each `{error}` refusal (a caller reading the fields it asked for is
  unaffected by one more), the view and remote surface print
  `installationLine()` in their startup line, and the MCP server prints it on
  STDERR because stdout is the protocol channel. `--installation
  <name|home|db>` ASSERTS that target — on any CLI command, and on argv for the
  three surfaces a service definition starts. It cannot redirect: a value
  disagreeing with the environment refuses before the store is opened (opening
  one migrates it, H-134), naming both candidates, and `HELMO_HOME`/`HELMO_DB`
  remain the only things that move the target. The check lives inside
  `requireInstallation` so no entry point can resolve a target and forget to
  verify it; a bare `--installation` refuses rather than reading as absent
  (H-1782).
- `reference.ts` — which installation a RECORD came from (H-2502), the inbound
  direction of the same question. Ids are minted per installation, so `H-267`
  exists in both and means two unrelated records: a reference an agent copied
  out of A used to resolve against B and answer, confidently, with the wrong
  ticket. Nothing was malformed — the id is the shape ids have, and B really
  does have one. The spelling is `H-267@dev.helmo.b`, split at the FIRST `@` so
  the qualifier takes the same three words `--installation` does (label, home,
  store path) through the shared `namesInstallation()`, and asserts the same
  way: `localRecordRef()` refuses a reference naming another installation
  rather than forwarding it, because forwarding would mean a process bound to
  one store opening a second. A BARE id keeps working everywhere and must — it
  is unambiguous within one installation, which is every single-install user
  and every caller written before this. Applied at the surfaces, before the
  store: every `ticket_id`/`from_id`/`to_id`/`deps[].to` in `tools.ts` through
  `local()`, and every `--ticket`/`--dep` in `cli.ts` through `ticketRef()`.
  Outbound, `tools.ts` puts `installation` (the label alone) on the ENVELOPE
  beside `result`, not inside it — the ids and seat names an agent carries away
  are in `result`, and the line saying whose they are must not read as a field
  of the record. The label alone and not the CLI's full block, because this
  surface lands in an agent's context on every call; `helmo_get_ticket` adds
  `ref`, the qualified spelling, alongside the bare `id`. The DASHBOARD is
  deliberately untouched: `ref()`'s documented promise is that the id and
  nothing else reaches the clipboard (H-2428), and a bare id is what the human
  with one installation wants to paste.
- `build.ts` — which BUILD this process is running (H-2490), the other half of
  the same question. Never read the answer off the artifact: `dist` is
  gitignored and nobody rebuilds it on restart, so on 2026-09-30 the sha beside
  the code was eight minutes younger than the dashboard serving it (H-2432).
  Each process takes ONE snapshot of its own code directory at startup
  (`loaded()`, warmed by every long-lived entry point before it serves) and
  every report compares that against the directory read fresh: `verified`,
  `stale`, `unstamped`, `unverifiable`. The commit named is always the LOADED
  one — on divergence the artifact's sha appears only as the thing nobody is
  executing. What is compared is a digest of the `.js` in the directory, not
  the sha: a dirty tree's commit did not produce the artifact and two rebuilds
  of one commit differ. `.d.ts` and the stamp are excluded because neither
  changes a byte a process executes. A source run under `tsx` has no JavaScript
  to digest and reports `unverifiable`, which is the honest answer rather than
  `stale`. `scripts/stamp-build.mjs` writes `dist/BUILD.json` as npm
  `postbuild`, so `npm run build` stamps with no second step to forget; a dirty
  tree is recorded, not refused, and `--check` fails a stamp older than the
  code beside it. The stamp travels WITH the artifact because a central file
  keyed by repo name cannot describe two installations of one repo (H-2435),
  and crew:tools/estate/builds.mjs prefers it over the deploy record. Rev's
  half that does NOT port is the RUNNING marker: `rev status` is one process
  answering for another, while every Helmo surface answers for itself — so the
  reading lives in module memory for the life of the process, which is exactly
  the life of the bytes it loaded. Reported by `installationLine()` (startup
  line of view, remote and both MCP servers), by `installationRef()` (inside
  every CLI result and refusal), and by the dashboard footer, which re-reads
  per render because a view that stays up across a rebuild is precisely the
  process whose answer changes.
- `schedule.ts` — recurring-ticket schedules (H-22): 'every N<m|h|d>' or 5-field
  cron, UTC. A ticket with `schedule` set is a TEMPLATE — standing work, never
  ready itself. Instances spawn lazily on ticket-list reads (the read path is
  the clock; no daemon), linked via parent dep, actor `helmo-scheduler`.
  Instances inherit an explicit template assignee; otherwise the workstream
  seat routes them, and a stream without either leaves them unassigned.
  Skip-if-in-motion, checked and inserted in ONE immediate transaction (two
  readers spawned twins, H-169); after downtime only the latest missed slot
  spawns. An instance in_progress, awaiting_human, or carrying a human answer
  blocks the next slot; a plain open instance nobody started is superseded
  (cancelled by the scheduler) when the next slot comes due — before H-618 it
  silently stalled the schedule for as long as it sat unworked.

## Commands

- `npm run build` (tsc → dist/), `npm test` (store + e2e against a temp db).
- `npm run floor` runs the release-floor checks alone (links, performance
  budget, declared widths, accessibility) against the served page. They are
  part of `npm test` too, but `npm test` runs them in a second Vitest process
  after the rest of the suite. The 400 ms render budget measures the view, not
  contention from unrelated parallel test workers; isolating the timed gate
  keeps that budget strict and repeatable. The separate script exists because
  the floor is what a release is gated on and it is worth being able to ask
  for by name.
- `npm run viewport` lays the same document out in Chromium at 360, 390, 480,
  700 and 1280px, delivered and with every row opened, and fails on anything
  that reaches past the right edge — boxes and text runs alike. It is NOT part
  of `npm test`: it needs Playwright's managed headless shell, installed with
  `npm run browser`, and the rest of the suite runs offline.
  Skipping itself when the browser is absent would make a release gate that
  passes hardest when it is doing least, so it fails and says what to install.
  `scripts/browser.mjs` is the shared launcher for viewport checks, live-floor
  and screenshots. It never falls back to installed Chrome: desktop extension
  policies can close the user's other windows even on a headless launch.
  `test/browser-launch.test.ts` proves the missing-browser path cannot retry
  against a desktop browser and keeps all three entrypoints on this launcher.
  `npm run screenshot -- <url> <output.png>` replaces direct Chrome commands.
  Two things it taught, both of which made an earlier control useless: every
  row is a collapsed `<details>`, so a browser that only loads the page lays
  out the summaries and never touches the bodies where the long refs are; and
  a browser breaks a long path after its slashes whatever the CSS says, so the
  case that needs `overflow-wrap: anywhere` is a 64-character digest, not a
  path. With digests in the fixture and the rows opened, deleting that one
  declaration takes the document to 624px in a 360px viewport and this is the
  only check in the repo that notices.
- `npm run live-floor -- <origin>` runs the same numbers and the same widths
  against a DEPLOYED service (default `http://localhost:4420`): three reads,
  a headless page load, no writes. This is what makes the budget appropriate
  to the record rather than to the fixture — run it after a deploy, and read
  its per-row figure, which is the reading that still means something when the
  record grows past the capacity the seed declares.
- `npm run smoke` drives a create → claim → return → answer lifecycle with
  different truthful fixture actors, asserts every state and event, then
  proves a rejected CLI operation exits nonzero. It always uses a fresh temp
  database and never falls through to the live record.
- `npm run vendor:tokens` / `npm run vendor:avatars` refresh the vendored
  estate design tokens and crew avatar sprite; add `-- --check` to fail on
  drift instead. See below.
- View: `node dist/view.js` (port via `HELMO_VIEW_PORT`, default 4400; binds
  127.0.0.1 — `HELMO_VIEW_HOST` to change). Restart it after rebuilding — the
  running process holds old code.
- Store lives at `~/.helmo/helmo.db` — `HELMO_HOME` or `HELMO_DB` overrides,
  and setting both to disagree is refused (`install.ts`). Agent identity comes
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
- Every ticket says what accounts for it (H-1126): a `project` tag when it
  belongs to a named project, an `obj:OBJ-n` label when it serves a charter
  objective directly, or one of three `acct:` labels for the third category —
  `acct:direction`, `acct:security`, `acct:estate` (H-1166). That set is
  closed: an unrecognised `acct:` spelling accounts for nothing, which is the
  point — a category a reader can check beats prose the sweep cannot read. The
  label names the category; the body still names the reason. This is a
  convention, not a schema — nothing is rejected for lacking it; the
  `unaccounted_work` hygiene check simply lists the work nobody can trace back
  to a purpose.
- Workstream budgets are disclosure, never enforcement: nothing in the store
  may block a write because a budget is spent — recording reality always wins.
  The agent-kind rejection in `setWorkstream` is the one hard rule (an agent
  must never steer its own stream).
- Tool-description changes deploy on the next session spawn (loops get them
  immediately; running sessions keep the old text).
- A return carries an issue and a recommendation; options are OPTIONAL, and
  when present there are two or three of them (H-939). Requiring them is what
  the store used to do, and it bought a meeting full of manufactured
  alternatives — an asker whose recommendation stood on its own still had to
  name a second course to satisfy the schema. Anything that reads a question
  handles both shapes: `presentation.ts` omits the `options` key entirely rather than
  sending an empty array, and the view draws an "answer this" button in place
  of the option buttons, because on that page the options ARE the answer
  surface and a question without them would otherwise be unanswerable from the
  dashboard. Questions written before the cap can still hold four; readers
  letter what they are given rather than refusing to draw it.
- `returnToHuman` refuses a return whose ask the human has already answered on
  that ticket (H-2126): `answeredAsks` walks the log pairing each `answered`
  event with the `returned` one before it, and a matching
  `questionFingerprint` throws with the answer quoted, so the caller needs no
  second read to act on it. The check is inside the write transaction for the
  same reason `answerTicket`'s is (H-1053) — the answer can land between a
  caller's read and its write, which is exactly the observed shape: on H-2099
  one live session returned a question, had it answered 35 seconds later, and
  returned the byte-identical ask again. Any previously answered ask counts,
  not just the last, and the scope is one ticket — the same words on other work
  are a new question. It is the store-side answer to the family H-1570 started:
  that one was fixed by teaching an agent to read `last_answer` before
  returning, which binds only the agent taught — a refusal binds every caller.
  It cannot wedge a ticket: a situation that accounts for the answer is a
  different fingerprint.
- Product acceptance is opt-in and exact-ref: no completion is
  `not_requested`; a completion without a current verdict is `pending`; FAIL is
  `failed`; only a current non-author PASS is `accepted`. A caller checking a
  different release manifest gets `pending/stale_verdict`, even if the record
  still contains an accepted older candidate.
- A completion carries a verdict SET, not its newest verdict (H-2432, R-39 A1,
  crew `projects/r39/VERDICT-SET-CONTRACT.md` §2). Within one completion a
  reviewer's latest verdict is theirs and replaces their own earlier one;
  aggregation then runs across reviewers, and the strictest governs. A FAIL is
  cleared only by a new completion — no later PASS on the same refs can clear
  it, which is exactly the overwrite this replaced. Disagreement reports as the
  distinct reason `contested`, and `verdicts[]` carries the whole set; the
  singular `verdict` still names the one that governs, so readers written
  before the set keep working. This was not theoretical: on H-94 a PASS landed
  557 ms after a FAIL and the release path saw only the PASS.
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
- the standing notice — RETIRED (H-1126). It carried one hand-maintained line
  of current priority to every queue read; Arthur's ruling at the Monday
  retrospective 2026-09-07 is that the charter and the roadmap already say
  that, and a copy of them drifts and then contradicts (the notice was
  corrected as stale on 09-03). There is no writer and no response field any
  more. The `notice` table, the replay of historical `notice_set` events and
  `store.getNotice()` remain so a store written before this still rebuilds
  exactly — the record is the record. What replaces it: agents take the work
  routed to them, and whether that work is accounted for is the
  `unaccounted_work` sweep below.
- the workstream `goal` — RETIRED (H-1186, Arthur's ruling 2026-09-08). It
  was the same shape as the notice one level down: free prose in a store
  column, no owner, no cap, no review seat, read as standing instruction by
  every agent on every queue read and written into every Rev iteration
  prompt. H-1126 scoped it to standing streams; the one survivor (calendar)
  duplicated its seat's profile nearly word for word. The invariant now:
  **steering fields carry numbers and names only** (`budget_usd`, `seat`).
  What done means for a stream lives in the seat's profile or the project
  body — capped, reviewed, owned files — never in a field. `setWorkstream`
  refuses a `goal` key outright; `test/tools-surface.test.ts` pins the
  `workstreams` row and `workstream_steering` shapes to an allowlist so a new
  string field fails the suite; the dashboard's "Workstream steering" section
  is gone. The `goal` column and historical `workstream_set` payloads remain
  for exact replay; nothing reads them.

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

## Copying a reference (R-42 I12, H-2428)

Arthur carries records into agent conversations by their id, so every visible
id on the page has a copy control beside it. One renderer draws them all —
`ref(id, href?)` in `view.ts` — and that is the whole mechanism: there is no
second way to draw a `.tid`, which is what makes "any reference on screen can
be copied" a property of the code. `test/view-accessibility.test.ts` holds it
there by asserting no renderer builds one by hand.

What goes on the clipboard comes off `data-copy`, never off the rendered text,
so a badge, an ellipsis or a future prefix drawn beside an id cannot reach the
paste. The control is 18px of glyph with a transparent `::after` overlay taking
it to a 44px target; a finger-sized icon beside 12px monospace would dominate
every row. Two things that look optional are not: `e.preventDefault()`, because
most of these sit inside a `<summary>` and engines differ on whether a button
inside one still toggles the disclosure; and the `document.execCommand`
fallback, because `navigator.clipboard` is secure-context only and this page is
plain http — a phone reading the estate over the LAN takes that path every
time, and a copy button that silently does nothing there is invisible from a
localhost browser.

`test/view-viewport-render.test.ts` proves it end to end in Chromium with a
real clipboard, including the no-API path, so `npm run viewport` is where this
is actually demonstrated. The roadmap ships the same control, spelled the same
way (`helmo-roadmap/src/view.ts`); it has no browser in its toolchain, so it
asserts the shape and leans on this repo for the behaviour.

## Opening a result (R-42 I5, H-2422)

A closed row separates three things that used to read as one evidence tail:
URL evidence is the product result, every other evidence kind is review
evidence, and `productAcceptance()` is the release state. The first reachable
result is the primary 44px `View result` action; an absent URL says no product
result is linked rather than promoting a commit or file into one.

A localhost URL is about the machine serving Helmo, not the phone reading it.
It therefore ships without an `href` and becomes a link in
`enableDeviceLocalResults()` only when the page itself is on localhost. A
remote reader sees `Result available on the estate machine` and cannot be sent
to their own device's port. The same hydration runs after the 15-second body
replacement, or a link would work only until the first refresh.

## Reading a title (R-42 I4, H-2476)

I4 asked for "plain human titles" and left one question open: does that need a
separate stored human-summary field? Measured over 400 real titles, no. Not one
needed translating — `createTicket`'s contract asks for plain human terms and
writers comply. What they have is length: median 78 characters, p90 112, max
145, all drawn at one weight, so scanning a queue meant reading a paragraph per
row. Nearly half already carried the handle their writer intended, ahead of a
`: ` or an em dash, and the page was throwing it away at paint.

`title(text, cls)` splits there and draws the lead at the title's weight with
the remainder in `.tdetail`. It is presentation and nothing else: no stored
field, no title rewritten, and **what renders is byte-identical to what is
stored** — the separator is kept, nothing clipped or elided — so selection,
find-in-page and a screen reader still get the whole title. That invariant, not
the split, is what `test/view-title.test.ts` holds, against the real rendered
page.

The lead is capped at 48 characters so a split only ever promotes a short
handle rather than the first half of a sentence, and the remainder must reach
12 characters to be worth quieting. Separators are the colon and the two
dashes, which is what the store actually writes (171 colons, 17 em dashes, no
other form in 400); a spaced hyphen is deliberately excluded, because a stray
hyphen splitting a title is worse than a long title drawn flat.

Both spans are inert and sit inside the row's existing `.rtoggle` button, so
this adds nothing interactive and cannot bring back `nested-interactive`
(H-2447). `helmo-roadmap/src/view.ts` carries the same rule for project titles
and proves it the same way.

## Neighbors

Rev (formerly Capstan), a sibling project, supervises the bash loops that draw
work from this record; it consumes the helmo-cli contract and injects the MCP
server into agent sessions. The estate shell (`~/projects/estate`) frames this
view whole and embeds its Awaiting-you section; Helmo remains the sole renderer
and record owner. Estate also owns the design tokens and avatar sprite this repo
vendors. Operators keep their own agent identities and estate maps outside this
repo. helmo-roadmap is a client of this repo's MCP surface and holds no code
path into it; the seam above is the whole coupling.
