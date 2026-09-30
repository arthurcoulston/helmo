# DEV — coding context for helmo-roadmap

**Stage: MVP** (recorded in the R-11/R-5 completion pass, H-916). Publication
readiness is a separate obligation: the privacy/history, disclosure and cold
setup gates apply before release even while this remains MVP. No 1.0 or Scale
promotion is implied. `README.md` names the current floor and prerequisites.

The layer above the ticket: Helmo records work being done, this records work
worth doing — parked, shaped, ranked, declared go. Product intent and the
full design: `PRODUCT.md`; the charter template ships with the product
(`CHARTER-TEMPLATE.md`). Built as a sibling of Helmo in Helmo's idiom:
append-only event log, materialized state, `.immediate()` write transactions
(same H-134 trap), the H-71 markup gate, actor provenance on every write.

## Architecture (src/)

- `store.ts` — SQLite store (better-sqlite3): projects, deps, claims,
  citations, objectives, bets, all materialized from an append-only event
  log (`rebuild()` is the invariant, tests enforce it — every side effect
  of a write lives in an apply* function, or replay silently diverges).
  Derived rank: facts set the tier (ship_next · ready · shaping · blocked ·
  parked), judgments order within it (best cited objective rank, latest
  value claim, effort), every rank carries a one-line explanation; shipped
  and archived projects are off the ranked list. Rules the store enforces,
  not just the docs: judgments never land without a reason; 'ready' means
  enough is known for an informed commitment and needs an agent other than
  the last description shaper (the human is never gated; retitling is not
  shaping); ship_next
  — the work phase, ladder v2 (H-672) — only via `setShipNext` with
  `decided_by`, several may hold it and the returned count is the
  resistance signal; the shipped statuses (shipped_watching,
  shipped_stable) are reachable only from ship_next, so nothing ships
  without the human's go; archived is the one terminal status and is
  permanent; actuals are absolute rollups recorded from Helmo's meter,
  never deltas. Pre-v2 events ('shipping'/'shipped'/'abandoned' statuses,
  ship_next 'demoted' payloads) still replay correctly — never strip that
  handling.
  `updateProject` takes an optional `if_revision` and compares it inside its
  own write transaction; `projectSnapshot` is the read that token comes from,
  and is one transaction for the same reason — see below.
  `recordReadinessVerdict` is the independent path from shaping to ready. Its
  append-only verdict set is anchored to the latest non-verdict project event,
  so several reviewers can judge identical state without staling one another;
  any other write starts a new round. Each reviewer's latest verdict is their
  own correction, any FAIL governs, and PASS+FAIL is surfaced as contested.
