#!/usr/bin/env node
// helmo-cli — programmatic access to the Helmo store for non-MCP writers:
// harnesses (Rev), scripts, and script-runner agents. Same actor rules as
// the MCP server: writes require an identity (HELMO_ACTOR env or --actor JSON).
// The binary is `helmo-cli`, matching its siblings `helmo-mcp` and `helmo-view`.
import { installationRef, requireInstallation } from './install.js';
import { localRecordRef } from './reference.js';
import { Store } from './store.js';
import { Actor, DepType, HelmoError, writingActor } from './types.js';

const args = process.argv.slice(2);
const cmd = args.shift();

// Every flag each command understands. The other half of the same silence
// (R-39 Q9): an undeclared flag used to be dropped without a word, so
// `create --project R-41` filed an untagged ticket and `update --assinee mason`
// reserved nothing, both reporting success. The CLI genuinely has no flag for
// several fields the MCP surface takes (H-2225) — a gap you could only find by
// reading the source. Now it says so. `--actor` is understood everywhere; on
// `verdicts` it names the reviewer to filter on rather than the writer.
// The matching rule on the MCP side is the strict input schema in tools.ts.
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  'wake-check': ['since-seq', 'workstream', 'assignee'],
  'seat-check': ['assignee'],
  'purge-orphan': ['ticket', 'confirm'],
  'actor-activity': ['name', 'since-seq', 'session', 'advancing'],
  'actor-tickets': ['name', 'since-seq', 'session'],
  'actor-spend': ['name', 'since-seq', 'session'],
  answers: ['since-seq', 'session'],
  verdicts: ['since-seq', 'workstream'],
  hygiene: [],
  'hygiene-dispose': ['check', 'ticket', 'reason'],
  workstream: ['name'],
  'workstream-set': ['name', 'budget-usd', 'seat'],
  'rename-workstream': ['from', 'to', 'note'],
  'record-spend': ['ticket', 'tokens', 'cost-usd', 'note'],
  list: ['ready', 'status', 'workstream', 'assignee', 'limit'],
  get: ['ticket'],
  'product-complete': ['ticket', 'artifacts', 'note'],
  'acceptance-verdict': ['ticket', 'refs', 'verdict', 'note'],
  'acceptance-check': ['ticket', 'refs'],
  create: ['title', 'body', 'workstream', 'type', 'priority', 'status', 'assignee', 'dep', 'dep-type', 'schedule', 'not-before', 'needs-human', 'sitting-with'],
  update: ['ticket', 'note', 'status', 'evidence-kind', 'evidence-ref', 'confidence', 'uncertainty-note', 'blast-radius', 'tokens', 'cost-usd', 'handoff-to', 'not-before', 'needs-human', 'sitting-with', 'no-needs-human', 'takeover', 'body-append', 'body-old', 'body-new'],
  return: ['ticket', 'situation', 'question', 'options', 'recommendation', 'if-unanswered'],
  action: ['ticket', 'situation', 'action', 'why-human', 'if-unanswered'],
  'action-report': ['ticket', 'did'],
};

// `--actor` says who is writing; `--installation` says which Helmo this command
// is about (H-2474). Both are understood everywhere, so neither table entry has
// to repeat them.
function allowedFlags(command: string): string[] {
  return [...(COMMAND_FLAGS[command] ?? []), 'actor', 'installation'];
}

/** Refuse an argv flag the command has no field for, before anything is
 *  written. Every `--`-prefixed token is a flag and never a value: a value
 *  beginning with `--` has to arrive through `--name=value` (see `flag`). */
function checkKnownFlags(command: string): void {
  const allowed = new Set(allowedFlags(command));
  const unknown = args
    .filter((a) => a.startsWith('--'))
    .map((a) => a.slice(2).split('=')[0] ?? '')
    .filter((n) => !allowed.has(n));
  if (unknown.length) {
    throw new HelmoError(
      `'${command}' does not understand ${unknown.map((n) => `--${n}`).join(', ')}. It takes: ${allowedFlags(command).sort().map((n) => `--${n}`).join(' ')}. ` +
        'A flag with no field behind it used to be dropped in silence and the write reported success with that field unset. For a field helmo-cli has no flag for, go through the MCP server.',
    );
  }
}

