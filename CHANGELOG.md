# Changelog

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
- `6ceb6bc`, `aa3d42b`, `081a9c2`, `31b2f15`, `6e590be`, `4ec3816`
- `6ecc1e7`, `71f2bf4`, `fc41885`

## v0.2.0 — 2026-08-06

- H-90: the dashboard learns to answer — the one write a human may make
- H-81: hygiene findings on closed tickets get a disposition surface
- H-71: reject mangled tool-call writes at the door
- H-61: silent_assignee — the seventh hygiene check, for reservations nobody will wake
- H-11 follow-up: npm run demo — the README screenshot's board, reproducible
