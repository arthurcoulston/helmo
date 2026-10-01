# Charter — template

*A template with illustrative examples. The example content below is invented
to show texture — it is nobody's actual charter.*

A charter is the document your crew reads before judging whether a project is
worth doing. It is written by you and only read by them.

**Write it as prose.** The point is not to give an agent a scoring rubric —
it is to make an agent understand you well enough to judge things you never
anticipated. Reasons, tensions, the thing you are torn about, the why behind a
no: that is what makes a stranger's judgment feel like yours, and none of it
survives being compressed into fields. The tags (`O-1`, `N-2`) exist only so a
project can cite a specific paragraph without ambiguity. They are anchors on
prose, not a schema replacing it.

**But make the prose bite.** Most mission documents are written to persuade an
audience, so they are broad and warm and reject nothing. Yours is read by
someone who has to say no to forty projects out of fifty. The test for a
paragraph is whether a plausible project could die on it.

> Weak: *"I want to build tools that make people more capable."*
> Strong: *"I build tools for one person running a crew of agents. If a
> feature only makes sense once there is a team of humans coordinating, it is
> not my problem to solve."*

Keep it to two to four pages, one markdown file, plain text. It gets held in
context alongside the whole backlog; a twenty-page charter gets skimmed, which
is worse than a short one. Date what changes. Write for a smart stranger who
will take you literally and has none of your shorthand.

---

## 1. The picture

*Free prose, no structure, three to six paragraphs. What you are doing, why,
where it goes, and what you genuinely do not know yet. This is the section that
makes an agent get it rather than merely comply. Do not tidy the uncertainty
out of it — an agent that knows what you are torn about judges better than one
handed a confident summary.*

> **Example.** I am one person with a crew of agents, and the whole experiment
> is whether that arrangement can carry real work rather than demos. Everything
> I build is either infrastructure for that crew or a test of it. The tools are
> real products I intend other people to use, not scaffolding — partly because
> shipping publicly forces a quality bar that private tooling never gets, and
> partly because I think this way of working is about to matter to a lot of
> people and I would rather be early with something honest than late with
> something polished.
>
> What I am unsure about: whether the tools are the point or the byproduct. On
> good days the crew is the product and the software is what it needed to
> exist. On other days I think Helmo is the actual business and the crew is how
> I can afford to build it alone. I have not resolved this, and projects that
> only make sense under one reading should say which one.
>
> The ten-year version is not a company with employees. It is a small number of
> tools that other solo operators depend on, and enough independence that what
> I work on is decided by whether it is interesting and useful rather than by
> what someone is paying for.

## 2. Bets

*What you believe about the world that justifies the work. Tag each one. A bet
lets an agent evaluate a speculative project that maps to no current
objective — without stated bets, everything exploratory looks unjustified. Say
what would prove each one wrong; it tells an agent which evidence matters.*

> **B-1 — Agent crews outproduce what one human can review.** *(2026-08)* The
> binding constraint is no longer building things, it is deciding what to build
> and verifying what came back. Tools that help a human review, steer, and
> trust agent output will be worth more than tools that help agents produce
> more. Wrong if review turns out to be automatable — if verification agents
> get good enough that the human bottleneck dissolves, most of what I am
> building becomes a transitional artifact.
>
> **B-2 — Solo operators are an underserved market, not a small one.** *(2026-08)*
> Every serious tool in this space assumes a team. Wrong if the economics push
> everyone back into companies.

## 3. Fixed points

*Some things you hold regardless of evidence, and that is not a defect — it is
what makes them commitments rather than hypotheses. The sorting question is not
"is this rational" but "would I revise this if the evidence went against it?"
If the honest answer is no, it does not belong in Bets. Filing a commitment as
a bet means the crew will keep dutifully bringing you evidence against
something you were never going to give up, and you will learn to ignore the
crew.*

*Two kinds live here, and they do opposite work when judging projects. Say
which one you mean.*

**Gates — these kill things.** A commitment about how you will operate,
regardless of what it costs. More discriminating than any bet, because it
rejects outright rather than shifting a weight.

> **F-1 — Sundays are not available, and neither is anything that requires
> them.** Not a preference to be traded against a good opportunity.
>
> **F-2 — Nothing that makes its money from someone's attention against their
> interest.** However good the business is.

**Stances — these license things.** Beliefs whose truth depends partly on
whether people act as though they were true. Holding one is participation, not
prediction. Where a gate rules projects out, a stance rules whole domains in,
and it sets which way you lean when a project's value is genuinely
unknowable.

> **F-3 — The outcome is not already decided, and effort moves it.** Whether
> this technology lands well is contingent on whether people work at making it
> land well. This reads like a truism and is not one: it rejects both "it will
> be fine on its own" and "it is already lost," which are the two most common
> positions held by serious people. Practically, it means work in this domain
> gets judged on tractability, never on the odds of the whole problem being
> solved.

