# Changelog

## Unreleased

One Helmo installation is now distinguishable from another: in what it is
called, which store is its own, and which build is serving it. Alongside that,
what an agent can ask a human for splits into three kinds, so a request to go
and do something can no longer come back as permission to act.

### Breaking changes

- `needs_human` takes the one line the sitting needs, not `true` (H-1761).
  Marking a ticket for a sitting now says what the human does and roughly what
  it costs them; that line is stored as `sitting`, returned on the ticket and in
  compact rows, and rendered on the dashboard as a card with a question's
  weight. `false` still clears the marker; a bare `true` is refused with the
  shape to send instead. `helmo update --needs-human` now takes a value, and
  `--no-needs-human` clears.

### Running more than one installation

- An installation has a name, and every entry point says which one it is about
  (H-2472, H-2474). `HELMO_HOME` names the installation and `HELMO_DB` names its
  store — either alone determines the other, so nothing already deployed has
  anything new to set, and both set to disagree is refused before the store is
  opened. The name comes from `HELMO_LABEL`, or the supervisor's `REV_LABEL`, or
  is derived from the home. `helmo-cli` carries `installation` in every result
  and every refusal; the view, the remote surface and the MCP server print it at
  startup. `--installation <name|home|db>` ASSERTS that target on any command or
  entry point: it refuses before opening the store when the environment resolves
  a different one, and it cannot redirect — `HELMO_HOME`/`HELMO_DB` move the
  target, the flag says you meant it. The single-install experience is unchanged:
  no variables set at all still means `~/.helmo/helmo.db`, and no flag to pass.

- A store belongs to the installation that first wrote it under a name. An
  explicitly named installation claims `installation_name` in the store's `meta`
  table, atomically with its first event; a later write from a process resolving
  a different name is refused, naming both, with nothing written. Reads stay
  available and report the disagreement as `target: UNCLEAR` beside both names,
  because a store you cannot write is still a store you may need to look at.
  This is what catches a name INHERITED from elsewhere — a shell carrying one
  installation's `REV_LABEL` with the other's `HELMO_DB` — which no flag can
  catch, because nobody typed anything wrong. A derived-only installation claims
  no name, leaving existing single-store use exactly as it was.

- Every Helmo process answers for the code IT loaded, not for what is on disk
  (H-2490). Read off the artifact, that answer is wrong the moment anyone
  rebuilds: on 2026-09-30 the stamp beside `dist/store.js` was eight minutes
  younger than the dashboard loading it. Each process takes one snapshot of its
  own code directory at startup and compares it per report against that
  directory read fresh, so `STALE`, `UNSTAMPED` and `UNVERIFIABLE` are answers,
  and the artifact's newer commit appears only as the thing nobody is executing.
  What is compared is a digest of the JavaScript, not a commit: a dirty tree's
  commit did not produce the artifact, and two rebuilds of one commit differ.
  The reading is on every startup line, in every CLI result and refusal, and in
  the dashboard footer, re-read per render because a view that stays up across a
  rebuild is exactly the process whose answer changes.

- An installation can be pinned to an immutable multi-product release set
  (H-2454). Set `INSTALLATION_RELEASE` to the selection's `ADOPTED.json`;
  resolution then verifies the Rev/Helmo/Roadmap commit set against the
  selection's `RELEASE.json` and that this process is running from the selected
  Helmo directory. A mixed set, or a fallback to some other checkout, refuses
  before the store is opened.

- A ticket reference can say which installation it came from, and one that
  names another is refused rather than resolved (H-2502). Ids are minted per
  installation, so `H-267` exists in every one of them and means a different
  record in each; a reference copied out of one store used to be answered, with
  confidence, by another's unrelated ticket. Write it `H-267@dev.helmo.b` —
  the qualifier takes the same `name|home|db` spellings as `--installation`,
  and asserts the same way: it can refuse a command, never redirect it. Every
  MCP tool and every `helmo-cli --ticket`/`--dep` accepts either form, and the
  check runs before the store is touched, so a refused write leaves the record
  alone. A BARE id keeps working everywhere and always will — within one
  installation it is unambiguous. MCP results and refusals now carry
  `installation` (the label) on the envelope beside `result`, so the ids and
  seat names an agent reads always arrive with whose they are, and
  `helmo_get_ticket` returns `ref`, the qualified spelling, alongside `id`.

