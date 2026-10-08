# Changelog

Helmo is one product with one version number; what that number promises is in
[VERSIONING.md](VERSIONING.md). `0.6.0` is the first consolidated version, and
the notes below it are the three products' own published notes under their own
numbering, carried over unchanged under the area each belonged to.

Work's section is the text published as `helmo` **v0.5.0**, taken from the
`helmo/v0.5.0` tag. The release was cut on its own branch, so the main line the
consolidation imported still carried that release's notes under "Unreleased";
this is the published wording, which is two entries and one commit reference
longer.

## Unreleased — 0.9.5

- The acceptance gate can now be asked by commit. Until now it answered one
  question — is this ticket's work accepted? — so anything holding a commit
  rather than a ticket id had to guess which tickets to ask. Crew's publication
  gate, the thing that keeps a commit still awaiting its verdict from riding out
  under someone else's push, guessed from three places: every live ticket, every
  ticket the outgoing commit messages name, and one step out along the dependency
  graph. Around forty-five reads on every push, and still blind to the case it
  was written for — a closed ticket holding an outstanding verdict that none of
  those commits name. `helmo-cli acceptance-holds --repo <name>` and
  `helmo_acceptance_holds` answer it directly now: every completion still pending
  or failed on those commits, the ticket holding each one, and a nonzero exit a
  release script can read the way it reads `acceptance-check`. Ticket status
  plays no part, which is the whole point of it. An empty answer means nothing
  on the record is holding those commits — never that they were reviewed.

- The same gate can now be asked who has CLEARED a commit, not only what is
  still holding it. The hold read answers with completions still pending or
  failed, so an accepted review and a commit nobody ever offered come back
  identically empty — and a publication gate reading that silence as "nothing
  is holding this" left four commits publishable to a public remote by any
  push for seven minutes, from one reviewer's PASS resolving the only
  completion naming them until the second review was first filed. The pass is
  what opened the gate, and nothing rode out through it.
  `helmo-cli acceptance-coverage --refs '[...]'` and
  `helmo_acceptance_coverage` state the facts instead: per commit, the tickets
  whose current offer names it, that offer's state, each reviewer's own
  standing verdict, the tickets that named it only in a superseded offer, and
  an empty list when nobody has offered it at all. It never judges whether the
  review was enough — how many reviews a destination requires is the caller's
  policy, and the record deliberately does not answer it.

- Team now says what each member is configured to carry into a session, and what
  its sessions have spent. A row gives the seat, a composition bar over its
  configured context and the period's tokens and notional dollars; opening one
  gives every configured file with its size and its own cap, a bounded reading of
  any of them, and the usage broken down by model and by day. Three things it
  deliberately will not do: count a seat's memory corpus as startup context, when
  it is read a file at a time and runs to hundreds of files; show a whole-session
  cap, because none is configured and a model's context window is not one; or let
  the dollar figures read as money, because they are an API-rate equivalent on a
  flat plan and the roster's own notional prices. What nobody can measure — the
  CLI's own system prompt, the tool schemas, the iteration prompt — is named
  rather than left to read as zero. A new roster key, `memory_dir`, is how a seat
  names its corpus; a seat without one says so rather than reporting an empty
  one.

- A file Team cannot safely read is now named rather than read. The inventory
  reaches files no roster entry names — whatever `CLAUDE.md` or `AGENTS.md` sits
  in a seat's working tree — so the reading had to stop trusting them. A fifo
  with one of those names used to hold every page of the app, not just Team,
  until the process was killed; a symbolic link used to put whatever it pointed
  at on the page. Both are now reported as what they are. So is a file too large
  to read, and a file whose text is shaped so that counting its tokens would
  stall the page for everyone — the tokenizer's cost turns out to follow how its
  own splitting cuts a file up, not how big the file is, so a size limit alone
  would not have been one, and the guard asks the tokenizer for that splitting
  rather than estimating it. In each case the page says the file
  is there and why it has no count, which is the one thing it must not get wrong:
  an unreadable file is never a zero folded into a total. And a member named
  after one of JavaScript's built-in property names is no longer a member.

- Team now reads one file once, however many members carry it. The shared
  instruction file at the top of this installation's agent tree is on every
  seat's list, and the page was counting it again for each of them — ten times a
  request, for the same ten thousand characters. It is counted once now. The
  whole page also has a ceiling on how much counting one request may do, not
  just a ceiling per file: the page is a tenth of it today, but a member's
  working tree is a place other things write, and enough awkward files across
  enough members used to be able to hold the page — and the rest of the
  dashboard with it — for fifteen seconds at a time. Past that ceiling a file is
  named, with its size and the reason, the same way an unreadable one is.

- Red now outranks amber. The four status colours all came out the same weight:
  their fills measured 1.10, 1.12, 1.12 and 1.14 against a white page, a three
  percent spread, so a failed review carried no more weight than something merely
  waiting for you and the word was the only thing telling them apart. Failure's
  fill now stands off the page further than any other role's — in both themes,
  at the same hue, still dusty rather than alarming — and the ink on it is the
  darkest of the four. The other three roles are untouched. A blocked loop stays
  amber, which was questioned and is now settled: the states that take no colour
  are the deliberate ones, and a blocked loop has downed tools and will not
  restart on its own.