/** The other direction, so the table cannot drift behind the code: a command
 *  that reads a flag it does not declare would refuse every caller who passed
 *  it. This fires in the suite, not in front of a user. */
function declared(name: string): void {
  if (cmd && COMMAND_FLAGS[cmd] && !allowedFlags(cmd).includes(name)) {
    throw new HelmoError(`Internal: '${cmd}' reads --${name} but does not list it in COMMAND_FLAGS, so a caller passing it is refused.`);
  }
}

// A flag that takes a value must be given one. Written bare — `--needs-human`
// as the last argument, or immediately before another flag — it used to read
// as undefined, indistinguishable from never passed, so the write succeeded
// with the field silently unset (H-1782, H-1783). `--name=value` is the escape
// hatch for a value that itself begins with `--`.
function flag(name: string): string | undefined {
  declared(name);
  const prefix = `--${name}=`;
  const inline = args.find((a) => a.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new HelmoError(
      `--${name} was given no value. Put the value after the flag, or write --${name}=<value> if the value itself starts with '--'.`,
    );
  }
  return value;
}
// The mirror image for a flag that takes none: `--takeover=true` would be
// ignored by an `includes` check, which is the same silence from the other side.
function has(name: string): boolean {
  declared(name);
  if (args.some((a) => a.startsWith(`--${name}=`))) {
    throw new HelmoError(`--${name} takes no value — pass it bare.`);
  }
  return args.includes(`--${name}`);
}

// The target is resolved and ASSERTED before the store is opened, because
// opening one migrates it (H-134) — a command aimed at the wrong installation
// has already written by the time it runs. `flag` is safe to call here: an
// undeclared flag is refused below, and `--installation` is declared for every
// command.
const install = requireInstallation(process.env, (error) => {
  console.error(JSON.stringify({ error }));
  process.exit(1);
}, flagBeforeStore('installation'));
const store = new Store(install.db, install);

/** `flag`, but a malformed flag reports in the CLI's JSON shape rather than
 *  reaching the try/catch that has not started yet. */
function flagBeforeStore(name: string): string | undefined {
  try {
    return flag(name);
  } catch (e) {
    console.error(JSON.stringify({ error: e instanceof HelmoError ? e.message : String(e) }));
    process.exit(1);
  }
}

function actor(): Actor {
  const override = flag('actor');
  const env = process.env['HELMO_ACTOR'];
  if (!override && !env) {
    throw new HelmoError('No actor. Set HELMO_ACTOR env or pass --actor \'{"name":"...","kind":"agent","model":"...","version":"..."}\'.');
  }
  // --actor says who is writing; the environment says which process it came
  // through, and keeps the seat stamp when both are present (H-687).
  return writingActor(
    override ? (JSON.parse(override) as Actor) : undefined,
    env ? (JSON.parse(env) as Actor) : null,
  );
}

// Every result names the installation it read or wrote (H-2474). It goes IN the
// object rather than on a line above it: the CLI's contract is that everything
// it prints parses, and a caller reading fields it asked for is unaffected by
// one more.
function out(data: unknown): void {
  console.log(JSON.stringify({ installation: installationRef(install, store.installationIdentity()), ...(data as object) }, null, 1));
}

