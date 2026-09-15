# Changelog

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
