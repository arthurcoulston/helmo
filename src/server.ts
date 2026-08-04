#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { Actor, ACTOR_KINDS, BLAST_RADII, CONFIDENCES, DEP_TYPES, HelmError, STATUSES, Ticket } from './types.js';

const dbPath = process.env['HELM_DB'] ?? join(homedir(), '.helm', 'helm.db');
mkdirSync(join(dbPath, '..'), { recursive: true });
const store = new Store(dbPath);

const envActor: Actor | null = process.env['HELM_ACTOR'] ? (JSON.parse(process.env['HELM_ACTOR']) as Actor) : null;

const actorSchema = z
  .object({
    name: z.string(),
    kind: z.enum(ACTOR_KINDS),
    model: z.string().optional(),
    version: z.string().optional(),
    session: z.string().optional(),
  })
  .optional()
  .describe('Identity override for harnesses multiplexing many agents through one connection. Normally omit: the actor comes from HELM_ACTOR in the server environment.');

function resolveActor(override?: Actor): Actor {
  return override ?? envActor ?? ({} as Actor);
}

function ok(data: unknown, warnings: string[] = []): { content: { type: 'text'; text: string }[] } {
  const body: Record<string, unknown> = { result: data };
  if (warnings.length) body['warnings'] = warnings;
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 1) }] };
}

function fail(e: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const msg = e instanceof HelmError ? e.message : `Unexpected error: ${String(e)}`;
  return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true };
}

function compact(t: Ticket) {
  return {
    id: t.id, title: t.title, status: t.status, priority: t.priority, workstream: t.workstream,
    type: t.type, assignee: t.assignee, blast_radius: t.blast_radius, updated_at: t.updated_at,
  };
}

const server = new McpServer({ name: 'helm', version: '0.1.0' });

