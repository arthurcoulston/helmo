The current dashboard is `packages/shell/src/RuntimeView.tsx`, composed from the unmodified official shadcn Table, Badge, Card and Collapsible. `src/view.ts` owns the state/reason, model, pace, spend, usage, build and recent-event JSON projection and serves the shared application on standalone routes. Historical token, sprite, HTML and DOM-refresh notes below describe the removed renderer.

# DEV — coding context for rev

Rev keeps agent loops turning: process supervision for autonomous loops
that draw work from Helmo. Rev never reads ticket content; Helmo never
manages a process. Product doc: `rev-product-description.md`.
The `trace` command gets only Work's `get --trace` projection: identity,
ownership, blocker and event launch metadata. Its subprocess capture is capped
at 8 MiB; an oversized projection takes the same content-safe refusal path as
any malformed response, never truncation.
The accepted A01–A14 workflow launch proof and its exact cross-repository
boundary are recorded in `WORKFLOW-GATE-VERIFICATION.md`.
The root `INSTALLATIONS.md` is the consumer's account of install identity, pinned
releases, upgrade, rollback and removal — what `install.ts`, `release.ts`,
`remove.ts` and the service-definition section below look like from outside.
It is a published promise: a change to any of those modules' behaviour is a
change to that document in the same pass.
Release selection is shared through `packages/core`; historical three-component
sets remain readable, while C1 locates Rev at `helmo/packages/runtime`.
New selections contain one `helmo` component. Runtime validates Work, Roadmap
and Runtime artifacts under that component against the same clean commit;
partial or extended manifests refuse rather than falling through to legacy.
After `release upgrade` or `release rollback`, `release activate` is the only
supported completion command: it records the attempt, requests the bounded
drain, and verifies the replacement. The aggregate app health check consumes
Runtime's explicit `ok`: stale supervisor bytes or a WEDGED loop fail it,
while deliberate STOP, IDLE and SEAT_HELD states remain healthy controls.
Renamed from Capstan 2026-08-05 (H-53); Helm event history before then carries
the old name, and the `capstan-dev` workstream merged into `rev-dev` (H-62).

## Architecture (src/)