- The README says where the checklist is (H-2517). Helmo's three entry points —
  `helmo-cli`, `helmo-mcp` and `helmo-view` — are each a path something in your
  setup names, and a running view or MCP server keeps the code it loaded until
  it restarts. The list of every path to review when you add an installation or
  change which release one runs, and of the surfaces that say what is actually
  running, is `ENTRY-POINTS.md` in the Rev repo; it covers the Helmo family
  standing without Rev as well. `ISOLATION-CHECKS.md` in the same repo is the
  reviewer's version: the isolation properties of a pair of installations, with
  the commands to re-derive each one against your own two.

### Three kinds of request

- A completed action can no longer read as permission (H-2521). An agent asking
  the human to DO something and an agent asking permission to act itself both
  arrived as a question and both came back through Ratify. An action now has its
  own path: it sits on the `awaiting_human` axis, because a pending request with
  the claim released is what that status means, and the one stored request
  column carries `kind`. A request without a kind reads as the decision it was,
  so no existing row is rewritten or reinterpreted, and `question` keeps its
  type and meaning for every external consumer. `requestAction` requires
  `why_human`: an asker who cannot say why their own hands will not serve owes a
  decision instead. `reportAction` takes what the human did and nothing else —
  no resolution, no chosen option — so by shape it can resume the work but can
  never close a ticket, grant anything, or stand in for the agent's own later
  verification. A sitting gains `sitting_with`, because "with [agent]" cannot be
  scraped out of a prose line.

- Each hero card on the dashboard says which kind it is (H-2530), in words
  beside a glyph and a hue, and offers only the control that matches its
  response. Decision needed keeps Ratify and its offered choices; Action for you
  gets "I've done it" and nothing that could read as approval; Needs a sitting
  names the agent to sit with and carries no control, because the response to a
  sitting happens in the sitting. They are drawn in ascending cost to the
  reader: a word, their hands, their diary. Reporting an action is a second
  route rather than a branch of answering, and it carries no words, so the
  stored report is written by the route. The split also fixes a row that could
  be counted in "awaits you" and drawn nowhere: anything with no readable
  request now gets a card saying so.

- Every choice a decision card offers can be answered from the card (H-2524).
  The dashboard's answer route accepts the previous `{ratify: true}` or one
  letter produced by the shared lettering, resolved against the currently stored
  options after the fingerprint check. Labels, free text, invented letters,
  mixed answers and resolution changes are not an input shape, so showing all
  the offered choices does not restore the broad write capability removed in
  H-1053.

- Both requests have doors (H-2534). `helmo_request_action` and `helmo-cli
  action` create an action request; `helmo_report_action` and `helmo-cli
  action-report` record a completion reported in conversation, without asking
  for a second click on the dashboard. Create and update expose `sitting_with`
  beside `needs_human`, and the decision door tells an asker whose question has
  no form-actionable recommendation to name a sitting and an agent instead. The
  cards landed before the doors deliberately: had a door come first, a pending
  action would have reached a renderer that drew nothing for it.

### Records and accounting

- A field neither front door declares is refused instead of silently dropped
  (R-39 Q9, H-2421). The MCP surface was handed raw shapes, which the SDK wraps
  in a plain object that STRIPS an undeclared key, so `capacity_hold` on a
  create or a misspelled `projekt` returned a new ticket ID with the field
  quietly unset. `helmo-cli` had the mirror image: `flag()` returns undefined
  for a flag nobody declared, and undefined is what "not passed" looks like, so
  `create --project R-41` filed an untagged ticket and `update --assinee <name>`
  reserved nobody — both exiting 0. Both doors now refuse by name and write
  nothing, including on reads, where a filter that does not exist used to read
  as no filter at all. Every flag Rev, the daily sweep, `memo-drain`,
  `github-listen`, `publish` and the configuration gate pass is declared, and
  `--flag=value` remains the escape hatch for free text. Fields `helmo-cli`
  still has no flag for (H-2225) are now named in the refusal rather than
  dropped; go through the MCP server for those.

