import Database from 'better-sqlite3';
import { parseSchedule } from './schedule.js';
import {
  Actor, Answer, BlastRadius, BLAST_RADII, Confidence, Dep, DepType, Evidence,
  HelmoError, HelmoEvent, Question, Status, Ticket, Workstream, WorkstreamInfo,
} from './types.js';

const STALE_CLAIM_HOURS = 24;
const AGING_QUESTION_HOURS = 48; // the awaiting-human queue exists to protect attention; its own staleness is the record failing
const SPEND_ANOMALY_FACTOR = 3; // flag cost > 3x the workstream norm (needs >= 3 spent tickets for a norm)
const BUDGET_PRESSURE_RATIO = 0.8; // surface a workstream budget once 80% is spent

// Instances spawned by the store's own clock carry the store's identity —
// attributing them to whichever reader triggered materialization would be
// false provenance.
const SCHEDULER_ACTOR: Actor = { name: 'helmo-scheduler', kind: 'orchestrator' };

export interface CreateInput {
  title: string;
  body: string;
  workstream: string;
  type: string;
  labels?: string[];
  priority?: number;
  status?: 'open' | 'in_progress';
  assignee?: string;
  deps?: { to: string; type: DepType }[];
  schedule?: string; // makes this a recurring template
  spawned_from?: string; // internal: set by materializeDue on instances
  due?: string; // internal: the slot this instance was spawned for
}

export interface UpdateInput {
  ticket_id: string;
  note: string;
  status?: 'open' | 'in_progress' | 'done' | 'cancelled';
  takeover?: boolean;
  handoff_to?: string;
  evidence?: Evidence[];
  confidence?: Confidence;
  uncertainty_note?: string;
  blast_radius?: BlastRadius;
  tokens?: number;
  cost_usd?: number;
  title?: string;
  body?: string;
  priority?: number;
  labels?: string[];
  workstream?: string;
}

export interface ListFilter {
  ready?: boolean;
  caller?: string; // actor name, used by ready to include reservations
  status?: Status;
  workstream?: string;
  assignee?: string;
  type?: string;
  priority_max?: number;
  limit?: number;
  cursor?: number; // offset
}

export interface UpdateResult {
  ticket: Ticket;
  warnings: string[];
}

