# Helm — Product Description

Open source, self-hosted, agent-platform agnostic.

## Premise

An agent team owning real workstreams — building software, planning events, original research — produces more work than a human can review. The answer isn't reviewing less carefully. It's a view that makes the shape of the work legible at a glance and surfaces what needs attention.

Agents write the record. The human reads it. No human editing UI.

Two rules:

1. **Status is self-reported by agents, and agents are trusted.** An agent marks its own work done, blocked, or in progress. Every report should carry an evidence link (the commit, the file, the draft, the published URL) so any claim is spot-checkable — but verification against evidence is a later layer, not a launch requirement.
2. **The default view is all tickets.** Everything the team is doing, visible in one place. Collapsing routine work and surfacing anomalies (low confidence, high blast radius, unusual spend) can come later as filters — hiding is opt-in, not the default.

## Why Helm is different

The agent-management space (Beads, Gas Town, Omnara, Vibe Kanban, GitHub Agent HQ) is crowded, but no comp occupies this combination:

- **The human interface is a great view plus AI meetings.** Not a form-filled tracker with a chat bolted on: a visual surface worth staring at, and an orchestrator-run meeting for everything interactive. The visual quality of the view is a differentiator, not a nicety.
- **The human never edits.** No adding, changing, or deleting tickets by hand — the human views and talks to AI, nothing else. Every comp ships a human editing UI; Helm's read-only constraint is a feature, because it keeps the record entirely agent-written and forces the meeting to be good.
- **Not just for software.** Coding is one work type among many — events, research, writing, operations. Every serious comp is repo- and code-shaped. Helm will work well for software without being shaped by it.

## Users

- **The human:** one operator. The MVP is shaped for a solo-preneur running an agent team alone. Keep the door open for multi-human teams later (don't bake single-user assumptions into the schema), but build nothing team-specific now.
- **The agents:** Claude Code, Codex, and any other frontier-model agent. Mostly run as headless bash loops — and bash loops spawning bash loops. This is why the interface must be MCP/tool-based with no platform assumptions: the typical client is a script-driven agent, not an IDE session.

## The human's primary working mode

Agents return tickets to the human when blocked, when a decision is needed, or when something needs clarification. These queue.

The human's main interaction with the system is working that queue in conversation with the orchestrator — a **meeting**, where the backlog *is* the agenda. The meeting happens inside the human's existing agent surface (Claude Code, Codex): the human summons it — "summon helm orchestrator" — which loads the orchestrator context into the current session. The team runs autonomously; the human is summoned to unblock, not to manage. The queue is always visible in the context of the broader pipeline, so answering happens with awareness of what's moving.

Design consequences:

- **Awaiting-human is a first-class state**, not a label. It has its own view, its own count, its own sort.
- **A returned ticket must carry the question well.** What was being done, what's needed, what the options are, what the agent recommends. A ticket that just says "what should I do?" wastes the meeting. Make this a requirement of the return tool, not a convention.
- **Batch related questions.** Several agents blocked on the same underlying decision should surface as one item.
- **Answering resumes work.** The agent picks up where it stopped — no re-delegation, no restating context. Because agents are often fresh bash-loop iterations, the ticket itself must carry enough context that *any* agent handed the ticket can continue the work.
- **The meeting should end.** Empty queue is a state worth showing.

## When agents escalate

Whether an agent ships autonomously or returns a ticket for approval is the **agent's discretion, governed by its constitution** — the instructions it was given for its workstream. E.g., "if complex, seek approval; if simple, ship without asking" (in practice, in-depth and specific to the agent's work). Helm doesn't enforce an approval policy; it provides the escalation channel (the returned ticket and the awaiting-human queue) that constitutions route through.

## Components

**The store.** Local. A single SQLite database (WAL mode) outside any repo: tickets plus an append-only event log. The event log carries provenance; the ticket carries current state. One DB serves agents across all repos and work types — no per-repo databases, no sync protocol, no merge states.

*Beads was evaluated (2026-08) and the decision is build, not adopt.* Beads' own history validates this architecture: its git-committed-JSONL era produced exactly the agent merge collisions Helm avoids, and the v1.0 fix (embedded Dolt, sync commands, bootstrap/repair flows) is machinery for a distributed topology Helm doesn't have. What Helm adopts from Beads instead:

- Collision-free, short, speakable ticket IDs (hash-based — parallel agents never coordinate on ID assignment)
- A computed ready/blocked queue derived from typed dependencies, where each dependency type has stated, computable semantics (`blocks` affects readiness; `discovered-from` records lineage without blocking)
- JSON-first tool responses
- One caution: community tools couple to whatever format is exposed. The MCP interface is the contract; storage stays private. A Beads-compatible JSONL export is a cheap optional door for interop and migration.

**The agent interface.** MCP, so any agent on any platform can create and manage tickets without platform-specific integration. Tool descriptions are how the system teaches agents to use it correctly — self-documenting rather than requiring a separate convention doc.

**The orchestrator.** A shipped agent whose job is managing the tool: creating and organizing tickets, enforcing correct usage by other agents, and running the meeting — walking the human through the awaiting-input queue and routing answers back. Loaded on demand via summon; not a separate app. Other agents create and manage their own tickets directly.

**The view.** Read-only, and visually excellent — legibility at a glance is the product, so design quality here gets real investment.

## What's visible per item

| Field | Notes |
|---|---|
| **Ticket ID** | Short, stable, human-speakable. The handle for referencing items in meetings — "approve H-142" must be unambiguous. |
| **Description** | One or two lines, in human terms. |
| **Review link** | Deep link to the actual artifact. Differs by work type — a PR, a file, a draft, a published URL. |
| **Type** | Tag or tags. Differentiates classes of work. |
| **Agent chain** | Which agents touched it, in order. **Include version, not just name** — this is what makes corrections verifiable. |
| **Tokens** | Total spent across the chain. |
| **Confidence** | Verifier's estimate that it would pass human review. |
| **Blast radius** | What it touched: draft-only, sent, published, records modified. Drives sort order — the cost of being wrong. |

## Confidence needs calibration

Log every human review outcome against predicted confidence. Compare predicted vs. actual pass rate periodically. If items marked 90% pass 60% of the time, the number is decoration.

Prefer a short specific claim alongside the scalar — where the verifier is uncertain is more useful than how uncertain it is.

## Constraints

Self-hostable by others. No assumptions about any particular agent framework, model provider, or repo layout. Configuration over convention where they conflict.