- A flag written bare is refused rather than read as absent (H-1783). `flag()`
  took a value to be the argv slot after the flag's name, so `--needs-human`
  with nothing after it returned undefined — indistinguishable from never
  passed. Rev wrote it that way: the marker never landed, the rest of the write
  did, and the failure looked exactly like success for a day. Both directions
  now refuse: a value-taking flag with no value, and a bare flag written
  `--takeover=true` that an `includes` check would ignore.

- A body can be edited without replacing the whole field, and a closed record
  stays closed (R-39 Q3/Q4, H-2439). `body_append` adds exact text;
  `body_patch` replaces one unique literal anchor and refuses a missing or
  repeated anchor before any event is written. Whole-field replacement remains
  for a caller deliberately rewriting the document. On a `done` or `cancelled`
  ticket, `updateTicket` accepts appended notes and evidence and refuses every
  other field without changing the record.

- A completion carries every qualifying verdict, and a FAIL stays failed
  (H-2432). The governing verdict was selected with `.at(-1)`, so the last write
  won: on one ticket a PASS landed 557 ms after a FAIL and the release path saw
  only the PASS — safety was a property of who typed second. Within a completion
  a reviewer's latest verdict now replaces their own earlier one and nobody
  else's, the strictest standing verdict governs, and a FAIL is cleared only by
  a new completion. Reviewers who disagree report as `contested` and read as
  "acceptance contested": neither ships, but agreement and disagreement are not
  the same fact. `verdict` still names the verdict that governs, so readers
  written before the set keep working; `verdicts[]` is new. Replayed over two
  live stores the new rule reports zero state changes.

- `helmo-cli verdicts --since-seq N [--actor A] [--workstream W]` — a read-only
  replay of acceptance verdicts from a cursor, returning `max_seq` from the same
  read (H-1830). It is `answers` for the other write that lets work through
  unread: a verdict is recorded in the reviewer's name by a caller-supplied
  actor on a store file the user can write, so a daily sweep can show every one
  back to the reviewer it names without opening `helmo.db` itself. A verdict
  whose ticket row has been deleted is still reported, with an empty workstream.
  `--actor` takes a reviewer's name; an identity JSON is refused.

- A budget of zero is the explicit uncapped sentinel (H-267). Measured spend is
  still disclosed, `remaining_usd` is null because there is no finite remainder
  to report, and pressure checks leave runnable work runnable. A positive budget
  keeps its finite arithmetic and its exhaustion guidance.

- A live spend anomaly can be acknowledged at a figure (H-1715). A ticket that
  is genuinely expensive and genuinely blocked tripped the check at every sweep,
  and the only way to say "this is accounted for" was a note the check cannot
  read — so agents wrote the same note again each pass, and each re-reading was
  itself metered onto the ticket. Spend is the one check that can safely be
  disposed on live work, because it is a number that only grows: an
  acknowledgement records the figure it answered for, and the finding returns on
  its own once the ticket has cost half as much again.

- A return the human has already answered is refused (H-2126). One live session
  returned a question, had it answered 35 seconds later, then returned the
  byte-identical ask again: the dashboard drew a decision the human had just made, and
  the session was metered for it. `returnToHuman` now throws when the ask's
  fingerprint matches one already answered on that ticket, quoting the answer so
  the caller needs no second read to act on it. The check sits inside the write
  transaction, because the answer landing between a caller's read and its write
  is exactly the observed shape. It cannot wedge a ticket: a situation that
  accounts for the answer is a different fingerprint.

- A reservation is no longer flagged as silent while one of its blocking
  dependencies is live (H-1900). The blocker already explains why the ticket has
  not moved; if it closes and the reservation remains untouched, the finding
  returns automatically.

- A store schema for durable workflows — definitions and their revisions, runs,
  attempts, manifests, requirements, decisions, admissions and outcomes, with
  foreign keys enforced — plus the one store method that records a definition,
  which validates stage ids for presence, uniqueness, surrounding whitespace and
  unknown prerequisites, and refuses a cycle (H-429). No tool or CLI door
  reaches it, so no workflow can exist in any store yet; this is groundwork,
  named here because it is in the store.

### Operator and harness surfaces

- A sitting the operator cannot reach yet is drawn as blocked work, not as work
  awaiting them (H-202). An open blocker, a future `not_before` or an active
  capacity hold now decides "Awaiting you" the same way it decides Ready: the
  ticket falls to Blocked naming its real prerequisite, out of the attention
  count, carrying `🪑 then a sitting` and the line it will need once the
  impediment clears. A question in `awaiting_human` is unaffected — answering it
  is how a block gets cleared. This also returns held sittings to the page at
  all: they were excluded from the operator queue for being held and from the
  agent sections for needing a human, and were drawn nowhere.