- `tools.ts` — the 11-tool MCP surface, descriptions are
  guidance-as-deployed (Helmo's rule). v1 postures baked into them:
  ship_next is FYI to the fleet, not tasking; the charter is derived from
  the human's document, never authored here.
- `server.ts` — MCP stdio entry. Store at `~/.helmo-roadmap/roadmap.db`
  (`ROADMAP_DB` overrides); identity from `ROADMAP_ACTOR`, falling back to
  `HELMO_ACTOR` so estates provisioned for Helmo need no second variable.
- `view.ts` — read-only dashboard at :4410 (`ROADMAP_VIEW_PORT`). Ship-next
  expanded on top, charter strip, everything else collapsed in derived rank
  order. No write routes at all — unlike Helmo's view there is no answer
  surface; add none.
- `types.ts` — the vocabulary. Gates and stances are named in PRODUCT.md
  but deliberately absent from v1 behavior; leave the room, don't fill it.

## Commands

- `npm run build` (tsc → dist/), `npm test` (store suite against temp dbs).
- `npm run vendor:tokens` / `npm run vendor:avatars` refresh the vendored
  estate design tokens and crew avatar sprite; add `-- --check` to fail on
  drift instead. See below.
- View: `node dist/view.js`; restart after rebuilding.
- `AGENT-INSTALL.md` is the agent-led install path a stranger's agent follows
  (H-1386). It states the two estate drift tests as expected skips — if that
  pair ever changes, it changes there too, or an installer reads a skip we no
  longer ship as a failure.

## Phone width (R-11 H-1176)

Everything this page renders is store text, and project bodies carry absolute
paths, commit refs and URLs — tokens with no space to break at. One of them in
a phone-width column laid out 433px wide in a 276px box and dragged the whole
document to 505px in a 390px viewport. So `:root { overflow-wrap: anywhere; }`
sits at the top of the stylesheet, declared once rather than on each prose
selector, so the next surface that renders a body does not have to learn this.
Anything that must stay on one line says `white-space: nowrap`, which still
wins.

`npm run smoke` in the **estate** repo is what caught it, and it is the better
check — it drives this page live at 390px and 1280px in both themes, so run it
after touching this file's HTML or CSS. But it can only see the defect while
some project body happens to be carrying a long path, which is why
`test/view-wrapping.test.ts` asserts the rule against the source as well.

## Copying a reference (R-42 I12, H-2428)

Arthur carries roadmap items into agent conversations by their id, so every
visible `R-`/`OBJ-`/bet id has a copy control beside it. One renderer draws
them all — `ref(id, cls)` in `view.ts`, where `cls` keeps the existing `pid`
(project) and `oid` (objective or bet) distinction — and there is no second
way to draw one. `test/view-copy-reference.test.ts` holds that by asserting no
renderer builds one by hand.

This is Helmo's control, spelled the same way on purpose; `helmo/DEV.md`
("Copying a reference") explains why `e.preventDefault()` and the
`document.execCommand` fallback are load-bearing rather than defensive. Helmo
proves the behaviour end to end in a real browser with a real clipboard. This
repo has no browser in its toolchain and is not worth buying one for, so it
asserts the shape and leans on that proof. If you change the control here,
change it there and run `npm run viewport` in helmo.

One consequence worth knowing: this page replaces `document.body` every 15
seconds, and that was harmless while nothing on it could hold focus. A copy
button can, so the refresh now skips while `document.activeElement` is not the
body — the same guard Helmo already had. Anything focusable added here depends
on it.

## The estate design tokens (R-11 H-714)

`src/estate-tokens.generated.ts` is a **vendored copy** of the estate shell's
`tokens/estate-tokens.css` — the source of the visual system every estate
surface shares. `scripts/vendor-estate-tokens.mjs` refreshes it (also
`--check`); `test/estate-tokens.test.ts` fails on drift.

Vendoring, not importing, is the point: the roadmap is published standalone, so
a clone with no estate checkout beside it must build and run unchanged. That is
also why the drift test uses `it.skipIf` rather than an early return — with no
source to compare against it reports **skipped**, which is visible in the run
summary, where a `console.log` from a passing test is not.

**What was adopted, and what was not.** `view.ts` keeps every one of its own
token names and not one of its rules changed in meaning; the aliases at the top
of `CSS` are the whole seam, so a look ratified upstream restyles this page
without it being touched. Adopted: surfaces (`--page`, `--surface`), the ink
ladder, `--hairline`, and the radius ramp (`--radius-card` / `-inner` are the
estate's `--radius` × 1 / 0.8). The middle ink is mixed from the estate's two,
since shadcn has no third step.

Status colours and the interactive `--link` blue were held back at first —
shadcn's neutral base ships no status ramp. The estate grew both of its own in
H-771, so they alias like everything else now and the dark overrides for them
are gone: the estate's ramp is themed. `--serious` moved in that swap, from
`#ec835a` (2.64:1 on white — a chart mark in the reference palette, and this
page renders it as an alarm note and a badge) to the estate's deepened light
step. Its own `--accent` is still a hover *surface*, not an interactive colour,
and the one place that `--accent` does
belong is `.prow summary:hover`, which is exactly a hover surface — and it has
to be that rather than `--surface`, because `--card` and `--background` are the
same white in the light palette, so a `--surface` hover would be no hover at
all.

Two collisions had to be resolved, because the vendored file lands on `:root`
ahead of the roadmap's own block: `--muted` and `--accent` exist in both with
*different meanings* (surface vs text; hover surface vs link). The roadmap's
are now `--ink-3` and `--link`. Its `--border` folded into `--hairline` — the
estate has one border token and the two resolved to it.

**One trap, learned the hard way here.** An alias that comes out
self-referential (`--hairline: var(--hairline)`) is *guaranteed-invalid* in
CSS: the property ends up with no value, every rule using it is dropped, and
nothing goes red — the page just quietly loses all its borders. It shipped that
way for one render and only a pixel sample caught it. `test/estate-tokens.test.ts`
now asserts no seam alias resolves to itself, in this repo and in Helmo.

## The estate crew avatars (R-11 H-714)

`src/estate-avatars.generated.ts` is the estate's `avatars/crew-avatars.svg`,
vendored on the same seam and for the same reason as the tokens: a copy, not an
import, because the roadmap is published standalone. The sprite is inlined into
the page body — cross-document `<use>` is not what this page does — and drawn
with `<use href="#crew-<mark>-<kind>">`. No colour travels with it: a mark is
`currentColor` over `var(--crew-<name>)`, which the token copy already defines,
so the two vendored files interlock and neither carries a value the other owns.

**Everything here fails silently.** A `<use>` at a missing symbol draws nothing
— no console error, no failed request, 200 on the page — so the checks in
`test/estate-avatars.test.ts` are all aimed at that one shape. The vendor script
derives its index by reading the sprite rather than declaring one, refuses a
sprite with no composed symbols, and refuses a ragged one (every mark must exist
at every kind, because the view names `crew-${mark}-${kind}` from a record it
did not choose). Recognise a composed symbol by its *body* — it `<use>`s a
`#crew-frame-*` — because `crew-frame-agent` matches the id shape exactly and is
not a mark.

**Kind is read, never asserted.** `Store.actorKinds()` answers with the kind
each name last wrote under, store-wide, one query per render; an event passes
the kind it recorded itself, which is better. A name the roadmap has never seen
write renders as bare text — a new agent is not a defect.

The one place a kind is passed rather than looked up is the ship-next decider,
and that is still read from the record: `setShipNext` refuses a write with no
`decided_by` and calls it "the human who made the call", so the schema is the
source. Without it the most consequential attribution on the page would render
bare, because Arthur never writes here himself — an orchestrator relays his call.

**A mark never stands without its name** (H-713 measured that ten members cannot
have ten mutually distinguishable hues, so a hue accelerates retrieval and never
identifies). That is structural: exactly one function draws a mark and it takes
the name it prints, the test asserts `view.ts` holds a single `#crew-`
reference beside `esc(name)`, and `.actor { white-space: nowrap }` keeps the two
on the same line.

## The update precondition

Every rule `updateProject` enforces is a rule about STATE — archived takes no
writes, only ship_next ships, the description's shaper cannot judge it ready —
and each is decided against a `getProject` that finishes *before* the write
begins. A project has more than one writer (an interactive session's and a
bash-loop agent's, at least), so two of them interleave and the second one's
rules were checked against a project that no longer exists. The case that
matters: one seat declares `ready` while another rewrites the body, and the
readiness judgment ends up standing on text nobody reviewed.

So `roadmap_update_project` takes an optional `if_revision`, and
`roadmap_get_project` answers with the `revision` to pass back. A revision is
the seq of the last event recorded against the project — not a new fact, the
event log always held it, but a caller must not have to read a precondition off
the tail of a history array. It covers every write, not just updates: a claim, a
citation, a link or a rollup moves it too, which is deliberately conservative,
because a decision can depend on any of them.

Two things about it are load-bearing:

- **It is compared inside `db.transaction(...)`, and nowhere else.** Checked
  before the transaction it is checked at the moment it cannot hold. Once the
  comparison is under the write lock, a revision that matches means the read
  outside it is provably current — which is what makes every rule above it
  sound, not just this one field.
- **It is optional, and omitting it keeps last-write-wins.** Existing callers
  are unchanged; a write that turns on nothing you read needs no precondition.

This is the only conditional write the store has, and a caller outside it cannot
substitute for it. A proxy or client that reads, decides, and then writes has
exactly the same race, and repairing the loser afterwards with a second write is
one more unchecked write rather than atomicity.

### The read it depends on

A precondition is only as good as the read that hands out the token, and
`roadmap_get_project` makes seven queries. Read the project and its revision in
two snapshots and a writer landing between them returns the old body with the
new revision: the caller judges text it can no longer write over, the token
passes the comparison, and `ready` stands on the replacement — the same
corruption, rebuilt out of the read side. So `Store.projectSnapshot` takes every
fact the read returns inside one transaction, and the tool returns that.

Its transaction is DEFERRED, the one exception to the `.immediate()` rule above:
nothing in it upgrades a lock, so there is no SQLITE_BUSY to wait out, and a WAL
read transaction holds one consistent snapshot from its first statement to its
commit. Readers do not block the writer either — a second connection still
commits mid-read, it is simply outside the snapshot.

What the token covers is the project's OWN record. `blocked_by` and incoming
`deps` are facts about other projects — a blocker archived, a relation added
from elsewhere — and those move without appending an event here. The tool
description says so, and a test pins it down: a caller whose decision turns on
the dependency graph needs more than this revision. Widening it to the
dependency closure was the alternative and is worse — every edit to a neighbour
would refuse writes to a project nothing touched.

## The Helmo seam

Two additions in the helmo repo (H-172), a public API commitment — resist
widening: a `project` tag on tickets (the join key for rollups) and a
`project` filter on the ticket query. The third, the standing notice on queue
responses, was retired in H-1126: Arthur's ruling is that the roadmap itself
carries the shipping order, so a hand-maintained copy of it on every queue
read only drifts. The roadmap holds no code
path into Helmo: in v1 Bosun's sweep is the client — it reads metered
cost from Helmo tickets tagged with the project id and records the rollup
via `roadmap_record_actual`.

The notice used to be the half of the seam an agent could not close (H-324):
a ship_next declared from a loop left a stale notice until a desk session
corrected it. Retiring it (H-1126) removes that drift entirely — ship_next is
read here, where it is written. Two caveats on the rollup itself:
desk sessions are unmetered, so a human-heavy project rolls up $0 (record
nothing rather than "cheap"), and list rows carry no cost, so the sum is one
`helmo-cli get` per tagged ticket — cheap in one shell pass, but the reason
a programmatic client stays on the v2 list.

## v2 parked in H-172

Gates/stances behavior, a programmatic roadmap→Helmo client, automatic
charter re-derivation, remote HTTP entry, estimation-learning analytics,
hygiene tooling, a CLI.
