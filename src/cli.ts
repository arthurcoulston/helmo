#!/usr/bin/env node
// helmo-cli — programmatic access to the Helmo store for non-MCP writers:
// harnesses (Rev), scripts, and script-runner agents. Same actor rules as
// the MCP server: writes require an identity (HELMO_ACTOR env or --actor JSON).
// The binary is `helmo-cli`, matching its siblings `helmo-mcp` and `helmo-view`.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { Actor, DepType, HelmoError } from './types.js';

const args = process.argv.slice(2);
const cmd = args.shift();

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return args[i + 1];
}
function has(name: string): boolean {
  return args.includes(`--${name}`);
}

const store = new Store(process.env['HELMO_DB'] ?? join(homedir(), '.helmo', 'helmo.db'));

function actor(): Actor {
  const raw = flag('actor') ?? process.env['HELMO_ACTOR'];
  if (!raw) {
    throw new HelmoError('No actor. Set HELMO_ACTOR env or pass --actor \'{"name":"...","kind":"agent","model":"...","version":"..."}\'.');
  }
  return JSON.parse(raw) as Actor;
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 1));
}

try {
  switch (cmd) {
    case 'wake-check': {
      // The harness idle poll: one call answers "should this loop wake, and at
      // what cursor should it re-idle." Zero tokens, and read-only in what it
      // REPORTS — but not in what it does: opening a Store migrates, so this
      // takes the write lock like any other call (H-134).
      const since = Number(flag('since-seq') ?? 0);
      const workstream = flag('workstream');
      const assignee = flag('assignee');
      out({
        max_seq: store.maxSeq(),
        ready_count: store.readyCount(workstream, assignee),
        changed_since: store.scopeChangedSince(since, workstream, assignee),
      });
      break;
    }
    case 'purge-orphan': {
      // Repair path for a row written outside Helmo (H-448). Refuses anything
      // with history, prints what it removed so the deletion is recoverable,
      // and requires --confirm because it is the one destructive command here.
      const id = flag('ticket');
      if (!id) throw new HelmoError('purge-orphan requires --ticket H-n');
      if (!has('confirm')) {
        const n = store.hygiene().filter((f) => f.check === 'orphan_ticket' && f.ticket_id === id).length;
        throw new HelmoError(
          `purge-orphan removes ${id} permanently. It is ${n ? '' : 'NOT '}currently reported as an orphan by hygiene. Re-run with --confirm; the removed row is printed so it can be put back.`,
        );
      }
      out({ purged: store.purgeOrphan(id) });
      break;
    }
    case 'actor-activity': {
      const name = flag('name');
      if (!name) throw new HelmoError('actor-activity requires --name <actor name>');
      out({ events: store.actorActivitySince(name, Number(flag('since-seq') ?? 0), has('advancing')) });
      break;
    }
    case 'hygiene': {
      out({ findings: store.hygiene() });
      break;
    }
    case 'hygiene-dispose': {
      store.disposeHygieneFinding(actor(), { check: req('check'), ticket_id: req('ticket'), reason: req('reason') });
      out({ disposed: `${flag('check')} on ${flag('ticket')}` });
      break;
    }
    case 'workstream': {
      // Read-only: Rev fetches this per iteration to put the goal and
      // remaining budget in front of the loop agent (H-55).
      const name = flag('name');
      if (!name) throw new HelmoError('workstream requires --name <workstream>');
      out(store.getWorkstreamInfo(name));
      break;
    }
    case 'workstream-set': {
      out(
        store.setWorkstream(actor(), {
          name: req('name'),
          goal: flag('goal'),
          budget_usd: flag('budget-usd') !== undefined ? Number(flag('budget-usd')) : undefined,
        }),
      );
      break;
    }
    case 'actor-tickets': {
      const name = flag('name');
      if (!name) throw new HelmoError('actor-tickets requires --name <actor name>');
      out({ tickets: store.actorTicketsSince(name, Number(flag('since-seq') ?? 0)) });
      break;
    }
    case 'rename-workstream': {
      out(store.renameWorkstream(actor(), { from: req('from'), to: req('to'), note: req('note') }));
      break;
    }
    case 'actor-spend': {
      const name = flag('name');
      if (!name) throw new HelmoError('actor-spend requires --name <actor name>');
      const since = Number(flag('since-seq') ?? 0);
      out({ ...store.actorSelfSpendSince(name, since), by_ticket: store.actorSelfSpendByTicketSince(name, since) });
      break;
    }
    case 'record-spend': {
      const t = store.recordSpend(actor(), req('ticket'), {
        tokens: flag('tokens') !== undefined ? Number(flag('tokens')) : undefined,
        cost_usd: flag('cost-usd') !== undefined ? Number(flag('cost-usd')) : undefined,
        note: req('note'),
      });
      out({ id: t.id, tokens_total: t.tokens_total, cost_usd_total: t.cost_usd_total });
      break;
    }
    case 'list': {
      const tickets = store.listTickets({
        ready: has('ready') ? true : undefined,
        status: flag('status') as never,
        workstream: flag('workstream'),
        assignee: flag('assignee'),
        caller: actorSafe()?.name,
        limit: Number(flag('limit') ?? 20),
      });
      out({ tickets: tickets.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, workstream: t.workstream, assignee: t.assignee })) });
      break;
    }
    case 'get': {
      const id = flag('ticket') ?? args[0];
      if (!id) throw new HelmoError('get requires a ticket id');
      out({ ...store.getTicket(id), last_answer: store.lastAnswer(id), agent_chain: store.agentChain(id) });
      break;
    }
    case 'create': {
      const t = store.createTicket(actor(), {
        title: req('title'),
        body: req('body'),
        workstream: req('workstream'),
        type: req('type'),
        priority: flag('priority') !== undefined ? Number(flag('priority')) : undefined,
        status: (flag('status') as 'open' | 'in_progress') ?? undefined,
        assignee: flag('assignee'),
        deps: flag('dep') ? [{ to: flag('dep')!, type: (flag('dep-type') as DepType) ?? 'relates' }] : undefined,
        schedule: flag('schedule'),
      });
      out({ id: t.id });
      break;
    }
    case 'update': {
      const { ticket, warnings } = store.updateTicket(actor(), {
        ticket_id: req('ticket'),
        note: req('note'),
        status: flag('status') as never,
        evidence: flag('evidence-ref') ? [{ kind: (flag('evidence-kind') as never) ?? 'other', ref: flag('evidence-ref')! }] : undefined,
        confidence: flag('confidence') as never,
        uncertainty_note: flag('uncertainty-note'),
        blast_radius: flag('blast-radius') as never,
        tokens: flag('tokens') !== undefined ? Number(flag('tokens')) : undefined,
        cost_usd: flag('cost-usd') !== undefined ? Number(flag('cost-usd')) : undefined,
        handoff_to: flag('handoff-to'),
        takeover: has('takeover'),
      });
      out({ id: ticket.id, status: ticket.status, warnings });
      break;
    }
    case 'return': {
      const t = store.returnToHuman(actor(), req('ticket'), {
        situation: req('situation'),
        question: req('question'),
        options: JSON.parse(req('options')),
        recommendation: req('recommendation'),
        if_unanswered: flag('if-unanswered'),
      });
      out({ id: t.id, status: t.status });
      break;
    }
    default:
      console.error(`usage: helmo-cli <command> [flags]
  wake-check     --workstream W --assignee A --since-seq N     (read-only harness poll)
  purge-orphan   --ticket H-n --confirm                          (remove a row with NO events — a write that came from outside)
  actor-activity --name A --since-seq N [--advancing]          (did this actor write events? --advancing: only ones that moved something)
  actor-tickets  --name A --since-seq N                        (which tickets, most-touched first)
  actor-spend    --name A --since-seq N                        (spend A self-reported in the window, total + by_ticket)
  record-spend   --ticket H-n [--tokens N] [--cost-usd X] --note N   (metered spend; terminal tickets accepted)
  list           [--ready] [--status S] [--workstream W] [--assignee A] [--limit N]
  get            <ticket-id>
  hygiene                                                      (deterministic record checks, read-only)
  hygiene-dispose --check C --ticket H-n --reason R  (stop re-reporting a finding on a TERMINAL ticket; evented, append-once)
  workstream     --name W                                      (goal, budget, spend-to-date; read-only)
  rename-workstream --from X --to Y --note N   (relabel every ticket incl. closed; one evented rename)
  workstream-set --name W [--goal G] [--budget-usd X]          (operator steering; actor kind human/orchestrator only)
  create         --title T --body B --workstream W --type TY [--priority P] [--status S] [--assignee A] [--dep H-n --dep-type TY] [--schedule 'every 30m' | '0 0 * * *']
  update         --ticket H-n --note N [--status S] [--evidence-kind K --evidence-ref R] [--confidence C] [--blast-radius B] [--tokens N] [--cost-usd X] [--handoff-to A] [--takeover]
  return         --ticket H-n --situation S --question Q --options '[{"label":..,"consequence":..}]' --recommendation R [--if-unanswered U]
Writes read identity from HELMO_ACTOR env or --actor JSON. DB path from HELMO_DB (default ~/.helmo/helmo.db).`);
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(JSON.stringify({ error: e instanceof HelmoError ? e.message : String(e) }));
  process.exit(1);
} finally {
  store.close();
}

function req(name: string): string {
  const v = flag(name);
  if (v === undefined) throw new HelmoError(`--${name} is required for '${cmd}'`);
  return v;
}
function actorSafe(): Actor | undefined {
  try {
    return actor();
  } catch {
    return undefined;
  }
}