- Capacity-held work is no longer drawn as ready, or as awaiting you (H-2321).
  The dashboard derived Ready from blockers, schedules, sittings and date gates
  but never looked at a capacity hold, so held work sat under Ready while every
  agent queue correctly withheld it — and the gap read as a fleet ignoring its
  backlog. Only an unexpired bounded release lifts a hold; held work falls to
  Blocked carrying its reason.

- A closed row separates the product result from the review evidence (R-42 I5,
  H-2422). URL evidence is the product result, every other evidence kind is
  review evidence, and product acceptance is the release state. The first
  reachable result is the primary `View result` action; no URL says no product
  result is linked, rather than promoting a commit or a file into one. A
  localhost URL is about the machine serving Helmo and not the phone reading it,
  so it ships without a link and becomes one only when the page itself is on
  localhost: a remote reader is told the result is available on that machine
  instead of being sent to their own device's port.

- Every reference the dashboard draws has a copy control beside it (H-2428).
  Records are carried into agent conversations by their id, so one renderer
  draws them all and there is no second way to draw one — which is what makes
  the guarantee a property of the code rather than a habit. What reaches the
  clipboard comes off the data attribute, never the rendered text. Measured in
  Chromium against the real record: 445 references drawn, 445 with a working
  control, exact text, 44px target, no row toggled.

- A row's reference sits beside the control that opens it, not inside it
  (H-2447). The rows drew the reference, copy control and all, as the first
  thing inside a `<summary>` — an interactive element, so the button was a
  nested-interactive violation and a real defect: a screen reader could not
  reach the copy control separately from the disclosure, and a pointer gesture
  over the two was ambiguous between copying and opening. The rows now spell the
  disclosure out: the reference and a button carrying `aria-expanded` and
  `aria-controls` are siblings in the row head, and the body is a panel that
  button hides and shows. Disclosures inside a row body stay `<details>` —
  nothing in them is interactive.

- A long title is drawn as the handle its writer wrote (H-2476). Measured over
  400 real titles, none needed translating into a stored human summary: writers
  comply with the plain-terms contract. What they have is length — median 78
  characters, p90 112 — drawn at one weight, so scanning a queue meant reading a
  paragraph per row. Nearly half already carried a handle ahead of a colon or an
  em dash, and the page threw it away at paint. The title now splits there and
  draws the remainder quieter. Presentation only: no stored field, no title
  rewritten, and what renders is byte-identical to what is stored, so selection,
  find-in-page and a screen reader still get the whole title.

- `helmo-cli wake-check` answers from one snapshot instead of six separate
  reads (H-1895). Each read took its own WAL snapshot, so a handoff committing
  partway through was seen by some fields and not others: a wake was logged
  reporting `ready_count` 0, and the same window could return a `max_seq` past
  an event the ready set had not yet seen — which is a loop re-idling at a
  cursor beyond the handoff and sleeping through the wake. The output shape is
  unchanged. `Store.readyIds` is gone, replaced by `Store.wakeCheck`, which
  reads the ready set once and reports every field from it.

- A seat is woken when independent triage releases its work (H-2304). The first
  non-meter touch by another actor, or by a human or an orchestrator relaying
  one, is now a readiness edge: it releases self-triage for the filing or for
  its recurring template, while subsequent notes stay inert.

### Reliability and tests

- The release floor is measured against the served document, not the source
  (H-202). The view's other tests read `src/view.ts` as a string, which answers
  "does the code say X" and cannot answer "does the document a browser receives
  hold X" — which is what all four floor axes are about. A new test spawns the
  view over a seeded store and checks the current record, the whole record and
  the embedded section: every fragment resolves to an id in the same document,
  every internal link goes to the one route the server has, every external one
  is absolute, an unknown section still 404s, no subresource is fetched at all,
  and byte and warm render budgets are written down rather than assumed.