server.registerTool(
  'helm_create_ticket',
  {
    description:
      `Create a ticket in Helm, the shared work record for all agents and the human operator. Create a ticket whenever you start a distinct piece of work that isn't already tracked, and whenever you notice work that should happen but that you are NOT doing now (set status 'open' so another agent can pick it up; link it with dep type 'discovered_from' if you found it while working on something else — this preserves lineage without derailing you).\n\n` +
      `Write 'title' in plain human terms (one line, no jargon): the human reads it in a dashboard. Write 'body' so that a different agent with NO other context could pick the ticket up and continue — include goal, constraints, relevant paths/links, and current state. You will not be around to explain; the body is the handoff.\n\n` +
      `Returns the new ticket ID (e.g. "H-142"). Reference it in commits, files, and messages you produce for this work. For 'workstream', check existing names first (helm_list_tickets) before inventing a new one. Deps edges always point FROM this new ticket; for a reverse-direction edge (e.g. an existing ticket blocked by this new one) use helm_link_tickets after creation.`,
    inputSchema: {
      title: z.string(),
      body: z.string(),
      workstream: z.string(),
      type: z.string().describe('build|research|writing|ops|planning, or another short noun if none fit'),
      labels: z.array(z.string()).optional(),
      priority: z.number().int().min(0).max(3).optional().describe('0 critical, 1 high, 2 normal (default), 3 low'),
      status: z.enum(['open', 'in_progress']).optional().describe("'open' (default) or 'in_progress' if you are starting it now"),
      assignee: z.string().optional().describe('Reserve for a named agent without starting it; leave unset for the pool'),
      deps: z.array(z.object({ to: z.string(), type: z.enum(DEP_TYPES) })).optional(),
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
  'helm_get_ticket',
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
      const base = {
        ...t,
        blocked: store.isBlocked(ticket_id),
        deps,
        agent_chain: store.agentChain(ticket_id),
        last_answer: store.lastAnswer(ticket_id),
      };
      if (format === 'history') return ok({ ...base, events: store.getEvents(ticket_id) });
      return ok(base);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'helm_list_tickets',
  {
    description:
      `Query tickets. Key filters: ready: true (open tickets with no open blockers that are unassigned or reserved for you — use this to find work you can start), status, workstream, assignee, type, priority_max. Returns compact rows sorted by priority then age; paginated (limit default 20, cursor = offset).\n\n` +
      `Start every loop iteration with {assignee: <your name>} — this returns both work you're mid-way through (in_progress) and work handed to you that you haven't started (open + reserved). Then {ready: true} for new work. Answered questions come back as unassigned open tickets — the ready queue surfaces them; you don't need to have been the agent who asked.\n\n` +
      `Triage duty: if you pass over a ready ticket BECAUSE it needs something only the human can supply (a missing input, an unrecorded location, a decision), do not route around it silently — file its question with helm_return_to_human first (no claim needed), then take other work. Helm cannot see that kind of blockage; only you can. A known-blocked ticket left quietly in the ready queue stalls until someone else rediscovers what you already knew.`,
    inputSchema: {
      ready: z.boolean().optional(),
      status: z.enum(STATUSES).optional(),
      workstream: z.string().optional(),
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
      return ok({ tickets: tickets.map(compact), count: tickets.length, workstreams: store.listWorkstreams() });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'helm_update_ticket',
  {
    description:
      `Record progress on a ticket: status changes, notes, evidence, confidence, blast radius, token spend. Call it when reality changes, not on a timer. Every call requires a 'note': one or two lines, human terms, saying what actually happened — notes are the story the human reads.\n\n` +
      `Claiming: set status "in_progress". Only 'open' tickets can be claimed. If another agent holds the ticket you'll get an error naming the holder — pick different work rather than duplicating theirs; if their claim is stale (>24h), retry with takeover: true and say so in your note.\n\n` +
      `Finishing: set status "done" WITH evidence — the commit, file path, URL, or draft that proves the work exists. Done without evidence is a claim, not a record; it is accepted but flagged to the human. Also set confidence ('routine' = ship it, 'spot_check' = worth a glance, 'needs_review' = human should look) and, if not routine, an uncertainty_note saying specifically WHERE the doubt is — where you are uncertain is more useful than how uncertain you are.\n\n` +
      `Keep blast_radius current the moment your work touches more of the world: 'draft' (created artifacts, shared nothing), 'records' (modified records/systems, reversible), 'sent' (reached specific people), 'published' (reached the world). It never goes back down. Report tokens and/or cost_usd spent since your last update when you can.\n\n` +
      `Handing off to another agent: set handoff_to with a note saying what you did and what the receiver should do. This releases your claim and reserves the ticket for them; they'll find it via their own list call. Helm records the pass; making the receiving agent run is your harness's job. Use handoff for round trips (builder→reviewer→builder) on one piece of work; if the delegated work is its own deliverable, create a linked ticket instead.\n\n` +
      `Do NOT use this to ask the human anything — use helm_return_to_human, which exists for that.`,
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
  'helm_link_tickets',
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
  'helm_return_to_human',
  {
    description:
      `Return a ticket to the human. This is the ONLY way to ask the human anything, and it is the most important tool call you will make: the human works these in batched meetings, so a question that arrives incomplete wastes the one resource Helm exists to protect — human attention. Use it when you are blocked on a decision only the human can make, when your constitution says this action needs approval, when requirements are genuinely ambiguous — and when you notice ready work (even a ticket you are not claiming; no claim is needed) blocked on a missing human input: file its question before moving on rather than leaving it stranded in the queue. Do not use it for things another ticket, file, or tool could answer, and do not use it to report progress (that's helm_update_ticket).\n\n` +
      `One question per return; if you have two independent questions, return twice (Helm batches them for the meeting). Sets status to 'awaiting_human' and releases your claim. Do not wait for the answer — end your loop iteration or take other ready work; the answer will be on the ticket when it comes.\n\n` +
      `BAD: question: "How should I handle the venue?" GOOD: situation: "Booking the gala venue; Aldrich Hall holds our date but wants a $2k non-refundable deposit by Friday." question: "Pay the deposit?" options: [{label: "pay", consequence: "date locked, $2k sunk if we cancel"}, {label: "wait", consequence: "risk losing the date; two backup venues exist but are smaller"}] recommendation: "pay — the date matters more than the $2k and backups don't fit 200 guests." if_unanswered: "Aldrich releases the date Friday 5pm."`,
    inputSchema: {
      ticket_id: z.string(),
      situation: z.string().describe("What you were doing and where it stands — written for someone who hasn't read the ticket"),
      question: z.string().describe('The single decision needed'),
      options: z.array(z.object({ label: z.string(), consequence: z.string() })).min(2).max(4)
        .describe('2-4 options; the human should be able to answer by saying a label'),
      recommendation: z.string().describe("Which option you'd pick and why, in one sentence. You have context the human lacks; always recommend"),
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
  'helm_answer_ticket',
  {
    description:
      `Record the human's answer to a ticket in 'awaiting_human'. Normally called by the orchestrator during a meeting, relaying the human's words. Capture their reasoning, not just the choice — it teaches future agents. resolution: 'resume' (default: ticket returns to 'open', unassigned, ready for any qualified agent — the original asker was a loop iteration that no longer exists), 'done' (the human accepted the work or made it moot), 'cancelled' (the human killed it). The answer is stored on the ticket; the next agent to claim it gets the full picture via helm_get_ticket.`,
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

const transport = new StdioServerTransport();
await server.connect(transport);