- A row's title gets the column, and a view's groups line up. The reference and
  its copy control came first in the record column and took the width before
  the title had any: in a 640 pixel window the title of a record was left about
  100 of 256 pixels, wrapped to four lines, and stood its collapsed row 123
  pixels tall. The title now leads and claims the column, with the reference
  beside it where there is room for both and under it where there is not; the
  columns after it declare what the record actually asks them to carry instead
  of a round number, which gives the title the difference. On the live record
  that is a third to two fifths off a row in the groups being watched — 243
  pixels to 151 in a 640 window, 223 to 151 — and the same again on Roadmap.

  And each group sized its own table from its own content, so equivalent columns
  started in different places in different groups of one view and there was no
  straight edge to scan down. The columns are laid out fixed now, so every group
  of a view agrees, and nothing may be wider than the column holding it. That
  also makes the fold measurable on a fixture: where it falls had been a
  property of which records happened to be in a group, which is how the live
  Blocked group's state was still cut in half at 390 while the verification
  passed.

- A phone reads a row's state again. Work and Roadmap are wider than a 390
  pixel window and scroll sideways by design, but the first column's floor put
  the fold through the State badge, so every table in both areas showed a
  state cut in half — "In moti" — with the priority, owner and last movement
  off the edge behind it. The floor is now the widest one that keeps a row's
  work and its state on screen together, and the browser verification measures
  where that fold falls at 390 instead of trusting the page's own overflow,
  which is zero whether the state is whole or halved.

- `release status` no longer calls a restarted fleet a down one. The service
  manager restarts the supervisor on its own, and the replacement comes back on
  the same release under a new pid; nothing reconciled the activation receipt
  when it did, so status read the old pid as dead and printed the one piece of
  advice that would have made things worse — roll back, then activate, off a
  release that was running correctly. A supervisor starting outside an
  activation now re-attests its own evidence, and only when the code it loaded
  is the selected release's own; where no supervisor has, status asks the live
  marker and says which pid restarted and what build it loaded. Recovery
  instructions are printed where something needs recovering, not under a
  healthy deployment.

- Give state a colour, in four meanings and no more. Work in motion and a
  project with the go-ahead read slate blue; a release review that accepted the
  work and a shipped project that settled read sage green; anything that needs
  you — a request, a blocked loop, a usage warning, a stale handoff, a closed
  ticket with nothing to show — reads ochre amber; a refused review, a wedged
  or crashed loop, a page that cannot be read at all reads dusty red. They are
  deliberately desaturated: the interface stays quiet so that the few things
  carrying a colour are the ones worth looking at. Ordinary queued work and
  anything deliberately held — a capacity hold, a dependency wait, a date gate,
  a parked project, a stopped loop, and the long tail of done tickets — stay
  exactly the chrome they were, because a backlog that looks like an incident
  is the same as no signal at all. Every colour sits beside words that say the
  same thing, so nothing depends on seeing it.

- Read Work and Roadmap as compact tables instead of walls of cards. Every
  group is a standard Data Table whose rows say what the work is, what state
  it is in, who owns the next step, when it last moved, and anything that
  should reach you before you open it. Expanding a row gives the record's own
  opening — a verbatim excerpt, bounded, never a generated summary — and the
  way into the complete record, which opens in a panel beside the table: the
  full description, what stands in front of the work, the last recorded
  progress, what it produced, its dependencies and its history, with the
  recorded token and usage figures at the foot where an estimate belongs. A
  sentence-length reason, like why something is on hold, is in that record
  rather than in the row. Several of these tables now fit in a window that
  used to hold three cards. Decisions, actions and sittings keep their own
  cards above the tables, with their controls and their complete text
  unchanged, and a bookmarked reference to one still reaches that card
  directly.

- Show the result a ticket actually produced, whatever it is. A closed row used
  to decide what the work produced from how the ref was *spelled* — every URL
  was the result, every commit and file was review evidence — which described
  2,153 closed tickets on the personal estate and 525 on Good Plumb as having
  produced nothing, when what they produced was a commit or a file. An evidence
  item now records its purpose (`role`: `result`, `supporting` or `review`,
  independent of `kind`), and the row reads that: a commit or a file is as
  prominent as a URL, several results are shown as several results with the
  latest carrying the action, a supporting link no longer competes with the
  result, and a result this device cannot reach stays the result — shown as not
  reachable from here, with its ref copyable — instead of vanishing. Nothing is
  back-filled: an item written before the field keeps exactly its old rendering
  and says the purpose was never recorded.

- Give every Helmo page one navigation: a shadcn/ui sidebar that hides
  completely — no icon rail, no reserved gutter — behind a trigger sharing one
  compact header row with the view's title and a new upper-right control that
  opens the current page, filters and all, in a window of its own. The
  horizontal strip each page used to draw for itself is gone. Work, Roadmap,
  Runtime and the app page render exactly as before inside it; the shell
  adopts their markup rather than replacing it, so every control, disclosure
  and refresh they already had goes on working. Only the chrome is migrated:
  what is inside each product is still its own hand-written HTML.
- Wrap the Runtime view's build and usage lines, so an unstamped build printing
  its own directory can no longer lay the page out wider than a phone's
  viewport.
- Recover scoped-seat trace attribution after a loop driver dies by holding
  replacement work until its orphaned session exits, then finishing the dead
  launch's measured ticket window from its durable pre-launch cursor.
