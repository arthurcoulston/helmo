# Helmo v0 Design — Store Schema & MCP Tool Surface

Companion to [helmo-product-description.md](helmo-product-description.md). This doc makes the three one-way-door decisions (event schema, ticket ID format, MCP tool surface) and the supporting two-way-door ones needed to build the walking skeleton. Everything here was designed from the agent's perspective first: the primary user of this API is a headless bash-loop agent with no memory of previous iterations.

Design inputs: Beads evaluation (2026-08), Anthropic's tool-design guidance (few consolidated tools, explicit descriptions, token-efficient responses, actionable errors), HumanLayer's approval/human-as-tool contract shape.

---

## 1. Ticket IDs

**Format: `H-<n>`** — sequential integers minted by the store (`H-1`, `H-2`, … `H-142`).

**Rationale.** Beads uses hash IDs (`bd-a1b2`) because parallel agents mint IDs in separate per-repo databases with no coordinator. Helmo has a single SQLite store — the database is the coordinator, so sequential IDs are collision-free by construction. That lets us take the more human-friendly option: `H-142` is shorter, speakable, memorable within a meeting, and sortable by age at a glance. Meetings are the product; IDs are optimized for being said out loud.

**Contract (the one-way door):** ticket IDs are **opaque strings, ≤ 16 chars, unique forever, never reused** (including after cancellation). Sequential minting is *policy*, not contract — if federation/multi-machine ever arrives, new IDs can switch to a hash or prefixed scheme without breaking anything that stored an ID as a string.

---

## 2. Ticket statuses

Five stored statuses. Small on purpose — every status is a word agents must use consistently and humans must instantly understand in a meeting.

| Status | Meaning |
|---|---|
| `open` | Exists, not started. Eligible for pickup if not blocked. |
| `in_progress` | An agent has claimed it and is working. |
| `awaiting_human` | Returned to the human with a structured question. The first-class state. |
| `done` | Work complete. Should carry evidence links. |
| `cancelled` | Won't be done. Terminal, kept for the record. |

**`open` + `assignee` = a directed handoff.** An open ticket with an assignee is *reserved*: handed to a specific agent that hasn't started yet (see §7a, delegation). The ready queue respects reservations.

**`blocked` is not a status — it's computed.** A ticket is *blocked* while any ticket it `blocks`-depends on is not yet `done` or `cancelled`; *ready* when `open`, not blocked, and either unassigned or assigned to the asking agent. Storing blockedness invites drift (dependency closes, status forgets to change). Deriving it means the ready queue is always correct. This follows the product principle: compute status where computation is possible, self-report where it isn't.

---

## 3. Actors

Every write records who did it. An actor is:

```json
{ "name": "codex-events-loop", "kind": "agent", "model": "gpt-6-codex", "version": "2.4.0", "session": "s_9f2c" }
```