*The guardrail on a stance: it decides which games you are playing, not which
moves are good. "Effort moves the outcome" does not imply that every project
wearing the right label is worth doing — if it did, the crew would learn that
invoking the domain gets a project ranked up, and the stance would decay into a
rubber stamp. The stance gets you into the domain; tractability still decides
what to build.*

## 4. What I am trying to achieve

*Ordered — most important first. Order is what breaks ties, and ties are most
of the work. A short paragraph each, not a row in a table. Include what
finishing actually looks like, in the prose, so an agent can tell whether a
project moves it. Mark the horizon.*

> **O-1 — Get Helmo in front of people who are not me.** *(near — this year)*
> One external user running it on their own crew, with their own agents, and
> telling me what broke. Not a launch, not a landing page — one person whose
> workflow I did not design for. Until that happens I am guessing about what
> the product is, and every feature I add is a guess compounded. This outranks
> everything else, including work that is more interesting.
>
> **O-2 — Make the crew able to run a week without me.** *(near)* Right now
> stalls need me. Done looks like a week where the fleet handles its own
> failures and the only things that reach me are genuine decisions.
>
> **O-3 — Build a body of public work that speaks for itself.** *(long)* Not
> audience-building. Enough shipped, documented, working things that someone
> deciding whether to trust me can just look.

## 5. What I am not doing

*The highest-leverage section, and the one nearly every planning document
omits. A closed door with a reason attached kills ten projects in a line — and
the reason matters more than the refusal, because it generalizes to cases you
never listed.*

> **N-1 — Not building a consulting or services business.** *(2026-08)* Selling
> my hours is the thing I am trying to escape, and it converts every good week
> into obligations. Anything whose revenue model is my time is out, however
> lucrative.
>
> **N-2 — Not chasing an audience.** Writing that follows from work I did is
> good. Work chosen because it would make good content is not. If a project's
> primary justification is that it would be interesting to post about, that is
> a reason to rank it lower, not higher.
>
> **N-3 — Not competing on breadth.** I will not match a funded team feature
> for feature. Projects framed as closing a gap with a competitor are usually
> the wrong instinct.

## 6. How I work, and what fits me

*Constraints an agent cannot infer and will otherwise ignore: real hours,
money, energy, what drains you, what you are already committed to. A project
can be a perfect strategic fit and a bad fit for you, and only this section
makes that visible.*

> **Time.** Roughly twenty focused hours a week, in two or three long blocks
> rather than daily slices. A project needing steady small daily attention will
> quietly fail; one needing two immersive weekends will get done.
>
> **Money.** Cash cost matters more than agent cost. A project with a monthly
> subscription needs to justify itself in a way that a project spending fifty
> dollars of tokens does not.
>
> **Energy.** Building and designing pull me forward. Recurring outbound
> anything — sales calls, cold outreach, scheduled social posting — drains me
> to the point where it stops the rest of the work. Discount projects that
> depend on my sustained enthusiasm for that.
>
> **Already committed.** Helmo v1 is mid-flight. Until it is out, new products
> compete against finishing it, and mostly lose.

## 7. Calls I have made

*If you write only one section, write this one. An agent pattern-matches
against precedent far better than it applies abstractions, and your real
tradeoffs live in the decisions you made, not the values you would state. Six
or so, mixed yes and no, each with the actual reasoning. Include one you got
wrong — knowing how you misjudge is worth as much as knowing how you judge.*

> **Yes — building Helmo rather than adopting Beads.** *(2026-08)* An existing
> tool covered most of it, and I built anyway, because its architecture assumed
> a distributed team and mine does not. The general lesson: I will take on real
> build cost to avoid inheriting someone else's wrong assumption, but only when
> the assumption is load-bearing.
>
> **No — a browser extension for reading agent output.** *(2026-07)* Genuinely
> useful, small build. Killed because it did not compound with anything else I
> own. Standalone utilities lose to things that make my existing tools better.
>
> **Wrong — spent three weeks on a dashboard nobody had asked for.** *(2026-06)*
> It was the most enjoyable work available, and I let that stand in for
> importance. My characteristic failure is choosing the interesting build over
> the boring one that unblocks a person. Push back when you see it.

## 8. Words I use

*Only terms that carry weight and would otherwise be guessed at. Two or three
lines each. If your old planning notes ran on shorthand, this is where the
shorthand gets paid off.*

> **Crew** — the named agents with persistent profiles and memory. Not any
> agent session.
>
> **Ship** — publicly usable by a stranger, documented, without me in the loop.
> Running on my machine is not shipped.

---

## Maintaining it

You write it; the crew only reads it. When an agent finds the charter stale or
contradicted by what actually happened, it proposes an amendment — the exact
language, plus the evidence — and you ratify. The document stays yours; the
crew's job is to notice drift, not to edit.

Date what changes. A stale paragraph that looks current is worse than an
obviously old one.