- Return a ticket to its seat's queue when an answer resolves a question on a
  ticket that also carried a sitting marker: the answer is the operator
  interaction that marker asked for, so it no longer stays withheld from every
  agent until someone clears the marker by hand. A sitting marked after the
  answer, and a current release handoff's own sitting, are left in place.
- Say in the return-to-human tool itself that a tool refusing a resource proves
  only that tool's scope, so supported contribution and maintenance routes are
  finished before the concrete remainder reaches a person.
- Refuse a return to the human when the identical ask was already answered by
  a human on a connected ticket — a parent, source or related dep, or one cited
  by id in the ask — and hand that answer back instead. Every field is compared
  byte for byte, with no case, Unicode or whitespace folding, so a changed
  condition, a new resource, extra words or a partial overlap all still reach
  the human. Relayed answers and qualified cross-installation references count
  for nothing.
- Add `rev reload <loop|role> [--worker]`, which respawns one worker on the
  current roster after its in-flight iteration, with no fleet drain. It never
  clears STOP/HOLD/BLOCKED: a halt present when the loop exits keeps it down.
- Route pool work by a per-ticket `lane`: a worker configured with `lane = "x"`
  claims only tickets carrying that lane on its next poll, with no roster edit
  or restart, and a lane no live worker serves holds its work visibly
  (`unserved_lanes`) instead of falling to the general worker. Work exposes the
  field on create/update/list and `launch-claim --lane`; existing stores gain
  the column by migration and resume their held claims unchanged.
- Wake a lane worker when an open ticket is moved into its lane. A lane change
  was not a readiness edge, so the worker slept until its periodic resync; it
  now wakes on the next poll, and moving a ticket back to the general pool
  wakes the general worker instead.

## v0.9.4 — 2026-10-05

- Keep session traces available for large real ticket histories by transporting
  only the Work identity, ownership, blockers and launch-link metadata they
  consume, with a bounded content-safe refusal instead of silent truncation.
- Bind every supervised Runtime iteration to a durable content-off launch
  record, including the provider session identifier when the provider emits
  one, timing, outcome, measured usage and cost. The same launch identifier is
  carried by Work events so later diagnostics can join without time or seat
  heuristics; missing provider identity remains explicitly unsupported.
- Preserve the requesting actor through an autonomous fleet redeploy so its
  landing note reaches the ticket that asked for the restart, and keep ordinary
  scoped-seat claims usable across traced iterations while retaining generation
  fencing for preclaimed pool work.

## v0.9.3 — 2026-10-05

- Keep Runtime operating through transient usage-service failures by retaining
  the last good reading until it ages out, honoring the configured Claude
  allowance, isolating tests from the live usage endpoint, and waiting for a
  host-load safety stop to finish instead of abandoning its recovery.
- Preserve active Work claims when records are rebuilt, keep scoped wakeups
  attached to the active workflow, and close admission and invalidation gaps
  so a finishing workflow cannot admit or retain unauthorized follow-up work.
- Compatible reliability correction: no store migration, MCP argument change,
  CLI command or flag change, installation binding change, service change,
  port change or configuration change. Consumers adopt this tag through their
  existing installation and release workflow; publication does not upgrade an
  installation.

## v0.9.2 — 2026-10-03

- Route repeated passes with no progress to team coordination. Claiming and
  releasing the same work no longer counts as progress, and unchanged work
  already routed for coordination does not keep waking the same seat. A
  meaningful ticket or dependency change makes that work eligible again.
- Retry a failed coordination write before recording the no-progress threshold
  or suppressing the ticket, so a transient failure cannot strand work without
  a coordination record.
- Include dependency links in Work's CLI ticket output, matching the MCP
  projection used to detect changed work. Clarify that human returns are for
  decisions only the human can supply; team-owned method and routing problems
  belong with the team.
- Compatible correction: no store migration, MCP argument change, CLI command
  or flag change, installation binding change, service change, port change or
  configuration change. Consumers adopt this tag through their existing
  installation and release workflow; publication does not upgrade an
  installation.

## v0.9.1 — 2026-10-03

- Restore the established Work, Roadmap and Runtime views inside the unified
  app, including decision/action controls, evidence, history, prioritization
  and live refresh. Keep common navigation and the consolidated backend.
  `/` preserves Work bookmarks; the summary is available at `/overview`.
  Mobile navigation keeps all five links visible, and Runtime names its
  horizontally scrollable columns.
- Keep the versioned Overview API record projection compatible while the
  summary page links to the full Work view. No store migration, installation
  binding change, service change or configuration change is required.

## v0.9.0 — 2026-10-03

- **Agent sessions are bound to one installation deed.** `HELMO_BINDING` plus
  `HELMO_REQUIRE_BINDING=1` carries one name, both stores, the selected release
  and Runtime control identity through the front command, compatibility
  aliases, MCP, app/view, service launcher, loop sessions and subprocesses.
  Missing, stale or foreign targets refuse before records or controls are
  touched; unbound single-install operator use remains compatible.
  Release upgrade and rollback maintain that deed's selected release, including
  repairing it when an interrupted upgrade is repeated. The public install docs
  state the same-user threat boundary and that pre-v0.9 clients are deed-blind.
- Runtime's Work link now follows the unified application's `/work` route and
  remains valid from the standalone compatibility view.