export interface HygieneFinding {
  check: 'stale_claim' | 'done_without_evidence' | 'phantom_block' | 'aging_question' | 'spend_anomaly' | 'priority_inversion' | 'budget_pressure';
  ticket_id?: string; // absent on workstream-level findings
  workstream?: string;
  detail: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  ticket_id  TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor      TEXT NOT NULL,
  payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON events(ticket_id);
CREATE TABLE IF NOT EXISTS tickets (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  workstream     TEXT NOT NULL,
  type           TEXT NOT NULL,
  labels         TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'open',
  priority       INTEGER NOT NULL DEFAULT 2,
  assignee       TEXT,
  evidence       TEXT NOT NULL DEFAULT '[]',
  confidence     TEXT,
  uncertainty_note TEXT,
  blast_radius   TEXT NOT NULL DEFAULT 'none',
  question       TEXT,
  tokens_total   INTEGER NOT NULL DEFAULT 0,
  cost_usd_total REAL NOT NULL DEFAULT 0,
  schedule       TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  closed_at      TEXT
);
CREATE TABLE IF NOT EXISTS deps (
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  type    TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, type)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workstreams (
  name       TEXT PRIMARY KEY,
  goal       TEXT,
  budget_usd REAL,
  updated_at TEXT NOT NULL
);
`;

function now(): string {
  return new Date().toISOString();
}

function validateActor(actor: Actor): void {
  if (!actor?.name || !actor?.kind) {
    throw new HelmoError(
      'No actor identity. Configure HELMO_ACTOR (JSON with at least {"name", "kind"}) in the MCP server environment, or pass an "actor" param. Provenance requires knowing who writes.',
    );
  }
  if (actor.kind === 'agent' && (!actor.model || !actor.version)) {
    throw new HelmoError(
      `Actor "${actor.name}" has kind "agent" but is missing model and/or version. Agents must identify their model ID and harness version — this is what makes corrections verifiable. Example: {"name":"${actor.name}","kind":"agent","model":"claude-sonnet-5","version":"1.0"}.`,
    );
  }
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    // Additive migration for stores created before recurring templates (H-22).
    try {
      this.db.exec('ALTER TABLE tickets ADD COLUMN schedule TEXT');
    } catch {
      /* column already exists */
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------- reads ----------

  getTicket(id: string): Ticket {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new HelmoError(`Ticket "${id}" not found. IDs look like "H-42"; use helmo_list_tickets to find the one you mean.`);
    }
    return rowToTicket(row);
  }

  getDeps(id: string): { outgoing: Dep[]; incoming: Dep[] } {
    return {
      outgoing: this.db.prepare('SELECT * FROM deps WHERE from_id = ?').all(id) as Dep[],
      incoming: this.db.prepare('SELECT * FROM deps WHERE to_id = ?').all(id) as Dep[],
    };
  }

  getEvents(ticketId: string): HelmoEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE ticket_id = ? ORDER BY seq').all(ticketId) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }

  lastAnswer(ticketId: string): Answer | null {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE ticket_id = ? AND event_type = 'answered' ORDER BY seq DESC LIMIT 1")
      .get(ticketId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Answer) : null;
  }

  agentChain(ticketId: string): string[] {
    const rows = this.db.prepare('SELECT actor FROM events WHERE ticket_id = ? ORDER BY seq').all(ticketId) as { actor: string }[];
    const chain: string[] = [];
    for (const r of rows) {
      const a = JSON.parse(r.actor) as Actor;
      const label = a.model ? `${a.name} (${a.model}${a.version ? ` v${a.version}` : ''})` : a.name;
      if (chain[chain.length - 1] !== label) chain.push(label);
    }
    return chain;
  }

  isBlocked(id: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM deps d JOIN tickets t ON t.id = d.to_id
         WHERE d.from_id = ? AND d.type = 'blocks' AND t.status NOT IN ('done','cancelled')`,
      )
      .get(id) as { n: number };
    return row.n > 0;
  }

  listTickets(filter: ListFilter): Ticket[] {
    // Lazy materialization (H-22): every ticket-list read catches up recurring
    // templates first, so due instances exist by the time the queue is answered.
    this.materializeDue();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
    if (filter.workstream) { clauses.push('workstream = ?'); params.push(filter.workstream); }
    if (filter.assignee) { clauses.push('assignee = ?'); params.push(filter.assignee); }
    if (filter.type) { clauses.push('type = ?'); params.push(filter.type); }
    if (filter.priority_max !== undefined) { clauses.push('priority <= ?'); params.push(filter.priority_max); }
    if (filter.ready) {
      clauses.push("status = 'open'");
      clauses.push('schedule IS NULL'); // templates are standing work, never claimable
      if (filter.caller) { clauses.push('(assignee IS NULL OR assignee = ?)'); params.push(filter.caller); }
      else clauses.push('assignee IS NULL');
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ?? 20;
    const offset = filter.cursor ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM tickets ${where} ORDER BY priority ASC, created_at ASC LIMIT ? OFFSET ?`)
      .all(...params, limit + (filter.ready ? 50 : 0), offset) as Record<string, unknown>[];
    let tickets = rows.map(rowToTicket);
    if (filter.ready) {
      tickets = tickets
        .filter((t) => !this.isBlocked(t.id))
        // Triage rule (H-55): work an agent filed for itself needs a second
        // pair of eyes before that same agent may draw it — otherwise the
        // queue is fed by its own consumer and never empties.
        .filter((t) => !(filter.caller && this.selfFiledUntouched(t.id, filter.caller)))
        .slice(0, limit);
    }
    return tickets;
  }

  /** True when `caller` created this ticket and no other actor has written any
   *  event on it since. Scheduler-spawned instances are judged by their
   *  template: standing work an agent set up for itself is still self-filed. */
  private selfFiledUntouched(id: string, caller: string): boolean {
    const created = this.db
      .prepare(
        `SELECT json_extract(actor, '$.name') AS creator, json_extract(payload, '$.spawned_from') AS template
         FROM events WHERE ticket_id = ? AND event_type = 'created'`,
      )
      .get(id) as { creator: string | null; template: string | null } | undefined;
    if (!created) return false;
    // The scheduler is the store's clock, not judgment — its events never
    // count as the second pair of eyes.
    const others = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE ticket_id = ? AND json_extract(actor, '$.name') NOT IN (?, 'helmo-scheduler')")
      .get(id, caller) as { n: number };
    if (others.n > 0) return false;
    if (created.template) return this.selfFiledUntouched(created.template, caller);
    return created.creator === caller;
  }

  /** The tickets the triage rule is withholding from `caller`'s ready queue —
   *  returned alongside the queue so the filer sees why, instead of wondering
   *  where their ticket went. */
  selfFiledPending(caller: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM tickets WHERE status = 'open' AND schedule IS NULL AND (assignee IS NULL OR assignee = ?) ORDER BY priority ASC, created_at ASC")
      .all(caller) as { id: string }[];
    return rows.map((r) => r.id).filter((id) => !this.isBlocked(id) && this.selfFiledUntouched(id, caller));
  }

  /** Record hygiene that needs no judgment and no tokens (H-23): deterministic
   *  queries over the store, surfaced in the view and `helmo-cli hygiene`.
   *  Pure read — never mutates. `nowTs` is injectable for tests. */
  hygiene(nowTs: Date = new Date()): HygieneFinding[] {
    const findings: HygieneFinding[] = [];
    const hoursAgo = (h: number) => new Date(nowTs.getTime() - h * 3_600_000).toISOString();
    const age = (iso: string) => Math.floor((nowTs.getTime() - new Date(iso).getTime()) / 3_600_000);

    // Stale claims: in_progress with no events for >24h — the takeover threshold agents already use.
    for (const r of this.db
      .prepare(
        `SELECT t.id, t.assignee, MAX(e.ts) AS last FROM tickets t JOIN events e ON e.ticket_id = t.id
         WHERE t.status = 'in_progress' GROUP BY t.id HAVING last < ?`,
      )
      .all(hoursAgo(STALE_CLAIM_HOURS)) as { id: string; assignee: string | null; last: string }[]) {
      findings.push({ check: 'stale_claim', ticket_id: r.id, detail: `held by ${r.assignee ?? '?'}, silent for ${age(r.last)}h` });
    }

    // Done without evidence: a claim, not a record (first-class here; the view already badges it per-row).
    for (const r of this.db.prepare("SELECT id FROM tickets WHERE status = 'done' AND evidence = '[]'").all() as { id: string }[]) {
      findings.push({ check: 'done_without_evidence', ticket_id: r.id, detail: 'closed with no evidence link' });
    }

    // Phantom blocks: every blocks-target closed, yet the waiting ticket has not
    // stirred since. Compared on seq, the store's monotonic clock — wall-clock
    // ties (same-millisecond writes) would make ts comparison lie.
    for (const r of this.db
      .prepare(
        `SELECT t.id, MAX(b.closed_at) AS freed, GROUP_CONCAT(b.id) AS targets,
                (SELECT MAX(seq) FROM events WHERE ticket_id = t.id) AS lastseq,
                (SELECT MAX(e.seq) FROM deps d2 JOIN events e ON e.ticket_id = d2.to_id
                 WHERE d2.from_id = t.id AND d2.type = 'blocks'
                   AND ((e.event_type = 'updated' AND json_extract(e.payload, '$.diffs.status.to') IN ('done','cancelled'))
                     OR (e.event_type = 'answered' AND json_extract(e.payload, '$.resolution') IN ('done','cancelled')))) AS freedseq
         FROM tickets t JOIN deps d ON d.from_id = t.id AND d.type = 'blocks' JOIN tickets b ON b.id = d.to_id
         WHERE t.status = 'open'
         GROUP BY t.id
         HAVING SUM(CASE WHEN b.status IN ('done','cancelled') THEN 0 ELSE 1 END) = 0 AND lastseq < freedseq`,
      )
      .all() as { id: string; freed: string; targets: string }[]) {
      findings.push({ check: 'phantom_block', ticket_id: r.id, detail: `unblocked ${age(r.freed)}h ago (${r.targets} closed) but untouched since` });
    }

    // Aging questions.
    for (const r of this.db
      .prepare("SELECT id, updated_at FROM tickets WHERE status = 'awaiting_human' AND updated_at < ?")
      .all(hoursAgo(AGING_QUESTION_HOURS)) as { id: string; updated_at: string }[]) {
      findings.push({ check: 'aging_question', ticket_id: r.id, detail: `question waiting ${Math.floor(age(r.updated_at) / 24)}d` });
    }

    // Spend anomalies: cost far above the workstream norm (H-19 made cost real).
    const spent = this.db
      .prepare('SELECT id, workstream, cost_usd_total AS cost FROM tickets WHERE cost_usd_total > 0')
      .all() as { id: string; workstream: string; cost: number }[];
    const byWs = new Map<string, { id: string; cost: number }[]>();
    for (const s of spent) {
      if (!byWs.has(s.workstream)) byWs.set(s.workstream, []);
      byWs.get(s.workstream)!.push(s);
    }
    for (const [ws, rows] of byWs) {
      if (rows.length < 3) continue;
      const total = rows.reduce((a, r) => a + r.cost, 0);
      for (const r of rows) {
        // The norm excludes the candidate: with it included, an outlier drags
        // the mean up until nothing can ever exceed the threshold.
        const peerMean = (total - r.cost) / (rows.length - 1);
        if (r.cost > peerMean * SPEND_ANOMALY_FACTOR) {
          findings.push({ check: 'spend_anomaly', ticket_id: r.id, detail: `$${r.cost.toFixed(2)} vs $${peerMean.toFixed(2)} '${ws}' norm` });
        }
      }
    }

    // Budget pressure: a workstream past 80% of its disclosed budget (H-55).
    // Disclosure elsewhere is the plan; this is the operator-facing flag.
    for (const ws of this.listWorkstreamInfo()) {
      if (!ws.budget_usd || ws.spent_usd < ws.budget_usd * BUDGET_PRESSURE_RATIO) continue;
      const pct = Math.round((ws.spent_usd / ws.budget_usd) * 100);
      findings.push({
        check: 'budget_pressure',
        workstream: ws.name,
        detail: `$${ws.spent_usd.toFixed(2)} of $${ws.budget_usd.toFixed(2)} spent (${pct}%)${ws.spent_usd >= ws.budget_usd ? ' — budget exhausted' : ''}`,
      });
    }

    // Priority inversions: a high-priority ready ticket sits while lower-priority work in the same workstream is in motion.
    for (const r of this.db
      .prepare(
        `SELECT o.id, o.priority, o.workstream FROM tickets o
         WHERE o.status = 'open' AND o.assignee IS NULL AND o.schedule IS NULL AND o.priority <= 1
           AND EXISTS (SELECT 1 FROM tickets w WHERE w.workstream = o.workstream AND w.status = 'in_progress' AND w.priority > o.priority)`,
      )
      .all() as { id: string; priority: number; workstream: string }[]) {
      if (this.isBlocked(r.id)) continue;
      findings.push({ check: 'priority_inversion', ticket_id: r.id, detail: `P${r.priority} ready while lower-priority '${r.workstream}' work is in motion` });
    }

    return findings;
  }

  /** Catch up recurring templates: spawn an instance for each template whose
   *  next occurrence has passed (H-22). Called from every ticket-list read —
   *  Helmo has no daemon, so the read path is the clock. Skip-if-open: no new
   *  instance while a previous one is open/in_progress/awaiting_human. After
   *  downtime, only the latest missed slot spawns — a backlog of stale
   *  instances would be silt, not work. Returns spawned ids. */
  materializeDue(nowTs: Date = new Date()): string[] {
    const templates = (
      this.db.prepare("SELECT * FROM tickets WHERE schedule IS NOT NULL AND status = 'open'").all() as Record<string, unknown>[]
    ).map(rowToTicket);
    const spawned: string[] = [];
    for (const t of templates) {
      const open = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM deps d JOIN tickets i ON i.id = d.from_id
           WHERE d.to_id = ? AND d.type = 'parent' AND i.status IN ('open','in_progress','awaiting_human')`,
        )
        .get(t.id) as { n: number };
      if (open.n > 0) continue;
      const lastDue = (
        this.db
          .prepare("SELECT MAX(json_extract(payload, '$.due')) AS due FROM events WHERE event_type = 'created' AND json_extract(payload, '$.spawned_from') = ?")
          .get(t.id) as { due: string | null }
      ).due;
      const sched = parseSchedule(t.schedule!);
      let due = sched.next(new Date(lastDue ?? t.created_at));
      if (due > nowTs) continue;
      for (let n = sched.next(due); n <= nowTs; n = sched.next(due)) due = n; // latest missed slot only
      const dueIso = due.toISOString();
      const instance = this.createTicket(SCHEDULER_ACTOR, {
        title: `${t.title} — ${dueIso.slice(0, 16)}Z`,
        body: `${t.body}\n\n(Instance of recurring ${t.id}, due ${dueIso}; schedule '${t.schedule}'.)`,
        workstream: t.workstream,
        type: t.type,
        labels: t.labels,
        priority: t.priority,
        assignee: t.assignee ?? undefined,
        deps: [{ to: t.id, type: 'parent' }],
        spawned_from: t.id,
        due: dueIso,
      });
      spawned.push(instance.id);
    }
    return spawned;
  }

  /** Highest event sequence number — the wake cursor for harnesses. */
  maxSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events').get() as { s: number };
    return row.s;
  }

  /** Count of ready tickets in scope (open, unblocked, unassigned-or-reserved-for-caller). */
  readyCount(workstream?: string, caller?: string): number {
    return this.listTickets({ ready: true, workstream, caller, limit: 1000 }).length;
  }

  /** True if any event since `seq` touches the scope: a ticket in `workstream`,
   *  or a ticket currently assigned to `assignee`. Zero-token wake check. */
  scopeChangedSince(seq: number, workstream?: string, assignee?: string): boolean {
    const clauses: string[] = [];
    const params: unknown[] = [seq];
    if (workstream) { clauses.push('t.workstream = ?'); params.push(workstream); }
    if (assignee) { clauses.push('t.assignee = ?'); params.push(assignee); }
    const scope = clauses.length ? `AND (${clauses.join(' OR ')})` : '';
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events e JOIN tickets t ON t.id = e.ticket_id WHERE e.seq > ? ${scope}`)
      .get(...params) as { n: number };
    return row.n > 0;
  }

  /** Count of events written by `actorName` since `seq` — a harness's "did my agent produce?" check. */
  actorActivitySince(actorName: string, seq: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE seq > ? AND json_extract(actor, '$.name') = ?")
      .get(seq, actorName) as { n: number };
    return row.n;
  }

  /** Tickets `actorName` wrote events on since `seq`, most-touched first — a
   *  harness's spend-attribution window. */
  actorTicketsSince(actorName: string, seq: number): { id: string; events: number }[] {
    return this.db
      .prepare(
        `SELECT ticket_id AS id, COUNT(*) AS events FROM events
         WHERE seq > ? AND json_extract(actor, '$.name') = ?
         GROUP BY ticket_id ORDER BY events DESC, MIN(seq) ASC`,
      )
      .all(seq, actorName) as { id: string; events: number }[];
  }

  /** Spend `actorName` self-reported on its own writes since `seq` (meter
   *  'spend' events excluded) — what a harness nets out of its metered figure
   *  so a session lands in the totals exactly once (H-57). */
  actorSelfSpendSince(actorName: string, seq: number): { tokens: number; cost_usd: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(json_extract(payload, '$.tokens')), 0) AS tokens,
                COALESCE(SUM(json_extract(payload, '$.cost_usd')), 0) AS cost
         FROM events
         WHERE seq > ? AND event_type != 'spend' AND json_extract(actor, '$.name') = ?`,
      )
      .get(seq, actorName) as { tokens: number; cost: number };
    return { tokens: row.tokens, cost_usd: row.cost };
  }

  listWorkstreams(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT workstream FROM tickets ORDER BY workstream').all() as { workstream: string }[];
    return rows.map((r) => r.workstream);
  }

  /** Rename a workstream across the record — an organizational relabel, not
   *  rework: one event carries the history and every ticket (open or closed)
   *  moves, which is why this exists instead of per-ticket workstream edits.
   *  Ticket updated_at is untouched: a relabel is not motion. */
  renameWorkstream(actor: Actor, input: { from: string; to: string; note: string }): { moved: number } {
    validateActor(actor);
    const from = input.from?.trim();
    const to = input.to?.trim();
    if (!from || !to) throw new HelmoError('rename-workstream requires from and to names.');
    if (from === to) throw new HelmoError('from and to are the same name — nothing to rename.');
    if (!input.note?.trim()) throw new HelmoError('note is required on rename-workstream: say why the stream is being renamed.');
    return this.db.transaction(() => {
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE workstream = ?').get(from) as { n: number }).n;
      const steering = this.db.prepare('SELECT 1 FROM workstreams WHERE name = ?').get(from);
      if (!n && !steering) throw new HelmoError(`No tickets or steering under '${from}' — nothing to rename.`);
      if (steering && this.db.prepare('SELECT 1 FROM workstreams WHERE name = ?').get(to)) {
        throw new HelmoError(
          `Both '${from}' and '${to}' carry steering — merge goal/budget deliberately via workstream-set, then rename.`,
        );
      }
      this.append(now(), `ws:${to}`, 'workstream_renamed', actor, { from, to, tickets: n, note: input.note });
      this.applyWorkstreamRenamed({ from, to });
      return { moved: n };
    })();
  }

  private applyWorkstreamRenamed(payload: Record<string, unknown>): void {
    this.db.prepare('UPDATE tickets SET workstream = ? WHERE workstream = ?').run(payload['to'], payload['from']);
    this.db.prepare('UPDATE workstreams SET name = ? WHERE name = ?').run(payload['to'], payload['from']);
  }

  /** One workstream with its steering and spend-to-date. Exists for names with
   *  tickets but no steering row too — goal/budget are simply null there. */
  getWorkstreamInfo(name: string): WorkstreamInfo {
    const row = this.db.prepare('SELECT * FROM workstreams WHERE name = ?').get(name) as Workstream | undefined;
    const spent = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd_total), 0) AS s FROM tickets WHERE workstream = ?')
      .get(name) as { s: number };
    const budget = row?.budget_usd ?? null;
    return {
      name,
      goal: row?.goal ?? null,
      budget_usd: budget,
      updated_at: row?.updated_at ?? '',
      spent_usd: spent.s,
      remaining_usd: budget === null ? null : budget - spent.s,
    };
  }

  listWorkstreamInfo(): WorkstreamInfo[] {
    const names = new Set(this.listWorkstreams());
    for (const r of this.db.prepare('SELECT name FROM workstreams').all() as { name: string }[]) names.add(r.name);
    return [...names].sort().map((n) => this.getWorkstreamInfo(n));
  }

  // ---------- writes (every write = append event + materialize, atomically) ----------

  /** Set a workstream's goal and/or budget — the human's steering (H-55).
   *  Agent-kind writes are rejected in the store, not just the tool docs: an
   *  agent must never set or raise the budget of the stream it draws from.
   *  Events ride the log under ticket_id `ws:<name>` so steering stays
   *  derivable and attributed like everything else. */
  setWorkstream(actor: Actor, input: { name: string; goal?: string; budget_usd?: number }): WorkstreamInfo {
    validateActor(actor);
    if (actor.kind === 'agent') {
      throw new HelmoError(
        'Workstream goals and budgets are operator steering — writable only by kind "human" or "orchestrator" (relaying a decision the human stated explicitly). An agent setting its own stream\'s goal or budget is the failure this field exists to prevent.',
      );
    }
    if (!input.name?.trim()) throw new HelmoError('name is required: which workstream is being steered.');
    if (input.goal === undefined && input.budget_usd === undefined) {
      throw new HelmoError('Provide goal and/or budget_usd — an empty steering write is noise.');
    }
    if (input.budget_usd !== undefined && !(input.budget_usd >= 0)) {
      throw new HelmoError('budget_usd must be a non-negative number (0 clears the pressure checks but keeps disclosure).');
    }
    return this.db.transaction(() => {
      const ts = now();
      const payload: Record<string, unknown> = { name: input.name };
      if (input.goal !== undefined) payload['goal'] = input.goal;
      if (input.budget_usd !== undefined) payload['budget_usd'] = input.budget_usd;
      this.append(ts, `ws:${input.name}`, 'workstream_set', actor, payload);
      this.applyWorkstreamSet(ts, payload);
      return this.getWorkstreamInfo(input.name);
    })();
  }

  createTicket(actor: Actor, input: CreateInput): Ticket {
    validateActor(actor);
    if (!input.title?.trim()) throw new HelmoError('title is required: one line, plain human terms.');
    if (!input.body?.trim()) {
      throw new HelmoError(
        'body is required. Write it so a different agent with NO other context could resume: goal, constraints, relevant paths/links, current state.',
      );
    }
    if (!input.workstream?.trim()) {
      throw new HelmoError(
        `workstream is required. Existing workstreams: ${JSON.stringify(this.listWorkstreams())}. Reuse one if it fits; invent only for genuinely new streams of work.`,
      );
    }
    if (!input.type?.trim()) throw new HelmoError('type is required: build|research|writing|ops|planning, or another short noun.');
    if (input.schedule) {
      parseSchedule(input.schedule); // reject bad expressions at the door
      if (input.status === 'in_progress') throw new HelmoError('A recurring template is standing work — it cannot be in_progress; its instances are.');
    }
    const status = input.status ?? 'open';
    if (status === 'in_progress' && !input.assignee) input = { ...input, assignee: actor.name };
    for (const d of input.deps ?? []) this.getTicket(d.to); // existence check before mint

    return this.db.transaction(() => {
      const id = this.mintId();
      const ts = now();
      const payload: Record<string, unknown> = {
        id,
        title: input.title,
        body: input.body,
        workstream: input.workstream,
        type: input.type,
        labels: input.labels ?? [],
        priority: input.priority ?? 2,
        status,
        assignee: input.assignee ?? null,
      };
      if (input.schedule) payload['schedule'] = input.schedule;
      if (input.spawned_from) { payload['spawned_from'] = input.spawned_from; payload['due'] = input.due; }
      this.append(ts, id, 'created', actor, payload);
      this.applyCreated(ts, payload);
      for (const d of input.deps ?? []) {
        this.checkNoBlocksCycle(id, d.to, d.type);
        this.append(ts, id, 'linked', actor, { to: d.to, type: d.type });
        this.applyLinked(id, d.to, d.type, true);
      }
      return this.getTicket(id);
    })();
  }

  updateTicket(actor: Actor, input: UpdateInput): UpdateResult {
    validateActor(actor);
    if (!input.note?.trim()) {
      throw new HelmoError('note is required on every update: one or two lines, human terms, saying what actually happened. Notes are the story the human reads.');
    }
    const t = this.getTicket(input.ticket_id);
    const warnings: string[] = [];
    const diffs: Record<string, { from: unknown; to: unknown }> = {};

    if (t.status === 'done' || t.status === 'cancelled') {
      throw new HelmoError(
        `${t.id} is ${t.status} — terminal. The record is permanent; do not rework closed tickets. If follow-up work is needed, helmo_create_ticket a new one with a 'relates' link to ${t.id}.`,
      );
    }
    if (input.handoff_to && input.status) {
      throw new HelmoError('Pass either handoff_to or status, not both — a handoff sets status itself (open, reserved for the receiver).');
    }

    // status transitions
    if (input.status) {
      if (t.status === 'awaiting_human') {
        throw new HelmoError(
          `${t.id} is awaiting_human — it is waiting on the human's answer, not on you. Status changes happen via helmo_answer_ticket (orchestrator, during a meeting). You may still add notes/evidence.`,
        );
      }
      // Triage enforcement (H-56): the ready-queue withholding (H-55) is a
      // rule, not advice — an agent may not claim its own untouched filing
      // directly either. Sits upstream of the reservation checks on purpose:
      // takeover exists for stale claims and never releases self-triage.
      // Agents only — a human or orchestrator IS the second pair of eyes.
      if (input.status === 'in_progress' && t.status === 'open' && actor.kind === 'agent' && this.selfFiledUntouched(t.id, actor.name)) {
        throw new HelmoError(
          `${t.id} is your own filing, untouched by anyone else — executing your own discoveries takes a second pair of eyes first (the same triage rule that withholds it from your ready queue). Any event by a human or another agent releases it: a meeting answer, a note, a handoff, a priority change. takeover does not apply — it exists for stale claims, not self-triage. If this cannot wait, helmo_return_to_human with the case for urgency; if you are starting genuinely new work, create the ticket with status 'in_progress' in the same call instead of filing it and drawing it back later.`,
        );
      }
      if (input.status === 'in_progress' && t.status === 'open' && t.assignee && t.assignee !== actor.name && !input.takeover) {
        const age = hoursSince(t.updated_at);
        if (age < STALE_CLAIM_HOURS) {
          throw new HelmoError(
            `${t.id} is reserved for "${t.assignee}" (last activity ${age.toFixed(1)}h ago). Pick different work rather than duplicating theirs. If the claim looks dead (>${STALE_CLAIM_HOURS}h), retry with takeover: true and say so in your note.`,
          );
        }
        warnings.push(`Claim on "${t.assignee}" looked stale (${age.toFixed(1)}h); consider takeover: true next time for an explicit record.`);
      }
      if (input.status === 'in_progress' && t.status === 'in_progress' && t.assignee !== actor.name) {
        const age = hoursSince(t.updated_at);
        if (!input.takeover && age < STALE_CLAIM_HOURS) {
          throw new HelmoError(
            `${t.id} is held by "${t.assignee}" (last update ${age.toFixed(1)}h ago). Pick different work. If the holder is dead (>${STALE_CLAIM_HOURS}h stale), retry with takeover: true.`,
          );
        }
        if (!input.takeover) {
          throw new HelmoError(
            `${t.id} is held by "${t.assignee}" and stale (${age.toFixed(1)}h). Retry with takeover: true and note the takeover.`,
          );
        }
      }
      diffs['status'] = { from: t.status, to: input.status };
      if (input.status === 'in_progress') diffs['assignee'] = { from: t.assignee, to: actor.name };
      if (input.status === 'open') diffs['assignee'] = { from: t.assignee, to: null };
      if (input.status === 'done') {
        const hasEvidence = t.evidence.length > 0 || (input.evidence?.length ?? 0) > 0;
        if (!hasEvidence) {
          warnings.push('done_without_evidence: done was recorded, but with no evidence link the human sees a claim, not a record. Add evidence via another update if any exists.');
        }
      }
    }

    if (input.handoff_to) {
      if (t.status === 'in_progress' && t.assignee && t.assignee !== actor.name) {
        throw new HelmoError(`${t.id} is held by "${t.assignee}"; only the holder can hand it off.`);
      }
      if (t.status === 'awaiting_human') {
        throw new HelmoError(`${t.id} is awaiting_human; it cannot be handed off until answered.`);
      }
      diffs['status'] = { from: t.status, to: 'open' };
      diffs['assignee'] = { from: t.assignee, to: input.handoff_to };
    }

    if (input.blast_radius) {
      const from = BLAST_RADII.indexOf(t.blast_radius);
      const to = BLAST_RADII.indexOf(input.blast_radius);
      if (to < from) {
        throw new HelmoError(
          `blast_radius never goes back down (currently '${t.blast_radius}', got '${input.blast_radius}'). It records the furthest the work has reached.`,
        );
      }
      if (to > from) diffs['blast_radius'] = { from: t.blast_radius, to: input.blast_radius };
    }

    for (const field of ['title', 'body', 'priority', 'workstream', 'confidence', 'uncertainty_note'] as const) {
      const v = input[field];
      if (v !== undefined && v !== (t as unknown as Record<string, unknown>)[field]) {
        diffs[field] = { from: (t as unknown as Record<string, unknown>)[field], to: v };
      }
    }
    if (input.labels !== undefined && JSON.stringify(input.labels) !== JSON.stringify(t.labels)) {
      diffs['labels'] = { from: t.labels, to: input.labels };
    }
    if (input.evidence?.length) {
      diffs['evidence'] = { from: t.evidence, to: [...t.evidence, ...input.evidence] };
    }
    if (input.confidence && input.confidence !== 'routine' && !input.uncertainty_note && !t.uncertainty_note) {
      warnings.push(`confidence '${input.confidence}' with no uncertainty_note — say WHERE the doubt is; that is what makes the review efficient.`);
    }

    return this.db.transaction(() => {
      const ts = now();
      const payload: Record<string, unknown> = { diffs, note: input.note };
      if (input.tokens) payload['tokens'] = input.tokens;
      if (input.cost_usd) payload['cost_usd'] = input.cost_usd;
      if (input.takeover) payload['takeover'] = true;
      if (input.handoff_to) payload['handoff_to'] = input.handoff_to;
      this.append(ts, t.id, 'updated', actor, payload);
      this.applyUpdated(ts, t.id, payload);
      return { ticket: this.getTicket(t.id), warnings };
    })();
  }

  /** Attribute metered spend to a ticket. Unlike updateTicket this accepts
   *  terminal tickets: a harness meters a session only after it ends, by which
   *  time the loop has usually closed its ticket. Bookkeeping, not motion —
   *  it never changes status, assignee, or updated_at. */
  recordSpend(actor: Actor, ticketId: string, input: { tokens?: number; cost_usd?: number; note: string }): Ticket {
    validateActor(actor);
    if (!input.tokens && !input.cost_usd) {
      throw new HelmoError('record-spend requires tokens and/or cost_usd — an empty spend record is noise.');
    }
    if (!input.note?.trim()) {
      throw new HelmoError('note is required on record-spend: say what session this spend came from and how it was attributed.');
    }
    this.getTicket(ticketId);
    return this.db.transaction(() => {
      const payload: Record<string, unknown> = { note: input.note };
      if (input.tokens) payload['tokens'] = input.tokens;
      if (input.cost_usd) payload['cost_usd'] = input.cost_usd;
      this.append(now(), ticketId, 'spend', actor, payload);
      this.applySpend(ticketId, payload);
      return this.getTicket(ticketId);
    })();
  }

  returnToHuman(actor: Actor, ticketId: string, q: Question): Ticket {
    validateActor(actor);
    const t = this.getTicket(ticketId);
    if (t.status !== 'open' && t.status !== 'in_progress') {
      throw new HelmoError(`${t.id} is ${t.status}; only open or in_progress tickets can be returned to the human.`);
    }
    for (const [field, v] of Object.entries({ situation: q.situation, question: q.question, recommendation: q.recommendation })) {
      if (!(v as string)?.trim()) {
        throw new HelmoError(`${field} is required. The human works these in batched meetings; an incomplete question wastes the attention Helmo exists to protect.`);
      }
    }
    if (!q.options || q.options.length < 2 || q.options.length > 4) {
      throw new HelmoError('options: provide 2-4, each {label, consequence}. The human should be able to answer by saying a label.');
    }
    for (const o of q.options) {
      if (!o.label?.trim() || !o.consequence?.trim()) throw new HelmoError('Every option needs both label and consequence (what happens if chosen, including cost/risk).');
    }
    return this.db.transaction(() => {
      const ts = now();
      this.append(ts, t.id, 'returned', actor, q as unknown as Record<string, unknown>);
      this.db
        .prepare("UPDATE tickets SET status = 'awaiting_human', assignee = NULL, question = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(q), ts, t.id);
      return this.getTicket(t.id);
    })();
  }

  answerTicket(actor: Actor, ticketId: string, a: Answer): Ticket {
    validateActor(actor);
    const t = this.getTicket(ticketId);
    if (t.status !== 'awaiting_human') {
      throw new HelmoError(`${t.id} is ${t.status}, not awaiting_human — there is no pending question to answer.`);
    }
    if (!a.answer?.trim()) throw new HelmoError('answer is required: the decision plus the human\'s reasoning and any new constraints.');
    const resolution = a.resolution ?? 'resume';
    return this.db.transaction(() => {
      const ts = now();
      this.append(ts, t.id, 'answered', actor, { ...a, resolution } as unknown as Record<string, unknown>);
      if (resolution === 'resume') {
        this.db.prepare("UPDATE tickets SET status = 'open', assignee = NULL, question = NULL, updated_at = ? WHERE id = ?").run(ts, t.id);
      } else {
        this.db
          .prepare('UPDATE tickets SET status = ?, assignee = NULL, question = NULL, updated_at = ?, closed_at = ? WHERE id = ?')
          .run(resolution, ts, ts, t.id);
      }
      return this.getTicket(t.id);
    })();
  }

  linkTickets(actor: Actor, fromId: string, toId: string, type: DepType, action: 'add' | 'remove'): void {
    validateActor(actor);
    this.getTicket(fromId);
    this.getTicket(toId);
    if (fromId === toId) throw new HelmoError('A ticket cannot link to itself.');
    this.db.transaction(() => {
      const ts = now();
      if (action === 'add') {
        this.checkNoBlocksCycle(fromId, toId, type);
        this.append(ts, fromId, 'linked', actor, { to: toId, type });
        this.applyLinked(fromId, toId, type, true);
      } else {
        this.append(ts, fromId, 'unlinked', actor, { to: toId, type });
        this.applyLinked(fromId, toId, type, false);
      }
      this.db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(ts, fromId);
    })();
  }

  // ---------- rebuild (the invariant) ----------

  /** Reconstruct tickets + deps purely from the event log. Used by tests to enforce
   *  that materialized state is always derivable from events. */
  rebuild(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM tickets; DELETE FROM deps; DELETE FROM workstreams;');
      const rows = this.db.prepare('SELECT * FROM events ORDER BY seq').all() as Record<string, unknown>[];
      for (const row of rows) {
        const ev = rowToEvent(row);
        switch (ev.event_type) {
          case 'workstream_set':
            this.applyWorkstreamSet(ev.ts, ev.payload);
            break;
          case 'workstream_renamed':
            this.applyWorkstreamRenamed(ev.payload);
            break;
          case 'created':
            this.applyCreated(ev.ts, ev.payload);
            break;
          case 'updated':
            this.applyUpdated(ev.ts, ev.ticket_id, ev.payload);
            break;
          case 'returned':
            this.db
              .prepare("UPDATE tickets SET status = 'awaiting_human', assignee = NULL, question = ?, updated_at = ? WHERE id = ?")
              .run(JSON.stringify(ev.payload), ev.ts, ev.ticket_id);
            break;
          case 'answered': {
            const res = (ev.payload['resolution'] as string) ?? 'resume';
            if (res === 'resume') {
              this.db.prepare("UPDATE tickets SET status = 'open', assignee = NULL, question = NULL, updated_at = ? WHERE id = ?").run(ev.ts, ev.ticket_id);
            } else {
              this.db
                .prepare('UPDATE tickets SET status = ?, assignee = NULL, question = NULL, updated_at = ?, closed_at = ? WHERE id = ?')
                .run(res, ev.ts, ev.ts, ev.ticket_id);
            }
            break;
          }
          case 'spend':
            this.applySpend(ev.ticket_id, ev.payload);
            break;
          case 'linked':
            this.applyLinked(ev.ticket_id, ev.payload['to'] as string, ev.payload['type'] as DepType, true);
            break;
          case 'unlinked':
            this.applyLinked(ev.ticket_id, ev.payload['to'] as string, ev.payload['type'] as DepType, false);
            break;
        }
      }
    })();
  }

  dumpState(): { tickets: Ticket[]; deps: Dep[]; workstreams: Workstream[] } {
    const tickets = (this.db.prepare('SELECT * FROM tickets ORDER BY id').all() as Record<string, unknown>[]).map(rowToTicket);
    const deps = this.db.prepare('SELECT * FROM deps ORDER BY from_id, to_id, type').all() as Dep[];
    const workstreams = this.db.prepare('SELECT * FROM workstreams ORDER BY name').all() as Workstream[];
    return { tickets, deps, workstreams };
  }

  // ---------- internals ----------

  private mintId(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'next_id'").get() as { value: string } | undefined;
    const n = row ? parseInt(row.value, 10) : 1;
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('next_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n + 1));
    return `H-${n}`;
  }

  private append(ts: string, ticketId: string, type: string, actor: Actor, payload: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO events (ts, ticket_id, event_type, actor, payload) VALUES (?, ?, ?, ?, ?)')
      .run(ts, ticketId, type, JSON.stringify(actor), JSON.stringify(payload));
  }

  private applyCreated(ts: string, p: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO tickets (id, title, body, workstream, type, labels, status, priority, assignee, schedule, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p['id'], p['title'], p['body'], p['workstream'], p['type'],
        JSON.stringify(p['labels'] ?? []), p['status'] ?? 'open', p['priority'] ?? 2, p['assignee'] ?? null,
        p['schedule'] ?? null, ts, ts,
      );
  }

  private applyUpdated(ts: string, id: string, payload: Record<string, unknown>): void {
    const diffs = (payload['diffs'] ?? {}) as Record<string, { from: unknown; to: unknown }>;
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [ts];
    const jsonFields = new Set(['labels', 'evidence']);
    for (const [field, d] of Object.entries(diffs)) {
      if (!['title', 'body', 'workstream', 'type', 'labels', 'status', 'priority', 'assignee', 'evidence', 'confidence', 'uncertainty_note', 'blast_radius'].includes(field)) continue;
      sets.push(`${field} = ?`);
      params.push(jsonFields.has(field) ? JSON.stringify(d.to) : (d.to as never));
    }
    const status = diffs['status']?.to as string | undefined;
    if (status === 'done' || status === 'cancelled') { sets.push('closed_at = ?'); params.push(ts); }
    const tokens = payload['tokens'] as number | undefined;
    if (tokens) { sets.push('tokens_total = tokens_total + ?'); params.push(tokens); }
    const cost = payload['cost_usd'] as number | undefined;
    if (cost) { sets.push('cost_usd_total = cost_usd_total + ?'); params.push(cost); }
    params.push(id);
    this.db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  private applySpend(id: string, payload: Record<string, unknown>): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    const tokens = payload['tokens'] as number | undefined;
    if (tokens) { sets.push('tokens_total = tokens_total + ?'); params.push(tokens); }
    const cost = payload['cost_usd'] as number | undefined;
    if (cost) { sets.push('cost_usd_total = cost_usd_total + ?'); params.push(cost); }
    if (!sets.length) return;
    params.push(id);
    this.db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  private applyWorkstreamSet(ts: string, p: Record<string, unknown>): void {
    // COALESCE keeps the field a partial write did not carry — replaying the
    // log reproduces exactly the same partial-update semantics.
    this.db
      .prepare(
        `INSERT INTO workstreams (name, goal, budget_usd, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           goal = COALESCE(excluded.goal, workstreams.goal),
           budget_usd = COALESCE(excluded.budget_usd, workstreams.budget_usd),
           updated_at = excluded.updated_at`,
      )
      .run(p['name'], p['goal'] ?? null, p['budget_usd'] ?? null, ts);
  }

  private applyLinked(fromId: string, toId: string, type: DepType, add: boolean): void {
    if (add) {
      this.db.prepare('INSERT OR IGNORE INTO deps (from_id, to_id, type) VALUES (?, ?, ?)').run(fromId, toId, type);
    } else {
      this.db.prepare('DELETE FROM deps WHERE from_id = ? AND to_id = ? AND type = ?').run(fromId, toId, type);
    }
  }

  private checkNoBlocksCycle(fromId: string, toId: string, type: DepType): void {
    if (type !== 'blocks') return;
    // Adding fromId -> toId. A cycle exists if fromId is reachable from toId via blocks edges.
    const seen = new Set<string>();
    const stack = [toId];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === fromId) {
        throw new HelmoError(
          `Adding blocks ${fromId} -> ${toId} would create a cycle: these tickets would wait on each other forever. Re-examine which one is truly the prerequisite.`,
        );
      }
      if (seen.has(cur)) continue;
      seen.add(cur);
      const next = this.db.prepare("SELECT to_id FROM deps WHERE from_id = ? AND type = 'blocks'").all(cur) as { to_id: string }[];
      for (const n of next) stack.push(n.to_id);
    }
  }
}

function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

function rowToTicket(row: Record<string, unknown>): Ticket {
  return {
    ...(row as unknown as Ticket),
    labels: JSON.parse(row['labels'] as string),
    evidence: JSON.parse(row['evidence'] as string),
    question: row['question'] ? JSON.parse(row['question'] as string) : null,
  };
}

function rowToEvent(row: Record<string, unknown>): HelmoEvent {
  return {
    ...(row as unknown as HelmoEvent),
    actor: JSON.parse(row['actor'] as string),
    payload: JSON.parse(row['payload'] as string),
  };
}