- `name` — stable identity chosen by the operator (in the agent's constitution). This is the name humans see.
- `kind` — `agent` | `orchestrator` | `human`. Humans appear as actors when they answer tickets — this is the door left open for multi-human teams; no auth in MVP.
- `model` / `version` — model ID and harness/agent version. Required for agents. This is what makes corrections verifiable ("that batch was the old prompt").
- `session` — optional; groups writes from one loop iteration.

The **agent chain** shown in the view is derived from the event log (ordered distinct actors), never stored on the ticket.

**Transport.** MCP has no standard per-call identity, so the actor is supplied once per connection: the agent's MCP config launches the Helmo server with the actor as environment/config (e.g. `HELMO_ACTOR='{"name": "codex-events-loop", ...}'`), and the server stamps it onto every write. An optional per-call `actor` override exists for harnesses that multiplex many agents through one connection. Writes with no resolvable actor are rejected with an error explaining how to configure one — anonymous writes would break provenance, which is the point of the system.

---

## 4. The event log (source of truth)

Append-only. Events are never updated or deleted. Ticket rows are a **materialized view**: a rebuild routine must be able to reconstruct every ticket from its events alone, and a test enforces this invariant. This is what makes the read-only dashboard trivially safe and provenance real.

**Schema:**

```sql
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,  -- global order
  ts         TEXT NOT NULL,                      -- ISO-8601 UTC
  ticket_id  TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor      TEXT NOT NULL,                      -- JSON actor object
  payload    TEXT NOT NULL                       -- JSON, shape per event_type
);
```

**Event types (v0):**

| Type | Payload carries |
|---|---|
| `created` | Full initial ticket fields. |
| `updated` | Field diffs (`{field: {from, to}}`), plus optional `note`, `evidence[]`, `tokens`, `cost_usd`. |
| `returned` | The structured question (see §6, `helmo_return_to_human`). |
| `answered` | The answer, direction, who answered. |
| `linked` / `unlinked` | Dependency edge added/removed (`{to, type}`). |

**Record more than the view needs.** The payload of `updated` carries the full diff even for fields the dashboard doesn't display yet; `tokens`/`cost_usd` ride on any event. You can't retroactively enrich events you didn't record — this is the clause that makes the one-way door safe.

---

## 5. Ticket schema (materialized state)

```sql
CREATE TABLE tickets (
  id             TEXT PRIMARY KEY,              -- "H-142"
  title          TEXT NOT NULL,                 -- one line, human terms
  body           TEXT NOT NULL DEFAULT '',      -- full context; enough that ANY agent could resume from it
  workstream     TEXT NOT NULL,                 -- free-text grouping: "helmo-dev", "spring-gala", "research"
  type           TEXT NOT NULL,                 -- "build" | "research" | "writing" | "ops" | "planning" | free text
  labels         TEXT NOT NULL DEFAULT '[]',    -- JSON array
  status         TEXT NOT NULL DEFAULT 'open',
  priority       INTEGER NOT NULL DEFAULT 2,    -- 0 critical, 1 high, 2 normal, 3 low
  assignee       TEXT,                          -- actor name currently claiming it
  evidence       TEXT NOT NULL DEFAULT '[]',    -- JSON array: {kind, ref, note}
  confidence     TEXT,                          -- 'routine' | 'spot_check' | 'needs_review'
  uncertainty_note TEXT,                        -- the specific claim: WHERE the doubt is
  blast_radius   TEXT NOT NULL DEFAULT 'none',  -- 'none'|'draft'|'records'|'sent'|'published'
  question       TEXT,                          -- JSON: pending return payload while awaiting_human, else NULL
  tokens_total   INTEGER NOT NULL DEFAULT 0,    -- aggregated from events
  cost_usd_total REAL NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  closed_at      TEXT
);

CREATE TABLE deps (
  from_id  TEXT NOT NULL,   -- the dependent ticket
  to_id    TEXT NOT NULL,   -- what it points at
  type     TEXT NOT NULL,   -- 'blocks' | 'parent' | 'discovered_from' | 'relates'
  PRIMARY KEY (from_id, to_id, type)
);
```

Storage: one SQLite file in WAL mode at a configurable path outside any repo (default `~/.helmo/helmo.db`). Concurrent agent writers on one machine are handled by SQLite's locking; writes are short transactions.

**Field notes:**

- **`body` carries resumption.** Because agents are fresh loop iterations, the ticket body plus its events must be sufficient for *any* agent to continue the work. Tool descriptions enforce this expectation.
- **`evidence`** — `{kind, ref, note}` where `kind` ∈ `commit` | `file` | `url` | `draft` | `other` and `ref` is the deep link/path. Self-reported in v0 per product decision; the structure is what a later verification layer will check.
- **`confidence`** — coarse bucket, not a scalar (scalars are uncalibrated decoration until review outcomes accumulate; the calibration loop can introduce numbers later). `uncertainty_note` is the more useful half: *where* the doubt is.
- **`blast_radius`** — ordered by cost-of-being-wrong: `none` (nothing outside the agent's head) < `draft` (artifacts created, nothing shared) < `records` (systems/records modified, reversible) < `sent` (reached specific people) < `published` (reached the world). Ratchets up via updates; never ratchets down.
- **`question`** — populated on return, cleared on answer. The answer itself lives in the event log and is surfaced by `helmo_get_ticket` as `last_answer`, so a resuming agent sees both what was asked and what was decided.
- **Dependency semantics** (each type has computable consequences, per Beads' best idea): `blocks` — from_id is not ready until to_id is `done` or `cancelled`. `parent` — hierarchy only. `discovered_from` — lineage: "found while working on X"; no readiness effect. `relates` — soft link.

---

## 6. MCP tool surface (v0)

Seven tools, namespaced `helmo_*`. Consolidated on purpose: one write tool for normal work (`helmo_update_ticket`), one for the human boundary (`helmo_return_to_human`). Tool descriptions below are **the actual v0 description strings** — they are the teaching layer, written for an agent that has never seen a convention doc. Errors always state what went wrong *and* what to do instead.

---

### `helmo_create_ticket`

> Create a ticket in Helmo, the shared work record for all agents and the human operator. Create a ticket whenever you start a distinct piece of work that isn't already tracked, and whenever you notice work that should happen but that you are NOT doing now (set status 'open' so another agent can pick it up; link it with dep_type 'discovered_from' if you found it while working on something else — this preserves lineage without derailing you).
>
> Write `title` in plain human terms (one line, no jargon): the human reads it in a dashboard. Write `body` so that a different agent with NO other context could pick the ticket up and continue — include goal, constraints, relevant paths/links, and current state. You will not be around to explain; the body is the handoff.
>
> Returns the new ticket ID (e.g. "H-142"). Reference it in commits, files, and messages you produce for this work.
>
> Params: `title` (required), `body` (required), `workstream` (required — ask the record: use helmo_list_tickets to see existing workstream names before inventing a new one), `type` (required: build|research|writing|ops|planning, or another short noun if none fit), `labels` (optional array), `priority` (0 critical, 1 high, 2 normal — default, 3 low), `status` ('open' default, or 'in_progress' if you are starting it now), `assignee` (optional — reserve the ticket for a named agent without starting it; leave unset for the pool), `deps` (optional array of `{to: "H-n", type: blocks|parent|discovered_from|relates}` — edges always point FROM this new ticket; for a reverse-direction edge use helmo_link_tickets after creation).

### `helmo_get_ticket`

> Fetch one ticket by ID. `format: "state"` (default) returns current fields plus any pending question/answer — enough to work. `format: "history"` additionally returns the full event log (who did what, when, with diffs) — use it when resuming unfamiliar work, investigating, or preparing a meeting. If you were told an answer is waiting for you, the answer is in the latest 'answered' event and in the `last_answer` field of the state view.

### `helmo_list_tickets`

> Query tickets. Key filters: `ready: true` (open tickets with no open blockers that are unassigned or reserved for you — use this to find work you can start), `status`, `workstream`, `assignee`, `type`, `priority_max`. Returns compact rows (id, title, status, priority, workstream, assignee, blast_radius, updated_at), sorted by priority then age; paginated (`limit` default 20, `cursor`). Start every loop iteration with `helmo_list_tickets {assignee: <your name>}` — this returns both work you're mid-way through (in_progress) and work handed to you that you haven't started (open + reserved). Then `{ready: true}` for new work. (Answered questions come back as unassigned 'open' tickets — the ready queue surfaces them; you don't need to have been the agent who asked.)

### `helmo_update_ticket`

> Record progress on a ticket: status changes, notes, evidence, confidence, blast radius, token spend. Call it when reality changes, not on a timer — claiming work, finishing it, producing an artifact, or learning something a resuming agent would need. Every call requires a `note`: one or two lines, human terms, saying what actually happened ("Drafted invite copy, saved to drive/gala/invite-v2.md"), because notes are the story the human reads.
>
> Claiming: set `status: "in_progress"`. Only 'open' tickets can be claimed — an 'awaiting_human' ticket is waiting on an answer, not on you. If another agent holds the ticket you'll get an error naming the holder and how long ago they last updated — pick different work rather than duplicating theirs. Exception: if the holder's last update is over 24h old the claim is stale (loop agents die); retry with `takeover: true` and say so in your note.
>
> Finishing: set `status: "done"` WITH `evidence` — the commit, file path, URL, or draft that proves the work exists. Done without evidence is a claim, not a record; the tool will accept it but flag it, and the human will see the flag. Also set `confidence` ('routine' = ship it, 'spot_check' = worth a glance, 'needs_review' = human should look) and, if confidence is not 'routine', an `uncertainty_note` saying specifically WHERE the doubt is ("unsure the venue's AV quote covers the second room") — where you are uncertain is more useful than how uncertain you are.
>
> Keep `blast_radius` current the moment your work touches more of the world: 'draft' (created artifacts, shared nothing), 'records' (modified records/systems, reversible), 'sent' (reached specific people), 'published' (reached the world). It never goes back down. Report `tokens` and/or `cost_usd` spent since your last update when you can.
>
> Handing off to another agent: set `handoff_to: <agent name>` with a note saying what you did and what the receiver should do ("Built the importer, PR linked in evidence — needs review, especially the date parsing"). This releases your claim and reserves the ticket (status 'open', assignee = receiver); they'll find it via their own list_tickets call, or your harness can pass them the ticket ID directly. Helmo records the pass; making the receiving agent actually run is your harness's job, not Helmo's. Use handoff for round trips like builder→reviewer→builder on one piece of work; if the delegated work is really its own piece of work, create a linked ticket instead (see helmo_create_ticket).
>
> Do NOT use this to ask the human anything — use helmo_return_to_human, which exists for that.
>
> Params: `ticket_id` and `note` (required); optional: `status`, `evidence`, `confidence`, `uncertainty_note`, `blast_radius`, `tokens`, `cost_usd`, `handoff_to`, `takeover`, and field corrections (`title`, `body`, `priority`, `labels`, `workstream`). Keep `body` current as understanding evolves — it's the handoff document for whoever works this next.

### `helmo_link_tickets`

> Add or remove a typed link between tickets. Params: `from_id`, `to_id`, `action` (add|remove), `type`: 'blocks' (from_id cannot proceed until to_id is done — affects the ready queue, use sparingly and only for true prerequisites), 'parent' (from_id is a subtask of to_id), 'discovered_from' (from_id was found while working on to_id — lineage, no blocking), 'relates' (soft association). Direction matters for 'blocks': to make ticket A wait on new subtask B, the edge is from_id: A, to_id: B. Linking well is what makes the human's dashboard show the shape of the work instead of a flat list.

### `helmo_return_to_human`

> Return a ticket to the human. This is the ONLY way to ask the human anything, and it is the most important tool call you will make: the human works these in batched meetings, so a question that arrives incomplete wastes the one resource Helmo exists to protect — human attention. Use it when you are blocked on a decision only the human can make, when your constitution says this action needs approval, or when requirements are genuinely ambiguous. Do not use it for things another ticket, file, or tool could answer, and do not use it to report progress (that's helmo_update_ticket).
>
> All fields required unless marked optional:
> - `situation`: what you were doing and where it stands — written for someone who hasn't read the ticket.
> - `question`: the single decision needed. One question per return; if you have two independent questions, return twice (Helmo batches them for the meeting).
> - `options`: 2–4, each `{label, consequence}` — what happens if chosen, including cost/risk. The human should be able to answer by saying a label.
> - `recommendation`: which option you'd pick and why, in one sentence. You have context the human lacks; always recommend.
> - `if_unanswered` (optional but valuable): what happens if no answer comes — "gala invites slip a day per day of delay" or "nothing urgent; blocks H-88 only".
>
> Sets status to 'awaiting_human' and releases your claim. Do not wait for the answer — end your loop iteration or take other ready work; the answer will be on the ticket when it comes.
>
> BAD: question: "How should I handle the venue?" GOOD: situation: "Booking the gala venue; Aldrich Hall holds our date but wants a $2k non-refundable deposit by Friday." question: "Pay the deposit?" options: [{label: "pay", consequence: "date locked, $2k sunk if we cancel"}, {label: "wait", consequence: "risk losing the date; two backup venues exist but are smaller"}] recommendation: "pay — the date matters more than the $2k and backups don't fit 200 guests." if_unanswered: "Aldrich releases the date Friday 5pm."

### `helmo_answer_ticket`

> Record the human's answer to a ticket in 'awaiting_human'. Normally called by the orchestrator during a meeting, relaying the human's words. Params: `answer` (the decision, plus any new constraints or context the human added — capture their reasoning, not just the choice: it teaches future agents), `chosen_option` (label, if the human picked one), `resolution` — what the answer means for the ticket: 'resume' (default: back to 'open', unassigned, ready for any qualified agent — the original agent was a loop iteration that no longer exists), 'done' (the human accepted the work or made it moot — record evidence if any), or 'cancelled' (the human killed it). The answer is stored on the ticket; the next agent to claim it gets the full picture via helmo_get_ticket.

---

### Deliberate omissions (v0)

- **No `helmo_claim_next`** — claiming is `update_ticket(status: in_progress)` with an atomic holder check; a dedicated tool adds surface without adding capability.
- **No `helmo_get_agenda`** — the meeting agenda is `list_tickets(status: awaiting_human)` sorted by blast_radius/priority/age; batching related questions is orchestrator prompt-work, not schema.
- **No delete anything** — cancellation is a status; the record is permanent.
- **No human-facing write tools** — the human's only write path is speech → orchestrator → `helmo_answer_ticket`. This is the product's central constraint expressed in the API.

---

## 7. Flows (sanity checks)

### 7a. Delegation between agents

Division of labor: **the harness moves the agents; Helmo moves the work and keeps the record.** Helmo deliberately does not spawn, schedule, or message agents — how a reviewer loop gets started is outside its scope. What Helmo provides is routing (reserved tickets), lineage (links), and visibility (the agent chain derived from events shows every pass: `builder-loop → reviewer-loop → builder-loop`, with versions).

Two patterns, both using existing machinery:

- **Baton pass (same ticket)** — for round trips where the work item stays one thing: `update_ticket {handoff_to: "reviewer-loop", note: ...}`. Claim released, ticket reserved for the receiver. Reviewer hands it back the same way with findings in the note. The dashboard shows one ticket whose agent chain tells the story.
- **Sub-ticket (new ticket)** — for delegated work that is its own deliverable: `create_ticket` with `deps: [{to: "H-140", type: "parent"}]`; then, if H-140 can't finish without it, `link_tickets {from_id: "H-140", to_id: <new>, type: "blocks"}` (the reverse-direction edge, which create_ticket's deps — always from the new ticket — can't express). Optionally reserve it (`assignee`) for a specific agent, or leave it for the pool.

Rule of thumb (encoded in the tool descriptions): if the receiver's output is a verdict *about your work*, baton-pass; if it's a *new artifact*, sub-ticket. Either way agent-to-agent delegation that happens entirely outside Helmo is invisible to the human — constitutions should say that any delegation lasting beyond one loop iteration goes through one of these two patterns.

### Core flows

**Bash-loop agent iteration:** `list_tickets {assignee: me}` → resume in_progress work and pick up tickets handed to me → else `list_tickets {ready: true, workstream: mine}` → claim via `update_ticket` → work → `update_ticket` with note/evidence/confidence → or `return_to_human` → exit. Every step survives the agent having no memory.

**Meeting:** human summons orchestrator → orchestrator pulls `awaiting_human` queue, batches related questions, walks the human through by ID ("H-201 and H-207 are both blocked on the gala budget…") → human decides → orchestrator calls `helmo_answer_ticket` per ticket → queue empties → meeting ends. Empty queue is shown as such.

**Discovery mid-task:** agent working H-140 notices a broken link on the site → `create_ticket {title, body, status: open, deps: [{to: "H-140", type: "discovered_from"}]}` → continues H-140 undistracted.

**Build → review round trip:** builder finishes H-140, links the PR as evidence → `update_ticket {handoff_to: "reviewer-loop", note: "needs review, esp. date parsing"}` → harness runs the reviewer, which finds H-140 via `list_tickets {assignee: "reviewer-loop"}` → reviews → hands back with findings, or marks done with confidence set. One ticket; the agent chain shows the whole exchange.

---

## 8. Open questions for review

Reviewed 2026-08-05 (H-5) against two days of dense dogfooding: 61 tickets,
~400 events, loop and interactive traffic. Resolutions inline.

1. **Workstreams: free text or first-class?** v0 says free text + "check before inventing." If meetings end up organized by workstream, promoting it to a table (with a description an orchestrator can read) may be worth it early.
   → *Resolved: both, and dogfooding built it before this review could.* Steering (goal, budget) became a first-class table via H-55; the ticket field stays free text. The one observed cost was rename drift (`capstan-dev` beside `rev-dev`), which is housekeeping, not structure.
2. **Priority scale** — proposed 0–3. Is "backlog" (Beads' P4) worth a distinct level, or is that just `open` + low priority?
   → *Resolved: 0–3 stands.* Usage was 1/2/3 = 6/39/15; nobody reached for a backlog level — low-priority `open` carries "someday" fine. 0 is unused but cheap to keep for a real emergency.
3. **`done` without evidence** — v0 accepts-but-flags. The stricter option (reject) teaches agents faster but will fight legitimately evidence-less work (e.g. "decided X after research"). Flag feels right; confirm.
   → *Resolved: flag confirmed.* Two evidence-less dones in 61 (H-1, H-32), both genuine decision tickets — exactly the case rejection would have fought.
4. **Cost reporting** — agents often don't know their own token spend reliably (a bash loop knows; an interactive session may not). Accept it as best-effort self-report, or drop from v0 and add when harnesses expose it?
   → *Resolved the hard way (H-57): best-effort was wrong.* A loop agent's guesses double-counted $201 against a $30 budget. Now: report only measured numbers, harness-metered sessions never self-report, and the meter nets out anything they report anyway (`actor-spend`) so a session lands in the totals exactly once.
5. **Retention/size** — event log grows forever by design. Fine for years at solo scale; noting it so it's a decision, not an accident.
   → *Resolved: append-forever stands.* ~400 events ≈ 2.3MB. Revisit only if size ever degrades the view.
6. **Stale-claim threshold** — proposed 24h before `takeover: true` is allowed. Too long for fast loops, too short for overnight research agents? Could be per-workstream config later; needs a v0 number now.
   → *Resolved: 24h stands — as the advisory line and hygiene threshold, not a hard gate.* `takeover: true` with an honest note works at any age; all four dogfooding takeovers (loop reclaims, rename corrections) were legitimate and self-documenting. Per-workstream config stays unbuilt until something bites.
7. **Agent names are unregistered free text** — a `handoff_to` typo strands a ticket reserved for an agent that doesn't exist (stale-claim takeover eventually rescues it, but slowly). v0 accepts this for simplicity; if it bites in dogfooding, the fix is a lightweight agent registry the orchestrator maintains, and `handoff_to` warning on unknown names rather than rejecting.
   → *Bit in dogfooding — via rename, not typo.* The crew renames (H-52) left two scheduled tickets reserved for a name that no longer answers (`master-at-arms`; H-48/H-49), caught only by manual sweep. Still no registry: a deterministic hygiene check for assignees gone silent covers typo, rename, and retirement in one rule (ticketed from H-5).