## v0.8.0 — 2026-10-03

- Route burn, capacity and anomaly safety stops to independent live-peer investigations, with restart-safe structured recovery, one restart per fresh peer disposition, and peer-owned recurrence instead of routine human permission prompts.

- **One five-area application.** `helmo serve` provides Overview, Work,
  Roadmap, Team, and Runtime from one listener, with versioned JSON APIs and
  configurable redirects for retired dashboard ports. Team exposes configured
  roster metadata and operator-owned profile links, never profile contents.
- **One installation key.** `HELMO_INSTALLATION` is the canonical identity for
  Work, Roadmap, and Runtime. Existing `HELMO_LABEL`, `ROADMAP_LABEL`, and
  `REV_LABEL` settings remain accepted during the documented two-release
  window, and conflicting values still refuse instead of choosing a target.

## v0.7.0 — 2026-10-02

- **One command: `helmo`.** Every area is reachable through one front command —
  `helmo work`, `helmo roadmap`, `helmo run`, `helmo team`, `helmo release`,
  `helmo service`, `helmo serve <area>` and `helmo mcp <area>`. It does no work
  of its own: it hands your command line to the entry point that always did
  that work, so output, exit codes and refusals are that entry point's own.
- **The old binary names still work, and say they are leaving.** `helmo-cli`,
  `helmo-mcp`, `roadmap-mcp` and `helmo-view` each print one line on stderr
  naming their replacement and the date they stop, with stdout untouched —
  `helmo-cli` still prints exactly one JSON object. `rev` is a permanent alias
  for `helmo run` and prints nothing. The dates are in the new
  [COMPATIBILITY.md](COMPATIBILITY.md), which also covers repointing an
  existing checkout's `node_modules/.bin` links.
- No port, launchd label, record identifier, MCP tool name or argument key
  moves, and neither store is migrated. Nothing a configuration file, a plist,
  a bookmark or a loaded tool schema names changes.

## v0.6.1 — 2026-10-02

- The stable Rev service launcher now reads the selected release manifest and
  starts Runtime from either the consolidated one-component layout or the
  historical three-component layout. A consolidated upgrade can therefore
  restart through the launcher instead of entering a launchd refusal loop.

## v0.6.0 — 2026-10-02

The three products become one: one repository, one version, one set of
documents, and one module for the mechanics all three were implementing
separately. No entry point, port, service label, MCP tool or record identifier
moves, and neither store is migrated.

- **One repository, four workspace packages** (H-2630). `helmo`,
  `helmo-roadmap` and `rev` are imported object-preserving into one tree as
  `packages/work`, `packages/roadmap` and `packages/runtime`, beside a new
  `packages/core`. Every commit, tag and recorded `repo@sha` from the three
  histories still resolves.

- **Installation identity, install and qualified references come from one
  module** (H-2636). `@helmo/core` replaces three near-copies whose precedence
  lists differed by one entry — the measured cause of an identity incident.
  Precedence selects the key when one is set; two accepted keys carrying
  distinct values refuse at startup rather than guessing.

- **An installation answers to a declared set of names** (H-2630). One function
  serves both `--installation` and the `<id>@<installation>` reference
  qualifier, and it accepts the resolved label, the `dev.helmo…` /
  `dev.roadmap…` a conventional home derives standing alone, and the home or
  store path. `VERSIONING.md` declares the set and its two-release window.
  45 references recorded in this estate are in the older spelling and resolve
  again; a qualifier naming a genuinely different installation still refuses
  before any store is opened.

- **One product version with a declared compatibility surface** (H-2630).
  Every package and every shipped protocol surface reports `0.6.0`, and
  `VERSIONING.md` names what a major, minor and patch change mean: MCP tool
  names and argument schemas, CLI subcommands and flags, the store schemas,
  configuration and environment keys, service labels and default ports.
  Everything else is internal.

- **A release selection names one component** (H-2630). `rev release upgrade`
  writes one `helmo` component and validates Work, Roadmap and Runtime
  artifacts under it against the same clean commit. The historical
  three-component layout stays readable, so an installation can still inspect
  and roll back across the consolidation boundary; a partial, extended or mixed
  manifest refuses rather than being guessed.

- **The runtime cannot import the work record's store** (H-2639). The monorepo
  makes that import available for the first time, so the boundary is asserted
  in the build rather than left to a reviewer's memory.

- **A root build refuses to write into a checkout an installation resolves
  through** (H-2630). `npm run build` writes only in a directory carrying the
  candidate marker, and never reads installation selections to assemble a
  denylist.

- **One of each product document** (H-2630). One `LICENSE`, `SECURITY.md`,
  `THIRD_PARTY_NOTICES.md`, `CHANGELOG.md`, `AGENTS.md` and `README.md` at the
  root, with `INSTALLATIONS.md`, `ENTRY-POINTS.md` and `ISOLATION-CHECKS.md` —
  written for Rev but true of the family — now the product's. Each area keeps
  its own `README.md` and `DEV.md`. One issue tracker serves all three.

- **One agent-led install** (H-2630). The three `AGENT-INSTALL.md` guides become
  one at the root: one clone, one `npm ci && npm run prepare:cold && npm run
  build && npm test`, then the areas the operator asked for turned on in order.
  The three guides each named their own clone URL and their own build, which no
  longer describes how this product is obtained; `scripts/build.test.mjs` now
  holds the install guide to the same one-at-the-root invariant as the licence.

