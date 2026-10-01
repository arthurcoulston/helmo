# Helmo Roadmap — Product Description

Open source, self-hosted, agent-platform agnostic. A sibling to Helmo, not a
part of it: the two are built to work as one system and to work alone.

## Premise

Helmo is the record of work **being done**. This is the record of work **worth
doing** — the layer above the ticket, where an idea gets parked, fleshed out,
costed, ranked, and eventually declared go.

The bottleneck has moved. When execution was expensive, a long roadmap was a
liability — anything past six months was a joke list of things the team had
quietly decided not to do. With an agent crew, the side project that used to
cost a quarter can cost an afternoon, so the constraint is no longer *can we
build it* but *which of the hundred things we could now build should we*.

Nathaniel Whittemore (The AI Daily Brief) calls the result the **infinite
backlog** — the sudden immediacy of every essay, product, venture, and side
quest you could pursue, borrowing Kierkegaard's "dizziness of freedom" for the
vertigo that arrives when possibility outruns direction.

This tool takes that seriously as a design constraint rather than a mood:

- **Getting an idea in costs nothing.** A title and a sentence. Everything else
  accretes later. Any required field would strangle the backlog at birth.
- **Bad ideas belong here.** Recording an idea and ranking it low is the
  process succeeding, not failing. A long tail of low-ranked ideas is the
  intended steady state.
- **The list re-sorts as building gets cheaper.** Rank is derived, and effort
  is estimated in dollars against metered actuals, so an idea can rise without
  anyone changing their mind about its value — because its cost fell. This is
  the infinite backlog made operational, and it is the mechanic to protect.

## What it is not

No Gantt charts, no timelines, no dates, no burndown, no hour estimates. Effort
is a t-shirt size and a dollar prediction, nothing more.

Not code-shaped. "Helmo v2.0" and "Run a hackathon at the co-working space" are
both first-class projects and neither is privileged.

## Relationship to Helmo

Separate products, separate stores, separate views. Together they read as one
system; apart, each stands alone. The seam is three small additions to Helmo,
each independently useful to a Helmo-only user:

1. An optional `project` tag on a ticket — another grouping string alongside
   `workstream`. Useful alone; doubles as the join key.
2. A `project` filter on the ticket query, following from (1).
3. A **standing notice** that rides along on ticket-queue responses, the way
   workstream goals and budgets already do. Helmo carries a one-line current
   priority with its provenance and knows nothing about what wrote it.

Dependency runs one way: the roadmap is a *client* of Helmo's MCP and degrades
gracefully without it. Progress and actual cost for a project are read back by
querying Helmo's tickets, never self-reported. The one place influence flows
the other way is the standing notice, and it flows through a hook that is
roadmap-agnostic by construction.

## The object

A project is not a ticket wearing a costume. It is durable where a ticket is
disposable, it accumulates and gets rewritten over months, and it is **never
ready work** — you never claim a project, only its tickets.

It carries fields a ticket has no use for (readiness, parking rationale, value
and effort claims, a provenance-heavy body) and lacks fields a ticket needs
(assignee, blast radius, confidence, evidence-of-done).

A workstream is a domain that never ends (`security`, `helmo-dev`). A project
is a thing that ships (`Helmo v2.0`). A ticket's project is optional, so
routine work is never forced into a fake one.

## Status

`parked` · `shaping` · `ready` · `ship_next` · `shipped_watching` ·
`shipped_stable` · `archived`

*(Ladder v2, ratified 2026-09-02. v1 had a separate `shipping` status beside a
singular ship_next flag, and terminal `shipped`/`abandoned`; in practice the
two work-phase names were used interchangeably, and freshly-shipped projects
had nowhere to be watched from.)*

**The first three rungs are The List.** Recorded, refined, scored, and ranked —
and deliberately not worked: the only labor a listed project takes is sharpening
its definition until it can be scored and handed off well.

**Blocked is not a status.** As in Helmo, it is computed from dependencies, not
remembered by whoever touched the record last.

**Ready supports a commitment decision, not a finished specification.** A
project is ready when enough is known for the human to make an informed decision
about committing to it. Details continue to be decided while building; this is
an agile threshold, not a promise that a builder will have no questions. An
agent other than the one who shaped the description must make that readiness
judgment, while retitling alone does not count as shaping.

**Ship next is the work phase, entered only on the human's go-ahead.** Nothing
is ever being shipped that the human did not declare go on — the store rejects
any other door in. Several projects may hold it at once, but with resistance:
the count is surfaced everywhere, a growing work phase is read as a problem,
and the standing aim is moving projects OFF it the moment they are close. The
human does not type the go-ahead: an agent records the decision with
attribution, the way Helmo's answer route already works. The provenance is the
point.

**Shipped splits by attention.** `shipped_watching` is newly shipped —
monitoring, feedback, bug fixes, loose ends. `shipped_stable` records a
standing human decision that the project's maintenance is worth it. Neither is
terminal.

**Archived is the one terminal state.** The project ran its course and no
longer earns its maintenance: surfaces closed and taken down, the record kept
permanently out of the way. Ideas killed before shipping land here too. A
revived idea is a new project with a `relates` link to its ancestor.

**Parking carries its own exit.** A parked project records why it is parked and
what would unpark it ("revisit when Helmo has one external user"), so a sweep
can test the condition instead of the idea rotting silently.

## Ranking

Rank is derived, never set by hand. The inputs are split by kind:

- **Facts** the store already knows and no agent can inflate: readiness,
  blocked-ness, staleness, dependency on another project.
- **Judgments** — value and effort — recorded as claims with an author, a date,
  and a one-line reason. Never a naked number.

Tiers come from the facts; order within a tier comes from the judgments. Every
rank must be explainable in one line: *"3rd — ready, no blockers, high value
(rolo, 08-12), effort L."*

Lowering a project's value is ordinary maintenance, not a dispute. The crew
agreeing an idea is low-value is the critique working.

Helmo's own warning about confidence applies here in full: *if items marked 90%
pass 60% of the time, the number is decoration.* A score assembled from
agent-supplied inputs decays into decoration unless every input is attributed
and every ranking is legible. When the human reads a rank explanation and
disagrees, that disagreement is the calibration signal.

## Fit — the charter

Ranking against nothing is vibes. The deciding question for most projects is
"does this fit what we are actually trying to do", so the objectives have to be
in the system, citable, and stable.

**The charter is the one thing the human writes and the agents only read.**
Everywhere else the rule inverts — agents write the record, the human reads it.
Here it flips, because a mission, a set of values, a year's priorities, are
precisely what only the principal can supply. The tool is not an authoring
surface for them.

So the charter lives wherever its author already keeps it — a life-planning
document with one-year and ten-year goals, a company mission statement, a set
of OKRs, a KPI sheet. The roadmap holds a **projection** of that source, not a
copy of it:

- A small set of **objectives**, each with a short quotable statement, a stable
  ID, a horizon (near / long / standing), and a `source` pointer back to the
  authoritative document.
- Each projection records what it was derived from and when, so drift is
  visible rather than silent. When the source document changes, an agent
  re-derives; nobody hand-maintains two copies.

A project cites zero or more objectives, each citation carrying a one-line
claim of *how* it advances that objective. This is what rescues value from
decoration: a claim of the form "advances OBJ-3, because …" is checkable, and
the human can disagree with the mapping rather than with a number.

**Citing nothing is a signal, not an error.** Some work is maintenance and
always will be. But a project that advances nothing anyone has written down
should be visible as such, and "advances nothing stated" is a view worth
having.

The clean division of labour, and the reason ranking can be derived at all:

> **The human ranks a dozen objectives once a year. The crew ranks three
> hundred projects against them, continuously.**

Project rank inherits from objective rank, so the human's hand rests on the few
durable things instead of on a backlog of hundreds.

Assessing fit is the first move of the shaping loop: a newly filed project gets
a fit assessment on its first sweep, which is usually enough to sort it.

**The fit judgment is prose; the ranking is thin and downstream.** What an
agent writes about a project is a paragraph on whether and how it serves what
the human is doing. The store keeps a citation and a one-line claim on top of
that. Understanding produces the judgment; the number is a consequence, and
treating the number as the product is how these systems rot.

### Four shapes, not one

A charter does not contain one kind of statement, and the projection has to
carry the difference, because they enter a judgment in different ways:

- **Objectives** — what the human is trying to achieve. A project *advances*
  one. A dial: it raises rank in proportion.
- **Bets** — claims about the world the work depends on, carrying a stake and a
  falsifier. They justify projects that advance no objective but cheaply test a
  belief, and they let an agent flag when a project rests on an assumption
  nobody has written down.
- **Gates** — commitments held regardless of evidence. A project *violates* one
  or it does not. A veto, not a weight: a project that cuts against a gate is
  flagged, never quietly ranked low.
- **Stances** — participatory beliefs, whose truth depends partly on people
  acting as though they were true. They rule whole domains *in* and set which
  way to lean when a project's value is genuinely unknowable. Their guardrail:
  a stance decides which games are played, not which moves are good, or it
  decays into a rubber stamp for anything wearing the right label.

Start the schema with objectives and bets; leave room for gates and stances
rather than foreclosing them.

### The charter template ships with the product

A roadmap that ranks against a charter is worth much more if it hands the user
a good charter format on day one. `CHARTER-TEMPLATE.md` in this directory is
that artifact and is part of the public deliverable, not scaffolding.

## Estimation

Effort is predicted in dollars and compared against the metered actual rolled
up from the project's Helmo tickets. This is the capability no off-the-shelf
tool can copy: none of them are wired to what the workforce costs. Over time it
teaches the crew what a given size actually costs, and it is what lets falling
costs re-sort the list.

## Tending

Re-derivation, staleness flagging, duplicate detection, and unpark-condition
checks belong to **Bosun**, as an extension of the existing sweep remit rather
than a new role.

An infinite backlog means hundreds of entries, so the sweep is tiered: cheap
facts are recomputed every pass; expensive judgment is revisited on a rotation
or on a trigger — a dependency cleared, an estimate moved, a project gone quiet
at a high rank.

## The human

Read-only view, as in Helmo. Ship-next at the top, expanded. Everything below
it collapsed, ordered by derived rank. All writing and editing is done by
agents, including recording the human's decisions.

## Shipping

This ships publicly alongside Helmo, under the same discipline (see
`crew/PUBLISHING.md`). Two consequences to hold from the start:

- The seam into Helmo is a public API commitment. Keep it to the three small
  additions above and resist widening it.
- The charter mechanism must stay generic. A solo operator's life plan, a
  startup's OKRs, and a nonprofit's mission statement are all just sources
  behind an objective projection; nothing in the model assumes one of them.

## Open questions

- The name.