- The floor is measured on a record as heavy as the deployed one, and in a
  browser (H-202). It shipped with a budget that could not fail: 300,000 bytes
  asserted over an 80-row seed of one-line tickets, while the record it was
  shipped against served 2,718,020. `src/floor.ts` now holds the numbers and the
  reading of one served document, so the test and the live checker cannot drift
  apart, and the fixture seeds 244 rows to the real record's shape — body
  lengths, an evidence tail reaching 118 items, 128-character paths — with the
  budget block refusing to measure until the fixture exceeds the real record in
  text, in bytes per row and in longest unbreakable run. The layout claim is
  laid out in Chromium rather than inspected as CSS.

- Browser checks run against a downloaded browser, never the installed desktop
  one (H-2401), so a check cannot reach a real profile or a real session.

- The shared record fixture carries an invented path rather than this machine's
  (H-2465). Its long-reference sample was a literal path into a client
  checkout — the one tracked file the private-information check failed on.
  Replaced with a synthetic path of the same 137 characters and the same
  slash-heavy shape, so every width and byte measurement taken against it is
  unchanged.

- Vulnerable transitive dependencies are patched (H-1535), including a later
  `ip-address` bump, so the candidate ships with no known advisories.

- The remote summon dispatch boundary is written down in `DEV.md`.

### Not covered by this release

A reader deciding whether to take this version should know what it does not do.

- A **derived-only** installation — no `HELMO_LABEL`, no `REV_LABEL`, the name
  computed from its own home — claims no durable name, so nothing at the store
  level distinguishes it from another derived installation pointed at the same
  store. That is deliberate, so single-install use is untouched, but it means
  the store-level guard protects named installations only. If you run two, name
  them.

- The store claims its name from the **first explicitly named writer**, so a
  store with history from before this release carries no name until some named
  process writes to it — and whichever named process writes first claims it,
  whatever it is called. On an existing pair, write once from each installation
  under its intended name and check the claim landed before relying on the
  guard.

- What a process reports as RUNNING is a digest of the JavaScript it loaded, not
  a commit. It can tell you the code changed under a live process; it cannot
  tell you which commit a dirty-tree build came from, and it reports
  `UNSTAMPED`/`UNVERIFIABLE` rather than guessing.

- Changing which release an installation runs does not change a running process.
  A view or an MCP server keeps the code it loaded until it restarts; the
  surfaces above will say STALE, but restarting them is still yours to do.

- The durable workflow tables and their one store method have no door on any
  surface. Nothing can create, run or read a workflow through the MCP tools or
  the CLI in this release.

### Commit coverage

Every commit after v0.4.0 and before this release record is represented above.
This manifest makes that claim auditable without relying on ticket-title
conventions:

- `77eb06e`, `b5d046c`, `e20caae`, `46a2bb6`, `ca1eccd`, `d844756`,
  `570cd80`, `2421546`, `d3328e4`, `b0a0247`
- `fadfe20`, `eb24daf`, `ef99982`, `09929fa`, `f73727a`, `6ca2373`,
  `5e449a8`, `4f86ba4`, `1211665`, `83b5686`
- `865afdc`, `5440bf0`, `c111bf5`, `f9331df`, `12f52a8`, `678ed98`,
  `956da74`, `cab1437`, `f9d19bb`, `ae88549`
- `4e6776b`, `25bcdc9`, `f1f2ef9`, `c1f96ff`, `1203d26`, `8a5b6a8`,
  `a70f560`, `53d5a3e`, `883c671`, `e7082bb`
- `ef42dd2`, `697e89b`, `656a04c`, `71ae82d`, `305ab03`, `7113b0b`,
  `864c62c`, `7d887ed`, `d1e7c0a`, `246460f`

The three merge commits carry no changes of their own: `f73727a` brought in
`09929fa`, `5e449a8` brought in `6ca2373`, and `1211665` brought in `4f86ba4`.

## v0.4.0 — 2026-09-15

### Breaking changes

- The standing notice is gone (H-1126). `helmo_set_notice` is no longer
  registered, and `helmo_list_tickets` no longer returns a `notice` field. The
  charter and the roadmap already say what the fleet should be shipping, and a
  hand-maintained copy of that on every queue read drifts and then contradicts.
- Workstream `goal` is retired (H-1186): steering carries numbers and names
  only. No tool input, CLI flag, response field, or dashboard section carries a
  goal; `helmo_set_workstream` refuses a write naming one for every actor kind,
  `workstream-set --goal` is gone, and `goal` is absent from the workstream rows
  and from `workstream_steering`. The list and get response shapes are pinned to
  an allowlist so a new string field fails the suite.