## Work — published as `helmo`

### v0.5.0 — 2026-09-30

One Helmo installation is now distinguishable from another: in what it is
called, which store is its own, and which build is serving it. Alongside that,
what an agent can ask a human for splits into three kinds, so a request to go
and do something can no longer come back as permission to act.

#### Breaking changes

- `needs_human` takes the one line the sitting needs, not `true` (H-1761).
  Marking a ticket for a sitting now says what the human does and roughly what
  it costs them; that line is stored as `sitting`, returned on the ticket and in
  compact rows, and rendered on the dashboard as a card with a question's
  weight. `false` still clears the marker; a bare `true` is refused with the
  shape to send instead. `helmo update --needs-human` now takes a value, and
  `--no-needs-human` clears.

#### Running more than one installation

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

#### Three kinds of request

- Recurring templates no longer appear as assigned work (H-440). They remain
  visible through template-specific reads, but an assignee query now returns
  only concrete tickets an agent can actually work.

- Workflow decisions are admitted through a trusted, scoped record (H-430).
  The writer identity comes from the Helmo runtime rather than caller input,
  and each decision is bound to one requirement and one subject manifest;
  revocation names the exact decision it replaces.

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

#### Records and accounting

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

#### Operator and harness surfaces

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

#### Reliability and tests

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

#### Not covered by this release

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

#### Commit coverage

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
- `3f9c61c`, `f8b5a1b`, `792f51a`

The three merge commits carry no changes of their own: `f73727a` brought in
`09929fa`, `5e449a8` brought in `6ca2373`, and `1211665` brought in `4f86ba4`.

### v0.4.0 — 2026-09-15

#### Breaking changes

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

#### Work routing and accounting

- Hygiene can read the third accounting category (H-1166): `acct:direction`,
  `acct:security`, and `acct:estate` are a closed set of labels alongside a
  project tag and an `obj:OBJ-n` label. Work justified that way was previously
  permanent, unclearable noise in every `unaccounted_work` sweep.
- Cleared work routes to its stream's seat instead of stranding in the pool
  (H-1096).
- Tickets awaiting second eyes are surfaced as their own set (H-1069).
- Recurring templates are excluded from spend anomalies (H-1124): standing work
  has no spend of its own to be anomalous about.

#### Harness surfaces

- `wake-check` exposes ready edges (H-1098): `ready_ids` alongside
  `ready_count`, so a harness can see which work moved, not just how much.
- A newly-ready cursor query (H-1097): `newly_ready_count` and `newly_ready_ids`
  since a sequence number, for an identified caller.

#### Operator surfaces

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

#### Reliability and tests

- Composed-Helmo contract coverage is restored (H-1086).
- View tests isolate their ports (H-1093), and demo seeding is single-process
  with correct session stamping (H-1272, H-1099).

#### Commit coverage

Every commit after v0.3.0 and before this release record is represented above.
This manifest makes that claim auditable without relying on ticket-title
conventions:

- `0150eb1`, `d98c933`, `ce83990`, `04f4a61`, `50ce79e`, `6f4bf98`,
  `cfc3fe0`, `2ed7213`, `a146e07`, `11200c9`
- `8179481`, `94d3249`, `a504902`, `7558025`, `4b68368`, `1d0a55c`,
  `eeea123`, `c67e903`, `8ca8a73`, `f6e063c`
- `7c16ac5`, `a8f1722`

### v0.3.0 — 2026-09-06

#### Work routing and stewardship

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

#### Product and operator surfaces

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

#### Reliability and record integrity

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

#### Commit coverage

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

### v0.2.0 — 2026-08-06

- H-90: the dashboard learns to answer — the one write a human may make
- H-81: hygiene findings on closed tickets get a disposition surface
- H-71: reject mangled tool-call writes at the door
- H-61: silent_assignee — the seventh hygiene check, for reservations nobody will wake
- H-11 follow-up: npm run demo — the README screenshot's board, reproducible

## Roadmap — published as `helmo-roadmap`

This is Helmo Roadmap's first published set of release notes. It is scoped to
the independent-installations release and does not reconstruct what came before
it; earlier history is in the git log.

### v0.1.0 — 2026-09-30

The roadmap can be installed more than once under one account. Each installation
has a name that both entry points resolve and print, a store it alone writes, a
build identity read off the code actually loaded, and record references that say
which installation minted them and refuse one carried from another.

#### An installation has a name, and both entry points say which

- One resolver for both entry points (H-2472). `server.ts` and `view.ts` each
  read `ROADMAP_DB` on their own, so the only thing that said which roadmap you
  were talking to was a database path, and nothing printed it back.
  `ROADMAP_HOME` names the installation and `ROADMAP_DB` names its store; either
  alone determines the other, so every existing caller keeps working untouched,
  and no variables at all still means `~/.helmo-roadmap/roadmap.db`. Both set and
  disagreeing is refused before the store is opened, naming both candidates. The
  name is shared rather than invented here: `ROADMAP_LABEL`, then `HELMO_LABEL`,
  then the supervisor's `REV_LABEL`, then derived from the roadmap's own home —
  so one installation has one name, whichever of the three products you ask.

