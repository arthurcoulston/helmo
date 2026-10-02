import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { localRecordRef, qualifiedRecordRef } from './reference.js';
import { Store } from './store.js';
import { Actor, ACTOR_KINDS, BLAST_RADII, CONFIDENCES, DEP_TYPES, HelmoError, STATUSES, Ticket, writingActor } from './types.js';
import { HELMO_VERSION } from '@helmo/core';

// Single source of truth for the MCP tool surface (H-116). Both entry points —
// server.ts (stdio, local agents) and remote.ts (Streamable HTTP, remote
// agents via the crew-mcp worker) — register the identical tools from here.
// Tool descriptions are guidance-as-deployed; edit them here and only here.

const actorSchema = z
  .object({
    name: z.string(),
    kind: z.enum(ACTOR_KINDS),
    model: z.string().optional(),
    version: z.string().optional(),
    session: z.string().optional(),
  })
  .optional()
  .describe('Who is writing. Omit only when HELMO_ACTOR in the server environment already names you exactly (loops get accurate per-agent env). Interactive sessions: the env identity is a static placeholder that cannot know your name or model — pass your true identity on every write: {name: your crew name, kind: "agent", model: your exact model ID, version: your harness version, e.g. "claude-code-" + output of `claude --version`}. Writes without a truthful complete identity are rejected.');

// Every tool's arguments go through one strict object, and helmo-cli enforces
// the same rule over its flags (R-39 Q9). Handed a raw shape the MCP SDK wraps
// it in a plain object, which STRIPS an undeclared key instead of refusing it:
// a misspelled `projekt`, or a `capacity_hold` that only exists on update, used
// to return success with the field simply unset — the expensive failure, where
// it worked and it was wrong and nothing complained (H-1186 is the same class
// one layer down). A strict object refuses during argument validation, before
// the handler runs, so a refused call leaves the record untouched.
function strict<S extends z.ZodRawShape>(shape: S) {
  return z.object(shape).strict();
}

// Every result and every refusal says which installation answered (H-2502).
// It rides on the ENVELOPE, beside `result`, not inside it: the ids and seat
// names an agent carries away are in `result`, and the one line that says
// whose they are must not be mistakable for a field of the record itself. The
// label alone, not the CLI's full installation block — this surface is read
// into an agent's context on every call, and which build is running is a
// diagnostic question the CLI and the status lines already answer (H-2490).
function envelope(installation: string | undefined, data: unknown, warnings: string[] = []): { content: { type: 'text'; text: string }[] } {
  const body: Record<string, unknown> = { result: data };
  if (warnings.length) body['warnings'] = warnings;
  if (installation) body['installation'] = installation;
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 1) }] };
}

function refusal(installation: string | undefined, e: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const msg = e instanceof HelmoError ? e.message : `Unexpected error: ${String(e)}`;
  return { content: [{ type: 'text', text: JSON.stringify({ error: msg, ...(installation ? { installation } : {}) }) }], isError: true };
}

function compact(t: Ticket) {
  return {
    id: t.id, title: t.title, status: t.status, priority: t.priority, workstream: t.workstream,
    type: t.type, assignee: t.assignee, blast_radius: t.blast_radius, updated_at: t.updated_at,
    ...(t.project ? { project: t.project } : {}),
    ...(t.schedule ? { schedule: t.schedule } : {}),
    ...(t.not_before ? { not_before: t.not_before } : {}),
    ...(t.workflow_attempt_id ? { workflow_attempt_id: t.workflow_attempt_id } : {}),
    ...(t.needs_human && (!t.release_handoff || t.release_handoff.current) ? { needs_human: t.sitting ?? true } : {}),
    ...(t.release_handoff ? { release_handoff: t.release_handoff } : {}),
    ...(t.capacity_hold ? { capacity_hold: t.capacity_hold } : {}),
  };
}