- Claiming work requires a loop session or an explicit human-sitting marker
  (H-1056). Agent actors without one can still file and update, but claiming —
  and creating a ticket already `in_progress` — is refused.
- `handoff_to: ""` clears the named receiver rather than always returning the
  ticket to the shared pool (H-1096). In a seated workstream the ticket routes
  to that stream's seat; only an unseated workstream sends it to the pool.
- The dashboard `/answer` route no longer accepts the free-text payload of a
  form that is no longer on any page (H-1053). It ratifies one thing — the
  question the feed actually drew — given the ticket and a fingerprint that
  `answerTicket` re-checks inside the write transaction.
- The older ticket feed is retired (H-1066). Its shared rendering moved to
  `presentation.ts`; the dashboard is the one reading surface.

The store keeps the `notice` and `goal` columns and their historical events, so
a store written before this release still replays exactly. Nothing reads them.

### Work routing and accounting

- Hygiene can read the third accounting category (H-1166): `acct:direction`,
  `acct:security`, and `acct:estate` are a closed set of labels alongside a
  project tag and an `obj:OBJ-n` label. Work justified that way was previously
  permanent, unclearable noise in every `unaccounted_work` sweep.
- Cleared work routes to its stream's seat instead of stranding in the pool
  (H-1096).
- Tickets awaiting second eyes are surfaced as their own set (H-1069).
- Recurring templates are excluded from spend anomalies (H-1124): standing work
  has no spend of its own to be anomalous about.

### Harness surfaces

- `wake-check` exposes ready edges (H-1098): `ready_ids` alongside
  `ready_count`, so a harness can see which work moved, not just how much.
- A newly-ready cursor query (H-1097): `newly_ready_count` and `newly_ready_ids`
  since a sequence number, for an identified caller.

### Operator surfaces

- The dashboard is phone-first (H-1063).
- A decision is drawn before its context (H-1061), and the default record is
  bounded (H-1062): the closed tail is capped, and the progress line each card
  shows comes from one precomputed lookup rather than a full event scan per
  ticket.
- Awaiting sections share one reusable renderer (H-1064).
- Any store string can break, declared once at the root (H-1176): a question's
  situation carrying an absolute path laid out 386px wide in a 326px box and
  pushed a 390px viewport to 420px. `overflow-wrap: anywhere` moves to `:root`
  and the three per-selector copies go; the rule is asserted against the source,
  because the smoke only sees it while some live ticket happens to hold a long
  path.
- The README hero is re-shot (H-1189): the old capture still showed a WORKSTREAM
  STEERING strip quoting a goal. The alt text now describes what the image
  actually shows.

### Reliability and tests

- Composed-Helmo contract coverage is restored (H-1086).
- View tests isolate their ports (H-1093), and demo seeding is single-process
  with correct session stamping (H-1272, H-1099).

### Commit coverage

Every commit after v0.3.0 and before this release record is represented above.
This manifest makes that claim auditable without relying on ticket-title
conventions:

- `0150eb1`, `d98c933`, `ce83990`, `04f4a61`, `50ce79e`, `6f4bf98`,
  `cfc3fe0`, `2ed7213`, `a146e07`, `11200c9`
- `8179481`, `94d3249`, `a504902`, `7558025`, `4b68368`, `1d0a55c`,
  `eeea123`, `c67e903`, `8ca8a73`, `f6e063c`
- `7c16ac5`, `a8f1722`

## v0.3.0 — 2026-09-06

### Work routing and stewardship

- Ready queues honor cross-workstream reservations, and released claims retain
  their assignee until explicitly returned to the pool (H-661, H-954).
- Workstreams can carry a seat; unassigned filings and recurring instances in a
  seated workstream are reserved to it at creation, and hygiene reports pools
  that no seat covers (H-1026).
- Agents cannot reclaim their own filings through metering events; relayed human
  decisions still release those filings for work (H-242, H-829).
- Tickets can carry date gates, explicit capacity holds, and expiring bounded
  releases without hiding or reprioritizing the underlying work (H-732).
- Live work sorts ahead of history, recurring templates cannot be completed,
  and stale unclaimed recurring instances no longer stop the schedule (H-669,
  H-851, H-618).