try {
  // Before any command reads a flag, and so before any write: an unrecognized
  // flag is a refusal, not a shrug. An unrecognized COMMAND still falls through
  // to the usage text below.
  if (cmd && COMMAND_FLAGS[cmd]) checkKnownFlags(cmd);
  switch (cmd) {
    case 'wake-check': {
      // The harness idle poll: one call answers "should this loop wake, and at
      // what cursor should it re-idle." Zero tokens, and read-only in what it
      // REPORTS — but not in what it does: opening a Store migrates, so this
      // takes the write lock like any other call (H-134).
      const since = Number(flag('since-seq') ?? 0);
      out(store.wakeCheck(since, flag('workstream'), flag('assignee')));
      break;
    }
    case 'seat-check': {
      // Who holds in_progress work in this name, and which session claimed it —
      // rev's same-seat guard (H-558) reads this before spending an iteration,
      // so a loop and a desk session sharing a crew name stop colliding.
      out({ holds: store.seatHolds(req('assignee')) });
      break;
    }
    case 'purge-orphan': {
      // Repair path for a row written outside Helmo (H-448). Refuses anything
      // with history, prints what it removed so the deletion is recoverable,
      // and requires --confirm because it is the one destructive command here.
      const id = ticketRefOpt(flag('ticket'));
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
      out({ events: store.actorActivitySince(name, Number(flag('since-seq') ?? 0), has('advancing'), flag('session')) });
      break;
    }
    case 'answers': {
      // The daily sweep's dashboard-answer replay (H-143, H-936). max_seq is
      // returned alongside so the caller can advance its checkpoint from the
      // same read instead of opening the store file to ask.
      out({
        max_seq: store.maxSeq(),
        answers: store.answersSince(Number(flag('since-seq') ?? 0), flag('session')),
      });
      break;
    }
    case 'verdicts': {
      // The daily sweep's acceptance-verdict replay (H-1830). A verdict is
      // what lets reviewed work through, and it is written in the reviewer's
      // name by a caller-supplied actor — so every one gets shown back to the
      // reviewer it names. max_seq rides along for the same reason as
      // 'answers': the checkpoint advances from this read, not a second one.
      // Every other command reads --actor as the writer's identity JSON.
      // Here it names the reviewer to filter on, so an identity passed out of
      // habit would match no name and quietly return nothing (H-1830).
      const reviewer = flag('actor');
      if (reviewer?.trimStart().startsWith('{')) {
        throw new HelmoError("verdicts --actor takes a reviewer's NAME, not an identity JSON — this command is read-only and needs no identity.");
      }
      out({
        max_seq: store.maxSeq(),
        verdicts: store.verdictsSince(Number(flag('since-seq') ?? 0), reviewer, flag('workstream')),
      });
      break;
    }
    case 'hygiene': {
      out({ findings: store.hygiene() });
      break;
    }
    case 'hygiene-dispose': {
      const disposedOn = ticketRef('ticket');
      store.disposeHygieneFinding(actor(), { check: req('check'), ticket_id: disposedOn, reason: req('reason') });
      out({ disposed: `${flag('check')} on ${disposedOn}` });
      break;
    }
    case 'workstream': {
      // Read-only: Rev fetches this per iteration to put the remaining
      // budget in front of the loop agent (H-55).
      const name = flag('name');
      if (!name) throw new HelmoError('workstream requires --name <workstream>');
      out(store.getWorkstreamInfo(name));
      break;
    }
    case 'workstream-set': {
      out(
        store.setWorkstream(actor(), {
          name: req('name'),
          budget_usd: flag('budget-usd') !== undefined ? Number(flag('budget-usd')) : undefined,
          seat: flag('seat'),
        }),
      );
      break;
    }
    case 'actor-tickets': {
      const name = flag('name');
      if (!name) throw new HelmoError('actor-tickets requires --name <actor name>');
      out({ tickets: store.actorTicketsSince(name, Number(flag('since-seq') ?? 0), flag('session')) });
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
      const session = flag('session');
      out({ ...store.actorSelfSpendSince(name, since, session), by_ticket: store.actorSelfSpendByTicketSince(name, since, session) });
      break;
    }
    case 'record-spend': {
      const t = store.recordSpend(actor(), ticketRef('ticket'), {
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
      const id = ticketRefOpt(flag('ticket') ?? args[0]);
      if (!id) throw new HelmoError('get requires a ticket id');
      out({ ...store.getTicket(id), last_answer: store.lastAnswer(id), agent_chain: store.agentChain(id), product_acceptance: store.productAcceptance(id) });
      break;
    }
    case 'product-complete': {
      out(store.recordProductCompletion(actor(), {
        ticket_id: ticketRef('ticket'),
        artifacts: JSON.parse(req('artifacts')),
        note: req('note'),
      }));
      break;
    }
    case 'acceptance-verdict': {
      out(store.recordAcceptanceVerdict(actor(), {
        ticket_id: ticketRef('ticket'),
        refs: JSON.parse(req('refs')),
        verdict: req('verdict') as 'pass' | 'fail',
        note: req('note'),
      }));
      break;
    }
    case 'acceptance-check': {
      const acceptance = store.productAcceptance(ticketRef('ticket'), flag('refs') ? JSON.parse(flag('refs')!) : undefined);
      out(acceptance);
      if (acceptance.state !== 'accepted') process.exitCode = 1;
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
        deps: flag('dep') ? [{ to: ticketRef('dep'), type: (flag('dep-type') as DepType) ?? 'relates' }] : undefined,
        schedule: flag('schedule'),
        not_before: flag('not-before'),
        needs_human: flag('needs-human'),
        sitting_with: flag('sitting-with'),
      });
      out({ id: t.id });
      break;
    }
    case 'update': {
      const bodyOld = flag('body-old');
      const bodyNew = flag('body-new');
      if ((bodyOld === undefined) !== (bodyNew === undefined)) {
        throw new HelmoError('--body-old and --body-new must be passed together.');
      }
      const { ticket, warnings } = store.updateTicket(actor(), {
        ticket_id: ticketRef('ticket'),
        note: req('note'),
        status: flag('status') as never,
        evidence: flag('evidence-ref') ? [{ kind: (flag('evidence-kind') as never) ?? 'other', ref: flag('evidence-ref')! }] : undefined,
        confidence: flag('confidence') as never,
        uncertainty_note: flag('uncertainty-note'),
        blast_radius: flag('blast-radius') as never,
        tokens: flag('tokens') !== undefined ? Number(flag('tokens')) : undefined,
        cost_usd: flag('cost-usd') !== undefined ? Number(flag('cost-usd')) : undefined,
        handoff_to: flag('handoff-to'),
        not_before: flag('not-before'),
        needs_human: has('no-needs-human') ? false : flag('needs-human'),
        sitting_with: flag('sitting-with'),
        takeover: has('takeover') ? true : undefined,
        body_append: flag('body-append'),
        body_patch: bodyOld === undefined ? undefined : { old: bodyOld, new: bodyNew! },
      });
      out({ id: ticket.id, status: ticket.status, warnings });
      break;
    }
    case 'return': {
      const t = store.returnToHuman(actor(), ticketRef('ticket'), {
        situation: req('situation'),
        question: req('question'),
        // Optional, like the tool (H-939): a recommendation that stands on its
        // own is the normal ask, not a degenerate one.
        options: flag('options') ? JSON.parse(flag('options') as string) : [],
        recommendation: req('recommendation'),
        if_unanswered: flag('if-unanswered'),
      });
      out({ id: t.id, status: t.status });
      break;
    }
    case 'action': {
      const t = store.requestAction(actor(), ticketRef('ticket'), {
        situation: req('situation'),
        action: req('action'),
        why_human: req('why-human'),
        if_unanswered: flag('if-unanswered'),
      });
      out({ id: t.id, status: t.status });
      break;
    }
    case 'action-report': {
      const t = store.reportAction(actor(), ticketRef('ticket'), { did: req('did') });
      out({ id: t.id, status: t.status });
      break;
    }
    default:
      console.error(`usage: helmo-cli <command> [flags]
  wake-check     --workstream W --assignee A --since-seq N     (read-only harness poll)
  seat-check     --assignee A                                  (in_progress holds in a name + claiming actor; rev's same-seat guard)
  purge-orphan   --ticket H-n --confirm                          (remove a row with NO events — a write that came from outside)
  actor-activity --name A --since-seq N [--session S] [--advancing] (did this actor/session write events?)
  actor-tickets  --name A --since-seq N [--session S]          (which tickets, most-touched first)
  actor-spend    --name A --since-seq N [--session S]          (self-reported spend in the window, total + by_ticket)
  record-spend   --ticket H-n [--tokens N] [--cost-usd X] --note N   (metered spend; terminal tickets accepted)
  list           [--ready] [--status S] [--workstream W] [--assignee A] [--limit N]
  get            <ticket-id>
  action         --ticket H-n --situation S --action A --why-human W [--if-unanswered C]
  action-report  --ticket H-n --did D
  product-complete --ticket H-n --artifacts '[{"ref":"repo@<40hex>","author":"name"}]' --note N
  acceptance-verdict --ticket H-n --refs '["repo@<40hex>"]' --verdict pass|fail --note N
  acceptance-check --ticket H-n [--refs '["repo@<40hex>"]'] (exit 0 only for independent acceptance of that manifest)
  answers        --since-seq N [--session S]                    (answers recorded since a cursor, + max_seq; --session dashboard for the sweep's replay)
  verdicts       --since-seq N [--actor A] [--workstream W]     (acceptance verdicts recorded since a cursor, + max_seq; the sweep's forged-PASS replay)
  hygiene                                                      (deterministic record checks, read-only)
  hygiene-dispose --check C --ticket H-n --reason R  (stop re-reporting a finding: any check on a TERMINAL ticket, or spend_anomaly on live work, where it holds until the cost grows by half again)
  workstream     --name W                                      (budget, seat, spend-to-date; read-only)
  rename-workstream --from X --to Y --note N   (relabel every ticket incl. closed; one evented rename)
  workstream-set --name W [--budget-usd X] [--seat A | --seat '']   (operator steering; actor kind human/orchestrator only; seat = agent unassigned filings are reserved to)
  create         --title T --body B --workstream W --type TY [--priority P] [--status S] [--assignee A] [--dep H-n --dep-type TY] [--schedule 'every 30m' | '0 0 * * *'] [--not-before 2026-09-10]
  update         --ticket H-n --note N [--status S] [--evidence-kind K --evidence-ref R] [--body-append T | --body-old OLD --body-new NEW] [--confidence C] [--blast-radius B] [--tokens N] [--cost-usd X] [--handoff-to A] [--not-before 2026-09-10 | ''] [--takeover]
  return         --ticket H-n --situation S --question Q --recommendation R [--options '[{"label":..,"consequence":..}]' (2-3, only for a real choice)] [--if-unanswered U]
Writes read identity from HELMO_ACTOR env or --actor JSON. Installation from HELMO_HOME (default ~/.helmo) or HELMO_DB naming the store
directly; set both only if they agree. Its name is REV_LABEL when Rev started this process, or HELMO_LABEL, else derived from the home.
Every command names the installation it used, and the build it loaded, in its JSON. --installation <name|home|db> asserts that target on any command: it refuses
before the store is opened when the environment resolves a different one, and it cannot redirect — move the target with HELMO_HOME/HELMO_DB.
A ticket id may be written bare (H-42, meaning this installation's) or qualified (H-42@<name|home|db>), which asserts which installation the
reference came FROM and is refused here when it names another — ids are minted per installation, so the same H-42 exists in each and means a
different record.`);
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(JSON.stringify({
    error: e instanceof HelmoError ? e.message : String(e),
    installation: installationRef(install, store.installationIdentity()),
  }));
  process.exit(1);
} finally {
  store.close();
}

function req(name: string): string {
  const v = flag(name);
  if (v === undefined) throw new HelmoError(`--${name} is required for '${cmd}'`);
  return v;
}
/** A ticket id as it arrives from a caller. A bare `H-42` is this
 *  installation's, as it always was; `H-42@<installation>` asserts which one
 *  it came from, and is refused here — before the store is touched — when it
 *  names another (H-2502). */
function ticketRef(name: string): string {
  return localRecordRef(req(name), install);
}
function ticketRefOpt(value: string | undefined): string | undefined {
  return value === undefined ? undefined : localRecordRef(value, install);
}
function actorSafe(): Actor | undefined {
  try {
    return actor();
  } catch {
    return undefined;
  }
}