export function buildServer(store: Store, envActor: Actor | null): McpServer {
  const resolveActor = (override?: Actor): Actor => writingActor(override, envActor);

  // The installation comes off the store rather than a second parameter, so
  // the identity this surface checks references against is the identity of the
  // store it is actually serving — they cannot be wired up disagreeing.
  const install = store.installationTarget();
  const ok = (data: unknown, warnings: string[] = []) => envelope(install?.label, data, warnings);
  const fail = (e: unknown) => refusal(install?.label, e);
  /** Resolve an incoming ticket reference to a local id before it reaches the
   *  store: bare ids pass through, a qualifier naming this installation is
   *  dropped, one naming another refuses (H-2502). */
  const local = (ref: string): string => localRecordRef(ref, install);

  const server = new McpServer({ name: 'helmo', version: HELMO_VERSION });

  server.registerTool(
    'helmo_create_ticket',
    {
      description:
        `Create a ticket in Helmo, the shared work record for all agents and the human operator. Create a ticket whenever you start a distinct piece of work that isn't already tracked, and whenever you notice work that should happen but that you are NOT doing now (set status 'open' so another agent can pick it up; link it with dep type 'discovered_from' if you found it while working on something else — this preserves lineage without derailing you).\n\n` +
        `Write 'title' in plain human terms (one line, no jargon): the human reads it in a dashboard. Write 'body' so that a different agent with NO other context could pick the ticket up and continue — include goal, constraints, relevant paths/links, and current state. You will not be around to explain; the body is the handoff.\n\n` +
        `Say what accounts for this work: a 'project' tag when it belongs to a named project, an 'obj:OBJ-n' label when it serves a charter objective directly, or — when it is justified some other way — one of exactly three labels: 'acct:direction' (the human said so, on the record), 'acct:security' (keeping the estate safe), 'acct:estate' (keeping the estate running). The label is what hygiene reads; still say WHY in the body, because the label names the category and only the body names the reason. Work carrying none of these is reported by hygiene as unaccounted, and someone has to reconstruct why it exists.\n\n` +
        `Returns the new ticket ID (e.g. "H-142"). Reference it in commits, files, and messages you produce for this work. For 'workstream', check existing names first (helmo_list_tickets) before inventing a new one. Deps edges always point FROM this new ticket; for a reverse-direction edge (e.g. an existing ticket blocked by this new one) use helmo_link_tickets after creation.\n\n` +
        `Stop discipline: before filing a follow-on ticket, answer "who is waiting on this, and what will they do with it?" If the honest answer is "nobody, nothing yet", record it as residuals in the current ticket's body instead. When real loose ends remain, consolidate them into ONE follow-up ticket rather than fanning out several small ones. Note: a ticket you file does not enter YOUR OWN ready queue until a human, an orchestrator relaying the human, or another agent touches it — discovery is always welcome, but executing your own discoveries takes a second pair of eyes.`,
      inputSchema: strict({
        title: z.string(),
        body: z.string(),
        workstream: z.string(),
        type: z.string().describe('build|research|writing|ops|planning, or another short noun if none fit'),
        project: z.string().optional().describe('Optional grouping tag for work that belongs to a named project (e.g. a roadmap project id like "R-4") — how cost and progress roll up. Routine work needs none.'),
        labels: z.array(z.string()).optional(),
        priority: z.number().int().min(0).max(3).optional().describe('0 critical, 1 high, 2 normal (default), 3 low'),
        status: z.enum(['open', 'in_progress']).optional().describe("'open' (default) or 'in_progress' if you are starting it now. Starting your own ticket in the same call is legitimate; once it sits as open backlog, the triage rule holds it from you until a human, an orchestrator relaying the human, or another agent touches it"),
        assignee: z.string().optional().describe('Reserve for a named agent without starting it; leave unset for the pool'),
        not_before: z.string().optional().describe(
          "Withhold this ticket from ready queues until a date — 'YYYY-MM-DD' (opens 00:00 UTC that day) or a full ISO instant. Use it when the work genuinely CANNOT start yet: it needs a week of data, a deadline has to pass, a dependency lands on a known day. Without it the only way to say so is shouting in the body, and every agent reading the queue pays a full ticket read to learn it must not act. This is not priority — priority says how much the work matters, not whether it can be started.",
        ),
        needs_human: z.union([z.string(), z.literal(false)]).optional().describe('Mark this as work that needs a sitting with the human by saying, in ONE LINE, what the sitting needs — what he does and roughly what it costs him ("Two clicks in the Cloudflare dashboard to add an Email Routing rule"). That line is what he reads on his dashboard to decide what to pick up, so write it for someone who will not open the ticket. The ticket stays open and is withheld from every agent ready queue. Pass false to clear the marker.'),
        sitting_with: z.string().optional().describe('The exact agent the human should sit with. Use this with needs_human for discussion, interpretation or guided joint work; never make the human infer the agent from ticket history.'),
        deps: z.array(z.object({ to: z.string(), type: z.enum(DEP_TYPES) })).optional(),
        schedule: z.string().optional().describe(
          "Makes this a RECURRING TEMPLATE: 'every <N><m|h|d>' or 5-field cron (UTC). The template itself is standing work — never ready, never claimed. Due instances spawn automatically on queue reads, linked to the template via a parent dep, and a new instance is skipped while a previous one is still open. Retire the template by cancelling it.",
        ),
        workflow_attempt_id: z.string().optional().describe('Bind this ticket immutably to an existing workflow attempt. Starting, claiming, handing off, or resuming it then requires an atomic admission from that attempt\'s exact current requirements.'),
        actor: actorSchema,
      }),
    },
    async ({ actor, ...input }) => {
      try {
        const t = store.createTicket(resolveActor(actor as Actor | undefined), {
          ...input,
          ...(input.deps ? { deps: input.deps.map((d) => ({ ...d, to: local(d.to) })) } : {}),
        });
        return ok({ id: t.id, ticket: compact(t) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_get_ticket',
    {
      description:
        `Fetch one ticket by ID. format "state" (default) returns current fields plus any pending question and the last human answer — enough to work. format "history" additionally returns the full event log (who did what, when, with diffs) — use it when resuming unfamiliar work, investigating, or preparing a meeting.\n\nA bare id means this installation's record, and every result says on its envelope which installation that is. The 'ref' field is that id qualified with it (H-42@dev.helmo) — quote THAT anywhere the reference may travel, because ids are minted per installation and the qualified form is REFUSED by any other rather than answered with its own unrelated H-42. Every tool here takes either spelling.`,
      inputSchema: strict({
        ticket_id: z.string(),
        format: z.enum(['state', 'history']).optional(),
      }),
    },
    async ({ ticket_id, format }) => {
      try {
        const id = local(ticket_id);
        const t = store.getTicket(id);
        const deps = store.getDeps(id);
        const ws = store.getWorkstreamInfo(t.workstream);
        const base = {
          ...t,
          // The reference to quote elsewhere. `id` stays bare, so every caller
          // reading it is unaffected; `ref` is the spelling that survives being
          // carried to another installation, because there it refuses (H-2502).
          ref: qualifiedRecordRef(t.id, install),
          blocked: store.isBlocked(id),
          deps,
          agent_chain: store.agentChain(id),
          last_answer: store.lastAnswer(id),
          product_acceptance: store.productAcceptance(id),
          // The stream's budget rides along so the claimer weighs the ticket
          // against it before spending anything (H-55). Numbers only: a prose
          // goal here was standing instruction outside caps and review (H-1186).
          ...(ws.budget_usd !== null
            ? { workstream_steering: { budget_usd: ws.budget_usd, spent_usd: ws.spent_usd, remaining_usd: ws.remaining_usd } }
            : {}),
        };
        if (format === 'history') return ok({ ...base, events: store.getEvents(id) });
        return ok(base);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_list_tickets',
    {
      description:
        `Query tickets. Key filters: ready: true (open tickets with no open blockers that are unassigned or reserved for you — use this to find work you can start), status, workstream, assignee, type, priority_max. Returns compact rows sorted live work first (done and cancelled last), then priority, then age; paginated (limit default 20, cursor = offset).\n\n` +
        `Start every loop iteration with {assignee: <your name>} — this returns both work you're mid-way through (in_progress) and work handed to you that you haven't started (open + reserved). Then {ready: true} for new work. Answered questions come back as unassigned open tickets — the ready queue surfaces them; you don't need to have been the agent who asked.\n\n` +
        `Triage duty: if you pass over a ready ticket BECAUSE it needs something only the human can supply (a missing input, an unrecorded location, a decision), do not route around it silently — file its question with helmo_return_to_human first (no claim needed), then take other work. Helmo cannot see that kind of blockage; only you can. A known-blocked ticket left quietly in the ready queue stalls until someone else rediscovers what you already knew.\n\n` +
        `The response's 'workstreams' carry each stream's seat and budget where set: 'budget_usd'/'spent_usd'/'remaining_usd' disclose the stream's budget. budget_usd 0 is the explicit no-cap sentinel: remaining_usd is null and runnable work must remain runnable. A positive budget is a finite plan — front-load the highest-value work so stopping at any point is safe. What done means for a stream is never a field here: it is the seat's profile or the project body. Ready-queue triage rule: tickets you filed yourself are withheld from your own ready queue until a human, an orchestrator relaying the human, or another agent touches them; they appear under 'awaiting_triage' (and stay available to everyone else). Date-gated work appears under 'gated'. Work needing the operator present appears under 'with_human'. Deliberate spending holds appear under 'capacity_held': they stay visible but never enter the executable queue until a separate update releases the hold.`,
      inputSchema: strict({
        ready: z.boolean().optional(),
        status: z.enum(STATUSES).optional(),
        workstream: z.string().optional(),
        project: z.string().optional().describe('Filter to tickets carrying this project tag'),
        assignee: z.string().optional(),
        type: z.string().optional(),
        priority_max: z.number().int().optional(),
        limit: z.number().int().optional(),
        cursor: z.number().int().optional(),
        actor: actorSchema,
      }),
    },
    async ({ actor, ...filter }) => {
      try {
        const caller = resolveActor(actor as Actor | undefined)?.name;
        const tickets = store.listTickets({ ...filter, caller });
        const workstreams = store.listWorkstreamInfo().map((w) => ({
          name: w.name,
          ...(w.seat ? { seat: w.seat } : {}),
          ...(w.budget_usd !== null ? { budget_usd: w.budget_usd, spent_usd: w.spent_usd, remaining_usd: w.remaining_usd } : {}),
        }));
        const awaitingTriage = filter.ready && caller ? store.selfFiledPending(caller) : [];
        // Withheld, not hidden (H-732): the gate says come back on this date,
        // which is the whole saving — one line instead of a ticket read.
        const gated = filter.ready && caller ? store.gatedPending(caller) : [];
        const capacityHeld = filter.ready && caller ? store.capacityHeldPending(caller) : [];
        const withHuman = filter.ready && caller ? store.withHumanPending(caller) : [];
        return ok({
          tickets: tickets.map(compact),
          count: tickets.length,
          workstreams,
          ...(awaitingTriage.length ? { awaiting_triage: awaitingTriage } : {}),
          ...(gated.length ? { gated } : {}),
          ...(capacityHeld.length ? { capacity_held: capacityHeld } : {}),
          ...(withHuman.length ? { with_human: withHuman } : {}),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_update_ticket',
    {
      description:
        `Record progress on a ticket: status changes, notes, evidence, confidence, blast radius, token spend. Call it when reality changes, not on a timer. Every call requires a 'note': one or two lines, human terms, saying what actually happened — notes are the story the human reads. For a body addition use body_append; for an in-place change use body_patch with a unique literal old anchor. A missing or repeated anchor refuses without writing. Whole-field body remains for callers deliberately replacing the complete document; pass only one body mode. On done or cancelled tickets only note and evidence appends are accepted; every state-changing field still refuses.\n\n` +
        `Claiming: set status "in_progress". Attended agents carrying out operator-directed work use this same path with their true identity; no worker session stamp or extra permission marker is required. Record the direction in the note and continue covered work without asking again. Only 'open' tickets can be claimed. If another agent holds the ticket you'll get an error naming the holder — pick different work rather than duplicating theirs; if their claim is stale (>24h), retry with takeover: true and say so in your note. A ticket you filed yourself that nobody else has touched cannot be claimed by you at all — the triage rule that withholds it from your ready queue also rejects the direct claim, and takeover does not bypass it. A human decision relayed by an orchestrator counts as that touch even when the relayer shares your agent name. The boundary is deliberate: creating a ticket with status 'in_progress' ("I am doing this now") is legitimate; the triage rule guards backlog you filed and later drew back, not work you start in the same breath.\n\n` +
        `Finishing: set status "done" WITH evidence — the commit, file path, URL, or draft that proves the work exists. Done without evidence is a claim, not a record; it is accepted but flagged to the human. Write refs so a stranger can follow them months from now: commits as repo@sha (crew@24e8003 — a bare sha does not say WHICH repo), one commit per item; files as an absolute path or repo:relative/path, never bare-relative; URLs as they are. Prose goes in the item's own 'note' — a clause on what the ref demonstrates — never inside 'ref'. Also set confidence ('routine' = ship it, 'spot_check' = worth a glance, 'needs_review' = human should look) and, if not routine, an uncertainty_note saying specifically WHERE the doubt is — where you are uncertain is more useful than how uncertain you are.\n\n` +
        `Keep blast_radius current the moment your work touches more of the world: 'draft' (created artifacts, shared nothing), 'records' (modified records/systems, reversible), 'sent' (reached specific people), 'published' (reached the world). It never goes back down. Report tokens and/or cost_usd only for numbers you actually measured — a usage readout you saw. Never estimate your own session's spend, and if you run as a supervised loop, do not self-report at all: the harness meters the session and writes real spend after it ends, so a guessed figure double-counts against the budget the human steers by.\n\n` +
        `Putting work down unfinished: set status "open". That releases your claim but keeps the ticket reserved for the seat it was routed to, so your next session finds it in its own ready queue — you do not have to be the same session to be the same worker. If you are genuinely done with it and anyone should be able to take it, say so: handoff_to "" clears the named receiver. In a seated workstream Helmo routes it to that stream's seat; in an unseated workstream it returns to the shared pool.\n\n` +
        `Handing off to another agent: set handoff_to with a note saying what you did and what the receiver should do. This releases your claim and reserves the ticket for them; they'll find it via their own list call. Helmo records the pass; making the receiving agent run is your harness's job. Use handoff for round trips (builder→reviewer→builder) on one piece of work; if the delegated work is its own deliverable, create a linked ticket instead.\n\n` +
        `Stopping well: when the marginal value of continuing drops — ask "what did the last stretch of work actually buy, and who is waiting for more?" — close the ticket with the residual loose ends documented in the body rather than pushing on. Closing at diminishing returns is a success state, not a failure. If the workstream discloses a budget, treat it as the plan: front-load the highest-value work, and when it is spent, close out honestly instead of continuing quietly.\n\n` +
        `Do NOT use this to ask the human anything — use helmo_return_to_human, which exists for that.`,
      inputSchema: strict({
        ticket_id: z.string(),
        note: z.string(),
        status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional(),
        takeover: z.boolean().optional(),
        handoff_to: z.string().optional(),
        evidence: z.array(z.object({ kind: z.enum(['commit', 'file', 'url', 'draft', 'other']), ref: z.string(), note: z.string().optional() })).optional(),
        confidence: z.enum(CONFIDENCES).optional(),
        uncertainty_note: z.string().optional(),
        blast_radius: z.enum(BLAST_RADII).optional(),
        tokens: z.number().int().optional(),
        cost_usd: z.number().optional(),
        title: z.string().optional(),
        body: z.string().optional().describe("Keep it current as understanding evolves — it's the handoff document for whoever works this next"),
        body_append: z.string().optional().describe('Append exact text to the current body without replacing what is already there'),
        body_patch: z.object({
          old: z.string().describe('Unique literal text observed in the current body; missing or repeated text refuses the write'),
          new: z.string().describe('Replacement text; may be empty to remove the anchored text'),
        }).strict().optional(),
        priority: z.number().int().min(0).max(3).optional(),
        labels: z.array(z.string()).optional(),
        workstream: z.string().optional(),
        project: z.string().optional().describe("Set or change the project tag; '' clears it"),
        not_before: z.string().optional().describe("Set or move the date gate that withholds this ticket from ready queues — 'YYYY-MM-DD' or a full ISO instant; '' opens it now"),
        needs_human: z.union([z.string(), z.literal(false)]).optional().describe('Mark this as work that needs a sitting with the human by saying, in ONE LINE, what the sitting needs — what he does and roughly what it costs him ("Two clicks in the Cloudflare dashboard to add an Email Routing rule"). That line is what he reads on his dashboard to decide what to pick up, so write it for someone who will not open the ticket. The ticket stays open and is withheld from every agent ready queue. Pass false to clear the marker.'),
        sitting_with: z.string().optional().describe('The exact agent the human should sit with. Use this with needs_human for discussion, interpretation or guided joint work; never make the human infer the agent from ticket history.'),
        capacity_hold: z.object({
          reason: z.string().describe('Why worthwhile work must not start under the current spending posture'),
          provenance: z.string().describe('Who authorized the hold and where that direction was recorded'),
          reconsider_when: z.string().describe('The concrete change that requires this hold to be reviewed'),
          release: z.object({
            batch_id: z.string().describe('Stable name shared only by the finite set selected for this batch'),
            until: z.string().describe("Expiry instant; an unqualified 'today' must be converted to local midnight before this call"),
            stop_conditions: z.string().describe('What stops new discretionary starts before expiry'),
            shared_reserve: z.string().describe("Capacity kept back for the operator's sessions and urgent work"),
          }).optional(),
        }).nullable().optional().describe('Set a deliberate capacity hold, optionally with a temporary bounded-batch release, or pass null to remove it. A release makes only the tickets carrying its batch_id executable until its expiry; the original hold then applies again automatically. Dependencies, dates, reservations, and human/review gates still apply.'),
        actor: actorSchema,
      }),
    },
    async ({ actor, ...input }) => {
      try {
        const { ticket, warnings } = store.updateTicket(resolveActor(actor as Actor | undefined), { ...input, ticket_id: local(input.ticket_id) });
        return ok(compact(ticket), warnings);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_hygiene',
    {
      description:
        `Run Helmo's deterministic record checks. Returns current findings only; it changes nothing and makes no judgment about them. Use this for cultivation sweeps instead of reading the store directly. Most live-ticket findings clear by acting on the ticket. A finding on a terminal ticket that has been examined and needs no further work — and a spend_anomaly you have accounted for on live work — is recorded with helmo_dispose_hygiene_finding, which is what stops the next sweep re-reporting it. Writing the same conclusion as a fresh note each sweep does not: the note is not read by this check, and the reading itself is metered onto the ticket.`,
      inputSchema: strict({}),
    },
    async () => {
      try {
        return ok({ findings: store.hygiene() });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_dispose_hygiene_finding',
    {
      description:
        `Record that one hygiene finding was examined and dealt with, so later sweeps stop reporting it. This is judgment, not deletion: give the exact check and ticket returned by helmo_hygiene, plus a reason another agent can audit.

On a DONE or CANCELLED ticket the judgment stands for good, and is append-once.

On LIVE work the one disposable finding is 'spend_anomaly'. Every other check reports a state that masking could hide indefinitely, so those still clear only by acting on the ticket. Spend is different: it is a number that only grows, and "this cost is accounted for" stays true until the number moves. So a live acknowledgement is recorded at the figure it answered for and the finding returns on its own once the ticket has cost half as much again — acknowledge it afresh then. Use this the FIRST time you find a spend anomaly accounted for; do not write the same conclusion as a new note every sweep, because nothing reads those notes and each re-reading is itself charged to the ticket.

Workstream-level findings have no ticket_id and cannot be disposed.`,
      inputSchema: strict({
        check: z.string(),
        ticket_id: z.string(),
        reason: z.string(),
        actor: actorSchema,
      }),
    },
    async ({ actor, ...input }) => {
      try {
        const ticket_id = local(input.ticket_id);
        store.disposeHygieneFinding(resolveActor(actor as Actor | undefined), { ...input, ticket_id });
        return ok({ disposed: `${input.check} on ${ticket_id}` });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_link_tickets',
    {
      description:
        `Add or remove a typed link between tickets. Types: 'blocks' (from_id cannot proceed until to_id is done — affects the ready queue; use sparingly, only for true prerequisites), 'parent' (from_id is a subtask of to_id), 'discovered_from' (from_id was found while working on to_id — lineage, no blocking), 'relates' (soft association). Direction matters for 'blocks': to make ticket A wait on new subtask B, the edge is from_id: A, to_id: B. Linking well is what makes the human's dashboard show the shape of the work instead of a flat list.`,
      inputSchema: strict({
        from_id: z.string(),
        to_id: z.string(),
        type: z.enum(DEP_TYPES),
        action: z.enum(['add', 'remove']).optional().describe("default 'add'"),
        actor: actorSchema,
      }),
    },
    async ({ from_id, to_id, type, action, actor }) => {
      try {
        const from = local(from_id);
        const to = local(to_id);
        store.linkTickets(resolveActor(actor as Actor | undefined), from, to, type, action ?? 'add');
        return ok({ linked: action !== 'remove', from_id: from, to_id: to, type });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_return_to_human',
    {
      description:
        `Return a ticket to the human. This is the ONLY way to ask the human anything, and it is the most important tool call you will make: the human works these in batched meetings, so a question that arrives incomplete wastes the one resource Helmo exists to protect — human attention. Use it when you are blocked on a decision only the human can make, when your constitution says this action needs approval, when requirements are genuinely ambiguous — and when you notice ready work (even a ticket you are not claiming; no claim is needed) blocked on a missing human input: file its question before moving on rather than leaving it stranded in the queue. Do not use it for things another ticket, file, or tool could answer, and do not use it to report progress (that's helmo_update_ticket).\n\n` +
        `One question per return; if you have two independent questions, return twice (Helmo batches them for the meeting). Sets status to 'awaiting_human' and releases your claim. Do not wait for the answer — end your loop iteration or take other ready work; the answer will be on the ticket when it comes.\n\n` +
        `A re-ask is refused (H-2126): if the human has already answered this exact situation/question/recommendation on this ticket, the return fails and hands you back what he said. Before asking, check 'last_answer' on the ticket — an answer can land while your session is mid-thought, and replaying the ask puts a decision he has already made back on his dashboard. If the answer left something open, ask about that, in a situation that accounts for it.\n\n` +
        `SHAPE OF THE ASK (H-939). The human reads these in a meeting and answers out loud, so a return is two parts. First the ISSUE — 'situation' then 'question' — enough that he can decide without reconstructing the ticket's history, and no more. Then EITHER your recommendation on its own, which is the normal case, OR two or three genuinely equal choices he can pick by saying a letter. Do not manufacture alternatives: options are for when the choice is really open, and a second course invented to fill the field costs him the same attention as a real one.\n\n` +
        `GOOD, recommendation standing alone: situation: "The staging deploy has been red for two days; the failing step is a lint rule we added last week and nothing else." question: "Turn the rule off for now?" recommendation: "yes — it is our own rule, it caught nothing real, and it is blocking every deploy." if_unanswered: "Nothing reaches staging until this clears."\n\n` +
        `GOOD, a real choice: situation: "Booking the gala venue; Aldrich Hall holds our date but wants a $2k non-refundable deposit by Friday." question: "Pay the deposit?" options: [{label: "pay", consequence: "date locked, $2k sunk if we cancel"}, {label: "wait", consequence: "risk losing the date; two backup venues exist but are smaller"}] recommendation: "pay — the date matters more than the $2k and backups don't fit 200 guests." if_unanswered: "Aldrich releases the date Friday 5pm."\n\n` +
        `BAD: question: "How should I handle the venue?" — no situation, no decision, nothing to say back. If there is no clear recommendation or closed choice the form can record, this is not an asynchronous decision: use helmo_update_ticket with needs_human and sitting_with so the dashboard names the sitting and agent.`,
      inputSchema: strict({
        ticket_id: z.string(),
        situation: z.string().describe("What you were doing and where it stands — written for someone who hasn't read the ticket"),
        question: z.string().describe('The single decision needed'),
        options: z.array(z.object({ label: z.string(), consequence: z.string() })).min(2).max(3).optional()
          .describe('Omit when your recommendation is the answer. Include only for a genuinely open choice: 2 or 3, each {label, consequence}, answerable by saying a letter'),
        recommendation: z.string().describe('Always required: the action you recommend, or the specific thing you need from the human, in one sentence. You have context they lack'),
        if_unanswered: z.string().optional().describe('What happens if no answer comes — cost of delay, deadlines, what it blocks'),
        operation_manifest_id: z.string().optional().describe('Exact immutable operation manifest. Standing test_authority suppresses escalation only for a verified test tenant, registry recipient, synthetic data, private visibility, no cost, and non-destructive effect; absent, unsafe, stale, revoked, or failed evidence leaves the human gate intact.'),
        actor: actorSchema,
      }),
    },
    async ({ ticket_id, actor, ...q }) => {
      try {
        const t = store.returnToHuman(resolveActor(actor as Actor | undefined), local(ticket_id), q);
        return ok({ ticket: compact(t), queued: t.status === 'awaiting_human' ? 'awaiting_human' : 'covered_by_standing_authority' });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_request_action',
    {
      description:
        `Ask the human to DO one concrete thing. This is not permission for an agent to act: it creates an explicit Action for you request, releases the claim, and waits for a completion report. Use helmo_return_to_human for a decision. If the work needs discussion, interpretation or guided joint work, use helmo_update_ticket with needs_human and sitting_with instead.\n\n` +
        `Say what is happening, the exact action and approximate cost, why only the human can do it, and what delay blocks. An action whose why_human amounts to "I need approval" is a decision and is refused by the store.`,
      inputSchema: strict({
        ticket_id: z.string(),
        situation: z.string().describe("What you were doing and where it stands — written for someone who hasn't read the ticket"),
        action: z.string().describe('The exact thing the human does, where, and roughly what it costs them'),
        why_human: z.string().describe("Why this needs the human's own hands rather than the agent's"),
        if_unanswered: z.string().optional().describe('What happens if the action is not done — cost of delay, deadlines, what it blocks'),
        actor: actorSchema,
      }),
    },
    async ({ ticket_id, actor, ...request }) => {
      try {
        const t = store.requestAction(resolveActor(actor as Actor | undefined), local(ticket_id), request);
        return ok({ ticket: compact(t), queued: 'awaiting_human' });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_report_action',
    {
      description:
        `Record that the human says they completed the pending Action for you request. Use this when they report completion in conversation or a meeting so they do not have to click the dashboard too. Quote what they actually did. This resumes the ticket to its workstream seat; it cannot close the ticket, choose an option, grant permission, or replace the agent's later verification.`,
      inputSchema: strict({
        ticket_id: z.string(),
        did: z.string().describe("What the human actually did, in their own words; 'done' is not enough state for the next session"),
        actor: actorSchema,
      }),
    },
    async ({ ticket_id, did, actor }) => {
      try {
        const t = store.reportAction(resolveActor(actor as Actor | undefined), local(ticket_id), { did });
        return ok({ ticket: compact(t) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_answer_ticket',
    {
      description:
        `Record the human's answer to a ticket in 'awaiting_human'. Normally called by the orchestrator during a meeting, relaying the human's words. Capture their reasoning, not just the choice — it teaches future agents. resolution: 'resume' (default: ticket returns to 'open', unassigned, ready for any qualified agent — the original asker was a loop iteration that no longer exists), 'done' (the human accepted the work or made it moot), 'cancelled' (the human killed it). The answer is stored on the ticket; the next agent to claim it gets the full picture via helmo_get_ticket.`,
      inputSchema: strict({
        ticket_id: z.string(),
        answer: z.string().describe("The decision plus any new constraints or context the human added — their reasoning, not just the choice"),
        chosen_option: z.string().optional().describe('Label of the chosen option, if the human picked one'),
        resolution: z.enum(['resume', 'done', 'cancelled']).optional(),
        actor: actorSchema,
      }),
    },
    async ({ ticket_id, actor, resolution, ...a }) => {
      try {
        const t = store.answerTicket(resolveActor(actor as Actor | undefined), local(ticket_id), { ...a, resolution: resolution ?? 'resume' });
        return ok({ ticket: compact(t) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_set_workstream',
    {
      description:
        `Set a workstream's budget_usd and/or seat — the human's steering surface. Call this ONLY to relay a decision the human stated explicitly; the write requires actor kind 'human' or 'orchestrator', and agent-kind writes are rejected: an agent must never set or raise the budget of the stream it draws work from, nor route the stream to itself.\n\n` +
        `Steering is numbers and names only. There is no goal field: what done means for a stream lives in the seat's profile or the project body, never in a store field every agent reads on every queue pass (H-1186). The budget is a disclosed plan, not a kill switch: agents see remaining balance on every queue read and are expected to front-load the highest-value work and close out honestly when it is spent. The seat is the agent every unassigned filing in the stream (recurring instances included) is reserved to at creation, so a loop bound elsewhere still finds it; a stream with no seat is ready to no loop, and hygiene reports it as unseated_pool. Partial updates are fine — a field you omit keeps its current value; seat '' clears the seat.`,
      inputSchema: strict({
        name: z.string().describe('The workstream being steered'),
        budget_usd: z.number().min(0).optional().describe('Total budget for the stream in USD; spend already recorded counts against it'),
        seat: z.string().optional().describe("Agent name unassigned filings here are reserved to at creation; '' clears it"),
        actor: actorSchema,
      }),
    },
    async ({ actor, ...input }) => {
      try {
        return ok(store.setWorkstream(resolveActor(actor as Actor | undefined), input));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_record_product_completion',
    {
      description:
        `Record that a product build is ready for independent acceptance. This is separate from ticket status: closing a generic review remains legitimate, while a product ship gate reads only this explicit record. Name every reviewed source snapshot as repo@ plus the full 40-character commit hash and name that commit's author. A later completion supersedes every earlier verdict and returns acceptance to pending, which is the remediation handback. This write is append-only and is allowed on terminal tickets.`,
      inputSchema: strict({
        ticket_id: z.string(),
        artifacts: z.array(z.object({ ref: z.string(), author: z.string() })).min(1),
        note: z.string(),
        actor: actorSchema,
      }),
    },
    async ({ actor, ...input }) => {
      try {
        return ok(store.recordProductCompletion(resolveActor(actor as Actor | undefined), { ...input, ticket_id: local(input.ticket_id) }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_record_acceptance_verdict',
    {
      description:
        `Record PASS or FAIL from a non-author reviewer against the latest product completion's exact immutable refs. The store rejects a missing completion, a ref mismatch, or a reviewer who authored any reviewed commit. FAIL is a first-class acceptance state; after remediation, the builder records a new completion and the gate returns to pending until another non-author verdict. Prose saying PASS and ticket status done never count as acceptance. This write is append-only and is allowed on terminal tickets.`,
      inputSchema: strict({
        ticket_id: z.string(),
        refs: z.array(z.string()).min(1),
        verdict: z.enum(['pass', 'fail']),
        note: z.string(),
        actor: actorSchema,
      }),
    },
    async ({ actor, ...input }) => {
      try {
        return ok(store.recordAcceptanceVerdict(resolveActor(actor as Actor | undefined), { ...input, ticket_id: local(input.ticket_id) }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_record_workflow_decision',
    {
      description:
        'Record an append-only decision or revocation against one exact workflow requirement and subject manifest. Identity comes only from the trusted HELMO_ACTOR configured for this server; this tool deliberately has no actor argument and remote/unbound servers refuse the write.',
      inputSchema: strict({
        id: z.string(),
        requirement_id: z.string(),
        manifest_id: z.string(),
        verdict: z.enum(['pass', 'fail', 'selection', 'revocation']),
        source: z.string(),
        revokes_decision_id: z.string().optional(),
      }),
    },
    async (input) => {
      try {
        return ok(store.recordWorkflowDecision(input));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'helmo_check_product_acceptance',
    {
      description:
        `Read the explicit product acceptance gate for one ticket. Only state "accepted" may ship. No completion is not_requested; a missing, stale, or self-authored verdict is pending; FAIL is failed. Generic ticket type and status do not affect this gate. For a process exit suitable for release scripts, use helmo-cli acceptance-check.`,
      inputSchema: strict({
        ticket_id: z.string(),
        refs: z.array(z.string()).optional().describe('Optional exact release manifest; when supplied, acceptance of any other refs remains pending/stale'),
      }),
    },
    async ({ ticket_id, refs }) => {
      try {
        return ok(store.productAcceptance(local(ticket_id), refs));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