- Both entry points assert the installation they serve (H-2474). Each prints one
  installation line at startup — the MCP server on stderr, because stdout is the
  protocol channel — and `--installation <name|home|db>` on argv ASSERTS that
  target rather than choosing it. Neither surface has a flag parser of its own,
  so the assertion is read off argv directly and the check sits inside the
  resolver, where neither can resolve a target and forget to verify it. A value
  disagreeing with the environment refuses before the store is opened;
  `ROADMAP_HOME`/`ROADMAP_DB` remain the only things that move the target. The
  proof that the refusal comes first is a store file that does not appear.

- An installation can be pinned to an immutable multi-product release set
  (H-2454). Set `INSTALLATION_RELEASE` to the selection's `ADOPTED.json`;
  resolution then verifies the selected Rev/Helmo/Roadmap commit set and refuses
  code from another checkout.

- A store belongs to the installation that first wrote it under a name (H-2488).
  An explicitly named installation claims `installation_name` in the store's
  `meta` table, atomically with its first event; a later write from a process
  resolving a different name is refused, with nothing written. Reads stay
  available and report the disagreement as UNCLEAR beside both names. This is
  what catches a name INHERITED from elsewhere, which no flag can catch, because
  nothing was typed wrong. A derived-only installation claims no name, leaving
  existing single-store use exactly as it was.

#### References that say whose they are

- A cross-installation reference has one spelling, and the product accepts it
  back (H-2506). The roadmap advertised a qualified form of its own —
  `<label>:R-1`, a second idiom for the thing Helmo spells `R-1@<label>` — and
  advertised it only: handed back to the very installation that minted it, it
  answered "Project not found". So an agent that quoted the reference the
  product gave it was told the record did not exist, and fell back to the bare
  `R-1`, which resolves in whichever installation it happens to be talking to.
  The spelling is now Helmo's, and the inbound half is the load-bearing one:
  every `project_id`, `objective_id`, dep endpoint and charter item id is
  resolved through the reference rules before it reaches the store, so a
  reference carried from another installation refuses having read and written
  nothing, rather than landing on an unrelated record of the same name. A bare
  id keeps working: within one installation it is unambiguous. Every MCP result
  collects the ids it returned into `references`, pairing each with its
  qualified form.

#### What is running

- Every process answers for the code it loaded (H-2492). One reading is taken at
  startup and compared afresh on every report: a rebuild beneath a live process
  is `stale`, a source run or unreadable code is `unverifiable`, and the commit
  named is always the loaded one. `postbuild` writes the stamp beside the
  artifact. Every MCP result carries the installation and the build state.

- The dashboard footer says which installation it is and which build is drawing
  it. It said only the store path, which answers neither question; the startup
  line already said both, and nobody reading a dashboard has the startup line.
  It is read per render, so a view that stays up across a rebuild reports
  `stale` rather than the artifact's newer commit.

#### Documentation

- The README says how to pin an installation to a release set (H-2454), and
  points a multi-installation reader at `ENTRY-POINTS.md` in the Rev repo — the
  checklist of every path to review when you add an installation or change which
  release one runs (H-2517). `ISOLATION-CHECKS.md` in the same repo is the
  reviewer's version, with the commands to re-derive each isolation property
  against your own two installations.

#### Not covered by this release

- A derived-only installation — no `ROADMAP_LABEL`, no `HELMO_LABEL`, no
  `REV_LABEL` — claims no durable name, so nothing at the store level
  distinguishes it from another derived installation pointed at the same store.
  That is deliberate, so single-install use is untouched, but it means the
  store-level guard protects named installations only. If you run two, name them.

- The store claims its name from the first explicitly named writer, so a store
  with history from before this release carries no name until some named process
  writes to it — and whichever named process writes first claims it, whatever it
  is called. On an existing pair, write once from each installation under its
  intended name and check the claim landed before relying on the guard.

- What a process reports as running is a reading of the code it loaded, not a
  guarantee about which commit produced it: a dirty-tree build is reported as
  what it is.

- A release change is taken at the next start. Restarting the MCP server or the
  view is still a deliberate act.

- The roadmap has no browser in its toolchain. Its shared presentation controls
  assert their shape here and lean on Helmo's repo for the rendered behaviour.

#### Commit coverage

Every commit in this release is represented above. This manifest makes that
claim auditable without relying on ticket-title conventions:

- `b20a070`, `487a7f4`, `931e474`, `739dd29`, `c201e42`, `92e62cd`,
  `91ba2d4`, `9af13c4`, `f04d504`, `f68d3cf`, `a5a508d`

## Runtime — published as `rev`

These notes start at v0.1.0, the independent-installations release. They do
not reconstruct what came before it; earlier history is in the git log.

### v0.2.0 — 2026-10-01

A loop no longer spends a session the work record would refuse, and the pinned
service path from v0.1.0 is safe to use: a pinned supervisor is recognised as
running, and installing the service over an in-flight one waits rather than
races.

- Before a loop spends a session, Rev asks Helmo whether the seat may launch
  at all, so a ticket bound to a workflow attempt is started only once its
  requirements have passed and the admission is recorded in the same
  transaction as the check. A refusal costs no session, is reported in the
  loop's log, and is asked again after a restart rather than bypassed by one.
  An explicit refusal holds a launch back. If admission is unavailable or
  corrupt, workflow-bound work also fails closed while ordinary tickets keep
  their prior launch behaviour (H-2561, H-472).