- Scheduler creation is atomic and produces unassigned instances, preventing
  duplicate or stranded recurring work (H-169, H-171).
- Seat checks identify the process that claimed work, while explicit actors
  retain the environment's seat stamp (H-558, H-687).
- An explicit assignee on a recurring template routes its instances; without
  one they take the workstream seat (H-1034).
- Work needing a sitting with the operator is typed as such: it stays open,
  is withheld from every agent ready queue, and is reported separately from
  questions waiting on an answer (H-1028).

### Product and operator surfaces

- Product completion and independent acceptance are explicit, immutable-ref
  gates rather than implications of ticket status, including while a builder
  still holds the ticket (H-884, H-1006).
- The roadmap seam adds project tags, project filtering, and a provenance-bearing
  standing notice (H-172, H-413).
- A bounded JSON reading lets the estate shell compose Helmo without gaining a
  second write path; rows also expose the latest recorded progress (R-11 H-832,
  H-923).
- The dashboard adopts the estate design tokens and crew marks, including the
  shared status palette and checks that catch silent token drift (R-11 H-714,
  H-771).
- The board and evidence references fit a phone, answer choices no longer widen
  the viewport, and controls expose accessible labels (H-880, H-889, H-916,
  H-930).
- Recorded answers have a read-only CLI door, hygiene is available through MCP,
  and human-return prompts allow a recommendation without manufactured options
  (H-936, H-758, H-939).
- The feed marks recurring templates, so a reader can keep standing work out of
  the live queue as Helmo's own view does (H-1027).
- The vendored shadcn-derived design tokens carry their upstream MIT notice,
  and the package ships THIRD_PARTY_NOTICES.md (H-1007).

### Reliability and record integrity

- Local and remote MCP entry points share one tool implementation; the remote
  endpoint authenticates every call and requires explicit actor identity
  (H-116).
- SQLite writers acquire their lock before reading, with contention tests that
  synchronize on the actual lock rather than elapsed time (H-134, H-681).
- Evidence references have one durable form, and spend accounting reports
  per-ticket self-reporting, clamps negative totals, and distinguishes motion
  from note-only updates (H-95, H-187, H-412).
- Dashboard answers require JSON, same-origin signals, and a per-boot nonce
  (H-145).
- Store recovery detects counters behind the table, reports orphan rows without
  taking down the dashboard, and provides a deliberately narrow, confirmed
  purge path for rows absent from the event log (H-448, H-463).
- The harness accounting queries take a session filter, so a metered loop
  session is not netted against desk work under the same actor name (H-878).

### Commit coverage

Every commit after v0.2.0 and before this final release record is represented
above. This manifest makes that claim auditable without relying on ticket-title
conventions:

- `d613ab5`, `05a1202`, `6df5fba`, `04dbcbd`, `ae6a7e0`, `1081e46`,
  `1f1ceab`, `ad96582`, `fc3c5ca`, `ac7f5c2`
- `ad982be`, `dfc2732`, `42f7c0c`, `75b3304`, `c36aa46`, `cee38bb`,
  `9f87c66`, `4189270`, `b390d95`, `c62308c`
- `4c2b180`, `c2d862a`, `d516324`, `1fa6ae4`, `b53440e`, `edd8508`,
  `19d916d`, `420ee89`, `d7a8c4b`, `364d951`
- `6a9a6f8`, `303d0ef`, `f53ac8a`, `4d70f92`, `8ae5b66`, `087bb84`,
  `d84741c`, `3105aed`, `a275ed5`, `afa8c7c`
- `6ceb6bc`, `aa3d42b`, `081a9c2`, `31b2f15`, `6e590be`, `4ec3816`,
  `6ecc1e7`, `71f2bf4`, `fc41885`, `9279b00`
- `ff819f6`, `bff1ba4`, `e9e6513`, `073983c`, `ed02a37`

## v0.2.0 — 2026-08-06

- H-90: the dashboard learns to answer — the one write a human may make
- H-81: hygiene findings on closed tickets get a disposition surface
- H-71: reject mangled tool-call writes at the door
- H-61: silent_assignee — the seventh hygiene check, for reservations nobody will wake
- H-11 follow-up: npm run demo — the README screenshot's board, reproducible