- `loop.ts` — the single-loop driver: wake on Helmo's event cursor (zero tokens
  while idle), spawn one fresh session per iteration, classify the outcome,
  idle or halt. The iteration prompt ("work ONE ticket to a natural stopping
  point") lives here. Its first sentence declares the run a Rev loop rather
  than a summon, before tool or routing context can be misread; it then gives
  the workstream's budget when set
  (helm-cli `workstream`: remaining budget, helmo H-55) — disclosure
  before planning, and a steering fetch failure never stops the loop.
  Zero is Helmo's uncapped sentinel (H-267): the prompt says there is no cap
  and keeps runnable work runnable; only positive finite budgets carry
  exhaustion guidance.
  Steering covers EVERY stream the seat has work in, not just the one it
  watches (H-954): `seatStreams` lists the tickets assigned to the seat, and
  the watched stream plus their streams are what `steeringText` speaks for,
  each budgeted stream named individually with its own close-out cue. Only
  streams with a budget appear in the preamble; routed streams without one
  add nothing and naming them in every iteration is prompt noise (H-1127).
  **The prompt carries no prose from outside git** (H-1186, Arthur's ruling
  2026-09-08): the store's workstream `goal` and the roster's per-loop
  `prompt` tail were both free text — uncapped, unreviewed — appended to
  every iteration. Both are gone: `steeringText` speaks numbers in fixed
  wording, and `loadRoster` rejects any loop key outside `LOOP_KEYS`, so a
  prose channel cannot reappear under any name. A seat's words are its
  constitution and roster skills, which the crew's context check measures.
  `workstream = "*"` makes a loop store-wide (H-92,
  built for bosun): wake is unscoped but fires on MOTION ONLY (changed_since, never
  ready_count — the whole store's standing backlog would wake a judge every
  poll forever), no steering fetch at all — its prompt carries none of the
  close-out framing steering is written for — and it defers to the
  constitution instead of naming a stream or the ONE-ticket rule. Per-loop `idle_floor_s` holds wakes after
  an unproductive pass, and since H-1072 it holds them for `'*'` loops ONLY:
  motion accumulates but cannot re-wake the loop until the floor elapses
  (H-336: a live desk session woke ward ~$1/2min against an empty queue;
  H-545: bosun's own sweep records were the motion that woke it, 16 straight
  iterations to the burn breaker). A store-wide loop also idles after a
  *productive* clean pass. Its idle cursor deliberately remains at the
  pre-session snapshot: a filing can land after the session's final queue read
  but before Rev's post-session snapshot, and advancing through that event
  would acknowledge work no triager ever saw. Motion during a store-wide pass
  is therefore delivered at least once on the next wake. The loop may buy one
  bounded reconciliation pass for its own writes, then advances on the quiet
  pass; the idle floor still caps that cost. Before this, the floor
  only ever gated wakes, and a produced pass used to `continue` straight
  into the next one, so bosun's pass-closing sweep record, which drew a
  done_without_evidence finding that the next pass disposed of, ran it back to back
  at ~$0.40 a pass (H-2164). One sweep covers the whole store; only someone
  else's motion justifies another. Motion is still what wakes a store-wide
  loop, so the floor is still what caps its burn. A scoped loop no longer
  needs one: it wakes on a readiness edge, and work newly ready for the seat
  is by definition not the churn the floor was built to absorb. The key is
  still parsed for those loops but never consulted, and it has been dropped
  from every scoped loop in the instance roster. The first successful poll after
  a process start bypasses a surviving `IDLE_AT`: the floor spaces passes from
  the same process, but must not make a restarted seat sleep on queued work
  (H-995). A scoped pass retains its pre-session cursor when Work's atomic
  post-session snapshot finds a readiness edge during that pass, so the first
  idle poll offers work the session never saw; the following pass advances
  normally if it declines that work. Work treats an assigned, in-progress
  ticket whose blocker or other executable gate opened as the same one-shot
  readiness edge, without putting held work in the open claim queue (H-2851).
  BOTH prompts tell a no-change
  pass to end WITHOUT filing or noting — its own exhaust is fresh motion, so a
  no-change record re-wakes the loop it closes. The scoped prompt says it in
  the terms a scoped seat actually meets (queue empty, or every ticket blocked,
  time-gated, or with the human) and carves out an unasked human question,
  which triage duty still requires; only the '*' prompt carried the
  instruction until H-740.
  Both prompts split a ticket only into independently useful deliverables,
  never to fit an iteration; the parent stays open with its owner until its
  scope is delivered or deliberately changed (replacing H-1057's close-as-plan
  rule). Both prompts also require every considered ready ticket to be acted
  on rather than remain invisibly declined (H-1071): link its real blocker and
  owner, hand it on, date it to a real event or cancel it. The human is asked
  only for a reserved decision not already made. A resumed ordinary claim that
  cannot advance until another ticket is done may be linked and set back to
  open, still reserved to the seat, so the held claim does not starve its own
  prerequisite; workflow-bound claims never are. For a scoped seat, Rev
  snapshots ready IDs around each clean, unproductive pass and keeps a
  per-ticket streak in `.silent_decline_streaks.json`. When a streak reaches
  three, Rev files (or notes on) one coordination ticket per loop in
  `escalation_workstream` and notes the routing on each source ticket. It
  never returns to the human, writes `needs_human` or alerts the operator for
  this: repeated no-progress is a team routing problem. Each ticket is routed
  once, at the crossing, and keeps its count through other work's productive
  passes; it leaves the map when an unproductive pass finds it no longer ready
  and unchanged. The routed count is saved only after coordination succeeds;
  a failed write leaves the crossing available for retry. Containment is Rev's
  own: the hourly resync skips a ready set
  made only of routed tickets and restarts its hour, while newly ready work
  still wakes the seat. Rev records each routed ticket's material state
  (`.routed_state_streaks.json`; its fields and its links, read through
  Helmo's `get`; notes, spend and the actor chain excluded). A routed ticket
  whose state has changed since then is offered at the next resync and counted
  afresh, so a coordinator supplying the next step, in the body or as a linked
  subtask, wakes the seat. Links need a Helmo whose CLI `get` returns `deps`.
  Store-wide `'*'` loops are excluded, and for them a note that changes
  nothing on the ticket is not a disposition.
  An IDLE sentinel keeps the wake cursor on its first line and a bounded reason
  on its second (H-954): either no executable work exists in the seat's scope,
  held work is non-executable, or a session left executable work untouched.
  The view and `/health.json` expose that reason; it stays local so observing a
  wait cannot create Helmo motion and wake the same seat again. A SEAT_SHARED
  sentinel names the tickets another live session holds in the seat's name
  while the loop works on beside it; the view, health feed
  (`shared_with`) and CLI (`SHARED SEAT:`) show it on a live loop, and it
  clears with the holds. SEAT_HELD is only ever left by an older process,
  which stood down instead; a current loop clears it.
  Multiple roster loops may explicitly share an accountable `seat`: each
  keeps its own state directory and `rev:<loop>` session identity, while
  Helmo sees the role name for assignment, authorship and self-review. The
  guard exempts only the peer sessions derived from the loaded roster; an
  unlisted desk session or subagent still holds every worker in the seat.
  Their `cwd` paths must be separate writable workspaces; the roster refuses
  two workers of one seat whose `cwd` is the same real directory (a symlink
  alias included), nested one inside the other, or inside one git worktree
  and so one index (H-671, `writableDestination` in config.ts), and refuses a
  `'*'` pool.
  **Pool workers launch on a claim, not a choice** (H-574). A loop sharing its
  seat skips `launch-admit` and, just before `run-start` (after every capacity
  exit, before the probe decision), calls helm-cli `launch-claim --workstream W
  --assignee <seat> --launch-id <id> [--project P] [--tickets H-1,H-2]` written by the worker
  itself — seat name, `rev:<loop>` session, `generation` = the launch id — so
  Helmo selects, workflow-admits and claims in one transaction, bound to that
  one attempt. The session's `HELMO_ACTOR` (MCP env, and the mock's env)
  carries the same generation; Helmo refuses execution writes on the ticket
  from any other session or generation (`execution_claim_held`) and any write
  from a retired one (`stale_generation`). The prompt names the one ticket and
  forbids touching any other. The journal records `claim: true` at intent and
  the ticket on the receipt. **Unfinished work stays with its worker**: a
  session that ends with the ticket in progress logs `claim-kept`, and the
  same worker's next `launch-claim` returns it with `resumed: true` — retiring
  the old generation — and the prompt says it was resumed, names the
  workspace, and points at the ticket's last recorded step. A restart after a
  crash settles the dead launch's journal and keeps the claim the same way, so
  a child that outlived its loop can write nothing after the resume. That
  fences the record, not the workspace (H-685): every journaled session's shell
  writes its process group id to `<entry>.group` before it execs the CLI, and
  while that group is still running the restarted worker logs
  `launch-session-running` and launches nothing — polling like the seat guard,
  no IDLE marker, no iteration spent — then settles and resumes once it has
  gone (`launch-session-ended`). It never kills the session: its generation is
  still current, so what it finishes is valid. A group it cannot signal counts
  as running; a group id whose leader started well after the dispatch is a
  later process that inherited the id. **A claim whose reply was lost** (H-686)
  — the CLI failed, or the process died after asking — may have committed, so
  its `intent` entry is never settled blind, at restart or in process: the
  next claim asks again under THAT launch id and logs `claim-reconciled`.
  Helmo answers the receipt it granted while the claim stands, claims afresh
  if the first ask never landed, or refuses `launch_claim_stale` /
  `stale_generation` once it has moved on (`how: 'stale'`), which alone
  settles the entry `quarantined` and lets the launch take a fresh id. A
  receipt that does not match the worker's scope (`how: 'mismatch'`, H-671)
  is an answer too, never re-asked: a claim it granted to this launch is put
  back and the launch denied. Until
  Helmo answers the worker polls with no IDLE marker and no iteration spent:
  its own claim is not motion that would wake it. Only a
  claim never worked goes back to `open` (seat reservation kept), released as
  the launch's own generation: a session that never started (`apparatus`), a
  failed pre-dispatch revalidation, a suppressed replay, or a journal write
  that failed. **A workflow-bound claim** (H-687) is never released: its
  attempt has spent its one launch admission, so an open ticket would be
  refused to every worker that drew it; those paths log `claim-kept` instead.
  Nor is a kept claim's admission quarantined — not at restart, not when its
  session ends short of `ok` — because Helmo's resume revalidates it, and a
  quarantine would refuse the very resume that keeps the work with this
  worker. A resumed workflow claim carries the admission its first launch
  consumed; Rev journals it claim-only and revalidates and quarantines by the
  `admission_launch_id` Helmo names (a store that names none revalidated at
  resume, and Rev relies on that). Authority that fails revalidation is still
  quarantined, and Helmo's next resume then returns the ticket open with
  `needs_human` and hands the worker its next ticket. A
  store without `launch-claim` denies every pool launch — without the atomic
  claim two workers race the same ticket. Nothing ready means `launch-idle`
  and no session. `project` is the worker's lane and `tickets` its exact
  allowlist (H-671) — what keeps two workers in ONE project off each other's
  work; Rev refuses a receipt naming a different allowlist or a ticket outside
  it, and the roster refuses one ticket in two allowlists. A worker of that
  seat with no allowlist is given the union as `exclude_tickets` (derived at
  load, never a roster key) and claims with `--exclude-tickets`, so the
  role's general worker never takes a lane's ticket. Both keys are refused on
  a loop with no pool.
  `lane` replaces the allowlist: Helmo routes by a ticket's `lane`
  column, so new lane work needs no roster edit or restart. A lane worker
  claims with `--lane` and Rev checks `scope.lane` on the receipt; a claim
  without `--lane` gets only lane-null tickets, so the general worker needs no
  exclusion for lane work. The roster refuses `lane` beside `tickets`, two
  workers of one seat on one lane, and a lane on an unpooled loop.
  `lane_null` is derived for the general worker once a sibling has a lane, and
  only then does wake-check carry `--lane`/`--no-lane`, so a lane-less roster
  sends Helmo exactly what it sent before. A worker whose config changed while
  it held a claim is denied `held_out_of_scope`: no session, no release, the
  `OUT_OF_SCOPE` sentinel names the ticket in `status`, and restoring the
  config resumes it. A pool worker's restart pickup also wakes when its seat
  holds work, so that restore is asked for at once rather than at the next
  motion. `status` lists ready lane work no live worker serves
  (`unserved_lanes` in `--json`), below the table.
  A current release handoff remains an intentional human sitting and is absent
  from the ready observer. If its acceptance snapshot moves, Work atomically
  makes the handoff stale and clears the sitting; the complete ready-backlog
  comparison then records the ticket without inventing a release mutation.
  **A role is addressed as a role** (H-676). The first worker usually keeps
  the role's name, so `stop`/`resume`/`pace`/`team` resolve through
  `controlTargets` (config.ts): a seat with more than one loop, or a seat no
  loop is named after, reaches every worker of it, and `--worker` narrows it
  to the one loop of exactly that name. Sentinels stay per loop; a role-level
  halt is written to each worker. Anything that routes work to a role must ask
  which worker can draw it: `drawsScope` (helm.ts) says a one-worker seat
  draws its seat's work in any stream, a pool worker only in its exact
  workstream and project, in its exact ticket lane, and with an
  allowlist only the tickets it names — so
  never a newly filed escalation. The anomaly investigator is chosen with it and
  assigned by seat, never by loop name — a pool worker's own name is no
  assignee anything wakes on. `status --json` prints each loop's `seat`,
  `pool`, `workstream`, `project`, `tickets` and `lane` beside its state, for consumers outside
  Rev (gp-crew's handoff guard) that must answer "can this role take this
  ticket"; the human table is unchanged because estate tools parse its header.
  **Workflow launch admission** is the last gate before a session is spent
  (H-2561, helmo H-471): `launchAdmit` asks helm-cli `launch-admit --workstream
  W --assignee A --launch-id <identity>`, and Helmo picks the
  seat's ready candidate, checks it, and records the admission in one
  transaction — so the verdict cannot drift between the check and the launch.
  Rev asks rather than deciding and keeps no verdict: the question is put again
  every pass, and a fresh process asks again on its restart pickup rather than
  walking through a denial it never saw. Helmo's echoed `launch_id` is
  deliberately not compared with the one sent; it is there so Helmo can admit a
  retry of the same launch without recording a second admission. For
  workflow-bound work that identity is a digest of the seat, ticket and
  workflow-attempt id, so a process restart asks with the same name and the
  durable pre-dispatch claim suppresses a second model session. Ordinary and
  probe launches retain their process-local unique identity because they have
  no workflow attempt to recover.
  Rev also requires the atomic answer to identify the same candidate as its
  immediately preceding compatibility read; a queue substitution fails closed
  instead of borrowing the earlier candidate's workflow classification.
  **Three of the four answers are a launch, and only one of them is a yes.**
  `admitted: true` admits a candidate (`launch-admitted`). `admitted: false`
  means nothing READY was there to gate — not a refusal: the seat still has its
  held work and its probe pass, and whether to spend an iteration on those is
  Rev's decision, so it is not even recorded as one. A thrown
  `workflow_admission_denied` is an explicit refusal: it logs `launch-denied`,
  spends nothing, and re-idles at the cursor it read, so the question returns
  on the next motion or the hourly resync. An installation that predates the
  command answers with its usage text. Rev first reads Helmo's same ordered
  next-candidate query: ordinary work keeps its prior behaviour and logs
  `launch-admit-unsupported`. The question is repeated on every pass so a later
  workflow candidate cannot inherit an ordinary ticket's bypass. Workflow-bound
  work instead fails closed until an exact immutable admission is returned.
  A corrupt or temporarily unavailable gate follows
  the same affected-work-only rule and is asked again next pass.
  Workflow admissions are durably revalidated immediately before dispatch and
  again after the model returns. A restart quarantines any admitted or
  dispatching journal entry it recovers, except a pool claim's (above): that boundary is ambiguous, so only
  the affected attempt is withheld while ordinary work and sibling branches
  continue. Failed quarantine remains unsettled for the next restart rather
  than being mistaken for safe output.
  Revocation is therefore bounded by one already in-flight model session: a
  killed driver cannot stop that detached session, but the next Rev boundary
  quarantines its attempt and refuses to launch it again or count its output as
  success. This relies on the host OS and process tree reporting honestly;
  unrestricted local process access remains outside Rev's trust boundary.
  That stderr is captured rather than forwarded (`run`'s `quiet`) —
  `execFileSync` does both by default, which would put Helmo's whole usage text
  in the loop log once per pass.
  After
  each iteration it writes the session's metered spend back to the
  claimed ticket for a pool worker, or the most-touched ticket for a
  free-roaming loop, via session-filtered helm-cli event queries and
  `record-spend` (H-19, H-878), so desk writes under the same actor name cannot
  capture the loop's charge — as the rev
  actor, since Rev is the meter, not the spender — net of anything the agent
  self-reported in the window (`actor-spend`, H-57): a session lands in the
  totals exactly once. Each guess is cancelled on the ticket that carries it
  and the meter lands on the primary alone (H-187) — a session-wide
  correction once left a ticket at −62k beside a neighbour's +80k guess.
- Known Claude usage bars follow the configured numeric exhaustion threshold;
  a `critical` severity below that threshold remains a warning. Actual Codex
  reached-cap evidence and unknown critical bar kinds remain binding. Routing
  and pre-launch capacity use the same `usageLimitExhausted` predicate.
- `usage.ts` — usage bars per provider. Claude: the undocumented
  `api.anthropic.com/api/oauth/usage` (H-278; security design approved in
  H-280, landed-code check is H-298), polled by the supervisor every 10 min
  into `~/.rev/usage.json`. Parse the `limits` array, not the top-level
  `five_hour` / `seven_day` objects: it is self-describing and it NAMES the
  model a scoped weekly cap belongs to, which is the only way the Fable cap is
  legible rather than an opaque codename. Codex: no network poller and no credential
  (H-479) — every `codex exec` run writes its rate-limit standing into its own
  rollout file under `$CODEX_HOME/sessions`, and the shim lifts the freshest
  block into `~/.rev/usage-codex.json` after each run. Before selecting a
  provider, Rev also reads bounded tails of the twenty newest rollouts in
  today's/yesterday's folders, so local desk meetings count too (H-892).
  Only parsed shared-Codex usage survives; Spark's separate bucket is ignored.
  Parsed Codex credit capacity survives with it: a fresh positive balance (in
  credits, never dollars) or explicit unlimited allowance keeps the account
  runnable after included bars fill, while missing/zero credits and provider
  spend-control refusal remain out. Credit availability does not bypass the
  subscription anomaly detector; it only answers whether another run can start.
  Event timestamps are preserved: rereading an old event never refreshes it.
  `rev usage [--poll]`, `rev status` and the view
  header read both. Every failure is soft — keep the last numbers, mark
  stale, back off; nothing in rev may wait on a usage bar. A failed poll keeps
  the last good `fetched_at`, so `lastGoodReadUsable` judges by age: the kept
  read admits a capacity `continue` until USAGE_MAX_AGE (H-740), but never
  justifies a wait and never ranks routing headroom.
- `ancestry.ts` — abandoned-tree detection (H-281). Every loop and the
  supervisor stamp their ancestor chain at start and self-terminate (loop:
  exit between iterations; supervisor: drain) when any link dies or is
  reparented. A direct ppid check is NOT enough — the 2026-08-28 swarm
  (~28 orphaned dev trees, some racing the live store for six days) died at
  the SHELL above the tsx wrapper, leaving every inner ppid link intact. A
  launchd-parented supervisor has an empty chain that can never break, so
  deliberate daemons go through `rev service`, never nohup. Drains also
  escalate: past `drain_grace_seconds` a straggler is SIGKILLed rather than
  waited on forever (a hung drain ends in an operator kill -9 and orphans) —
  and the escalation takes the straggler's session group with it (H-1089),
  because the loop alone is not the whole seat.
- `health.ts` — fleet-down detection (H-448). A failing wake-check is modelled
  as "no news, try next poll", which is right for contention and wrong for
  anything permanent; past `wedge_cap` consecutive failures the loop is marked
  WEDGED and an alarm is raised. **The alarm cannot go through Helmo** — Helmo
  is what a wedged loop cannot reach — so it leaves by another door
  (`osascript` notification on darwin, best-effort, never fatal). Raised once
  per episode; the sentinel clears the moment a wake-check succeeds.
- `sentinels.ts` — process identity is three-state. A missing or mismatched
  process is dead; a matching command is alive; unavailable process inspection
  is `unknown`, shown that way by status surfaces while conservatively keeping
  the RUNNING marker occupied so a restricted observer cannot start a duplicate.
  Process-control sentinels keep their value on line one and may carry `by`,
  `at`, `pid`, `reason` and `expires_at` provenance below it. Legacy or malformed
  controls are presumed deliberate and never auto-cleared. Only an expired or
  orphaned non-human PACE is released, and cleanup compares the observed
  by+at+pid tuple before unlinking so it cannot erase a replacement owner.
  `pace` from the CLI records `pid=0` (`NO_OWNER_PID`): the command exits as
  soon as it writes, so an agent's park is held by its one-hour `expires_at`
  and never counted as orphaned (H-738; a CLI pid released it on the next poll).
- `burn.ts` — reads the token-log back as a per-loop rolling window (hour and
  day) for the breaker. A file scan, not an in-memory total, because the two
  burns it exists for both spanned process restarts; the window is floored at
  `.burn_floor` (stamped at loop start) so a resumed loop starts clean instead
  of tripping again on money already accounted for (H-412). New token-log
  entries carry `duration_ms`; each window counts the fraction of a session
  whose interval overlaps it, while legacy duration-less entries retain their
  point-in-time behavior (H-3129).
- `team-now.ts` — the condensed roster behind Overview's Team now card (R-44
  H-3091): Rev's state words rolled up from SESSIONS to accountable AGENTS, in
  six display states. See "The condensed roster" below for the mapping, the
  roll-up order and where the reasons come from.
- `team.ts` — the Team projection (H-3001): what each seat is CONFIGURED to
  carry into a session, and what the token-log says its sessions spent. The
  inventory measures the files the roster itself names — the constitution and
  each roster skill, which is `systemPrompt`'s own composition — with
  js-tiktoken `o200k_base`, the same encoding the estate's context check uses,
  so one file never reports two sizes on two surfaces. Three distinctions it
  exists to keep, each of which was a way to mislead: what Rev COMPOSES against
  what the runtime's CLI DISCOVERS by walking up from `cwd` to the enclosing
  repository (measured the same, attributed differently); what LOADS at startup
  against what is AVAILABLE to read, because a seat's `memory_dir` corpus runs
  to hundreds of files and counting it in would overstate every seat by two
  orders of magnitude; and what is MEASURED against what is not — the CLI's own
  system prompt, its tool schemas and the iteration prompt are named rather
  than left to read as zero. It invents no whole-session cap, because none is
  configured anywhere and a model's context window is not one. `seatSpend`
  windows the same token-log `burn.ts` reads, by period, with per-model and
  per-day sums; a line the shim wrote as `tokens=? cost_usd=?` is counted as an
  unmetered session rather than totalled as a free one. The ~20MB of BPE ranks
  load on the first measurement, so no command that never asks for context pays
  for them. `view.ts` adds `state()` to the document, rather than team.ts
  deriving loop state a second time and letting two surfaces disagree.
- `context-coverage.ts` — whether that configured account is still TRUE
  (R-45 H-3581). team.ts says what the roster would supply; it cannot say
  whether that still matches what a session was handed, and the audit behind
  this feature (`crew:projects/r50/CONTEXT-COVERAGE.md`, H-2952) found the
  account goes stale silently — a host CLI upgrade that renames the retained
  request shape, or a roster change that adds a skill, invalidates part of it
  with nothing going red. So it is a check that runs, not prose that was true
  once. It adds no collector: the roster, the launch journal and the host CLI's
  own transcript are all records that already exist.
  Five assertions against the most recent SETTLED launch on a path, in order,
  each one's failure being its own repair instruction: the session carries an
  `observed` `provider_session_id`; the host record that id names exists and
  parses; its retained request shape is readable; its recorded `cwd` matches
  the roster's; and the bytes this installation composes today are retained
  verbatim inside that launch's prompt. The last one is an exact byte
  containment test and never a first-line or opening-paragraph match: an
  edited file whose opening survived would otherwise be called the same file
  (H-3581). When the bytes differ, the finding is that they differ plus the
  evidence limit — the host record retains the prompt whole and no per-source
  hash, so WHICH source moved is not determinable from it, and that is what
  R-55's per-source record answers.
  Four distinctions, for the same reason team.ts has three. CURRENT against
  HISTORICAL: `current` is composed from today's files and `historical` is one
  launch's own records, as separate blocks never averaged into a verdict.
  SUPPORTED against UNSUPPORTED: a codex loop and a named summon stay in the
  reading as `unsupported` with the reason, because a gap that is absent reads
  as a gap that is covered. CHANGED against STALE: sources that moved on are a
  normal event, not a broken check — only an assertion that could not be MADE
  is stale. And a path's runtimes come from its rotation and fallbacks, not its
  primary: a seat configured `runtime: codex` with a claude choice runs on
  both, and reporting only the primary is how the inventory came to omit a file
  every Claude run receives (the audit's correction 1).
  `last_verified_at` is the last SUCCESSFUL check, kept in
  `state/<seat>/context-coverage.json`, so a failing check writes nothing and
  the previous success is what says how long the account has been drifting.
  Two entry points because it runs at two moments: `checkOnSettle` fires from
  `loop.ts` after `recordLaunchTouched`, cheap by construction (no tokenizer,
  one bounded read) and in its own block so a failed check cannot affect the
  run that produced it; `coverageReading` is the whole-fleet reading and embeds
  team.ts's own `seatContext` under `current.inventory` rather than restating
  the cap rules — a second copy of those here would be H-3009 again. It
  composes the prompt a second way, because `shim.systemPrompt` throws on a
  missing source and a missing source is one of the states to report; the two
  compositions are held byte-identical by a test, since drift between them
  would report a change nobody made.
  The host record is looked up by session id across `~/.claude/projects`
  (`CLAUDE_CONFIG_DIR` when set) and not only under the computed slug: the
  host maps both `/` and `.` to `-`, so the name is lossy both ways and a
  present record would be reported missing. `HOST_RECORD_BYTE_CEILING` bounds
  a transcript that holds no request shape at all; the launch's own shape is in
  the first entries and the read stops there. The id is held to the uuid shape
  before it becomes part of a path (`HOST_SESSION_ID`, H-3599): it comes from
  the host CLI's own `session_id`, but it reaches the reader through this
  installation's launch journal, and an id that is not a session id is reported
  as a malformed join key rather than as a missing record — different repairs,
  and the id itself is not echoed back. Not by the assertion and not by the
  document either: `historical.provider_session_id` is filled in only once the
  id has been observed AND held to its shape, because building `historical`
  from the journal entry first put the raw string one field away from an
  assertion carefully reporting nothing but a character count (H-3612).
- `startup-context.ts` — what one launch ACTUALLY received, written at the
  moment it was handed over (R-55 H-3573). context-coverage.ts names its own
  two limits in its code, and both are this module's contract: the host's
  transcript is prunable and not versioned with our releases, so a host path is
  not retention; and that transcript retains the prompt WHOLE with no
  per-source hash, so it can only say the bytes differ, never which file moved.
  So this record is this installation's own, and it is per source.
  Two halves, written at the two moments their evidence exists. At dispatch,
  immediately before the model process starts, `recordStartupContext` reads the
  constitution, each roster skill and each discovered instruction file once,
  retains their exact bytes, and records the identity, association basis,
  versions, channels, per-source hashes, source repositories and the
  composition's own hash. At settlement `attachSettlement` adds the host CLI's
  own record and asks the one question that turns RECORDED into CONFIRMED:
  does the host's retained prompt contain the exact bytes this receipt took at
  launch? A receipt whose host record was pruned stays `supplied_confirmed:
  null` with its content intact — the case the retained copy exists for — and a
  receipt whose host disagrees says so rather than reconciling it.
  **The composed prompt is not stored.** It is rebuilt from the per-source
  blobs and `skillHeader`'s framing by `reconstructComposed`, then checked
  against the sha256 taken at launch. That check is what makes the rebuild
  evidence instead of a plausible reconstruction: if this reader's framing and
  the launcher's ever drift, it reports a mismatch rather than returning bytes
  nobody received. Storing a second copy of the same bytes would be the
  redundant content the brief warns against, and it would not carry that check.
  Content lives in one content-addressed store per installation,
  `state/context-blobs/<first two>/<sha256>`, shared by every receipt naming
  it: a seat's constitution is one copy however many times it launches, so
  storage is O(distinct content) rather than O(launches). Blobs are written
  before the receipt, so a receipt never names a blob that was not on disk
  first.
  Five distinctions, the same discipline as team.ts's three and
  context-coverage.ts's four. SUPPLIED against DISCOVERED: Rev composes the
  constitution and the roster skills, and the host CLI finds `CLAUDE.md` files
  itself — both are recorded, only the first is something this installation
  handed over, and NEITHER is a claim the session read them. RECORDED against
  CONFIRMED, above. RETAINED against EXPIRED against LOST: `resolveContent`
  resolves each reference at READ time, so a receipt is never rewritten to hide
  the difference between content the policy dropped at `RETENTION_DAYS` and
  content that went missing inside the horizon, which is a defect in the store.
  A reading resolves EVERY `retention` field it prints, per source and for the
  iteration prompt, not only the aggregate counts — the per-source line is the
  one a reader uses to find out WHICH file is gone, and it used to echo the
  receipt and say `retained` beside a top-level `lost` (H-3641). The stored
  receipt still says what was true when it was written; the resolution is the
  reading's, which is why `ReadingReceipt` is a separate type.
  COMPLETE against PARTIAL against FAILED recording: a recording failure must
  never take down a launch and must never pass as an absence, so it writes a
  receipt that says it failed, keeping the work association and the hashes of
  what it did read — a launch with no receipt at all therefore means only that
  nothing could be written. And NOW against LATER: nothing here covers what a
  session read after it started or what survived a compaction, and both stay
  named in `unknowns`.
  The tool surface is named by reference only — server names and the program
  each runs. Never their arguments or environment, which is where credentials
  and the per-session actor stamp live, and a receipt is a document somebody
  reads. `compareReceipts` is the two-run comparison and answers in file names;
  it refuses to read a cross-installation pair as drift in one, since seat
  names and launch ids are unique only inside an installation. `pruneBlobs` is
  reference-counted over the receipts inside the horizon and never over a
  blob's own mtime: two launches 100 days apart share the constitution, and
  dropping it on its age would empty a receipt written yesterday. Its live set
  walks the SEATS THAT HAVE RECEIPTS, not `roster.loops` — a seat retired while
  its receipts were still inside the horizon lost its blobs to a roster walk,
  and those receipts then read `lost`, reporting a store defect that was the
  prune's own doing (H-3641). Three shapes it refuses rather than walks: an entry
  in the store whose name is not a sha256, a shard that is not two hex
  characters, and an entry that is not a regular file — a symlink wearing a
  valid blob name is reported, never unlinked and never counted as content the
  store holds, because the names in a trust boundary are not the store's own
  (H-3701). All three are reported under `skipped`. And `PRUNE_WRITE_GRACE_MS`
  holds anything written in the last hour, because `retain` returns before the
  receipt naming it exists and that gap belongs to a launch in flight; a
  `retain` that deduplicates against bytes already there touches their mtime
  for the same reason, since a reuse writes nothing and would otherwise leave
  an aged blob droppable in the window before the new receipt lands (H-3701).
  **Operating it** (R-55 asks for this by name). The operating owner is the
  `estate-ui` seat, which owns this module, its retention constant and its
  repair; Ward holds the posture of the blob store itself (H-3637). Capture
  asks nothing of an operator — it runs at every supported launch, and a
  launch that could not be recorded is the only launch with no receipt.
  INSPECT with `startup-context`, which carries one `status` word for the
  whole reading and exits non-zero on anything short of `ok` — so whatever
  runs it learns the finding without parsing the JSON. `failed` is a receipt
  whose recording failed or content missing inside the horizon; `degraded` is
  a `partial` receipt. Partial counts because a store obstructed on EVERY
  launch records `partial` forever, and a probe that stays green through that
  cannot see the failure it exists for (H-3641 finding 7; it did stay green
  in 2026.10-30, measured). `recording.errors` names what failed, and `lost`
  against `expired` separates a defect in the store from the policy doing its
  job. A selector that named one thing and matched nothing — `--launch` or
  `--ticket` — is a one-line refusal and exit 1, not an empty reading; a bare
  seat or installation read still exits 0 on an empty store, because zero
  receipts is the right answer before a fleet has launched. REPAIR is by cause
  and never by back-fill: a `partial` receipt is repaired by the next launch
  once whatever obstructed the store is cleared, and the obstructed receipt
  stays as the record that it happened, because a receipt rewritten later
  would be exactly the fabricated completeness the brief forbids.
  Content that is `lost` cannot be recovered; the receipt keeps its hashes and
  says so, which is the honest end state rather than a repair. STORAGE is
  bounded by the supervisor itself: `pruneRetainedContent` runs in the
  periodic pass, once a day, self-throttled by a stamp under
  `state/supervisor/`, and logs `startup-context-pruned` every time it runs so
  the control is visible in `events.log` rather than merely asserted. It never
  throws — the same bargain `logretention.ts` makes, since retention must not
  be able to take the fleet down. `--prune [--apply]` is the same walk on
  demand, dry until the word. Before this caller existed nothing enforced
  `RETENTION_DAYS` but an operator typing the command, which made the 90-day
  horizon the privacy clearance rests on nominal (H-3641 finding 3, the bound
  Ward set on H-3642). ROLL BACK by
  selecting the retained release and restoring its entry-point pins: a release
  without this module neither reads nor writes either store, so both are left
  behind inert and no downgrade deletes them.
- `context-trace.ts` — what one SESSION's context actually was, per model
  invocation (R-55 H-3724). The two modules above answer about the launch:
  context-coverage asks whether the configured account still holds, and
  startup-context records what the launch was handed. Neither can say what
  reached the model on the fortieth call — what had been added since, what the
  host had dropped, and how big any of it was. The audit behind
  context-coverage recorded that as "No record" on every path, and that was too
  pessimistic: both host CLIs keep a per-invocation ledger and both record
  compaction. This module reads them, and it adds no collector either.
  Two adapters, because the two hosts are partial in DIFFERENT places, and that
  difference is the finding.
  **Claude** (`api-request`, `api-request-shape`, `api-request-blob`, from
  claude-code 2.1.300) names every call's message list exactly — `base` is the
  call it builds on, `keep` how many of that call's messages survived, `tail`
  the hashes appended — so the list, the additions AND the removals are
  reconstructable without the host ever writing one out. Each configuration of
  system prompt and tool schemas is a `shapeHash` re-emitted whenever it
  changes, so a session's instruction and tool timeline is readable: one mason
  loop session grew from 12 tools at 23KB to 24 at 75KB as deferred schemas
  loaded. What it does NOT hold is the content of every message it references —
  measured at 41% of 3,332 referenced messages across fourteen loop sessions.
  The retained blobs skew to what the host SYNTHESIZES (system reminders,
  recalled memory, injected instruction files), and ordinary turns are left to
  the transcript's own `user` and `assistant` entries.
  The first reading of this record called that remainder joinable "only by
  position" and declined the join. It was wrong, and `recovery` is the
  correction: every assistant transcript entry carries `requestRef`, the
  api-request id whose reply it is, so what a request ADDED is the PREVIOUS
  request's reply group — its assistant message assembled from that group's
  blocks in `apiBlockIndex` order, then the user message built from the tool
  results that followed. An EXPLICIT key, not a position. On those fourteen
  sessions it resolves 1,957 of 1,957 unretained messages, so a session is
  100% readable rather than 41%.
  It is still an inference, and the record carries its own validation set: the
  host retains a blob for SOME of those slots too, so each reconstruction is
  compared against what actually went out, block hash by block hash. Measured:
  the reply-group slot count agreed on every group of all fourteen sessions, an
  ASSISTANT message reconstructs byte for byte 154 times out of 154, and a USER
  message does so 65 times out of 97 — because the host appends system-reminder
  text to a user message, and sometimes wraps a block, on the way out. Those
  are counted by failure mode in `recovery.modes`, and two of them are why
  `additions` stays `partial` even when nothing is unresolved: a reconstruction
  is what the host wrote down, not what it sent. One more trap the validation
  set caught — the transcript keeps a tool call as the MODEL wrote it, and the
  host rewrites some inputs before the wire and records that form beside it in
  `wireToolInputs`; reconstructing from the model's form reports a command the
  next call's context never held.
  **Codex** (`session_meta`, `world_state`, `turn_context`, `response_item`,
  `token_usage_record`, `compacted`) is the mirror image: every item's content
  is inline, the host's own prompt is verbatim in `base_instructions`, the cwd
  repository's revision comes free in `session_meta.git`, and each source
  arrives as text or as the host's own hash, which is the immutable reference
  the brief asks for. What it does not hold is the message array of each underlying API
  call: it records turns and items, so `invocations` is `partial` and no
  per-call count is computed. A `world_state` with `full: false` is a DELTA
  carrying only the keys that moved; the first version of this reader read one
  as a configuration and reported a tool list of 35 as a tool list of 0, so a
  delta is recorded as a change point and never read as an inventory.
  Five distinctions, the same discipline as its two neighbours. INVOCATION vs
  SESSION: every figure is per call, and no session total is presented as what
  one call received. PRESENT vs RECOVERABLE vs
  RECONSTRUCTED, above: retained content and a transcript reconstruction are
  separate fields with separate states, never one fraction. ADDED vs REMOVED vs
  COMPACTED: a shorter list is a removal, and only a removal the host
  accompanies with a replacement summary is a compaction — a drop with no
  boundary reports `partial` with "what replaced them is unknown" rather than
  inventing one. STRUCTURE vs CONTENT: this module retains nothing. It records
  identity, byte sizes and the host's own hashes and leaves content where it
  already lives, which keeps a trace free of credentials by construction rather
  than by redaction. OBSERVED vs PARTIAL vs UNAVAILABLE: all seven categories
  are always present with a reason, because a category dropped from the reading
  would read as covered.
  The provider ceiling is stated on every trace and is the same on both: what a
  provider adds, rewrites, caches or drops inside its own service is in no file
  on this machine. So is the attention limit — every figure here is about what
  was SUPPLIED, never about what the model used.
  Read by `--record <path>`, or by seat, which joins through the launch
  journal's `provider_session_id` and therefore only resolves a SETTLED launch:
  a dispatching entry carries no id, and saying a live run has no trace is the
  honest answer rather than reading the previous run's file.
  `indexClaude` is exported for the module below, which answers over the SAME
  index: a read surface with its own parse of the record could answer over a
  different join from the one `recovery` measures, and the measurement is the
  only reason to trust the half of a session the host retains no blob for.
- `context-query.ts` — the operator read surface over that trace (R-55 H-3724
  requirement 6). The module above answers the INVENTORY question: what does
  this record hold, per required category, with a state and a reason. That had
  to be settled first — a view built over an unknown boundary shows gaps it
  cannot explain — but it is not the question an operator asks. Three functions
  for the three that are: `contextAt` (what was in THIS call's context, and
  where did each part come from), `contextEvolution` (what entered, what the
  host dropped, when the instructions or the tool inventory moved, what a
  compaction replaced), `contextFind` (which part of which call's context held
  this string, and when did it enter).
  It SHOWS content and STORES none: a part is read out of the host record at
  read time and printed, so there is no new store to redact and the exposure is
  exactly the operator's own existing read access to their own record. Parts are
  bounded to `PREVIEW_CHARS` unless asked for in full, and every truncation
  says so on the part.
  Three readings it will not give. A reconstructed part is LABELLED, with this
  session's own measured accuracy for that part's ROLE beside it — averaged
  over roles, a session would tell an operator its user reconstruction had been
  checked when the only slot that could be checked was an assistant one. A part
  nothing on this machine can read is `unreadable` with its reason, never shown
  blank: the standing case is a codex `reasoning` item, which carries
  `summary: []` and the content only as provider-encrypted text, so the item
  WAS in the call's context and what it said is not here. And a nil `contextFind`
  reports what it searched and what it could not read, because "not found in
  what is readable" is not "was not in the context".
  A payload's own JSON is never its text: ANY item carrying
  `encrypted_content` and no plaintext field is unreadable whatever its kind,
  and so is one with no text in any field this reader knows — named with the
  keys it does carry. Fell to the `compaction` item a resumed rollout OPENS
  with, which was labelled `retained` with 64KB of ciphertext as its content
  and counted in the readable bytes, on 58 rollouts on this machine. The
  item's own size is still reported, because 64KB of a context that cannot be
  read here is the figure most worth having; `part_bytes` counts only what
  could be read.
  The renderers make C0/C1 control bytes VISIBLE (`\u001b`), as their last act
  over everything they print, applied to the whole rendering so a field added
  later cannot forget it. A record holds whatever a session's tool results
  held, a fetched page included, so a part's text can retitle the operator's
  window, clear the screen above a line or write their clipboard. Visible and
  never stripped: the bytes WERE in the context, and `--json` carries the
  record's own, which is what a consumer reads.
  Two readings the timeline would get wrong without saying so. A compaction
  does not appear in the host's own keep count at all — it REBASES rather than
  truncating, so `removed` reads 0 while sixty parts leave, and `held`/
  `previously` are what the drop is actually read against. And the first shape
  of a session is the CONFIGURATION, not a change to one; reported as a change
  it reads as twelve tools having been added at call 0.
  On codex a CALL is one `token_usage_record` — the host writes one per API
  call, carrying that call's own `response_id` and its input token count — and
  the items recorded before it are its context, in order, which is this
  reader's arithmetic and is stated as such on every answer: the rollout
  records turns and items, never the array sent on one call.
  The usage record is written AFTER the call, so its window ends with what the
  call itself produced — its reasoning, its reply, its tool request. Those were
  never in the context it was GIVEN, so a call's input stops at its own first
  model-produced item (`MODEL_PRODUCED`), and the count of what was left out is
  named in the answer's gaps. Taking the whole window instead put three items
  that did not exist yet into every call's context, on every rollout. An item
  kind the reader does not recognise counts as input, so the list errs long
  rather than short, and says which way it errs.
  A codex compaction REPLACES the item list rather than trimming it: the host
  writes the new context as `replacement_history`, so a call after a boundary
  holds those items plus whatever was recorded since, the dropped items are
  named as dropped in the answer's gaps with the last call that held them, and
  a `contextFind` span ENDS at the first boundary after the part entered.
  Reading the file from item 0 instead reported 216 parts for a call the host's
  own usage record puts at 24,837 input tokens against 204,655 for the one
  before it. Which compaction applies is read off the rollout's own ORDER (how
  many calls it had recorded at the boundary), not off the item index: the host
  writes the boundary after the call whose window ended on the same item count,
  so `index <= call.before` handed the call BEFORE the compaction the context
  of the one after it. A part a boundary dropped before any call had been given
  it — one call's own output — is reported as in no call, in the structure and
  not only in the rendering.
  The TIMELINE reads a boundary by that same order, and three things follow
  from it. The row carrying a compaction is the first call whose context was
  the replacement list, which is where claude's timeline puts its boundary
  too; by item index it sat on the call before — the one `--at` still shows
  holding every dropped item — and a boundary written at item 0, which is how
  a resumed rollout opens, landed on no row at all. The replacement items are
  that row's ADDITIONS, and an added part's slot is its place in that call's
  context rather than its index in the file, which after a boundary is past
  the end of it. And the drop is stated from the host's own per-call input
  figures either side of the boundary, because both figures the host writes AT
  a boundary are pre-compaction — `pre_tokens` is the turn's cumulative input
  and `post_tokens` the call its usage record was written after — so quoting
  them read as the shrink while the host's figure for that very call sat on
  the next row down. The compaction's own `basis` says BOTH are pre-compaction
  and where the real pair is, because a `--json` consumer has that string and
  not the row. What a boundary dropped is counted as the parts the call
  before it HELD, never the file's item count: at a second boundary that count
  includes everything an earlier boundary already took out, and 8 of the 20
  compacted rollouts on this machine have two or more.
  A rollout can be a TAIL of its thread rather than the whole of it. The host
  writes every record in `paginated` history mode, and three of the 867 codex
  records on this machine carry a `session_meta.history_base`: it names the
  thread and the ordinal this file picks up at — the file's own first entry
  carries that same ordinal — so the entries before it are in a different
  rollout of the same thread id and no part of this one holds them. Every
  reading showed what the file has as if it were the whole context: `--at 0`
  listed 5 parts for a call the host's own usage record puts at 91,273 input
  tokens (88,192 of them cached), 2 parts against 77,407, and 0 parts against
  243,044, and the boundary row said `the 0 parts the call before it held left
  the context` on a row whose own token pair reads 243,044 -> 24,819. A
  compaction ENDS the shortfall rather than deepening it — the host writes its
  replacement list into THIS file, so from the first boundary on the context is
  wholly here — which is why one rule, `codexBaseInForce`, both states the gap
  and makes `codexPartsAt` refuse to count a drop against a call whose own
  context is elsewhere: counting the parts the file holds is not a floor there,
  it is a wrong figure. The statement is on all three readings (the call, the
  row it begins at plus the timeline's gaps, and a search, where a miss is "not
  in this segment" and not an absence), and the trace reports `additions` and —
  where the record holds no boundary at all — `evolution` as `partial` on such
  a record instead of `observed`. `end_ordinal_exclusive` is read with its
  sign: a base of zero names no entries before this file, and reading it
  without the sign would put the caveat on all 867 records instead of 3.
  That earlier segment is RESOLVED and READ rather than named, because a thread
  id is not a path and requirement 6 wants a part followable to its origin.
  `readCodexBaseSegment` identifies it by the CUT and nothing else: the base
  carries a byte offset as well as an ordinal, and the parent's own byte length
  through exactly the entries this file picks up after equals that offset on 3
  of 3 here. Neither a name nor a session id can do it — every segment of a
  thread carries the thread id as its `session_meta.session_id`, and the
  filename match fits the child itself — and the parent file runs PAST the cut,
  by 10, 11 and 9 entries of an aborted turn written seconds before the resume,
  so ordinals at and after the base exist in both files with different content.
  A candidate that does not hold exactly that cut is refused by name, and two
  that both do are refused rather than chosen between: a reading spliced from
  the wrong record would be worse than the stated gap it replaces.
  What is carried in is the segment's LIVE items — its last replacement list
  plus what it recorded after that boundary — by the same two rules a call's
  context is read by here, because a parent that compacted holds items its own
  boundary already dropped: 476 in the prefix of one of the three, of which 101
  were live. `codexBaseInForce` stays the structural fact and `codexBaseShort`
  is the fact PLUS no reading, so every "cannot be counted here" now fires only
  where nothing was resolved. `--at` lists those items in their slots with the
  record they were read from on each part, `codexPartsAt` counts them (so a
  later boundary's drop figure is the real one), `--find` searches them with
  their span, and the timeline says they are context on its first row and not
  additions. Measured on the three: `--at 0` went from 0, 5 and 2 parts to 415,
  106 and 103, and ward's own probe over all 33 compacted boundaries reads
  `bad=0` where two rows previously refused their drop. A chain is followed to
  `BASE_HOPS` segments and names what is still outside it; a hop that does not
  resolve leaves `short` saying so rather than presenting what was read as the
  whole context.
  A part's BYTES are still what the host wrote for it, and on these three the
  live items sum to 1.0, 1.4 and 1.5MB against its own per-call figures of
  243,044, 91,273 and 77,407 input tokens. The host's figure stays the only
  size of a context: an image is one proven reason, since a carried-in message
  here holds two base64 data URLs of 537,630 and 223,746 characters that reach
  the model as image tokens. Such a part is NAMED with its size by
  `contentPart` and never printed as its data — the same rule as the
  `compaction` item's ciphertext, one level down, inside a message that is
  otherwise readable.
  `findCodexRecord` names the LATEST segment of a thread, because a resumed
  thread's later rollout is the one the run went on in and the earlier ones are
  reachable from it; `findCodexRecords` is the whole list. Both segments of one
  thread here sit in the same day directory, so the previous ordering, the
  directory's own, named no winner between a run's record and the record it
  continued.
  `preserved_messages` is what the HOST lists as preserved at a boundary, by
  its own count, and is never called what the next call carried: on claude it
  is a transcript-level list of entries, and against the one compacted record
  on this machine 0 of the 5 messages the next request actually carried is
  byte-equal to one of the 50 it lists. The parts figure on the same line is
  the one that came off the request. Note this is a
  FINER unit than `context-trace.ts`'s codex `invocations`, which counts
  `turn_context` entries: a turn is a USER turn, so one loop iteration is a
  single turn with a dozen calls inside it, and reading a context by turn
  offered `--at 0` and nothing else over a real mason rollout whose context grew
  from 15,908 to 37,468 input tokens across seven calls. Each answer names its
  own unit in `call_unit` rather than leaving a bare ordinal to be read against
  the wrong one; reconciling the trace's `invocations` to the usage record is a
  recorded residual on H-3724, and would restate figures the R-55 boundary
  document measured. A rollout old enough to carry no usage record falls back
  to the turn and says that is what it is.
  `host_tokens` is the host's own count for the call or null — never a
  tokenizer run here, and null on claude, whose request entry carries no usage
  at all.

- `context-inventory.ts` — what EVERY run in a window was given, and in how
  many of them (R-56 H-3802). The two modules above read ONE run. This one
  reads a POPULATION, and the population is the hard half: a report whose
  denominator is the runs it managed to parse reads as completeness while
  hiding every run it could not join.
  Two layers with a seam between them, which is also the test seam.
  `cohortRuns` builds the population from the LAUNCH JOURNAL — not by scanning
  host records, because a run that produced no host record at all is written
  down in exactly one place — and gives each run a state with its reason:
  `read`, `running` (not settled, so no host session id by design — the state
  of the run taking the reading), `unjoined` (settled, and no record on this
  machine names it), `unreadable`, `no_model_call` (a launch that died before
  its first request; calling that unreadable would hide a failure mode behind
  a tooling one). A seat that launched nothing is a ROW, because a configured
  agent that stopped running is the thing a fleet report must not lose.
  `inventory` aggregates the readable runs. Every item counts a run ONCE, by
  its earliest sighting, so `preload` (in the first model call) and `later`
  are told apart and a profile carried through forty calls is one run.
  `bounds` is `any_runs .. any_runs + unknown_runs` against EVERY run in the
  window, and `share` — the only percentage — is withheld unless the whole
  population was read and no channel in it was unknown. Unknown is not zero,
  and a run nobody could read is not a run that held nothing.
  Attribution is one-directional: R-45's configured inventory puts a NAME to a
  chunk the host retained, and is never evidence that a source was loaded. A
  source on that list that matched nothing is `configured_unseen`, which is a
  finding. `attribution_basis` says how strong the name is — `sha` and
  `contains` are proofs against retained bytes, `prefix` matched only a part's
  opening and is marked for discounting, `shape` names a host STRUCTURE and no
  source at all. `contains` has a 64-byte floor on the variant
  (`CONTAINMENT_FLOOR_BYTES`): a handful of bytes is held by almost anything,
  so a short instruction file would otherwise be named in bundles it was never
  part of (H-3817). `sha` is whole-chunk equality and needs no floor. Every basis compares against the source as it reads TODAY, so
  a file edited since a run matches nothing from it and is reported unnamed
  rather than as the current file; the version recorded is the chunk's, never
  the present one.
  Both hosts STRIP a leading YAML frontmatter block before delivering an
  instruction file, so `SourceVariant` carries the body form as well as the
  whole file. Matching only the file as it sits on disk reported crew's
  CLAUDE.md — which is in every claude run's context — as configured and
  unseen. Which form matched is reported: frontmatter a seat's author wrote
  never reached the model.
  A chunk is rarely one thing: the harness hands over a bundle with two
  instruction files and its own wrapper in one message. So a chunk yields
  EVERY source it carries plus its unaccounted remainder, and the bytes split
  across them without loss. An attributed item is versioned and sized by what
  MATCHED, not by the chunk that carried it — the bundle differs per run and
  the file does not, so hashing the chunk read as five versions of a profile
  that had not changed. Instruction and tool bytes nothing accounts for get an
  item of their own rather than being swept into the conversational residue,
  where nobody would look for them.
  `RunAccount` is the balance: every chunk of a run's first call is an item, an
  unresolved chunk (content the host did not retain — its SIZE is still real),
  or run material. Turns and tool results are run material on purpose: they
  are as real as a profile and no more countable across runs than the command
  that produced them, and a row for each would bury every row that means
  something. The residue is counted, never dropped — an accounting that
  balances by omission is the failure this whole reading exists to avoid.
  What is counted is what the host put in a call's message list. A filename in
  a prompt, a read that failed, a source this installation configured: none of
  those are loads and none reach an item row.

- `summon-trace.ts` — which host records are NAMED SUMMONS, and on what basis
  (R-55 H-3724 requirement 6). Every other trace here joins a record to a
  launch THIS installation made, through the launch journal's
  `provider_session_id`; a summon has no launch, because the operator opens the
  session himself and the estate is never told. So the join comes out of the
  record: his own opening words ("summon mason") and the canary the summoned
  role reproduces in what it says back. Two claims about two different moments,
  kept apart — one SUPPLIED, one CONFIRMED — which is why a summon has to
  record nothing new and costs him nothing at the moment he starts one.
  `skills/summon.md` deliberately keeps that moment free of tool calls, so a
  design that registered the summon would have had to spend the one thing the
  protocol protects.
  Three readings it refuses, each measured on the 14,135 records of this
  machine rather than supposed. A canary is NOT a summon: 86 loop records
  reproduce one, so the journal is consulted first and authoritatively, and an
  iteration prompt in the record settles it too — journalling came later than
  the fleet and 3,230 records carry no entry to join to. A role named with no
  canary IS still a summon: 8 of 122 sittings here, reported as `protocol:
  absent` rather than demoted. And one sitting is not one record: 165 opener
  matches came from 142 sittings, because a resume copies the transcript.
  A canary reproduced with nothing naming a role is its own state,
  `spoke_as_role`, never a summon — of 37 such sittings here some are summons
  he phrased without a role name ("Arthur summons you into a meeting") and
  others are probe sessions something else launched under a seat's own cwd,
  which arrive with that profile and reproduce its canary while being nobody's
  summon. One observable cannot separate those.
  Ordered cheap first, and the order is the design rather than an
  optimisation: the journal settles a record in a map lookup, the opening words
  come from the head of the file, and only a record that is neither reads
  whole. The whole scan is ~5s over 4,698 records.
  The ceiling is stated on every scan: a summon through the crew-summon MCP
  (phone, web) runs on the provider's side and writes NOTHING on this machine,
  so an away-from-desk summon is not partially traced — it is absent.
  The renderers are pure functions in the same module, so what an operator sees
  is what the acceptance asserts. They print each distinct caveat ONCE with how
  many parts carry it — a call with 72 reconstructed parts printed the same two
  sentences 72 times, which is how a real qualification comes to be skipped.
- **Every Team read goes through `readBounded`, and that is the whole guard
  (H-3004).** The inventory includes every `CLAUDE.md` and `AGENTS.md` found
  walking up from a seat's cwd — files no roster entry names, in trees any agent
  on this machine can write — so the open is what decides, not a stat a later
  open could race. `O_NOFOLLOW` refuses a symbolic link, because the walk used
  `existsSync` and the file route served the link's target; `O_NONBLOCK` keeps a
  fifo from parking the open, because a fifo named `AGENTS.md` in a seat's cwd
  held *every* route of the app, `/overview` included, until a kill; `fstat` on
  the descriptor refuses anything that is not a regular file.
  Two ceilings sit above it. `MEASURE_BYTE_CEILING` bounds what one request
  pulls into memory. `TOKENIZE_WORK_CEILING` is the one that matters: a byte
  ceiling does not bound the tokenizer, because js-tiktoken's BPE merge loop is
  quadratic in the UTF-8 byte length of a single chunk — so 16KB of one repeated
  character costs 22s, 32KB of spaces 94s, and 256KB whose every run is 1KB
  still costs 23s. `tokenizeWork` sums the squares of those chunks' byte
  lengths, which is what the cost is proportional to (30-90ms per million,
  across every shape measured).
  **It gets the chunks by running the encoding's own pattern, and that is the
  load-bearing part (H-3007).** The first version estimated them, splitting runs
  on space, tab, CR and LF; the pattern's whitespace branch is `\s`, so 16KB of
  U+3000 alternating with LF is one chunk where the estimate saw 8,000 runs of
  one character. It passed, was counted, and held the member route 39s with
  `/overview` blocked behind it. Any hand-written split has that failure mode one
  Unicode class at a time, and measuring characters rather than bytes has it
  again for CJK. Taking `patStr` off the encoder closes both: the bound is
  computed over the same cuts `encode` makes. It is js-tiktoken's own internal
  field, so `chunkPattern` throws if a version stops exposing it, and a unit
  test asserts it is there.
  A file past either ceiling — or one the tokenizer throws on, which `<|endoftext|>`
  in any instruction file used to do — is reported `unreadable` with its byte
  count and the reason, never with a token count, so it cannot silently shrink
  the total it belongs to. Both ceilings sit well clear of real configuration:
  this installation's largest instruction file measures 41,272 against a ceiling
  of four million, and all 23 encode in 33ms together.
- **Both ceilings bound a FILE; the document gets its own pass (H-3011).** A
  request waits for a document, and an installation's seat count multiplies
  whatever the per-file ceiling admits — ward measured ten seats sharing six
  worst-admitted files holding `/api/v1/team` 14.6s with `/api/v1/overview`
  blocked 14.2s behind it, on every poll, past this surface's own 10s deadline.
  `measurePass()` is threaded from `teamDocument` through every `seatContext`
  and does two things the per-file ceiling cannot.
  It measures each unique path ONCE. `crew:AGENTS.md` is on all ten seats'
  walks, so the live document was tokenizing it ten times a request: 24
  inventory entries, 13 unique files. The key is `resolve`, which normalizes
  `.`, `..` and repeated separators without touching the filesystem —
  deliberately **not** `realpath`, which would collapse a symlink onto its
  target and let whichever a seat asked for first answer for both, serving a
  planted link the real file's count. That is the one thing `O_NOFOLLOW` is
  there to refuse, so two spellings reaching one file through a symlinked
  directory are measured twice instead; a test holds the distinction.
  And it spends `TOKENIZE_DOCUMENT_BUDGET` across the whole document rather than
  per file. Measurements take turns on `pass.turn` for that reason: `encode` is
  synchronous so concurrency bought nothing, and under `Promise.all` every file
  read `work` as 0 before any other had spent any — a budget nothing could
  exceed. The budget is six worst-admitted files, which is where ward measured
  1.4s; this installation's whole document is 361,534, a sixty-sixth of it, and
  measures in 465ms including the one-time rank load. Past the budget a file is
  `unreadable` naming the budget, never a token count.
  The two halves are red-proved separately: without dedupe, ward's own shape
  runs past the budget and the e2e case fires on the refusal; without the
  budget, distinct worst-admitted files time the request out at 10s; without
  either, both.
- **The Team routes answer a failed read 500, like every other route.** They
  read files, so they answer from a promise, which takes a throw out of
  `serve.js`'s own handler catch — so `answer()` has to repeat that status
  rather than choose one. It chose 503 at first, and a broken roster made
  `/api/v1/team` disagree with `/api/v1/runtime` and `/api/v1/overview` about
  what had gone wrong. The app's acceptance suite asserted against that
  already; it lives in `@helmo/cli`, a workspace no proof of this page had
  measured, so the root tally said 602/602 while the suite was red (H-3004).
- **A seat is looked up with `Object.hasOwn`.** `roster.loops` and `PERIODS`
  are plain objects, so `/api/v1/team/members/__proto__` answered 200 with a
  phantom member and `?period=__proto__` dated the window to NaN and answered
  503 instead of falling back (H-3004).
- `capacity.ts` — plan capacity and runaway detection, pure (H-185), consumed
  by the loop before subscription-provider runs (H-186). Metered providers
  retain the legacy dollar and transient-limit gates; declaring a provider
  `billing = "subscription"` makes its fresh plan bars the capacity gate.
  It exists because a breaker metering *notional* dollars stopped a loop for
  7h08m on a full backlog while both accounts had a third of their weekly
  allowance spare (H-178, 2026-09-29). Three quantities it refuses to
  substitute for one another: plan capacity (the provider's own percent bars —
  the only one that says whether more work is possible), notional metered
  equivalent (token-log dollars — accounting, and the axis a runaway shows on),
  and billed spend (not observable on a flat plan, so it is said rather than
  approximated). `capacityDecide` returns continue / switch / refresh /
  continue_stale / wait / scheduled_resume / blocked; the scheduled-resume
  branch persists `resume_at` in LIMIT, exits the loop, and lets the supervisor
  relaunch it at the reset without clearing STOP, HOLD or BLOCKED. A reset past
  the exhaustion ceiling still blocks for a human because the telemetry is
  wrong rather than the plan.
  `anomalyDecide` measures a rate against the loop's own rolling mean, never a
  cumulative total. After a subscription run the loop compares its notional
  cost with the preceding five parseable iterations of the same loop on the
  same runtime and refreshes the same plan window to measure percentage-point
  movement. The cost-rate backstop applies
  only at $5 or more: this clears the three confirmed $1.71-$2.55 transitions
  from cheap queue passes to real builds while retaining the historical $5.17
  blowout; the measured plan-point ceiling remains absolute. Runtime filtering
  precedes the five-entry limit, so cheap Codex probes do not dilute a Claude
  baseline. Untagged history cannot establish a same-runtime baseline;
  known zero costs still count, and unknown costs are skipped. A trip writes
  both the halt sentinel and `BLOCKED.json` with the observed values, baseline, time and
  escalation ticket, which `/health.json` and the dashboard surface. An
  anomaly, terminal-capacity or burn trip is assigned at priority 0 to the first
  live, unblocked roster peer outside the stopped seat. If none is live, the
  investigation stays open and unassigned until an eligible peer can draw it;
  a routine mechanical stop never becomes a human question or notification.
  A peer can authorize one restart by attaching
  an exact `rev:false_alarm:<encoded reason>` evidence ref; the supervisor
  matches it to `BLOCKED.json`, clears only BLOCKED, and proves minimum uptime
  before closing the investigation. A same-reason relapse inside the configured
  window remains blocked on its peer-owned investigation; the first disposition
  authorizes one restart, not a blind retry. The supervisor retains that release
  context in memory, so if the child trips its own fail ladder and deletes the
  files first, the observed new cause is restored to `BLOCKED.json` and the
  durable release record while the same investigator keeps ownership. The loop
  also preserves that record when a supervisor drain forgets the in-memory
  release context. The durable release record is keyed to the investigation
  ticket and removed after a healthy restart, so a later same-reason incident
  starts with its own dispositions. It emits one relapse note, not one
  per supervisor poll, and consumes each append-only matching disposition for
  exactly one restart; a persistent fault needs fresh peer evidence before
  every further attempt. A manual `rev resume` and any
  unrelated unstructured block remove stale structured-release records. **No
  percent is ever converted to tokens or dollars**, in either direction.
- `shim.ts` — the runtime adapter (claude / codex / mock). It carries the
  installation deed and required-binding flag into both the agent process and
  its generated Helmo MCP configuration, so a session cannot acquire a store
  from user scope, cwd or a copied command. Owns non-interactive
  flags, constitution injection (fail-closed), `cleanEnv()` (strips parent
  CLAUDE/ANTHROPIC/CODEX env — the auth-leak fix; don't weaken it) and
  `sessionEnv()` over it (the seat's git committer identity, H-787 — the
  variables rev SETS are `sessionEnvOverrides()`, separable because a spec
  printed to stdout must never carry the caller's own environment), the session
  **process group**, per-session
  token metering, transient-API detection, and the strict MCP surface (sessions
  see ONLY Helmo + the loop's `mcp_extra`; only the Helmo server is handed the
  loop's actor identity in `env` — an `mcp_extra` server that wants to know who
  is writing gets it as a per-call parameter from the agent, or from its own
  `env` block in the loop's JSON, never from `HELMO_ACTOR`, which `cleanEnv()`
  does not carry into the session, H-324): claude via `--strict-mcp-config`,
  codex via the whole-table `-c mcp_servers={...}` override (H-479) — and that
  override is argv, so an `mcp_extra` server's `env` block is `ps`-readable by
  every local user for the session's lifetime where claude's copy is a 0700
  scratch file; a loop that may run on codex must not carry a secret there
  (documented in `examples/roster.toml`, H-1417). Codex
  gotchas the adapter encodes, all verified on codex-cli 0.150.1: the prompt
  goes in on stdin (`exec -`) because argv is ps-readable and size-capped;
  `--ignore-user-config` is always passed (H-520) — fleet behavior must not
  change when the operator tweaks `~/.codex/config.toml` (auth.json and
  session rollouts are unaffected); anything a run needs beyond the MCP table
  arrives as `-c` overrides from `[providers.<name>.config]` in the roster
  (reasoning effort, future custom endpoints via `model_providers`). Project
  hooks remain in scope, and Rev passes `--dangerously-bypass-hook-trust`
  because an unattended loop cannot answer Codex's interactive trust prompt;
  the estate reviews those hook definitions in git. MCP
  tools need `default_tools_approval_mode = "auto"` AND the
  approvals/sandbox bypass or every call hard-fails under `approval_policy =
  never`; exit 0 without a `turn.completed` event is a real failure
  (openai/codex #19309), so results are gated on the event stream, and a
  failed run's tail carries a `rev: codex failed — exit N, turn …, error
  event: …` line even when the agent sent a final message, which used to
  hide the reason entirely (H-2164); codex under
  plan auth reports no dollar cost, so cost is notional from the roster's
  `[providers.codex.prices]` — absent prices, the burn breaker is blind to
  that provider and the token-log shows `cost_usd=?`.
  Astra additionally needs a current CLI: 0.150.1 was rejected by the server;
  Homebrew 0.153.2 passed a real Astra run on 2026-09-04 (H-892). Updating the
  desktop app alone does not update the CLI Rev invokes.

  Real agent CLIs are spawned asynchronously and their pipes are drained as
  they run (H-387). Retention is capped at 128 MiB per stream: crossing that
  bound terminates and reports a resource failure, while launch errors retain
  their OS code, nonzero exits remain child failures, and malformed/truncated
  wire output is named rather than mistaken for a clean run. Rev retries none
  of these automatically because the session may already have acted — except
  Claude's signal-ended and API-deadline cases, where that same fact argues the
  other way (H-2071, H-1773).
  `claude --output-format json` writes its result only at exit, so a session
  group stopped mid-turn leaves no JSON and read as apparatus: the loop
  blocked and the claim went back as if nothing had run. `interruptedBy()`
  separates a signal — direct, or a wrapping shell's 143/137 — from genuine
  malformation and makes it a `failure` under the retry cap, so the claim
  stays with the worker whose session may already have done the work.
  Truncation with no signal is still apparatus. codex and mock never had this:
  neither parses one JSON blob, so a signal there already reaches
  `res.status ?? 1` and classes as a failure.
  **Every session is its own process group** (`SESSION_GROUP`, H-467). Without
  it the agent CLI shares the group of the loop and the supervisor above it, so
  anything that signals that group — launchd stopping the job, systemd killing
  the cgroup, a Ctrl-C or hangup on a shell-started fleet — lands on the agent
  mid-turn. It died `rc=143` after its file writes and before its Helmo close,
  and the next iteration met artifacts no ticket accounted for; twice against
  ward, once against bosun, once against mason. Detached, the signal reaches
  only the loop process. The cost is deliberate and worth naming: a SIGKILLed
  loop now leaves its session running to completion as an orphan — one
  session's tokens, spent finishing and closing its own work, which is the
  trade this bug was about. A journaled launch's replacement waits for that
  orphan rather than running beside it (H-685, under the pool section). After a CLI returns normally, the shim terminates
  background children still in that session group (H-1013); this cleanup is
  unreachable when the loop is killed while awaiting its session, so H-467's
  close-out protection against external group signals still stands. Mock
  sessions use the same async spawn as real CLIs, so drain tests
  exercise delivery of signals during a session. `test/shim.test.ts` proves both
  sides with real process groups.

  **`sessionSpec()` is that composition as data** (H-1152), so a consumer that
  is not a loop can run a seat's session without a second copy of the recipe.
  Its one caller today is the Meetings room, where Arthur types instead of the
  queue: same cwd, same skills, same Helm surface, same model routing. Two
  things it does NOT do the way a loop does. The exported `env` is
  `sessionEnvOverrides()` only, plus `env_strip` as the rule for the rest — a
  spec goes to stdout, and `sessionEnv()` copies the fleet's whole environment.
  And the actor's session stamp is a required argument, never defaulted:
  `rev:<seat>` is the seat stamp `seatDecide` reads (H-558), so a consumer that
  signed by omission would make its Helm writes read as the loop's own hold.
  Ward's H-1151 ruling names the meeting form: `meeting:<thread id>`.

  **The one place that cost is not paid is the supervisor's drain escalation**
  (H-1089). A redeploy drains; a loop mid-iteration defers its SIGTERM past
  `drain_grace_seconds`; the supervisor SIGKILLs it — and the detached CLI
  reparented to init and kept working while the returning fleet spawned a
  SECOND session for the same seat, on the same ready queue, as the same Helmo
  actor, in the same working trees. It happened to mason on 2026-09-07 and cost
  H-1086 a trustworthy gate run. So the escalation now enumerates the loop's
  own session groups *before* the kill (after it, the children are init's and
  unfindable) and ends them: `sessionGroupsOf` / `endSessionGroup` in
  `shim.ts`. Only true group LEADERS are signalled — a child sharing its
  parent's group is skipped, because signalling that group would reach the loop
  and the supervisor, which is the broadcast H-467 exists to prevent. Past the
  grace the session has already had its finishing time; two seats is the worse
  failure. Proven in `test/supervisor.e2e.test.ts` — a mock that records its
  pid and outlives any grace must be gone once the drain completes.

- `ladder.ts` — pure decision functions for the failure ladder (transient ≠
  failure ≠ apparatus). Unit-tested; change with tests.
- `supervisor.ts` — the fleet (v1, H-18): one child process per roster loop,
  respawn decided by `respawnDecide` in the ladder (halt sentinel → await
  clearance; healthy clean exit → fresh spawn; crash/short-lived → exponential
  backoff, BACKOFF sentinel). Drain = SIGTERM cascade. Each loop explicitly
  records a pending signal while its async session or close-out is in flight,
  then logs `loop-stop reason=drain` and exits 143 after run-end,
  journal settlement, metering and the ladder's state writes. Terminal ladder
  paths honor the pending drain too. Idle, parked, capacity, transient and
  throttle waits exit promptly rather than adding their wait to the drain.
  The top-of-loop `setImmediate` still gives queued signals a turn before a
  new iteration (H-1109), including paths whose awaits resolve synchronously.
  Deferral used to rely on `spawnSync`; once real CLIs streamed asynchronously,
  the old handler instead exited immediately, orphaning the detached session
  beside the returning fleet. Synchronous mocks hid this failure. A wedged
  session is still bounded by `drain_grace_seconds`; the supervisor enumerates
  and ends its detached group when killing the runner (H-1089). Group isolation
  still protects sessions from external broadcast signals (H-467, above).
  Child stdout/err goes to state/<loop>/console.log; supervisor decisions to
  state/supervisor/events.log. 'supervisor' is a reserved loop name.
  An installation may also opt this same poll into the narrow Good Plumb
  intake-preparation adapter with `intake_preparation_origin` and
  `intake_preparation_checkout`. `intake-preparation.ts` signs outbound
  claim/heartbeat/failure/result requests with the macOS Keychain service
  `plumb-intake-executor-secret`, validates the occurrence identity and exact
  signup hash before writing, and creates one identifiers-only Builder ticket
  using only Helmo CLI-supported fields; project metadata is not passed because
  that CLI refuses fields which exist only on the MCP create surface.
  Attempt state contains no signup text and lives under state/supervisor; a
  stale result is discarded on the Worker's 409. A staged result is delivered
  whatever the ticket's status: staging then closing is the Builder's
  ordinary sequence, and the close can land before the poll. Any other refusal
  is logged with the Worker's error phrase (bounded by shape, never the raw
  body); while the ticket is open or in progress the lease is renewed and the
  result kept for retry, and once it is not, or before a heartbeat with nothing
  staged, the adapter discards the local attempt. A discard is recorded,
  identifiers only, in `intake-preparation-abandoned.json` (last 20), because
  the Worker hands a live lease straight back to its owner: the next ticket for
  that occurrence names the prior ticket, attempt and commit and the refusal,
  so it reads as a resubmission rather than fresh preparation. There is no listener or
  second scheduler, and an installation declaring neither key is unchanged.
  The same poll and keys run `refinement-commit.ts`, the Worker's
  `/api/refinement-commit/*` pull: a claimed directive revision is checked
  against its hash, its path (`clients/<org>/projects/<project>/directive.md`)
  and its own `refinement/<org>/<project>/` branch, then committed with
  plumbing (`hash-object`, a private index, `commit-tree`) on origin/main and
  pushed without force, so the operator's checkout and main are never
  touched. A branch already pushed by an earlier attempt is reused only if it
  is one commit whose parent is on origin/main and whose tree is that
  parent's with only these words set; anything else on a matching name is
  refused, never overwritten. A claim may also carry `files`: at most one, and
  only that project's `library/schema.yaml`, with words matching their own
  sha256. It is committed in the same tree as the directive, a pushed branch is
  reused only when both files match, and the built commit is checked to hold
  both before the push. The result carries the raw commit, the
  directive blob (and the schema blob when the claim carried one) and the trees
  on their paths. State under state/supervisor holds identifiers and the commit,
  never the words; a 422 keeps the lease and retries, and the fifth hands the
  attempt back as retryable. Refused claims fail as not retryable; Git or
  network errors as retryable. Each non-idle pass is a `refinement-commit`
  event.
- `refinement-preparation.ts` is the H-1523 preparation protocol adapter,
  disabled by default in the supervisor. It consumes the separate signed
  `/api/refinement-preparation/*` contract. A claim carries one meeting's
  organization/project, directive version/content hash, submitted-feedback
  hash, lease token and provider-publication decision reference. The Worker
  checks configured scope and current evidence on heartbeat; configuration is
  trusted operator relay, not a Helmo-verified grant. The adapter validates
  identifiers and portable meeting names before any callback. It saves only
  those identifiers, artifact refs, binding receipts and closed failure
  diagnostics, bound to the original origin and executor identity.
  Build/publish callbacks must call the supplied checkpoint immediately before
  each external effect. The adapter also checkpoints between phases, preserves
  a receipt before readback, and requires a read-only provider verification
  callback before result delivery. Verification mismatch fails for owned
  inspection rather than another mutation. A verified result or outstanding
  failure is reconciled first on restart; a lost result response cannot repeat
  publication. Five 422 result refusals stop automatic retry. Network ambiguity
  retains state, with Builder named in the content-free last-run record.
  `refinement-artifact.ts` supplies the concrete callbacks. The EXISTING intake
  poll invokes them only with `refinement_preparation_enabled = true`, the
  existing intake origin/checkout, and all five explicit fields:
  `refinement_preparation_source`, `refinement_preparation_base_ref` (40 lowercase
  hex characters), `refinement_preparation_work_root`,
  `refinement_preparation_sync_script`, `refinement_preparation_scan_script`.
  Paths are absolute; the work root must be outside the source (including
  real-path validation before artifacts). Incomplete enabled configuration
  refuses startup with a closed diagnostic. No defaults select a source or
  infer independent acceptance. Do not enable an unaccepted/unadopted snapshot;
  the signed Worker's original provider-publication scope must also be configured.
  One retained attempt belongs to `state/supervisor/refinement-preparation.json`.
  Repeated polls do not overlap; stopped roster workers stay stopped. The
  content-free `refinement-preparation-last.json` records time/result/claim status
  and Builder ownership; errors log a closed inspection instruction. A drain
  stops new polls, fences future effects at checkpoints and waits for the current
  pass to settle. Signed requests have a 30-second timeout; artifact commands and
  provider children retain their 120-second ceilings. Retained state reconciles
  on restart, including verified result delivery without republishing. Empty
  rosters start no adapter/timer. Runtime adoption and live verification remain
  separate from this source wiring.
  The operator pins an accepted product commit, a registered source repository,
  private work root, origin and the existing company's scanner/sync tools.
  Each immutable meeting gets a registered isolated worktree and deterministic
  proposal branch; no shared working files are edited. Product export must
  return the resolved tenant/project and exact current meeting evidence.
  The product's own readers validate content/feedback hashes before artifacts
  are written; its prompt builder/configuration determine the actual sent hash.
  Only the prompt and meeting snapshot enter one commit on that pinned base.
  Candidate scan precedes commit; signed checkpoint precedes scanner-backed
  private sync; exact clean remote tip is verified. Lost push responses reuse
  the retained exact commit. Foreign edits, links in artifact paths, conflicting
  branch/base/content and scanner findings require Builder inspection.
  Source/artifact worktrees remain private evidence; no automatic cleanup.
  A separate product child invokes the supported callable publisher, using IPC
  to checkpoint immediately before provider/binding effects. Permanent product
  refusals map to protocol refusals, network ambiguity to owned recovery.
  No child stdout, credentials, provider body or client words enter status.
  The verify callback independently reads actual provider configuration.
  Local integration runs the actual product builder/publisher and company
  scanner/sync against disposable Git plus intercepted API/provider/keychain
  access. Run `REFINEMENT_TEST_PRODUCT=<exact-product-checkout>` and
  `REFINEMENT_TEST_PUBLISHING=<company-tools/publishing>` with runtime tests
  `test/refinement-artifact.test.ts`; these integration cases are explicitly
  skipped without both inputs. Give both as REAL paths, not a convenience
  symlink into the company's home: the sync tool only acts when it is the main
  module, and that check compares the argv path against a symlink-resolved
  `import.meta.url`, so a linked path makes it exit silently without pushing
  and the artifacts fail their remote-tip check instead. This proves local composition and recovery,
  **not** live provider, deployed Durable Object, or publication authority.
  Poll wiring, independent reviews/upstream merge and pinned runtime adoption
  remain. No new roster setting, scheduler or live authority scope is enabled.
- A human answer reopens a Helmo ticket with `resolution: resume` regardless
  of whether its operational choice was resume, hold, or investigate. The
  supervisor clears `BLOCKED` only when `last_answer.chosen_option` is the
  `resume` choice (or the dashboard's `resume — rationale` recommendation);
  ticket lifecycle state alone is not process-control authority (H-1320).
- `redeploy.ts` — activating rev's own committed, tested fix (H-1046). A loop
  that lands one cannot restart the fleet from inside its own iteration, so it
  writes a REDEPLOY sentinel (`rev redeploy --ticket <id> --reason ...`); the
  supervisor honours it at its next poll with an ordinary drain, then exits
  **75, unsuccessfully on purpose** — the only exit launchd and systemd bring
  back, and the supervisor that returns is the new code. Deliberately not the
  reinstall path: nothing boots the job out, so there is no race with launchd's
  60s ceiling. A REDEPLOY present at startup is the record of the restart that
  just happened, never a fresh ask — the new supervisor clears it before any
  poll can read it, which is what stops a redeploy looping forever, and notes
  the landing on the requesting ticket. That note is best-effort by design, and
  a **closed ticket is the ordinary case, not a fault** (H-1118): the loop that
  asks finishes its close-out during the drain it asked for, so it is done by
  the time a supervisor is back to write, and Helm rightly refuses writes on a
  terminal ticket. So the status is read first and a terminal one logged as
  `redeploy-note-skipped`; only a real failure is `redeploy-note-failed`, and
  it now carries Helm's own words via `cliError` rather than execFileSync's
  message, which is the command line and nothing else. Five landings in one day
  were logged as failures with that message, and it read as Rev calling Helm
  without an identity — it never was. **Nothing is dropped and no new record is
  filed for it:** the landing is the `redeploy-done` line in events.log, which
  is the very file the note offers as its evidence, so a skipped note costs a
  reader nothing. Filing a fresh ticket per successful routine redeploy would
  put noise in the human's queue to record a success. Asking mid-work
  is safe because the drain's SIGTERM to the requester's own driver is deferred
  past the in-flight iteration like any other, so the restart lands after the
  iteration ends with its run-end and metering intact. Measured on the live
  fleet: ask 02:19:59Z, drain 02:20:38Z (the next poll), the last straggler's
  iteration held it to 02:28:54Z, fleet back 160ms later.
- `service.ts` — reboot resilience: launchd plist (KeepAlive on crash only —
  a drain exits 0 and stays down) / systemd user unit. Units embed
  install-time PATH and REV_HOME because service managers strip env. Bound
  definitions also carry `HELMO_BINDING`; the stable launcher sets
  `HELMO_REQUIRE_BINDING=1` before handing over to a selected release.
  **The service identity is the resolved Rev home** (`serviceLabel()`,
  `systemdUnitName()`, H-2210 then H-2452). It was the constant `dev.rev`, and
  that one string is also the plist filename and the bootout/kickstart address —
  so two fleets under one login fought over one job and one file, and the second
  install silently replaced the first. H-2210 derived it from the home's
  basename, which was still one identity for many installs:
  `/tmp/customer-a/.rev` and `/tmp/customer-b/.rev` are both `.rev`. Redirecting
  `HOME` does not separate them either — a plist *filename* lives under `$HOME`,
  but launchd's namespace is the uid's (`gui/<uid>/<label>`), so two installs
  under one account share one bootout and kickstart address whatever `HOME`
  says. Hence:
  - A **conventional home** keeps the label it is already bootstrapped under,
    by rule and not by name: a direct child of the **account's** home directory
    called `.rev` or `.rev-<suffix>` cannot collide with another such home.
    `~/.rev` → `dev.rev`, `~/.rev-gp` → `dev.rev.gp` and systemd `rev-gp`. This
    must hold whether `REV_HOME` is unset or explicitly the default, because the
    installed plist exports `REV_HOME=~/.rev` back to the process.
  - **Anywhere else** the label carries eight hex of a SHA-256 of the resolved
    home path, after a readable part taken from the home's basename or, when
    that is a bare `.rev`, from the directory holding it:
    `/tmp/customer-a/.rev` → `dev.rev.customer-a.3f9a…`. Stable across restarts,
    distinct per install, no new state store.
  - The account's home comes from the **password database** (`userInfo()`), not
    from `$HOME`, for the same reason the plist is a hazard here: a service
    manager hands a daemon an environment the software under test may have
    written, so an identity keyed on `$HOME` is keyed on something a second
    install can set. `$HOME` still decides *where* the definition file goes —
    that is `serviceFile()`, and it must stay that way, because it is also what
    lets a test fixture contain a write.
  - The input is `resolve()`d, not `realpath`ed: a home reached through a
    symlink is a second identity, and `HELMO_INSTALLATION` is the override for that.
  `HELMO_INSTALLATION` overrides the derivation outright, and **`serviceInstall` writes it
  into the service environment** (plist `EnvironmentVariables`, systemd
  `Environment=`), so a job restarted with the bare environment a service
  manager gives daemons resolves the identity it was installed under rather than
  re-deriving a different one. The label is a parameter of `launchdPlist`,
  `systemdUnit` and `installLaunchd` rather than a module constant, so the plist
  a call writes and the job it boots out can never disagree.
  **Ownership before a destructive act.** The derivation can no longer collide,
  but an operator can still point two installs at one explicit `HELMO_INSTALLATION`, and
  then the label says nothing about who a service belongs to. `install`,
  `uninstall` and `start` therefore read the definition already on disk and
  refuse when its `REV_HOME` is a different installation's (`definedHome()`,
  `assertOwnService()`), naming both homes and the way out; the `rev service`
  CLI prints that refusal as an error rather than a stack trace. A definition
  carrying no `REV_HOME` reads as unowned, which is what keeps a pre-H-2210
  install upgradeable.
  **Migration.** A non-conventional home's label gains its digest, so a service
  installed under the old basename-only name is still on disk and still loaded.
  `serviceInstall` retires it (`legacyServiceLabel()`, `retireLegacyService()`)
  — but only when that definition names *this* home, which is what makes the
  removal this installation's own business rather than a guess. Conventional
  homes are unaffected: `~/.rev` and `~/.rev-gp` compute the same labels they
  always did, verified against both live plists.
  **A pinned definition names a launcher, never a release** (H-2511). A
  definition is written once and nothing rewrites it, so the path it carries is
  frozen at install time. It used to be `process.argv[1]`, which under a release
  selection is a `cli.js` *inside* a release directory — so after `rev release
  upgrade` the job the service manager brought back exec'd the release the
  installation had just left, was stopped by `selectedRelease()` as an uncaught
  throw, and under `KeepAlive` was brought back to fail again, with launchd.log
  the only account of it. The upgrade's own output promises the opposite. So
  when `INSTALLATION_RELEASE` is set, `serviceInstall` writes
  `<REV_HOME>/service/launch.mjs` (`launcherPath()`, `writeLauncher()`) and the
  definition names that:
  - It resolves the selection at **start**, so a release change is picked up by
    a restart with no reinstall — which is exactly what the upgrade says.
    Resolution follows the selected directory's `RELEASE.json`: the unified
    `helmo` component names `helmo/packages/runtime/dist/cli.js`, while the
    legacy three-component shape names `rev/dist/cli.js`.
  - It hands over **in the same process** (`process.argv[1] = cli; await
    import(...)`), so the manager's signals, its exit timeout and the pid it
    supervises all reach the supervisor itself, and everything downstream — the
    loop drivers the supervisor spawns, `REV_CLI`, the command line the
    sentinels record — is what it would have been had the manager named that
    file directly.
  - It decides as little as possible: it is the one file a release change cannot
    update. *Verifying* the set stays in `selectedRelease()`, which now passes
    because the code came from the directory the selection names.
  - A selection it cannot resolve still refuses, as **one line** naming the
    installation and the repair rather than a stack trace, and exits non-zero on
    purpose: the manager retries, so a repaired selection brings the supervisor
    back with no command run.
  - **Unpinned installations are untouched** — no launcher, and the definition
    still names the `cli.js` it was installed from.
  The launcher records its physical path in `REV_SERVICE_LAUNCHER` before it
  corrects `argv[1]`. `runningStamp()` uses that path only for the supervisor's
  exact `run` invocation; inherited loop processes keep their cli.js command.
  Thus liveness matches the kernel command line without weakening loop identity.
  A definition installed before this change still names a release directory;
  `stalePinnedService()` finds it and `rev release upgrade|rollback` says so,
  where the promise is made, rather than leaving it for launchd.log.
  systemd gets `KillMode=mixed` and a timeout longer than rev's drain, so a stop
  signals the supervisor rather than every process in the cgroup (H-467).
  launchd is different: it clamps `ExitTimeOut` at 60s even when the plist asks
  for 660s (measured on Darwin 25.6, H-877). Its bootout/reinstall path is
  therefore a hard stop after the largest available 60s window. Installation
  waits until that job has actually released its label before bootstrap, and a
  failed bootstrap restores the prior definition and job. The detached
  session process group is what lets an agent finish and close its work. Use
  `rev stop` when the whole machine must drain gracefully before service work.
- `build.ts` — **what did this process load?** (H-2489). `snapshot()` reads a
  code directory as it is now; `loaded()` holds what the running process read
  at startup; `compare()` says whether they are still the same bytes. See "What
  built `dist`, and what is RUNNING it" below — the two are never one claim.
- `install.ts` — **which installation is this command about?** (H-2473). The
  shared core deed is checked before any Runtime command reads roster,
  control, release or service state. Repair commands skip release coherence,
  but never the deed's name/control/service fence.
  identity above answers what an installation is called; this answers the
  question every command was assuming. `target()` returns the label, the
  resolved home, and a conflict if there is one; `targetLine()` is the line
  each command prints to say which Rev it read or wrote; `requireTarget()` is
  the gate a mutation passes before it writes.
  When `INSTALLATION_RELEASE` names an `ADOPTED.json`, every CLI/supervisor
  start verifies all three component commits against that release's
  `RELEASE.json` and verifies Rev runs from its selected directory. Missing,
  mixed, or shared-checkout code refuses before the roster is read. Service
  definitions and spawned Helmo MCP servers carry the selector.
  - **Every command names its target.** `status`, `usage`, `routing`,
    `service status` and the bare-usage footer print it, and so does each
    mutation's own confirmation, because the mutation's output is where an
    operator looks to see what they just did. The two exceptions are `tail` and
    `session-spec`, whose stdout is a machine value a caller substitutes — a
    prose line there would break the caller, and both already carry the home
    (a state path, a roster-composed spec).
  - **`--installation <name|home>` asserts; it never redirects.** It takes
    either spelling because those are the two an operator has in front of them
    — a label a status line printed, a home path a roster or plist names,
    joined by a space or an `=` — and a disagreement is a refusal, not a
    precedence rule. An inherited value quietly beating an explicit one is the
    case that must be impossible, so there is deliberately no flag that
    *changes* the target: `REV_HOME` does that, and the flag is how you say you
    meant it.
  - **The assertion is made at the door, for every command including reads**
    (`assertInstallation()`, called in `cli.ts` before the switch). It was a
    parameter of `requireTarget()` until H-2526, which meant it held only where
    a handler remembered to pass it — and the read surfaces, which are exactly
    where a script puts an assertion, returned before reaching it and exited 0.
    One check before the switch is the same discipline as the `UNPINNED` list:
    a surface added later cannot forget it. It reads the target `unchecked`, so
    the two escapes from a broken selection stay reachable while still being
    held to the name they were given.
  - **The inherited conflict needs no flag to go wrong.** `cleanEnv()` copies
    the supervisor's environment into every session, `REV_LABEL` included, so a
    command run with another `REV_HOME` is named by one installation and aimed
    at another. The label cannot detect this — any process can set it — but the
    definition installed under it can, because it carries the `REV_HOME` it was
    installed for. `inheritedConflict()` is `assertOwnService()`'s question
    asked for every mutation rather than only the `service` verbs.
  - Reads still read under a conflict — they are safe from any context and the
    watch officer depends on that — but they print `installation: UNCLEAR` and
    name both homes rather than claiming a name they cannot stand behind.
  - `bin/gp-rev.js` deletes an inherited `REV_LABEL`: it fixes the home, so the
    name must come from the home. Without that, a crew session running `gp-rev`
    would be refused every mutation it asked for, correctly.
- `release.ts` — **changing which release an installation runs** (H-2493).
  Upgrade and rollback also durably rewrite a supplied installation deed's
  `release`; their unchanged path repeats that maintenance, so an interruption
  between the selection and deed renames is repaired by rerunning the command.
  `install.ts` verifies the pin; this is the only thing that moves it, because
  until now the write half was a text editor. `rev release status | upgrade
  <dir> | rollback`.
  - **The whole set is verified before the pointer moves.** For each of rev,
    helmo and helmo-roadmap: `dist` holds JavaScript, and its `BUILD.json`
    stamp names exactly the commit `RELEASE.json` does, built clean. A dirty
    component is refused — `stamp-build.mjs` records a dirty tree rather than
    refusing it, which is right for a build and not enough for a release: the
    manifest's commit would not identify the bytes. `releaseProblems()` returns
    every fault at once so a set is fixed in one pass, not three rebuilds.
  - **`MIGRATION.json` is required in the release directory**, authored rather
    than generated: `data_compatibility` (`compatible` | `one_way`) and
    `rollback` (`{supported:true}`, or `{supported:false, limit}` saying what
    cannot be recovered and how to recover from a backup). A release that has
    not declared it cannot be selected — after the upgrade is too late to ask.
    It is copied INTO the selection when selected, so a rollback can be refused
    in the limit's own words with the release directory long gone. **This repo
    ships the declaration for the release it is tagged as**, at `MIGRATION.json`
    in the root: the consumer builds the three `dist` directories and assembles
    the release directory, so upstream's claim about consequences has to travel
    inside the source rather than be left for them to invent. It carries no
    `release` field on purpose — the id is the directory's basename, which is
    theirs to choose, and a declaration naming an id is refused in a directory
    named anything else. `test/release.test.ts` selects a set built from the
    shipped file, so an edit that makes it unselectable reddens.
  - **The replacement is atomic and durable**: temp file in the same directory,
    `fsync`, `rename`, then `fsync` on the directory — without the last one the
    bytes are durable and the name pointing at them is not. The selection it
    replaces is retained whole INSIDE the new one, so a rollback is the same
    write in the other direction and one rename moves both or neither.
  - **`rev release` is one of the two families exempt from the pin check** in
    cli.ts (`install` is the other), and has to be: it is how a broken
    selection is repaired, so gating it on the selection being sound would put
    the repair behind the fault. `status` reports the incoherence as lines
    instead of throwing, and `upgrade` over an unreadable selection says
    plainly that nothing was retained to roll back to. The exemption lives in
    `UNPINNED` at the top of cli.ts and nowhere else — a handler passing
    `requireTarget` its `'unchecked'` argument never reaches that argument if
    the module gate stopped it first, which is exactly how `install remove`
    shipped unreachable (H-2522).
  - It changes one file and restarts nothing: a running process keeps the code
    it loaded. The command sends the operator to `release activate`, never to
    the outgoing CLI's ordinary redeploy or service-start paths.
- `release-intent.ts` — **a release write has to say what it is for** (H-3376).
  `upgrade`, `rollback` and `activate` move the code an installation runs next,
  and until now nothing in the product asked why. On 2026-10-21 two stray words
  in a doctrine sentence became shell command substitutions inside an
  autonomous loop iteration, and `rev release rollback` ran twice against the
  live selection (H-3374). The two cancelled and nothing was damaged; a lone
  `activate` would not have cancelled, and the substitution swallowed stdout so
  no transcript showed any of it. H-3374 closed the quoting ACCIDENT with a
  harness hook — which is config a session can be launched without. This closes
  the CAPABILITY, in the product.
  - **An attended run answers the question by being attended**; every other run
    must pass `--ticket <id>`. Attended is measured twice because either
    measurement alone is wrong: stdin is a terminal (the one thing separating a
    person at a prompt from a spawned child — every tool call, script and
    launchd job gets a pipe) AND `REV_LOOP` is unset (a supervised loop is
    unattended by definition whatever its stdio, it is the population the
    incident came from, and the shim writes the variable so a prompt cannot).
  - **It refuses the accident and the unnamed act, not an adversary.** A session
    with shell access can clear `REV_LOOP` or allocate a pty, and both are
    deliberate acts that name themselves in a transcript. What happened here
    was named nowhere, which is the whole defect.
  - **The ticket is checked for shape and against no store.** Verifying it would
    put the repair behind the fault (H-2493): these three verbs are the only way
    out of a broken selection, so the gate has to hold when everything else in
    the installation is down. The refusal says so, because an operator mid-repair
    needs to know the flag is not another thing that can fail.
  - **One list, above the dispatch, once.** `RELEASE_WRITE_VERBS` is both what
    cli.ts dispatches and what the gate reads, and the call sits above the
    three-verb branch and above every read of the installation — so the refusal
    cannot tell a run what it would have changed, and a verb added later cannot
    be dispatched without being gated. The guard class this replaces lived as an
    argument each handler passed, and held only where its author remembered
    (H-2526). `--ticket` is consumed at the cli.ts door beside
    `--installation`, so `release upgrade --ticket H-1 <dir>` cannot hand the
    flag to the verb as its release directory, and `redeploy` reads the same
    one value. `status` is a read and is never gated.
- `deployment.ts` — **the durable activation record** (H-2572), stored as
  `activation.json` beside the release selection. Built, published, selected,
  activating, running, failed, and rolled-back are distinct; every record
  carries exact component refs, effective installation identity and an owned
  recovery instruction. `rev release status` combines it with the selection
  and reports missing, partial, or stale evidence rather than treating selected
  artifacts as live processes. A running record declares its required process
  set; status checks coverage, exact commands, loaded refs, installation
  identity and PID liveness, and keeps activation recovery visible even when
  the selection is unreadable. Activation code writes running only after its
  process probes supply their loaded refs, identities and identity write/readback.
  `rev release activate` (H-2571) is the supported write path: it records
  `activating`, reuses the redeploy sentinel so the current iteration closes
  before the bounded supervisor drain, and lets only the replacement supervisor
  record `running`. The detached restart watch records `failed` and recovery if
  no supervisor returns; identity conflicts refuse at the CLI door before any
  activation record or sentinel is written.
  - **A restart is not a failure, and the record has to be told** (H-2985).
    Nothing reconciled the receipt when launchd restarted the supervisor on its
    own, so it went on naming a dead pid, status read that as `NOT RUNNING`, and
    the recovery line it printed told the operator to roll back off a correctly
    running release — the dangerous direction, fired hardest during an
    activation preflight, the one procedure that has agreed to halt on drift.
    `recordRestart` closes the gap at the source: a supervisor starting outside
    an activation re-attests its own evidence, gated on `loadedFromRelease` —
    the loaded directory under `<release>/<component>/…` and that component's
    selected commit, never a configured ref and never a dirty stamp (H-2432).
    `describeDeployment` is the second half for a record nobody re-attested: it
    reads the supervisor's `RUNNING` marker through the same predicate and the
    same liveness rule (`markerObservation`, shared with `sentinels.ts` so the
    recycled-pid defence of H-154 is not written twice), and prints `RESTARTED`
    rather than a false failure. Recovery prints only when something is wrong.
  - **A release that starts cannot assume its consumers moved with it**
    (H-3103). Activation changes one file and restarts one process, so every
    entry point named by its full release path is still pointing at the release
    being left. On 2026-10-09 the supervisor activated 2026.10-18 while
    `roster.toml` still named 2026.10-17's Work CLI and MCP server: all five
    loops launched, then failed every Helmo read as an incoherent release set,
    four wedged, and the installation stayed that way for sixteen hours while
    the record said `running`, liveness was up and `/health.json` was ok. None
    of those three asks whether the consumers agree with the selection.
    `releasePinProblems` (release.ts) does, and the supervisor refuses the
    start before anything reports `running`: it names every disagreeing path,
    the release each one is on, the file to edit, and exits 0 so the service
    manager leaves it down rather than crash-looping over the reason. The
    refusal discharges the redeploy sentinel on its way out, because a refusal
    whose own recovery line is then rejected as "a redeploy is already pending"
    is worse than the strand it replaced. What it judges is the release a path
    NAMES — found by walking up to that release's `RELEASE.json`, not by
    inferring a layout — so a working-tree path belongs to no release and is
    left alone, and a development installation or a roster of placeholders
    still starts. Only the two roster globals are gated here; they are the
    paths this process reads itself. The wider hand-written consumer set (two
    launchd argv, three desk and seat MCP configs, the operator's shell alias —
    three file formats, three of them outside any repo) is instance data no
    release can reach, and `crew:tools/estate/release-pins.mjs` is what sweeps
    it both directions.
- `remove.ts` — **the one command that deletes an installation's records**
  (H-2512). `rev install remove [--confirm]`. Every other removal rev has keeps
  the data: `rev service uninstall` takes the definition and leaves the store,
  the controls and the selection byte-for-byte. That left the
  independent-installations contract with a line nothing could satisfy — the
  spec asks a release to prove that "uninstall of A, deleting only A's data,
  leaves B's store and controls untouched" — and the only removal an operator
  had was a hand `rm -rf` in a shell carrying the other installation's
  `REV_HOME`, which is the H-2431 shape with no product refusal in the way.
  - **It is a separate verb, not a flag.** `rev service uninstall --also-data`
    would make the difference between keeping and deleting every record a word
    someone can miss. The two removals are distinguishable at the command line.
  - **The plan is printed before anything goes, and `--confirm` is a second
    act.** Without it the command writes nothing and exits 0, which is also how
    an operator finds out what the installation actually owns.
  - **The boundary is the directories the installation OWNS, named** —
    `removalBounds`. It was `dirname` of the resolved Rev home, which is right
    for a parent dedicated to one installation (`/srv/installs/alpha/.rev` beside
    `/srv/installs/alpha/.helmo`, the shape the fixture proves) and wrong for the
    layout this product calls conventional: `~/.rev-b` beside `~/.helmo-b` makes
    that parent the ACCOUNT HOME, so every path under `~` read as ours. Ward
    found it in the H-2542 clearance, and the plausible route in is `cp -a ~/.rev
    ~/.rev-b`, which brings `roster.toml` and its `helmo_db = ~/.helmo/helmo.db`
    with it — the first installation's records, named by the second, inside the
    boundary (H-2544). So a conventionally NAMED home gets a named set instead:
    itself plus the Helmo family's homes beside it carrying the same tail
    (`conventionalTail`, exported from service.ts because it is the same
    uniqueness the label rests on). A tail beginning `-roadmap` at a name
    boundary is reserved: `.helmo-roadmap[-…]` is another installation's
    roadmap home, so removal never pairs it as this installation's Helmo home
    (H-2553). The name, not the location, decides — so
    `.rev-a` and `.rev-b` are separate wherever they sit, and the rule is
    provable in a tmpdir rather than against the real account home. Any other
    name keeps the enclosing directory, because there is nothing to pair with;
    that is the remaining gap, and the docs say so rather than implying a guard.
    A selection file in the directory the homes share is now reported rather than
    taken — under the conventional layout that directory is the account home, so
    the documented place for it is inside the Rev home. Rev's home, the Helmo
    store the roster names, the roadmap store `ROADMAP_DB`/`ROADMAP_HOME` names,
    and the selection, each with its SQLite `-wal`/`-shm` beside it. A product
    this installation names no store for gets no default assumed — the default is
    the shared one.
  - **Order, each refusal naming the command that clears it.** A standing
    service definition blocks it (`rev service uninstall` first, or a manager
    keeps bringing back a supervisor whose home this deleted); a live supervisor
    blocks it (`rev stop` first — it writes state back into a home being
    removed); a `REV_HOME` that contains the account's own home directory is
    refused outright. Like `rev release`, it runs `unchecked`: a removal is one
    of the two ways out of a broken selection, so gating it on the selection
    being sound would leave an installation that can neither run nor be
    removed. That takes BOTH halves — the `'unchecked'` argument here and the
    `install` entry in cli.ts's `UNPINNED`. It shipped with only the first, so
    the exemption was unreachable until H-2522.
  - **A liveness read must not create what it reads.** `occupiedPid` goes
    through `stateDir`, which `mkdir`s — so asking it of an already-removed
    installation rebuilt that installation's Rev home, and the next plan had
    something to take again. The check is skipped when there is no home.
  - Release directories are never touched: a release is shared between
    installations, and `rev release` is what a version change goes through.
- `sentinels.ts` / `config.ts` — sentinel files + roster loading. A loop's
  optional `skills = [...]` (paths) are appended whole to its constitution at
  spawn — how a Drive-touching loop carries crew `skills/file-stewardship.md`
  (H-247); a missing skill fails the session closed like a missing constitution.
  Providers (H-479): `[providers.<name>]` is an adapter plus the operator's
  tier→model table (and prices) — the machine copy of crew
  `skills/model-selection.md`; model names live in the roster, never in rev's
  code, so name churn is a roster edit. A loop says `provider` + `tier`
  (`probe_tier` for the probe pass) or the v0 `runtime` + `model` strings;
  `rotation = ["claude", "codex"]` alternates providers per iteration and
  `fallback = ["codex:mid"]` names where to run when every scheduled
  provider's cap is out. All references resolve at load and fail the roster
  loudly. Instance data
  lives in `~/.rev/` (roster.toml, mcp/, state/<loop>/, token-log), NEVER
  in this repo — publishability is structural.
- `launch-journal.ts` — the durable, per-loop record from model dispatch through
  its content-off provider result. Preclaimed pool iterations carry the
  launch id as their Work actor generation; scoped seats do not, because a
  claim made inside one iteration may remain with that seat for the next.
  Every iteration still has a launch journal, and the settled record adds provider,
  model, provider session id when observed, timing, outcome and measured
  usage/cost, never prompts, responses, tool payloads or environment. An
  absent provider id is stored as `unsupported`, not empty. Workflow launches
  also expand Helmo's immutable launch receipt into the exact ticket, workflow
  attempt, admission, definition
  revision and requirement/manifest/decision refs, then fsyncs an exclusive
  dispatch claim before starting the model process. The claim is at-most-once:
  replaying one launch id cannot start a second model process, including after
  a crash in the pre-dispatch gap. Entries live under
  `state/<loop>/launches/`; recovery and revalidation build on them rather than
  reconstructing authority from current workflow state.
- `view.ts` — read-only machine dashboard at :4500; `/health.json` is the
  machine-readable snapshot (loop states, usage) for aggregators like the
  estate health page (crew tools/health, H-627) — consumers read it rather
  than re-deriving sentinel truth. `cli.ts` — run / status /
  stop / resume / pace / service / tail. `rev run`/`rev stop` with no argument
  mean the whole machine (Arthur's ruling: the operator starts the machine,
  not a named worker). `bin/gp-rev.js` is the Good Plumb operator entrypoint:
  it fixes `REV_HOME` to `~/.rev-gp` before loading that same CLI, so every
  verb stays shared while neither a shell override nor remembered flag can
  cross estates. `command-name.ts` resolves the invoked name once for every
  caller-facing next command, including calls dispatched by the `helmo` front
  command; installed binary paths, service labels and `rev:` process log
  prefixes keep naming the actual runtime. Its displayed commands and roster
  source follow that name.

## Commands

- `npm run build`, `npm test` (ladder units + e2e with mock runtime). The
  verbose reporter is deliberate: the real-process e2e files can take several
  minutes on a loaded fleet host, and per-case progress distinguishes that
  bounded work from a hung run without inspecting or killing its fixtures.
- The release CLI fixture clears inherited `INSTALLATION_RELEASE` and product
  identity/store variables before applying explicit fixture overrides, and its
  `HOME` is the disposable parent of `REV_HOME`. Redirecting `REV_HOME` alone
  leaves an inherited absolute selection writable (H-2579). The regression
  runs an unpinned command beneath a disposable pinned parent and requires the
  parent's selection to remain byte-for-byte unchanged.
- **`npm test` runs two test files at a time, not eight (H-1347).** Vitest's
  default is `availableParallelism() - 1`, and this suite's parallel unit is
  not a worker, it is everything a worker spawns: the five e2e files each
  drive a real supervisor, real loops and a real Helm store. The cap is free
  — measured on 159cb11, a quiet-ish machine, 225/225 green each time:
  workers 8 → 83.8s wall / 111s CPU, 2 → 83.3s / 105s, 1 → 145.3s. Wall time
  here is set by the slowest single file (`loop.e2e.test.ts`, ~80s), not by
  how many run beside it, so two costs nothing and one costs a minute. What
  the cap buys is resident weight: peak vitest processes 10 → 6.

  Do not read that as the cure for a red CI run. On 2026-09-13 this suite
  read red in CI with nothing wrong in it — both attempts failed, the first
  killed at the runner's 600s cap and the retry failing seven tests, every
  one a timeout and every one absurd (a 5s budget reported at 106000ms, a
  450ms test at 106251ms). The same commit passes in 84s here. It was the
  machine: that night `connectors` took **971s** for a build and a typecheck,
  a step with no fan-out at all, and four of six repos ran red or flaky. The
  cap bounds what this suite asks for; it cannot make a starved box compute.
  What ends that class of red is CI not reading a machine already carrying
  the live fleet — H-1352.

  One red-under-load case was neither slowness nor a starved box. The
  resume-failure case in `supervisor.e2e.test.ts` (H-1038) failed only on a
  busy machine, and giving it more time made it worse: with its wait budget
  raised from 20s to the whole 60s of the case it still timed out, at 55s
  instead of 25s. It was racing, not waiting. The supervisor calls a resume
  healthy once the restarted child has stayed alive for `min_uptime_seconds`,
  and the fixture set that to 1s — while the loop under test needs two failed
  runs and the burn breaker to die, a couple of seconds out. Idle, death won
  and the case passed; loaded, liveness won, the resume was recorded healthy,
  and the failure return the case asserts never came. The cure was fixture
  shape, not budget: that case sets `min_uptime_seconds = 20` and now passes
  at three times the load that broke it (H-1419). The healthy path can also
  lose the race to an agent: bosun closed H-2152 from the answer before the
  supervisor's min-uptime check, and Helmo refuses every write to a terminal
  ticket, so completion retried and failed every poll for as long as the
  supervisor ran. `completeAnsweredResume` now reads the status first and stands down
  on a closed escalation (H-2164). So when a case is red only
  under load, ask first whether it is waiting on something slow or racing
  something fast. A timeout raised on a race only buys a longer red.
- `node dist/cli.js routing` previews working-model selection without starting
  work. `usage --poll` refreshes Claude remotely and Codex from local rollouts.
- `status` independently reads the complete ready backlog reserved to each
  roster seat. `unavailable_seats` names ready work no eligible worker can draw
  — including reservations to a seat absent from the roster and work outside
  every configured project/ticket/lane scope — and the coordinator action;
  unreadable Work state stays `null`, UNKNOWN asks
  for verification, and deliberate STOP/HOLD/PARKED/SEAT_HELD controls are not
  recovery findings. `self_triage` separately names a seat's own filings that
  Work has correctly withheld for second eyes; their action is recorded triage,
  never a launch or a bypass of the gate.
- `node dist/cli.js trace H-n@installation` is the read-only exact-key
  diagnostic across Runtime launch journals and Work history. It requires a
  qualified ticket reference, emits closed metadata only, and keeps observed,
  measured-zero, not-observed, unsupported and malformed/refused distinct.
  `sessionTrace` stays a pure reading of what it is handed, so the two fields
  the launch journal has never carried come from the CALLER, which knows the
  seats and their working directories: `source_revision` from the codex
  rollout's own `session_meta.git` where there is one and from this
  installation's startup receipt `repos` otherwise, and `served_context` from
  that receipt's composition hash and supplied/discovered split. The state does
  not say which — the `source` string does. A launch the caller found nothing
  for still reports `unsupported`, so the default reading is unchanged.
- `node dist/cli.js context-coverage [seat] [--no-inventory]` prints the
  coverage reading for every entry path, or one seat's. It exits non-zero when
  any path is `stale` or `error`, so whatever runs it learns the finding
  without reading the JSON. `--no-inventory` drops the tokenized per-file
  measurement; the whole fleet with it measures ~2s here.
- `node dist/cli.js summons [--since <date>] [--limit <n>] [--root <path>]`
  lists the named summons this installation can see, each with the basis for
  its role claim, whether the protocol was performed, and every record of the
  sitting. It hands off to the reader above: `context-trace --record <path>`
  over a listed record reads that summon's context like any other session's.
  The scan says what it searched and what it cannot see, because a nil answer
  that does not is read as an absence.
- `node dist/cli.js context-trace <seat> [--launch <id>]` or
  `context-trace --record <path>` prints one session's per-invocation context
  trace from the host CLI's own record. It exits non-zero when a required
  category is `unavailable` or the record cannot be attributed to a harness,
  which are the two findings it exists for; a category that is `partial` is a
  reading and does not. Only a SETTLED launch is traceable, because that is the
  only one the launch journal carries a host session id for: `--launch <id>`
  reads that launch's own journal entry, and the bare seat form takes the
  newest settled launch across every route the seat can launch under, not the
  primary's providers alone.
  With `--at <call>`, `--changes` or `--find <text>` the same command answers
  as the operator read surface instead: the parts of one call's context with
  their origins, the timeline of what entered and left, or where a string came
  from. `--changes --notable` keeps only the calls with something to report
  (three of 132 in one real session). `--chars <n>` and `--full` set how much
  of each part comes back — the default is a bounded preview, because a 132-call
  session's parts are the 30MB the JSON reading already was. `--json` hands over
  the structure. Two questions at once is refused rather than answered as one,
  and a call the session never made is refused with the range it did.
  `--verbatim` (with `--json`, and on `--at` or `--changes`) is the FULL-DATA
  export an audit reads rather than the reading an operator reads (R-56,
  H-3818). Every other field here is a rendering: a part's `text` prints an
  image block as `[image]` and a tool call as a JSON line, a tool is three
  fields of its schema, and the codex instructions are the world_state keys
  that are prose. `--verbatim` adds, alongside them and without replacing
  them, `parts[].payload` (the content blocks the host retained, whole — a
  tool_use `input` as the object it was, a structured `tool_result`, an image
  part with its own metadata), `instructions.tools[].definition` (the whole
  tool entry, `input_schema` included), `instructions.state` (codex: the full
  world_state, including the sixteen keys of twenty that no block or tool row
  decomposes — `environments`, `permissions`, `collaboration_mode`, `skills`
  and the rest; claude: null, because an `api-request-shape` holds `system`
  and `tools` and nothing else) and `call_params` (claude: the parameters the
  request was sent under, betas and context-management edits included; codex:
  null, because a rollout writes none per call). It implies no truncation — a
  content block clipped at the preview length is a rendering again — and it is
  refused without `--json`, because the terminal rendering has nowhere to put
  it and a flag that is silently a no-op is worse than one that says so.
  Cross-checked against the host records independently of this reader on one
  run per harness: 50/50 retained blobs and 17/17 tool definitions byte-equal
  on a claude call of 122 parts (the other 72 are reconstructed, each carrying
  its payload, its `via` transcript uuids and its measured caveat), and 82/82
  recorded response items plus 42/42 replacement-history items byte-equal on a
  codex call of 124.
  Note the default reading is unchanged, and deliberately: an operator's
  terminal has no use for a second copy of every part, so `payload`,
  `definition`, `state` and `call_params` are all null without the flag — and
  codex's `gaps` NAMES the world_state keys it is not rendering whatever the
  view, so a reader who never passes `--verbatim` is still told they exist.
  ONE NORM FOR AN AGENT RUNNING THIS, not a code rule (ward, H-3750): the
  command stores nothing, but an agent running `--full` or `--find` puts the
  record's content into its own transcript, and anything it quotes into a
  ticket or a commit becomes a store. A sweep or a loop reports states, counts
  and labels — never the text.
  Note the dev tree cannot drive this command against a pinned installation:
  the release-coherence gate refuses before any projection runs. `env -u
  INSTALLATION_RELEASE node packages/runtime/dist/cli.js …` is the read-only way
  to exercise it against real records.
- `node dist/cli.js context-inventory [seat] [--from <ISO>] [--to <ISO>]
  [--limit <n>] [--json]` prints the population reading: per seat, every run in
  the window with its state, then the items with their frequencies and an
  evidence ref per item that is itself a `context-trace --record <path> --at
  <ordinal>` command, so a figure drills straight down to the content behind
  it. No seat argument reads every configured one, including the seats that ran
  nothing. The window defaults to the last seven days INTERSECTED with the R-56
  cohort start (`COHORT_START`), because runs before it were launched by
  releases whose context composition this report cannot vouch for; `--from`
  takes a wider historical read deliberately and says so in `window.basis`.
  Either bound is REFUSED by name if it is not a readable instant — one stderr
  line, exit 1, nothing on stdout. An unparseable bound is NaN and every
  comparison against NaN is false, so a mistyped `--from` used to drop the
  lower bound and report the whole journal at exit 0, and a mistyped `--to`
  threw a RangeError at the operator (H-3817).
  Reads only — the journal and the host's own records, no new store. The same
  norm as `context-trace` applies to an agent running it: `--json` carries the
  item labels and the paths, not the text, and a sweep reports counts and
  labels. Driven from the dev tree the same way: `env -u INSTALLATION_RELEASE`.
- `node dist/cli.js startup-context [seat] [--launch <id>] [--ticket <id>]
  [--limit <n>]` prints the startup receipts: one per launch, newest first,
  each with its content resolved now and whether its composition still rebuilds.
  `--ticket` is the flag the CLI door already consumes, and the work-linked
  lookup goes through the launch journal's admitted ticket and measured
  `touched_tickets` window rather than a second index that could disagree with
  it. `--diff <launch> --b <launch>` (with `--a-seat`/`--b-seat` to cross seats)
  compares two runs per source. `--prune` reports what the retention policy
  would drop and deletes nothing until `--apply`: the destructive half of a
  policy asks for the word, so that reading the policy can never delete under
  it. Exits non-zero when a receipt failed to record or retained content went
  missing inside the horizon.
- `npm run vendor:tokens` refreshes the vendored estate design tokens,
  `npm run vendor:avatars` the vendored crew avatar sprite, and
  `npm run vendor:reach` the vendored estate reach table; add `-- --check`
  to any of them to fail on drift instead. See below.
- Start the machine: `node dist/cli.js run` (supervisor over the whole roster).
  Drive one loop: `node dist/cli.js run <loop> [--count N]` (foreground;
  `--count 1` is the assess-early lever).
- Activate a committed fix on the running fleet: `node dist/cli.js redeploy
  --ticket <id> --reason "<why>"`. It returns immediately; the drain lands
  within one poll and the service manager brings the fleet back on the new
  code. Needs a running supervisor (a cold start already runs current code)
  and a service manager — with no service installed it warns that the fleet
  will drain and stay down.
- Dashboard: `node dist/view.js` (`REV_VIEW_PORT`, default 4500; binds
  127.0.0.1, `REV_VIEW_HOST` to change; `REV_HELMO_VIEW_URL` overrides only
  the standalone Helm link while preserving the composed-estate reach) — restart after rebuild. It has no
  authentication: widening the host serves every loop's home path, spend and
  event trace to anyone who reaches the port.
- Delete an installation: `node dist/cli.js install remove` prints exactly what
  would go and removes nothing; `--confirm` does it. There is no undo and no
  other command brings it back. To remove only the service and keep every
  record, that is still `service uninstall`.
- What a seat's session is made of, as JSON, without running one:
  `node dist/cli.js session-spec <seat> --session <actor stamp> [--provider
  claude] [--tier high] [--model M] [--cwd P] [--constitution P] [--version V]`.
  Reads state, writes none. `--session` is required (see `shim.ts` above) and
  refuses a `rev:<seat>` value: that stamp is a loop's own, a loop never asks
  for a spec, and the answer gate in `work/store.ts` reads the prefix as an
  unattended iteration (H-3622). A tier resolves through the roster's providers table — a meeting can ask for
  `claude:high` while the seat's loop runs codex/frontier. A seat with no
  roster loop is composable by supplying `--cwd` and `--constitution`, the two
  facts rev has no business knowing; the spec then says `in_roster: false`.

## Legacy visual sources

Helmo owns the legacy CSS and avatar source in `packages/core/assets/legacy`.
The embedded modules remain byte-identical in rendered content; a release
carries everything needed to render them. `npm run vendor:tokens` and
`npm run vendor:avatars` regenerate from those included sources. Drift tests
always run, including in a cold clone with no sibling checkout. Missing
sources fail instead of skipping. Explicit `ESTATE_TOKENS_CSS` and
`ESTATE_AVATARS_SVG` overrides remain development-only options.

These compatibility files do not govern the current application preset;
`UI.md` remains the component and upgrade contract. The notes below describe
the historical legacy adoption, not an external source dependency.

**Rev was the third adopter and the only one starting from nothing.** Helmo and
the roadmap already had token layers to alias; rev's view had fifteen literal
hex colours and no dark half at all — it served a white page at midnight. So
here the seam had to be built rather than re-pointed: a `:root` block of
aliases, and every rule below written against them. `ESTATE_TOKENS` is inlined
ahead of that block, which is what brings the dark values in under
`prefers-color-scheme` on a page with no theme switch.

Adopted: surfaces (`--page`), the grey ladder, `--hairline`. No radius ramp —
nothing on this page is rounded.

Status colours and the interactive `--link` blue were held back at first —
shadcn's neutral base ships no status ramp, and its own `--accent` is a hover
*surface*, not an interactive colour. Arthur's call on **H-771** was to put
both in the estate's token set, so they alias like everything else now and
rev's dark overrides for them are gone: the estate's ramp is themed.
`--warn-text` moved one step in that swap. Rev carried `#b60`, 4.19:1 on white,
and rev is the view that uses amber AS body text; the estate's light amber is
`#a60` at 4.56:1 — the value this file's own note reported upstream when the
health page measured it. That divergence is closed.

Two things rev needed that the other two did not:

- **Dark siblings for the status colours.** They were tuned for a white page
  that no longer exists at night. `#b00` red and `#b60` amber both drop under
  4.5:1 on the estate's dark surface, so each has a lightened step of the same
  hue in the `prefers-color-scheme` block. Amber's dark step *is* the shared
  `#fab219`; its light step stays rev's `#b60`, because the other two views use
  amber as a wash behind a badge and rev uses it as small text, where `#fab219`
  on white is unreadable.
- **A fourth grey.** Rev distinguished `#999` and `#bbb`; two percent apart is
  not a distinction anyone reads, so one faint step (`--ink-4`) serves both.

**Two traps worth knowing.** An alias that comes out self-referential
(`--hairline: var(--hairline)`) is *guaranteed-invalid* in CSS: the property
ends up with no value, every rule using it is dropped, and nothing goes red —
the page just quietly loses all its borders. That shipped for one render in the
roadmap and only a pixel sample caught it. And a hex left behind in a rule is
invisible to tsc and still renders — it is simply a colour picked for white
being shown on near-black. `test/estate-tokens.test.ts` asserts against both.

Rev also gained the `viewport` meta the other two views already had; without it
a phone rendered the page at 980px, zoomed out to illegibility. Seven columns
of machine detail still do not fit a phone and should not try to, so
`.tablewrap` scrolls the table horizontally and leaves the heading and usage
lines where they are.

That wrapper was briefly filed as a defect and is not one (H-889). The estate's
overflow detector used to flag any element whose rect reached past the
viewport, which is every cell of a table that scrolls on purpose; it reported
OVERFLOW on this page while printing, in the same line, that the document was
390px wide in a 390px viewport. The detector now stops at the first ancestor
whose `overflow-x` is not `visible`, so this page reads clean. Estate's `npm
run smoke` drives it at 390px in both themes along with the other products —
that check lives there because it needs a browser and this repo stays
zero-dependency; run it after touching `view.ts`'s HTML or CSS.

## The crew avatar sprite (R-11 H-714)

`src/estate-avatars.generated.ts` is a second **vendored copy** on the same
seam and for the same reason — core's `assets/legacy/crew-avatars.svg`, refreshed
by `scripts/vendor-estate-avatars.mjs`, drift-checked by
`test/estate-avatars.test.ts`. The sprite is inlined into the page body and a
mark is drawn with `<use href="#crew-<mark>-<kind>">`. No colour travels with
it: a mark is `currentColor` over `var(--crew-<name>)`, which the vendored token
copy already defines, so the two files interlock and neither holds a value the
other owns.

Rev has one actor surface — the Loop column — and rev is the third adopter, so
the pattern transferred whole. **What is different here is the kind.** Helmo and
the roadmap read it from the record: they store mixed kinds and answer with the
one each name last wrote under. Rev's record holds no kind and has no field one
could arrive in, so `LOOP_KIND` in `src/view.ts` states it once — and it rests
on the roster's own contract rather than on the look of a name. `loadRoster`
refuses a loop with no `constitution`, the profile the process runs under; the
one exception is an all-mock loop, which is a test fixture. Every seat on this
page is an agent because the roster will not load anything else.
`test/estate-avatars.test.ts` pins both halves — the refusal, and the sprite
composing that kind at all — so relaxing either turns `LOOP_KIND` red instead
of turning every mark on the page invisible.

**Everything in this area fails silently**, which is what the ten checks are
for. A `<use>` at a symbol the sprite does not carry draws nothing: no console
error, no failed request, a 200 on the page and a column that looks like a
design choice. So the checks aim at that one shape — the id the view builds,
the symbols the copy actually carries, and the sprite reaching the served HTML
after `</style>` rather than inside it. Two traps inherited from the first
adopter are in the estate's DEV.md: recognise a composed symbol by its *body*
(`crew-frame-agent` matches the id shape exactly and is not a mark), and refuse
a ragged sprite, because the view names `crew-${mark}-${kind}` from a roster it
did not choose — roster keys are instance data in `~/.rev`, never in this repo.

The all-pairs rule is structural, not a habit: ten members cannot have ten
mutually distinguishable hues (H-713), so a mark must never stand without its
name. Exactly one function draws one and it takes the name it prints, and
`.actor { white-space: nowrap }` is part of the same rule — the Loop column is
the narrowest on the page and the first to wrap on a phone.

## The condensed roster (R-44 H-3091)

`teamNowSnapshot()` in `view.ts` is the reading; `team-now.ts` is the judgment.
It answers one question — which agents are working, awaiting work, blocked or
stopped — and it rides the Overview document as `team`.

**Six states, not four.** Arthur asked for Working / Awaiting work / Blocked /
Stopped. `failed` and `unknown` exist because folding them in would lose the
two readings that matter most: an unexpected failure is not a blockage somebody
decided on, and a state this build could not read is not a state. The mapping
is a table in `team-now.ts`, and a state word it does not hold reads as
`unknown` rather than `stopped` — a future sentinel must never present itself
as a deliberate stop.

| Rev's word | Display | Why |
| --- | --- | --- |
| `RUNNING` | working | executing |
| `IDLE`, `SEAT_HELD` | awaiting | up and available; nothing to draw, or the seat's holder has it |
| `BLOCKED`, `LIMIT` | blocked | cannot draw work, and nobody chose it |
| `STOP`, `HOLD`, `PARKED`, `halted` | stopped | somebody's instruction, or never started |
| `BACKOFF`, `WEDGED`, `CRASHED` | failed | an unexpected crash or failure, whether or not the supervisor will retry it |
| `UNKNOWN`, anything else | unknown | the reading failed |

`BACKOFF` remains *failed*: the supervisor writes it only after the loop
crashes, and retrying the crash does not turn it into a blockage.

**The roll-up is by severity, never by convenience.** One agent is one
accountable seat, and a seat may be served by several sessions (`seat` in the
roster). The chip takes the worst of them in the order failed > blocked >
unknown > working > awaiting > stopped, and the reason shown is the deciding
session's own — a reason belonging to a different worker would be worse than
none. `unknown` outranks `working` deliberately: a session whose state could
not be read may be in any state, including a failed one, so a healthy sibling
must not cover for it. Every session is listed under the card's disclosure, so
the roll-up can be checked rather than taken on trust.

**Nothing is inferred from an absence.** A seat with no process and no marker
is `stopped` because Rev reports `halted`, not because this code looked for a
heartbeat and missed one. Where no reason was recorded the card says so rather
than composing a plausible sentence: `stateReason` is the four reasons
Runtime's own State column carries, and `stoppageReason` is the rest — a stop's
owner and reason, a park's PACE command, a limit's provider reply, a backoff's
attempt and retry instant, and a crash's abandoned pid. Each reads a field its
writer in this repo actually writes.

**A reading that cannot be taken is a reading, not a crash.**
`teamNowSnapshot` catches it and answers `unavailable`; the card draws red and
says so. Overview builds its whole document before writing a header, so
throwing here would answer 500 for the entire page (H-3001). One honest limit:
on the composed app an unreadable ROSTER never reaches this branch, because
Overview counts the roster for its Team summary card first and answers 500 —
asserted deliberately in `packages/cli/test/app-acceptance.test.mjs`. What this
branch covers there is a failure after the roster loaded, such as a state
directory that cannot be read.

The tickets on each entry are the claims the work record holds, passed in by
`serve.js`: `seatWork()` in `packages/work/src/presentation.ts`, keyed by
assignee. A claim is the only thing in that record saying an agent is working
on something — reserved work is work handed to a seat, not work it is doing.
The runtime never imports the work record (R-47 C1), which is why this one
argument is passed rather than read.

Proof: `test/team-now.test.ts` (the mapping against every state word `state()`
can return, the roll-up, and each reason read from a real installation
directory), `packages/work/test/seat-work.test.ts` (claims through the real
store), `packages/shell/test/team-now.test.mjs` (what a reader sees),
`packages/shell/test/status-palette.test.mjs` (the roll-up's severities are
Runtime's, state word by state word), `packages/cli/test/app-acceptance.test.mjs`
(the document reaches Overview through the shipped binary, join included), and
`packages/shell/scripts/verify-ui.mjs` (all six states seeded and drawn, the
disclosure opened, both themes, three widths, axe).

## Where the Work link points (R-11 H-832, R-47 H-2801)

`src/estate-reach.generated.ts` is the third **vendored copy** on the same
seam, and the first whose source is the crew repo rather than the estate:
`crew/tools/estate/services.json`, refreshed by
`scripts/vendor-estate-reach.mjs`, drift-checked by `test/estate-reach.test.ts`.
Unlike the other two it is derived rather than verbatim — a registry entry
carries plist and log paths rev has no business holding — so the vendor script
refuses a registry with no `reach` prefix or nothing navigable rather than
emitting a table of localhost addresses that look fine on this Mac.

**A composed surface has two true addresses.** `url` is the product on its own
port, right at the desk and dead from anywhere else; `path` is the same-origin
path the estate shell composes it at. A `desk_only` surface instead has one
loopback address and the vendor repeats it in both fields. Runtime's one link
out now names unified `helmo-app` and appends `/work`: from `/run` that is the
same app origin, while the standalone Runtime compatibility view reaches the
app's loopback listener. `REV_HELMO_VIEW_URL` remains the explicit base for an
isolated installation. `reachLink()` ships both addresses (`href` and
`data-reach`), and `REACH_SCRIPT` swaps them only for a remote reader.

**The server cannot decide it**, which is the thing to know before deleting the
script. The estate shell's proxy fetches this page itself, so the `Host` header
rev sees is always its own port however far away the reader is. The same rule
lives in `estate/src/lib/reach.ts` and `crew/tools/estate/registry.mjs`
(`reachFrom`) — three runtimes, one registry deciding the addresses, and no
service hand-keeping one of its own. With scripting off the href stays the desk
address, which is every rev build before this one.

The checks aim at the silent shapes: a link shipped without the registry's
address, the script placed above the anchors it rewrites (finds none, reports
nothing, looks like a working page), and a surface renamed in the registry —
which `reachLink` throws on, so it goes red in CI rather than on Arthur's phone.
The far-origin half of the proof is a real browser: `estate/tools/reach.test.mjs`
does it for the shell's own nav with `--host-resolver-rules=MAP estate.test
127.0.0.1`, and rev's equivalent is the unit test running `REACH_SCRIPT`
verbatim against a stubbed origin, because a browser harness is not a
dependency this repo should grow for one link.

## What built `dist`, and what is RUNNING it (H-2442, H-2489)

### The artifact (H-2442, R-39 Q8)

`dist/` is gitignored and `rev redeploy` restarts the fleet WITHOUT building,
so the supervisor has always loaded an artifact with no provenance. On
2026-09-30 `dist/cli.js` was built 2026-09-29 19:46 while the supervisor
running it had started 2026-09-27 18:01 — the fleet was executing code that
no longer existed on disk, and the iteration prompt every loop runs is
compiled from `src/loop.ts`.

`npm run build` now stamps `dist/BUILD.json` through a `postbuild` hook, so
there is no second step to forget. The stamp travels WITH the artifact rather
than living in a central log directory: two installs of rev on one machine
(the personal supervisor and `~/.rev-gp`'s) build into different checkouts,
and a file keyed by repo basename could only ever describe one of them
(H-2435, H-2436). `node scripts/stamp-build.mjs --check` fails when the stamp
is missing or older than the code beside it, and never counts itself as
evidence of its own freshness.

A dirty tree is RECORDED, not refused — `tsc` compiles the working tree, so
the sha would not certify the artifact, and a refusal only produces builds
with no record at all. crew's `tools/estate/builds.mjs --check` reads this
stamp and reports `dirty` as a failure there.

Because building and restarting are separate acts here, a build alone does not
change what the fleet runs: the supervisor keeps executing what it read at
spawn until `rev redeploy`.

### The running process (H-2489)

Which is why the stamp can never be the answer to "what is the fleet running".
The two come apart at every rebuild, and reading the stamp beside the code was
going to report the NEW commit as the running one — the single answer that is
certainly wrong. So `src/build.ts` reports them as two different questions, and
`status`, `service status`, `/health.json` and the dashboard print both:

- `build:` the artifact in the directory the reading process ran from, now.
- `running:` what the live process recorded when IT loaded, or `STALE` /
  `UNVERIFIABLE`. It never falls back to the artifact's sha: on divergence that
  sha appears only as the thing nobody is executing.

**The record rides in the `RUNNING` marker.** A long-lived process writes that
marker at startup and clears it on exit, which is exactly the lifetime of the
bytes it loaded — so `runningStamp()` adds `loaded <digest> <dir>` and
`build <commit> clean|dirty <built_at>`, and no new file gets a new lifecycle to
get wrong. A marker from before this simply lacks the lines, and a reader calls
that UNVERIFIABLE rather than guessing: a supervisor started before the change
reports UNVERIFIABLE until its next `rev redeploy`.

**What is compared is bytes, not the sha** — `digestOf()` over the `.js` in the
directory, because a dirty tree's sha did not produce the artifact and two
rebuilds of one commit differ. `.d.ts` files and `BUILD.json` are excluded:
they move on a rebuild without changing a byte any process executes, so
counting them would report divergence where there is none.

`loaded()` holds ONE reading, taken at startup, and `view.ts` calls it before
it serves. A process that asked later would read whatever replaced its code and
call that running — which is the whole defect, restated.

Limit, stated plainly: the digest is the bytes on disk when the snapshot was
taken, which for a statically imported ESM graph is load time. It does not
follow a module imported dynamically much later.

## Invariants that bite

- Roster `version` is constitution provenance — bump it when a loop's profile
  changes.
- Reboot resilience is opt-in: `rev service install` (launchd/systemd user
  service). First install changes what runs at login — operator's call, never
  an agent's (H-874). Reinstall to activate a committed, tested fix is the
  crew's call, not a question for the operator (Arthur, 2026-09-07, H-1046).
  On launchd, reinstall writes the new plist, boots out any loaded supervisor,
  then bootstraps it again; the command names that running work is
  interrupted rather than leaving the old job silently loaded. The everyday
  path for activating a fix is `rev redeploy`, not a reinstall: it needs no
  bootout, so it cannot race the 60s ceiling.
- **Never `rev stop` from a loop session to activate a fix** (H-1046). Two
  things bite at once: the drain blocks on the caller's own driver, which is
  deferring SIGTERM until the session returns, so it cannot finish while the
  caller is still working; and when it finally does, it exits 0 — the one exit
  launchd and systemd deliberately leave down. The fleet stops with nothing to
  bring it back. `rev redeploy` exists so that neither happens.
- **A loop session reaches the harness only through `$REV_CLI`** (H-646).
  `sessionEnvOverrides` sets it to this supervisor's own CLI, and the session
  inherits this supervisor's `REV_HOME`. A `rev` on PATH may be a different
  installation's alias that carries its own `REV_HOME`. A caller's prefix
  cannot override that, and both fleets answer `status`, so nothing looks
  wrong. The iteration prompt therefore names only `node $REV_CLI redeploy`.
  Offering bare `rev` first, with `$REV_CLI` as the fallback, sent agents on
  a two-installation machine to the other fleet.
- **A redeploy that never comes back must not be silent** (H-1046). The fleet
  is the thing that would have noticed, so the exiting supervisor arms a
  detached `redeploy-watch` first: past `redeploy_deadline_seconds` it alarms
  out of band and files a priority-0 ticket to the human. It always files a
  FRESH ticket — the requesting one may be closed, and returning a live one
  would release a claim its holder is still working.
- The supervisor never overrides a halt sentinel: STOP/HOLD/BLOCKED keep a
  loop down until an operator (or Helm answer) clears them; clearance is
  picked up within one poll.
- **The iteration prompt loads the tools before the work** (H-448). An agent
  picks its tool set from a guess about the session ahead, and "I might need to
  file a ticket" is what you discover halfway through: 13% of loop sessions
  since 2026-08-20 started without `create_ticket` — every loop, not one. One
  of them found no tool for the job and reasoned its way into writing Helmo's
  SQLite file by hand, wedging the whole fleet for forty minutes. The prompt now
  names the tools to load up front and says plainly that a missing tool is never
  grounds to go around Helmo.
- **Never assert on the iteration prompt through rev's stdout** (H-2496). The
  console prints `res.outputTail.slice(-2000)` — a bounded tail, by design, on
  top of the shim's own 4000-char cap. The prompt is one long line, so as it
  grows its head falls out of that window, and an assertion reading stdout
  fails for a reason that has nothing to do with the prompt. The `not.toContain`
  direction is worse: it passes because the text was truncated away, not
  because the prompt lacks it — a mutation putting "what done means" at the
  head of the prompt left the old steering test green. Mocks in
  `test/loop.e2e.test.ts` write `$REV_PROMPT` to `$REV_HOME/prompt.txt`
  (`CAPTURE_PROMPT`) and assertions read `promptOf(e)`.
- **Production means work advanced, not bytes written** (H-412). The
  produced-check calls helm-cli `actor-activity --advancing`, so a note-only
  update does not count. It matters because `ladderDecide` returns `continue`
  on production and `continue` skips the wake gate entirely: an agent that
  honestly recorded "nothing actionable" was certifying itself busy and buying
  another full iteration. The filter is the floor, not the whole fix (H-740):
  an update carrying an `evidence` diff IS advancing, so a scoped seat's honest
  "still blocked, base still green" pass cleared it and bought the next
  iteration anyway — observed on mason 2026-09-03, iterations 14 and 15 both
  `produced=true action=continue` at ~$1.30 each against a queue blocked on
  Arthur. Narrowing the filter would be wrong (the commit proving a build green
  is exactly what a ticket should carry when work HAS advanced), so the fix is
  the instruction: teach every seat the contract the ladder scores it against.
  Known gap, latent rather than observed: a scoped loop's wake still fires on
  `ready_count > 0` alone, so a ready ticket the agent keeps declining re-wakes
  it each poll. That belongs to the wake gate.
- **A long-lived Rev process keeps the Helmo path it read at startup**
  (H-3530). `g.helmo_cli` comes from the roster once, at `loadRoster()`, and
  nothing refreshes it — which is why the start-time `releasePinProblems` check
  is where a stranded path is refused: the supervisor is the one process a
  release change restarts. Inside an activation window the opposite holds, the
  selection having moved while the supervisor and its loops have not, so every
  Helmo call those processes make is refused by the coherence check, correctly.
  `releaseSetMoved` in `helm.ts` reads that one refusal out of the CLI's error
  ("running from A, not B" — never the selection-or-manifest disagreements that
  share its prefix and mean a broken installation), and the two call sites that
  meet it in that window name it rather than their own failure. The
  produced-check logs `release-set-moved`, counts the iteration as no
  production and goes on; it used to die there with a Node stack trace naming
  the outgoing release, which is indistinguishable in a log from a fleet
  genuinely executing stale code — 1,020 to 1,437 of them per loop console log
  on 2026-10-25, and one mason iteration spent re-establishing that they were
  benign. The supervisor's two poll-time Helmo calls — the blocked-loop resume
  check and its completion — log it in place of their own `*-failed` line and
  say once on the console that this process can no longer read Helmo at all,
  which is the larger true statement that `answer-resume-check-failed` on one
  unlucky loop was hiding. `consumeRuntimeRecovery` beside them is deliberately
  not wrapped: it reads local files only and can never meet this refusal.
- **The usage poller never touches the token except in one header** (H-278/
  H-280). Read from the keychain per poll and discarded when the call returns;
  never held for the process lifetime, never written to disk, never in argv —
  which is why it uses `fetch` and not `curl`, since process args are readable
  via `ps`. `usage.json` holds PARSED values only: agents read that file into
  prompts, so no raw upstream text may pass through, and an error line carries
  our own words plus a status code, never a response body.
- **A cap that resets beyond the horizon is a decision, not a retry** (H-402).
  `limitDecide` reads the usage snapshot on any transient condition: if a bar
  is at/over `limit_exhausted_percent` the wait runs to its actual `resets_at`,
  and if that is further out than `limit_block_horizon_seconds` the loop blocks
  immediately with the cap NAMED. Unidentifiable conditions keep the old
  twenty-attempt ladder. The shim no longer reduces a 429 to `API 429` — the
  response body is what distinguishes an exhausted quota from a rate limit, and
  discarding it is what made 2026-08-26 opaque for 34-42 hours.
- **WEDGED is not a halt.** `halted()` deliberately does not include it: the
  fault is outside the loop and may clear, so it keeps polling. It sorts above
  RUNNING/IDLE in the status label because a wedged loop looks busy from the
  outside while drawing no work at all.
- **An empty-handed iteration is a probe and runs on the probe model** (H-412;
  crew `skills/model-selection.md`). A loop with `probe_model` in the roster
  runs an iteration on it when the wake-check shows nothing ready AND nothing
  in_progress in the loop's own hands (`held_count`, from helmo) — that session
  can only read the queue and stop, and running it at the working tier is pure
  waste. Decided fresh each iteration (`probeDecide`), never sticky; the
  actor identity, token-log, and spend note all carry the model actually used.
  An unknown `held_count` (older helmo) never probes — real work misrouted to
  the small tier is the worse mistake — and store-wide loops never probe:
  their motion-only wakes ARE the triage work. A `[global] probe =
  "provider:tier"` pin (H-625; live as `codex:small`, Arthur 2026-08-31)
  routes every probe to that provider while its cap stands — the whole
  RunChoice swaps, so runtime, prices, config, toolset wording, and the
  transient path all follow the pinned provider. The pin yields to the
  loop's own `probe_tier` when the pinned cap is out, and never touches a
  mock loop (tests stay hermetic).
- **Balance allowance before exhaustion, within the same tier** (H-892).
  Per-loop `routing = "headroom"` opts in; `rotation` lists at least two
  same-tier choices in preference order. `headroomRate` takes the minimum of
  `(limit_exhausted_percent - used_percent) / hours_until_reset` across the
  model's applicable bars; a weekly bar is required. The highest rate wins,
  with ties staying on the first configured provider. It is a routing
  heuristic, not a promise to consume exactly 95%: concurrent sessions and
  delayed telemetry cannot reserve future consumption. Never translate
  notional API dollars into subscription percentage or generate work to fill
  a quota. Fallback tiers remain cap-out only; original `rotation` remains
  the default for unopted loops. Missing, failed, older-than-30-minute or
  expired telemetry uses configured order. Fable's scoped cap only affects
  matching models, including in the transient path. `routing.ts` composes
  the same selector for loops and `rev routing`; each headroom decision logs
  its rates or why it used the configured order. Roster/model changes need a
  graceful worker restart; in-flight sessions keep their original model.
- **Claude API billing is an explicit provider, independent of Max.** Keep
  the normal `claude` subscription provider and add a second named provider:

  ```toml
  [providers.claude-api]
  runtime = "claude"
  billing = "metered"
  [providers.claude-api.models]
  mid = "sonnet"
  [providers.claude-api.config]
  api_key_helper = "/path/to/credential-helper"
  max_budget_usd = 5
  max_turns = 20
  timeout_seconds = 900
  # Optional durable allocation admission (requires stop_at):
  # allocation_file = "/canonical/private/allocation/allocation.json"
  # Optional absolute end of an authorized window:
  # stop_at = "2026-10-14T23:47:00Z"
  ```

  Select `provider = "claude-api"` and `tier = "mid"` on a loop, or use
  `claude-api:mid` in its existing rotation/fallback list. The helper is a
  trusted operator command executed in the loop's cwd with a clean environment;
  it must print only the key and exit zero within five seconds. Use a credential
  store, never a literal key in the roster or command. Rev checks it before
  launch, and Claude Code calls the same helper for authentication. Lookup
  failure stops before launch; there is no subscription fallback. Rev does not
  write the key to disk or put it in process arguments or environment. Secrets
  printed back by the CLI are redacted from Rev's retained output, but this is
  not a substitute for keeping secrets out of tool output and CLI transcripts.

  This is the normal Claude Code `-p` agent: constitution, skills, hooks, tools,
  strict MCP and actor/generation binding remain. Explicit command settings
  select the helper, clear competing credential/cloud-provider settings and
  select Anthropic's API endpoint. Managed policies retain higher priority;
  operators must ensure their policy permits this provider. Rev never logs out
  or edits a subscription login. `session-spec` rejects API providers because
  external consumers cannot yet enforce this launch contract.

  `max_budget_usd` is Claude Code's **estimated session spend limit**, not a
  provider invoice cap; a request can overshoot it. `max_turns` bounds agent
  turns, not every background HTTP request. Rev terminates the session process
  group at the earlier of `timeout_seconds` and `stop_at`, escalating TERM to
  KILL after one second. Interrupted usage is unknown, recorded as `?`, and
  needs reconciliation before another allocation. A deadline-killed session
  did start, so it is a retryable `failure` that keeps its claim, not an
  apparatus halt; with an `allocation_file` it still fails closed, because its
  reservation is held. Provider-side spend limits,
  aggregate budgets and credential expiry remain the operator's responsibility.
  Optional `allocation_file` enforces a frozen, durable per-consumer allocation
  immediately before dispatch, across restarts. Unknown usage keeps its reservation
  and refuses further admission. [API-ALLOCATION.md](API-ALLOCATION.md) describes
  provisioning, strict receipts, checkpoints and same-allocation reconciliation.
  API choices ignore subscription bars and headroom; this does not assert that
  an API account has credit. API 429/529 responses retain their own transient
  handling without consulting Max's reset time. Existing metered declarations
  without `api_key_helper` keep their historical authentication behavior.

  References: [Claude authentication](https://code.claude.com/docs/en/authentication),
  [CLI session limits](https://code.claude.com/docs/en/cli-reference),
  [settings precedence](https://code.claude.com/docs/en/settings).
- **A provider choice is decided fresh each iteration, never sticky** (H-479).
  `choiceDecide` takes the rotation cycle at the iteration's position, skips
  any provider whose cap the fresh snapshot says is out (then fallbacks), and
  when everything is out returns the scheduled choice so the transient ladder
  — not the selector — decides what stopping looks like. On an IDENTIFIED cap
  with another provider standing, the transient path switches instead of
  waiting or blocking; an unidentified transient (529, outage) keeps the
  ladder, so a network wobble never becomes a migration. The probe pass runs
  on the provider actually chosen. The actor identity, token-log, run-start
  event, and spend note all carry the provider/model actually used.
- **The burn breaker is a ceiling, not a pacer** (H-412, H-2779). It checks only
  `continue` iterations — every other ladder action is already stopping — and
  trips to BLOCKED with a structured peer investigation. A productive loop's
  arbitrary iteration count is a signal to assess, never a permission request
  sent to Arthur. Defaults (`burn_usd_per_hour` 30, `burn_usd_per_day`
  75, `continue_cap` 15, per-loop overridable) sit above every figure in the
  token-log's history: a trip means new territory, never a busy afternoon.
  Spend is amortised uniformly across each session's recorded duration, so a
  ninety-minute iteration cannot land ninety minutes of cost inside one hour
  merely because that is when it ended (H-3129). It
  deliberately does NOT catch a small spin — ward's five iterations against a
  one-ticket wake cost $5.70 — because that is a question of what counts as
  production, not of spend.
- **A ceiling in dollars only bounds work that is billed in dollars** (H-185).
  `[providers.<name>] billing` says what an account IS — `metered`
  (pay-per-token) or `subscription` (flat plan). It defaults to `metered`
  everywhere, including the builtin claude and codex entries, so an estate that
  declares nothing keeps every gate above exactly as it is. Where an estate
  declares a flat plan, the token-log's dollars for it are notional — codex's
  come from roster prices × tokens and claude's from the CLI's API-equivalent
  estimate — and notional dollars must never stop productive work; the plan
  bars are what bounds it. The burn caps stay in the roster as the recorded
  ceilings they are, and a pay-per-token provider gets them back by saying so.
  The anomaly thresholds beside it (`anomaly_rate_multiple` 6,
  `anomaly_min_usd` 1.00, `anomaly_abs_percent` 10) are calibrated against 597
  rolling windows of a real token-log, not chosen: see the comments in
  `capacity.ts` for why the rate axis is cost rather than tokens (the two
  largest token ratios in that record cost *less* than their own means — they
  are cache reads) and why the multiple needs an absolute floor beneath it
  (6× a $0.12 mean is 72 cents, which is not a runaway).
- Escalations must land as Helmo tickets, never only in logs; a BLOCKED loop
  that couldn't escalate prints loudly and relies on the dashboard. One live
  summons per loop (H-401): a block checks for a standing non-terminal
  escalation before filing (best-effort — a duplicate beats silence). And
  `rev resume` resets the fail/limit streaks: a resume is a statement the
  cause was looked at, so the loop gets its full retry budget back rather
  than one retry that re-blocks in seconds and files a duplicate.
- **A loop session commits as its seat** (H-787, Arthur's ruling). `sessionEnv`
  puts `GIT_COMMITTER_NAME=<loop>` / `GIT_COMMITTER_EMAIL=<loop>@crew.local`
  into every spawned session's environment, so `git log --committer=mason`
  answers "what did that seat commit" in any repo without depending on an
  agent having read an instruction. Author is left to the machine's git config
  — Arthur stays responsible for the work, and blame keeps naming him — and
  the harness's own `Co-Authored-By: Claude <model>` trailer is deliberately
  left alone: it is the vendors' standard channel for tool provenance and it
  is true. Use `sessionEnv(l)`, not `cleanEnv()`, at any new spawn site.
- Liveness is identity, never a bare pid. A RUNNING marker records the command
  that owns it (`runningStamp()` — use it anywhere RUNNING is written), and
  `pidAlive` requires the live process to still be running that command. Pids
  are recycled across a reboot: a stale marker whose number had been reused by
  an unrelated process made the supervisor abort as "already running" through
  57 launchd retries, with the whole fleet down and unable to converge (H-154).
- **A sitting owns its ticket, not the seat** (H-558). Before
  spending an iteration the loop asks Helmo who holds in_progress work in its
  name (`seat-check`). A FRESH hold its own seat's workers did not claim is
  another live session sharing the crew name — an attended sitting or a
  subagent — and working over it is how H-542 and H-560 were both trampled.
  H-558 stood the whole loop down for it; that idled every worker of a role
  for as long as an operator sat with one of them, so the loop now works
  on and leaves exactly those tickets alone. Helmo is the fence: a claim
  without an execution generation belongs to the session stamped on the event
  that claimed it (an attended claim carries none), and another session of the
  same name may only note it — any other write is refused `session_claim_held`
  until the claim is over 24h stale and taken over explicitly. Pool workers
  were already fenced by their execution claim and launch binding, and draw
  only ready (open) tickets. Rev keeps those tickets out of the seat's held
  work for wakes and the probe tier (`withoutHolds`), names them in a
  self-drawing worker's prompt, and records them as SEAT_SHARED. Loop sessions
  stamp `session: "rev:<loop>"` into their Helmo actor (`loopActor`), which is
  how the seat's own mid-flight work is recognized across iterations. Stale
  holds (past `seat_stale_seconds`, default 24h — Helmo's own takeover
  convention) and unattributable claims are not named. Best-effort — a
  seat-check failure logs and proceeds, and Helmo's fence still holds.
- Wake is MOTION for store-wide loops and READINESS for scoped ones (H-426
  and H-92, rewritten by H-1072). A scoped loop wakes when Helmo's wake-check
  reports `newly_ready_count > 0` — currently-ready tickets carrying a
  readiness-causing event after the idle cursor — and no longer on
  `changed_since`, which fired on any event in scope and therefore on pure
  noise. That noise is what made the idle floor necessary, and the floor is
  what cost real work: ward idled 02:57Z, H-1053 was handed back to it 03:20Z,
  and it woke 03:58Z on the timer. Three rules sit alongside the edge. The
  restart pickup stands (first successful poll after process start counts
  standing ready work, so a seat that went down with work queued does not wait
  for unrelated motion, H-995). An hourly resync wakes a seat that has been
  idle an hour with ready work in reach — a backstop for a readiness edge Rev
  never saw, never a debounce: the immediate path does not consult it, so it
  cannot delay a handoff. And an absent `newly_ready_count` falls back to the
  old rule, so a Rev running against an older Helmo degrades to the previous
  behaviour instead of wedging a seat.
  THE OLD OBJECTION, and why it no longer holds: readiness was rejected here
  because ready_count is a standing property, so a ticket a seat silently
  declined would re-wake it every poll, forever. Two things changed. H-1071
  makes every pass-over a recorded disposition, which takes the ticket out of
  ready; and "newly ready SINCE THE CURSOR" means an untouched ticket cannot
  wake a seat a second time even where H-1071 is not yet perfectly obeyed.
  Neither half would be enough on its own.
  A store-wide loop keeps `changed_since` exactly as it was — fresh filings
  are bosun's work — and its wake-check must additionally carry NO scope at
  all, assignee included. Helm ORs the scope clauses, so any one of them
  narrows the whole store back down to tickets already assigned and silences
  the fresh-filing signal these loops exist for. Cost us bosun's entire wake
  path until H-138.

## Neighbors

Helmo is the work record and must be built separately; runtime rosters point at
its `dist/cli.js` and `dist/server.js`. Integration tests run the source checkout
named by `REV_TEST_HELMO` through dedicated CLI and server shims, so an immutable
Rev candidate needs neither shared build — every reference through
`test/helmo.ts`, never a written-out `../../helmo` path, which resolves only
where the two checkouts are adjacent. With the variable unset, `test/helmo.ts`
asks `@helmo/core/checkout` for the work record: the package of this workspace
whose package.json declares the name `helmo`, and failing that a `helmo`
repository cloned beside this checkout. That is one rule for both worlds, and it
is why this suite no longer needs `REV_TEST_HELMO` inside the workspace —
`../../helmo` named `packages/helmo` here, which has never existed (H-2638). That
prerequisite is declared to the release gate as `publish.cold.requires_env` in
package.json, so its scratch clone is given the variable instead of failing at
collection; see crew's PUBLISHING.md, "Works cold" (H-1400). Loop
identities and constitutions live outside this repository and are referenced by
the instance roster. Meetings (`~/projects/meetings`, R-31) is a consumer, not a
dependency: it shells out to `session-spec` to run a seat's session under a
human's typing instead of the queue, so a change to what a loop session carries
changes what a meeting carries too — which is the point. In a larger estate, its
own project map owns the remaining cross-project context.

**The import boundary is now enforced, because the workspace stopped enforcing
it** (R-47 C1, H-2639). In two repositories you could not import a repository
you had not installed. In the unified candidate `packages/work` is a package
named `helmo`, so `import { Store } from 'helmo'` inside the runtime resolves
through the workspace link and links the supervisor to the work record's source
at build time: one store schema, one upgrade, one blast radius. `prebuild` runs
`scripts/check-import-boundary.mjs` over the shipped surface (`src`, `bin`,
`scripts`), exits 1 naming file, line and specifier, and `tsc` never starts;
the root workspace build fails with it. `test` is outside that surface on
purpose — `test/helmo.ts` opens the store directly to assert what a loop
actually wrote, which observes the other side rather than coupling this one.
`test/import-boundary.test.ts` asserts the same scan over the live tree, plus
the shapes it must catch (bare name, scoped rename, relative path by either
spelling, dynamic import, require, re-export) and the ones it must leave alone
(a commented-out import, the word in prose, `helmo-roadmap`, `@helmo/core`).
Watched refusing: a deliberate `import { Store } from 'helmo'` at the head of
`src/helm.ts` failed the build for exactly that reason before being reverted.

The scan **lexes regex literals** before it reads strings (H-2647). It has to:
`const re = /it's/;` holds an apostrophe that is not a quote, and read as one
it opens a string running to the next real quote in the file — the opening
quote of an import below it — so that import is never seen. A `/` in operand
position opens a literal; after an operand it divides; where the two readings
disagree division wins, because a regex cannot span a line, so a misreading
costs the rest of one line and never the rest of the file. No shipped file
today has a quote inside a regex, and the lexers old and new extract the
identical 185 specifiers from all 37 of them — the case is proven by
`test/import-boundary.test.ts` and by the probe above re-run with the regex in
front of it, which the old scan passed and the new one refuses. What it still
cannot see is a specifier assembled at runtime, and the inside of a template
literal's `${...}`.

# Recover a ticket stranded by a repeated owner checkpoint

Before H-1646 an owner repeating `status: in_progress` retired its own
generation and dropped its claim while the ticket stayed in_progress, so no
later launch could resume it. `inspect-missing-claim|reconcile-missing-claim
--worker NAME --record FILE --installation NAME` recovers exactly that strand.
The first record names `ticket_id`, `session` and the old `generation`;
inspection prints Work's comparison record, which is saved and supplied to
reconciliation. Neither changes worker controls.

Runtime refuses unless the worker is a registered journaled pool worker, live
and idle with no halt or recovery control, the original driver pid is gone,
the launch journal holds that exact completed claimed launch with a clean
historical run-end, every dispatched session group is absent and no launch is
unsettled. Two evidence snapshots surround Work's read-only check, and the
original receipt scope must still match the worker's roster scope. Work then
reopens the ticket atomically (see Work DEV.md); it creates no claim and never
revives the old generation. Verify through the worker's next normal launch.

# Recover one diagnosed runtime failure

`recover-runtime <exact worker> --record <JSON file> --installation <name>`
queues one request for the owning supervisor. The immutable record contains
`installation`, `worker`, `ticket`, the exact plain runtime-trip `reason` and
`at`, SHA256 of the complete BLOCKED bytes as `sha256`, and `expires_at` no
more than fifteen minutes ahead. It does not claim or complete a work ticket.
Diagnose and verify current startup through issued provider access first.

The supervisor consumes the request once with no child, rechecks the trip and
refuses a live/unknown worker, structured block, STOP, HOLD, PACE, pending PACE
writer or LIMIT. Release clears only the matching BLOCKED and fail streak.
All supported BLOCKED writers share an exclusive per-worker `.blocked-lock`;
contention or an interrupted lock fails closed and needs operator diagnosis,
never automatic stale-lock removal. This is the existing local filesystem
trust boundary, not protection from hostile direct file edits or old binaries.
Deploy a coherent accepted runtime before using the command.

`RUNTIME_RECOVERY.last.json`, retained per-request decision files, and
`events.log` record release/refusal. A consumed manifest cannot be replayed;
a new failure needs diagnosis and a fresh manifest. A crash during consumption
can leave a consumed request with the old block still present; inspect the
decision and controls before any new request. No hold or provider policy is
changed, and no worker health or useful-work verdict is invented. Verify new
worker PID/startup and actual admitted useful work separately. `stop <worker>
--worker --installation <name>` contains the recovered worker; there is no
one-step undo restoring the old incident state.

# Prime team control

`gp-rev team stop|resume <loop|all>` is the Good Plumb leadership surface. It
is admitted only for `REV_LOOP=prime`; its STOP records carry Prime provenance,
and resume clears only those records while preserving every HOLD and BLOCKED
marker. Test it only against disposable `REV_HOME` state until the GP release
hold is independently cleared.

## Reconcile a cleanly ended, stopped worker's claim

`reconcile-ended-claim --worker <exact worker> --record <JSON file>
--installation <name>` releases only an unchanged ordinary claim into a
mandatory deliberate hold. It never resumes a worker or changes controls.
The record names raw `ticket_id`, exact `session` and `generation`,
`expected_updated_at` and `expected_event_seq` from Work's ticket/history,
`hold` (reason, provenance, reconsider_when, no release) and `body_patch`
(old unique continuation anchor, new paused instruction).

Runtime requires STOP, a dead worker marker and original driver PID, the exact
completed claimed journal, an absent recorded detached session group, the
last run-start matching the iteration, exactly one clean run-end followed by
STOP exit, and two identical evidence snapshots. Missing, unknown, live or
replaced evidence refuses. Work independently compares and retires the claim
under its write lock, so a concurrent claim replacement or ticket event wins
and repair refuses, or the hold wins and prevents further selection. No store
is read directly by Runtime. OS/control files and local actor assertions remain
the existing trust boundary, not authentication against hostile local users.
After the operation, read the ticket through Work and the fleet status through
this installation's Runtime. Generation retirement is append-only: there is
no one-step undo restoring an old execution identity. Software selection can
roll back, but the ticket hold remains until separately authorized release.