- Pinned services now report their launcher-backed supervisor as live while
  retaining exact command identity for loop drivers; status no longer mistakes
  the real supervisor for a stale marker and risks starting a duplicate
  (H-2560).
- On macOS, service installation waits for the previous launchd job to release
  its label before bootstrapping the replacement. If bootstrap fails, it
  restores the previous definition and running job (H-2560).
- Removal never pairs a Helmo home whose own name is already a conventional
  roadmap home: the bounds for `.rev-roadmap-b` no longer claim
  `.helmo-roadmap-b`, which belongs to the roadmap `-b` installation (H-2553).

### v0.1.0 — 2026-09-30

Two Rev installations can now run under one login without reaching into each
other: each has a name, a service identity bound to its own home, a store it
alone writes, and commands that say which one they are about and refuse to act
on the other. A pinned installation also gains the two verbs it was missing —
changing which release it runs, and going back.

#### An installation has an identity

- An installation's service identity is its resolved home, not a basename
  (H-2452). The launchd label is also the plist filename and the
  bootout/kickstart address, so it is the one name two installations under a
  single account cannot share — and it used to be derived from the home's
  basename, which left `/tmp/customer-a/.rev` and `/tmp/customer-b/.rev` both
  answering to the same label. Redirecting `HOME` does not separate them:
  launchd's namespace belongs to the uid. The label is now bound to the resolved
  home path. A direct child of the ACCOUNT's home named `.rev` or
  `.rev-<suffix>` keeps the label it was bootstrapped under, so existing
  installs are untouched; anywhere else the label carries a readable part plus
  eight hex characters of the path's digest. The account's home is read from the
  password database rather than `$HOME`, because `$HOME` is something the plist
  this code writes can set.

- A service restarted with a daemon's bare environment resolves the identity it
  was installed under (H-2452). The plist and the systemd unit now export
  `REV_LABEL`, so a job the service manager brings back does not re-derive a
  different name.

- `install`, `uninstall` and `start` read the definition on disk and refuse when
  its `REV_HOME` belongs to another installation, naming both homes and the way
  out (H-2452). This is the case an explicit or INHERITED `REV_LABEL` can still
  create — a shell carrying one installation's label aimed at another's home —
  which no amount of care at the keyboard prevents, because nothing was typed
  wrong. A definition with no `REV_HOME` reads as unowned, so an older install
  stays upgradeable, and installing retires a definition left at this home's
  previous label.

- Every command says which installation it is about, and `--installation` makes
  that an assertion (H-2473, H-2526). The target used to come from whatever
  `REV_HOME`/`REV_LABEL` happened to be in the ambient environment, and nothing
  printed it back. Reads (`status`, `usage`, `routing`, `service status`, the
  bare-usage footer) now name their target, and so does each mutation's
  confirmation, because that is where an operator looks to see what they just
  did. `--installation <name|home>` ASSERTS that target and cannot redirect it:
  a disagreement with the environment refuses, exit 1, naming both candidates.
  `REV_HOME` moves the target; the flag says you meant it. The check runs once
  before the command switch, so a read surface added later cannot forget it, and
  `--installation=<value>` is recognised as well as the space-separated
  spelling. The flag is therefore usable as a guard at the top of a script,
  including on a read. `tail` and `session-spec` are exempt: their stdout is a
  machine value a caller substitutes.

#### What is running, and what built it

- A build records which commit it came from (H-2442). `dist` is gitignored and
  `rev redeploy` restarts without building, so the supervisor has always loaded
  an artifact with no provenance: on one occasion `dist/cli.js` was built the
  evening after the supervisor running it started, meaning the fleet was
  executing code that no longer existed on disk. The stamp travels beside the
  artifact rather than in a central log directory, because a file keyed by repo
  basename cannot describe two installations of one repo. A dirty tree is
  recorded, not refused — refusing would only produce builds with no record at
  all.

- The surfaces say what the fleet is RUNNING, separately from what is on disk
  (H-2489). Every surface that could be asked "what is the fleet running" would
  have read the build stamp, which on one day would have named a commit built at
  06:40 to describe a process that started at 18:01 the evening before:
  precise, healthy-looking, wrong. `build:` is the artifact; `running:` is what
  the live process recorded when it loaded, and it never falls back to the
  artifact's commit — on divergence that commit appears only as the thing nobody
  is executing. `STALE` and `UNVERIFIABLE` are answers. What is compared is a
  digest of the JavaScript in the directory, not the commit, because a dirty
  tree's commit did not produce the artifact and two rebuilds of one commit
  differ. `status`, `service status`, `/health.json` and the dashboard print
  both, and `health.json` gains the installation it was never naming.

#### Choosing and changing a release

- An installation can be pinned to an immutable multi-product release set
  (H-2454). `INSTALLATION_RELEASE` points at the selection's `ADOPTED.json`;
  every entry point then verifies the selected Rev/Helmo/Roadmap commit set and
  refuses code from another checkout.

