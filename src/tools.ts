import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Store } from './store.js';
import { Actor, ACTOR_KINDS, BLAST_RADII, CONFIDENCES, DEP_TYPES, HelmoError, STATUSES, Ticket, writingActor } from './types.js';

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

function ok(data: unknown, warnings: string[] = []): { content: { type: 'text'; text: string }[] } {
  const body: Record<string, unknown> = { result: data };
  if (warnings.length) body['warnings'] = warnings;
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 1) }] };
}

function fail(e: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const msg = e instanceof HelmoError ? e.message : `Unexpected error: ${String(e)}`;
  return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true };
}

function compact(t: Ticket) {
  return {
    id: t.id, title: t.title, status: t.status, priority: t.priority, workstream: t.workstream,
    type: t.type, assignee: t.assignee, blast_radius: t.blast_radius, updated_at: t.updated_at,
    ...(t.project ? { project: t.project } : {}),
    ...(t.schedule ? { schedule: t.schedule } : {}),
    ...(t.not_before ? { not_before: t.not_before } : {}),
  };
}

export function buildServer(store: Store, envActor: Actor | null): McpServer {
  const resolveActor = (override?: Actor): Actor => writingActor(override, envActor);

  const server = new McpServer({ name: 'helmo', version: '0.1.0' });

  server.registerTool(
    'helmo_create_ticket',
    {
      description:
        `Create a ticket in Helmo, the shared work record for all agents and the human operator. Create a ticket whenever you start a distinct piece of work that isn't already tracked, and whenever you notice work that should happen but that you are NOT doing now (set status 'open' so another agent can pick it up; link it with dep type 'discovered_from' if you found it while working on something else — this preserves lineage without derailing you).\n\n` +
        `Write 'title' in plain human terms (one line, no jargon): the human reads it in a dashboard. Write 'body' so that a different agent with NO other context could pick the ticket up and continue — include goal, constraints, relevant paths/links, and current state. You will not be around to explain; the body is the handoff.\n\n` +
        `Returns the new ticket ID (e.g. "H-142"). Reference it in commits, files, and messages you produce for this work. For 'workstream', check existing names first (helmo_list_tickets) before inventing a new one. Deps edges always point FROM this new ticket; for a reverse-direction edge (e.g. an existing ticket blocked by this new one) use helmo_link_tickets after creation.\n\n` +
        `Stop discipline: before filing a follow-on ticket, answer "who is waiting on this, and what will they do with it?" If the honest answer is "nobody, nothing yet", record it as residuals in the current ticket's body instead. When real loose ends remain, consolidate them into ONE follow-up ticket rather than fanning out several small ones. Note: a ticket you file does not enter YOUR OWN ready queue until a human or another agent touches it — discovery is always welcome, but executing your own discoveries takes a second pair of eyes.`,
      inputSchema: {
        title: z.string(),
        body: z.string(),
        workstream: z.string(),
        type: z.string().describe('build|research|writing|ops|planning, or another short noun if none fit'),
        project: z.string().optional().describe('Optional grouping tag for work that belongs to a named project (e.g. a roadmap project id like "R-4") — how cost and progress roll up. Routine work needs none.'),
        labels: z.array(z.string()).optional(),
        priority: z.number().int().min(0).max(3).optional().describe('0 critical, 1 high, 2 normal (default), 3 low'),
        status: z.enum(['open', 'in_progress']).optional().describe("'open' (default) or 'in_progress' if you are starting it now. Starting your own ticket in the same call is legitimate; once it sits as open backlog, the triage rule holds it from you until a human or another agent touches it"),
        assignee: z.string().optional().describe('Reserve for a named agent without starting it; leave unset for the pool'),
        not_before: z.string().optional().describe(
          "Withhold this ticket from ready queues until a date — 'YYYY-MM-DD' (opens 00:00 UTC that day) or a full ISO instant. Use it when the work genuinely CANNOT start yet: it needs a week of data, a deadline has to pass, a dependency lands on a known day. Without it the only way to say so is shouting in the body, and every agent reading the queue pays a full ticket read to learn it must not act. This is not priority — priority says how much the work matters, not whether it can be started.",
        ),
        deps: z.array(z.object({ to: z.string(), type: z.enum(DEP_TYPES) })).optional(),
        schedule: z.string().optional().describe(
          "Makes this a RECURRING TEMPLATE: 'every <N><m|h|d>' or 5-field cron (UTC). The template itself is standing work — never ready, never claimed. Due instances spawn automatically on queue reads, linked to the template via a parent dep, and a new instance is skipped while a previous one is still open. Retire the template by cancelling it.",
        ),
        actor: actorSchema,
      },
    },
    async ({ actor, ...input }) => {
      try {
        const t = store.createTicket(resolveActor(actor as Actor | undefined), input);
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
        `Fetch one ticket by ID. format "state" (default) returns current fields plus any pending question and the last human answer — enough to work. format "history" additionally returns the full event log (who did what, when, with diffs) — use it when resuming unfamiliar work, investigating, or preparing a meeting.`,
      inputSchema: {
        ticket_id: z.string(),
        format: z.enum(['state', 'history']).optional(),
      },
    },
    async ({ ticket_id, format }) => {
      try {
        const t = store.getTicket(ticket_id);
        const deps = store.getDeps(ticket_id);
        const ws = store.getWorkstreamInfo(t.workstream);
        const base = {
          ...t,
          blocked: store.isBlocked(ticket_id),
          deps,
          agent_chain: store.agentChain(ticket_id),
          last_answer: store.lastAnswer(ticket_id),
          product_acceptance: store.productAcceptance(ticket_id),
          // The stream's steering rides along so the claimer weighs the ticket
          // against the goal and budget before spending anything (H-55).
          ...(ws.goal || ws.budget_usd !== null
            ? { workstream_steering: { ...(ws.goal ? { goal: ws.goal } : {}), ...(ws.budget_usd !== null ? { budget_usd: ws.budget_usd, spent_usd: ws.spent_usd, remaining_usd: ws.remaining_usd } : {}) } }
            : {}),
        };
        if (format === 'history') return ok({ ...base, events: store.getEvents(ticket_id) });
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
        `The response's 'workstreams' carry the human's steering where set: 'goal' states what done means for the whole stream — check candidate work against it, and treat a met goal as a stop signal, not an invitation to polish; 'budget_usd'/'spent_usd'/'remaining_usd' disclose the stream's budget, which is a plan — front-load the highest-value work so stopping at any point is safe. Ready-queue triage rule: tickets you filed yourself are withheld from your own ready queue until a human or another agent touches them; they appear under 'awaiting_triage' (and stay available to everyone else). Date gate: a ticket carrying 'not_before' is withheld from every ready queue until that instant and listed under 'gated' with its release date — so passing over it costs you one line, not a ticket read.`,
      inputSchema: {
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
      },
    },
    async ({ actor, ...filter }) => {
      try {
        const caller = resolveActor(actor as Actor | undefined)?.name;
        const tickets = store.listTickets({ ...filter, caller });
        const workstreams = store.listWorkstreamInfo().map((w) => ({
          name: w.name,
          ...(w.goal ? { goal: w.goal } : {}),
          ...(w.budget_usd !== null ? { budget_usd: w.budget_usd, spent_usd: w.spent_usd, remaining_usd: w.remaining_usd } : {}),
        }));
        const awaitingTriage = filter.ready && caller ? store.selfFiledPending(caller) : [];
        // Withheld, not hidden (H-732): the gate says come back on this date,
        // which is the whole saving — one line instead of a ticket read.
        const gated = filter.ready && caller ? store.gatedPending(caller) : [];
        // The standing notice rides along like workstream steering (H-172):
        // the human's one-line current priority, disclosure not tasking.
        const notice = store.getNotice();
        return ok({
          tickets: tickets.map(compact),
          count: tickets.length,
          workstreams,
          ...(notice ? { notice } : {}),
          ...(awaitingTriage.length ? { awaiting_triage: awaitingTriage } : {}),
          ...(gated.length ? { gated } : {}),
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
        `Record progress on a ticket: status changes, notes, evidence, confidence, blast radius, token spend. Call it when reality changes, not on a timer. Every call requires a 'note': one or two lines, human terms, saying what actually happened — notes are the story the human reads.\n\n` +
        `Claiming: set status "in_progress". Only 'open' tickets can be claimed. If another agent holds the ticket you'll get an error naming the holder — pick different work rather than duplicating theirs; if their claim is stale (>24h), retry with takeover: true and say so in your note. A ticket you filed yourself that nobody else has touched cannot be claimed by you at all — the triage rule that withholds it from your ready queue also rejects the direct claim, and takeover does not bypass it. The boundary is deliberate: creating a ticket with status 'in_progress' ("I am doing this now") is legitimate; the triage rule guards backlog you filed and later drew back, not work you start in the same breath.\n\n` +
        `Finishing: set status "done" WITH evidence — the commit, file path, URL, or draft that proves the work exists. Done without evidence is a claim, not a record; it is accepted but flagged to the human. Write refs so a stranger can follow them months from now: commits as repo@sha (crew@24e8003 — a bare sha does not say WHICH repo), one commit per item; files as an absolute path or repo:relative/path, never bare-relative; URLs as they are. Prose goes in the item's own 'note' — a clause on what the ref demonstrates — never inside 'ref'. Also set confidence ('routine' = ship it, 'spot_check' = worth a glance, 'needs_review' = human should look) and, if not routine, an uncertainty_note saying specifically WHERE the doubt is — where you are uncertain is more useful than how uncertain you are.\n\n` +
        `Keep blast_radius current the moment your work touches more of the world: 'draft' (created artifacts, shared nothing), 'records' (modified records/systems, reversible), 'sent' (reached specific people), 'published' (reached the world). It never goes back down. Report tokens and/or cost_usd only for numbers you actually measured — a usage readout you saw. Never estimate your own session's spend, and if you run as a supervised loop, do not self-report at all: the harness meters the session and writes real spend after it ends, so a guessed figure double-counts against the budget the human steers by.\n\n` +
        `Handing off to another agent: set handoff_to with a note saying what you did and what the receiver should do. This releases your claim and reserves the ticket for them; they'll find it via their own list call. Helmo records the pass; making the receiving agent run is your harness's job. Use handoff for round trips (builder→reviewer→builder) on one piece of work; if the delegated work is its own deliverable, create a linked ticket instead.\n\n` +
        `Stopping well: when the marginal value of continuing drops — ask "what did the last stretch of work actually buy, and who is waiting for more?" — close the ticket with the residual loose ends documented in the body rather than pushing on. Closing at diminishing returns is a success state, not a failure. If the workstream discloses a budget, treat it as the plan: front-load the highest-value work, and when it is spent, close out honestly instead of continuing quietly.\n\n` +
        `Do NOT use this to ask the human anything — use helmo_return_to_human, which exists for that.`,
      inputSchema: {
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
        priority: z.number().int().min(0).max(3).optional(),
        labels: z.array(z.string()).optional(),
        workstream: z.string().optional(),
        project: z.string().optional().describe("Set or change the project tag; '' clears it"),
        not_before: z.string().optional().describe("Set or move the date gate that withholds this ticket from ready queues — 'YYYY-MM-DD' or a full ISO instant; '' opens it now"),
        actor: actorSchema,
      },
    },
    async ({ actor, ...input }) => {
      try {
        const { ticket, warnings } = store.updateTicket(resolveActor(actor as Actor | undefined), input);
        return ok(compact(ticket), warnings);
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
      inputSchema: {
        from_id: z.string(),
        to_id: z.string(),
        type: z.enum(DEP_TYPES),
        action: z.enum(['add', 'remove']).optional().describe("default 'add'"),
        actor: actorSchema,
      },
    },
    async ({ from_id, to_id, type, action, actor }) => {
      try {
        store.linkTickets(resolveActor(actor as Actor | undefined), from_id, to_id, type, action ?? 'add');
        return ok({ linked: action !== 'remove', from_id, to_id, type });
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
        `SHAPE OF THE ASK (H-939). The human reads these in a meeting and answers out loud, so a return is two parts. First the ISSUE — 'situation' then 'question' — enough that he can decide without reconstructing the ticket's history, and no more. Then EITHER your recommendation on its own, which is the normal case, OR two or three genuinely equal choices he can pick by saying a letter. Do not manufacture alternatives: options are for when the choice is really open, and a second course invented to fill the field costs him the same attention as a real one.\n\n` +
        `GOOD, recommendation standing alone: situation: "The staging deploy has been red for two days; the failing step is a lint rule we added last week and nothing else." question: "Turn the rule off for now?" recommendation: "yes — it is our own rule, it caught nothing real, and it is blocking every deploy." if_unanswered: "Nothing reaches staging until this clears."\n\n` +
        `GOOD, a real choice: situation: "Booking the gala venue; Aldrich Hall holds our date but wants a $2k non-refundable deposit by Friday." question: "Pay the deposit?" options: [{label: "pay", consequence: "date locked, $2k sunk if we cancel"}, {label: "wait", consequence: "risk losing the date; two backup venues exist but are smaller"}] recommendation: "pay — the date matters more than the $2k and backups don't fit 200 guests." if_unanswered: "Aldrich releases the date Friday 5pm."\n\n` +
        `BAD: question: "How should I handle the venue?" — no situation, no decision, nothing to say back.`,
      inputSchema: {
        ticket_id: z.string(),
        situation: z.string().describe("What you were doing and where it stands — written for someone who hasn't read the ticket"),
        question: z.string().describe('The single decision needed'),
        options: z.array(z.object({ label: z.string(), consequence: z.string() })).min(2).max(3).optional()
          .describe('Omit when your recommendation is the answer. Include only for a genuinely open choice: 2 or 3, each {label, consequence}, answerable by saying a letter'),
        recommendation: z.string().describe('Always required: the action you recommend, or the specific thing you need from the human, in one sentence. You have context they lack'),
        if_unanswered: z.string().optional().describe('What happens if no answer comes — cost of delay, deadlines, what it blocks'),
        actor: actorSchema,
      },
    },
    async ({ ticket_id, actor, ...q }) => {
      try {
        const t = store.returnToHuman(resolveActor(actor as Actor | undefined), ticket_id, q);
        return ok({ ticket: compact(t), queued: 'awaiting_human' });
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
      inputSchema: {
        ticket_id: z.string(),
        answer: z.string().describe("The decision plus any new constraints or context the human added — their reasoning, not just the choice"),
        chosen_option: z.string().optional().describe('Label of the chosen option, if the human picked one'),
        resolution: z.enum(['resume', 'done', 'cancelled']).optional(),
        actor: actorSchema,
      },
    },
    async ({ ticket_id, actor, resolution, ...a }) => {
      try {
        const t = store.answerTicket(resolveActor(actor as Actor | undefined), ticket_id, { ...a, resolution: resolution ?? 'resume' });
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
        `Set a workstream's goal ("done means…") and/or budget_usd — the human's steering surface. Call this ONLY to relay a decision the human stated explicitly; the write requires actor kind 'human' or 'orchestrator', and agent-kind writes are rejected: an agent must never set or raise the goal or budget of the stream it draws work from.\n\n` +
        `The goal is what lets every agent answer "is this stream's purpose already met?" — phrase it as the end state, not activities (e.g. "the operator has a confirmed, emailable outreach shortlist", not "research contacts"). The budget is a disclosed plan, not a kill switch: agents see remaining balance on every queue read and are expected to front-load the highest-value work and close out honestly when it is spent. Partial updates are fine — a field you omit keeps its current value.`,
      inputSchema: {
        name: z.string().describe('The workstream being steered'),
        goal: z.string().optional().describe('What done means for the whole stream, as an end state'),
        budget_usd: z.number().min(0).optional().describe('Total budget for the stream in USD; spend already recorded counts against it'),
        actor: actorSchema,
      },
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
    'helmo_set_notice',
    {
      description:
        `Set or clear the standing notice: ONE line of current priority with its provenance, carried on every helmo_list_tickets response the way workstream steering is. Call it ONLY to relay a decision the human stated explicitly (e.g. their ship-next call on the roadmap); the write requires actor kind 'human' or 'orchestrator', and agent-kind writes are rejected — an agent must never broadcast its own priority to the fleet.\n\n` +
        `The notice is disclosure, not tasking: agents reading it learn what the human currently wants shipped, and weigh their choice of ready work accordingly — it does not authorize starting anything. Write provenance so a stranger can trace the decision ("ship_next R-4, decided by Arthur 2026-08-24, recorded by mason"). Empty text clears the notice.`,
      inputSchema: {
        text: z.string().describe("The one-line current priority; '' clears it"),
        provenance: z.string().describe('Who decided and what recorded it'),
        actor: actorSchema,
      },
    },
    async ({ actor, ...input }) => {
      try {
        return ok({ notice: store.setNotice(resolveActor(actor as Actor | undefined), input) });
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
      inputSchema: {
        ticket_id: z.string(),
        artifacts: z.array(z.object({ ref: z.string(), author: z.string() })).min(1),
        note: z.string(),
        actor: actorSchema,
      },
    },
    async ({ actor, ...input }) => {
      try {
        return ok(store.recordProductCompletion(resolveActor(actor as Actor | undefined), input));
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
      inputSchema: {
        ticket_id: z.string(),
        refs: z.array(z.string()).min(1),
        verdict: z.enum(['pass', 'fail']),
        note: z.string(),
        actor: actorSchema,
      },
    },
    async ({ actor, ...input }) => {
      try {
        return ok(store.recordAcceptanceVerdict(resolveActor(actor as Actor | undefined), input));
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
      inputSchema: {
        ticket_id: z.string(),
        refs: z.array(z.string()).optional().describe('Optional exact release manifest; when supplied, acceptance of any other refs remains pending/stale'),
      },
    },
    async ({ ticket_id, refs }) => {
      try {
        return ok(store.productAcceptance(ticket_id, refs));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