- `rev release status | upgrade <dir> | rollback` (H-2493). A pin was previously
  moved only by a text editor: an upgrade was an unwitnessed edit, a half-written
  selection bricked every command in the installation, and going back meant
  finding and reinstalling old code. Now the whole set is verified before the
  pointer moves — each product's `dist` holds JavaScript and its `BUILD.json`
  names exactly the commit `RELEASE.json` does, built clean — and every fault is
  reported at once rather than one per attempt. `MIGRATION.json` is required in
  the release directory and is copied into the selection, so a one-way migration
  refuses a rollback in its own words even after the release directory is gone.
  The replacement is a same-directory temp file, fsync, rename, directory fsync,
  and it retains the whole previous selection inside it, so a rollback is one
  write rather than a reinstall.

- A pinned service starts through the installation's own launcher (H-2511). A
  service definition is written once and nothing rewrites it, so the path it
  names is frozen at install time — and it used to be the `cli.js` of whatever
  release was selected when the service was installed. After an upgrade, the job
  the service manager brought back exec'd the release the installation had just
  left, was stopped by the coherence check as an uncaught throw, and under
  KeepAlive was brought back to fail again. A pinned installation's definition
  now names `<REV_HOME>/service/launch.mjs`, which lives outside every release.
  It reads the selection at START, sets `argv[1]` to the resolved `cli.js` and
  imports it in this process, so signals, the exit timeout and the supervised
  pid all still reach the service manager, and everything downstream is what it
  would have been had the manager named that file directly. A release change is
  therefore picked up by a restart, with no reinstall.

- `rev release` and `rev install` are exempt from the pin check (H-2493,
  H-2522). They are the two ways out of a broken selection and cannot sit behind
  the fault. The exemption is in the module-level list as well as in each
  command's own argument: it was in the argument alone, so `rev install remove`
  threw inside the gate and never reached the declaration that it was exempt,
  leaving a hand `rm -rf` as the only route out.

#### Removing one installation's data

- `rev install remove [--confirm]` (H-2512). Every other removal Rev has keeps
  the records: `rev service uninstall` takes the definition and leaves the
  store, the controls and the selection byte-for-byte, which is right, and which
  left an operator with a hand `rm -rf` as the only way to delete an
  installation — in a shell that may be carrying the other installation's
  `REV_HOME`, with no product refusal in the way. This is a separate verb rather
  than a flag on `service uninstall`, because the difference between keeping and
  deleting every record must not be a word someone can miss. The plan prints
  first and `--confirm` is a second act. The boundary is the directories the
  installation owns, named: its Rev home and, for a home named the conventional
  way, the Helmo family's homes beside it carrying the same suffix (`~/.rev-b`
  with `~/.helmo-b`). A store in none of them is reported as left in place rather
  than followed, whether or not anything has opened it yet. Naming them beats
  trusting the directory they sit in, which under that layout is the whole
  account home — so a roster copied from `~/.rev` to bootstrap `~/.rev-b` no
  longer brings the first installation's store inside the second's boundary
  (H-2544). A home named outside the convention keeps the enclosing directory,
  which holds as far as that directory is one installation's. A standing service
  definition or a live supervisor refuses, each naming the command that clears
  it, and a `REV_HOME` containing the account's own home directory is refused
  outright. Release directories are never touched.

#### Documentation

- `INSTALLATIONS.md` — the consumer's guide to running more than one
  installation: what to set, what each refusal means, which versions form a set,
  and the backup a one-way migration makes your only way back (H-2515, H-2516).
- `ENTRY-POINTS.md` — every path to repoint when you add an installation or
  change which release one runs, and the surface that tells you it took. It
  covers the Helmo family standing without Rev as well (H-2517).
- `ISOLATION-CHECKS.md` — the reviewer's checklist: seven isolation properties,
  the commands to re-derive each against your own two installations, what to
  observe, what our own run observed, and what is not proved.

#### Reliability and tests

- The prompt tests assert what the loop compiles, not what fits in the console
  (H-2496). Nine tests read prompt text through the loop's bounded stdout tail.
  The iteration prompt is one long line and has grown past that window, so the
  `toContain` assertions were one clause away from red — and the `not.toContain`
  ones were already a false green: a mutation putting a phrase at the head of the
  prompt left the test passing, because the text was truncated away rather than
  absent. The mocks now write the compiled prompt to a file and the assertions
  read it from there.

#### Not covered by this release

- The service-definition guard is Rev's answer to an inherited label, and it
  needs a definition to read. The Helmo family installs no service, so its
  answer is a different mechanism — a durable name claimed in the store — and it
  is subject to that mechanism's own limits, which Helmo's notes state.

- What a process reports as RUNNING is a digest of the JavaScript it loaded, not
  a commit. It can tell you the code changed under a live process; it cannot
  tell you which commit a dirty-tree build came from.

- A release change is taken at the next start. Nothing in this release moves a
  running supervisor or a running loop onto new code; restarting is still a
  deliberate act.

- `rev install remove` deletes one installation's data. It is not a general
  uninstaller: it leaves release directories alone, and it will not follow a
  store that sits outside the installation home.

#### Commit coverage

Every commit in this release is represented above. This manifest makes that
claim auditable without relying on ticket-title conventions:

- `02ac9d6`, `5cbb31c`, `1d2dfdf`, `2d7bb6c`, `30ba160`, `60c8c8b`,
  `ec33ba9`, `6be02c6`, `a36af04`, `9d00b5e`
- `57e0b0b`, `4e3d6a8`, `a9ed409`, `12fb533`, `9055f6e`, `4a712d3`,
  `a14a59b`, `817dc23`, `bb7b4a9`
