import Database from 'better-sqlite3';
import { projectAcceptance } from './acceptance.js';
import { namesInstallation, type Installation } from './install.js';
import { actionFingerprint, questionFingerprint } from './presentation.js';
import { parseSchedule } from './schedule.js';
import {
  ActionReport, ActionRequest, Actor, ActorKind, ACTOR_KINDS, Answer, AnswerEvent, BlastRadius, BLAST_RADII, CapacityHold, Confidence, Dep, DepType, Evidence,
  HelmoError, HelmoEvent, HumanRequest, Notice, ProductAcceptance, ProductArtifact, Question, QuestionInput, Status, Ticket, TicketProgress, VerdictEvent, Workstream, WorkstreamInfo,
} from './types.js';

const STALE_CLAIM_HOURS = 24;
const AGING_QUESTION_HOURS = 48; // the awaiting-human queue exists to protect attention; its own staleness is the record failing
const SPEND_ANOMALY_FACTOR = 3; // flag cost > 3x the workstream norm (needs >= 3 spent tickets for a norm)
const SPEND_ACK_REGROWTH = 1.5; // an acknowledged spend anomaly returns once the ticket has cost half as much again (H-1715)
const BUDGET_PRESSURE_RATIO = 0.8; // surface a workstream budget once 80% is spent
const SILENT_ASSIGNEE_HOURS = 168; // 7d without the assignee writing anywhere: a reservation that will not wake on its own
// Streams whose work accounts for itself: keeping the estate safe is never
// discretionary, so a security ticket needs no project or objective behind it
// (H-1126). Deliberately tiny — everything else says what it is for.
const ACCOUNTED_WORKSTREAMS = new Set(['security']);

// The third accounting path (H-1166): work that serves no named project and no
// charter objective, but is still plainly justified — Arthur's own direction,
// keeping the estate safe, keeping it running. The convention always named this
// category; until now only a body line could say so, which the sweep cannot read.
// The set is closed on purpose: an enumerated label is a claim a reader can check,
// where free prose is one more steering field nobody owns (the H-1186 lesson).
const ACCOUNTING_LABELS = new Set(['acct:direction', 'acct:security', 'acct:estate']);

// The two "is this withheld from the executable set?" clauses, written once.
// EXECUTABLE_HOLD mirrors capacityReleased() exactly — no hold at all, or a
// bounded release still running — and EXECUTABLE_DATE mirrors the H-732 date
// gate. Each takes one ISO instant as its next parameter. Sharing the spelling
// is the H-2321 lesson: when two queries answer "can this start?" in their own
// words, the one nobody obeys drifts, and here the drift reached Arthur as a
// demand to route work he had deliberately parked (H-2556).
const EXECUTABLE_HOLD = "(capacity_hold IS NULL OR json_extract(capacity_hold, '$.release.until') > ?)";
const EXECUTABLE_DATE = '(not_before IS NULL OR not_before <= ?)';

function refuseUnmarkedDeskClaim(actor: Actor, needsHuman: boolean): void {
  if (actor.kind !== 'agent' || actor.session || needsHuman) return;
  throw new HelmoError(
    'If it needs a ticket, it is not meeting work — file the design and leave the ticket for a loop. If Arthur wants it done with him present, first mark the open ticket for a sitting with needs_human: true in a separate update, then claim it.',
  );
}

// Instances spawned by the store's own clock carry the store's identity —
// attributing them to whichever reader triggered materialization would be
// false provenance.
const SCHEDULER_ACTOR: Actor = { name: 'helmo-scheduler', kind: 'orchestrator' };

export interface CreateInput {
  title: string;
  body: string;
  workstream: string;
  type: string;
  project?: string;
  labels?: string[];
  priority?: number;
  status?: 'open' | 'in_progress';
  assignee?: string;
  deps?: { to: string; type: DepType }[];
  schedule?: string; // makes this a recurring template
  not_before?: string; // withhold from ready queues until this date/instant
  needs_human?: string | false; // the one line the sitting needs; never agent-ready
  sitting_with?: string; // the agent to sit with
  spawned_from?: string; // internal: set by materializeDue on instances
  due?: string; // internal: the slot this instance was spawned for
  workflow_attempt_id?: string; // immutable binding; gated starts require an atomic admission
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
  body_append?: string;
  body_patch?: { old: string; new: string };
  priority?: number;
  labels?: string[];
  workstream?: string;
  project?: string | null; // '' clears the tag
  not_before?: string | null; // '' clears the gate
  needs_human?: string | false; // the one line the sitting needs, or false to clear
  sitting_with?: string; // the agent to sit with; '' clears it
  capacity_hold?: CapacityHold | null; // null releases the deliberate hold
}

export interface ListFilter {
  ready?: boolean;
  caller?: string; // actor name, used by ready to include reservations
  status?: Status;
  workstream?: string;
  project?: string;
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

export const HYGIENE_CHECKS = [
  'stale_claim', 'done_without_evidence', 'phantom_block', 'aging_question',
  'spend_anomaly', 'priority_inversion', 'budget_pressure', 'silent_assignee',
  'orphan_ticket', 'unseated_pool', 'awaiting_second_eyes', 'unaccounted_work',] as const;

export interface HygieneFinding {
  check: (typeof HYGIENE_CHECKS)[number];
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
  project        TEXT,
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
  not_before     TEXT,
  needs_human    INTEGER NOT NULL DEFAULT 0,
  sitting        TEXT,
  sitting_with   TEXT,
  capacity_hold  TEXT,
  workflow_attempt_id TEXT,
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
  seat       TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notice (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  text       TEXT NOT NULL,
  provenance TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hygiene_dispositions (
  check_name TEXT NOT NULL,
  ticket_id  TEXT NOT NULL,
  actor      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  ts         TEXT NOT NULL,
  at_cost    REAL,
  PRIMARY KEY (check_name, ticket_id)
);
CREATE TABLE IF NOT EXISTS workflow_definitions (
  workflow_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, revision)
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, definition_revision TEXT NOT NULL,
  state TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (workflow_id, definition_revision) REFERENCES workflow_definitions(workflow_id, revision)
);
CREATE TABLE IF NOT EXISTS workflow_attempts (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, stage_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  state TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, stage_id, ordinal),
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
);
CREATE TABLE IF NOT EXISTS workflow_manifests (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, kind TEXT NOT NULL, manifest TEXT NOT NULL,
  created_at TEXT NOT NULL, FOREIGN KEY (attempt_id) REFERENCES workflow_attempts(id)
);
CREATE TABLE IF NOT EXISTS workflow_requirements (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, definition_revision TEXT NOT NULL,
  requirement TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (workflow_id, definition_revision) REFERENCES workflow_definitions(workflow_id, revision)
);
CREATE TABLE IF NOT EXISTS workflow_decisions (
  id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, manifest_id TEXT NOT NULL,
  decision TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (requirement_id) REFERENCES workflow_requirements(id),
  FOREIGN KEY (manifest_id) REFERENCES workflow_manifests(id)
);
CREATE TABLE IF NOT EXISTS workflow_admissions (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, admission TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES workflow_attempts(id)
);
CREATE TABLE IF NOT EXISTS workflow_invalidations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL, reason TEXT NOT NULL,
  source TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES workflow_attempts(id)
);
CREATE TABLE IF NOT EXISTS workflow_outcomes (
  attempt_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES workflow_attempts(id)
);
CREATE TABLE IF NOT EXISTS workflow_retries (
  attempt_id TEXT PRIMARY KEY, predecessor_attempt_id TEXT NOT NULL,
  diagnosis_manifest_id TEXT NOT NULL, change_manifest_id TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES workflow_attempts(id)
);
`;

export interface WorkflowStageDefinition { id: string; after?: string[] }
export interface WorkflowDefinition { workflow_id: string; revision: string; stages: WorkflowStageDefinition[] }
export interface WorkflowActorRef { name: string; kind: ActorKind }
export interface WorkflowManifest {
  id: string; attempt_id: string; kind: string; subjects: string[]; creators: WorkflowActorRef[];
  operation?: {
    target: string; recipient: string; tenant: string;
    data_class: 'synthetic' | 'client' | 'other';
    visibility: 'private' | 'public';
    cost: 'none' | 'paid';
    effect: 'non_destructive' | 'destructive';
    is_test: boolean;
    recipient_in_registry: boolean;
  };
  supersedes_manifest_id?: string;
}
export interface WorkflowRequirement {
  id: string; workflow_id: string; definition_revision: string; scope: string; subject_manifest_id: string;
  stage_id?: string;
  allowed_verdicts: ('pass' | 'fail' | 'selection')[]; authorities: WorkflowActorRef[];
  independence: 'none' | 'different_from_manifest_creators';
}
export interface WorkflowDecision {
  id: string; requirement_id: string; manifest_id: string; verdict: 'pass' | 'fail' | 'selection' | 'revocation';
  source: string; actor: Actor; revokes_decision_id?: string;
}
export type WorkflowOutcome = 'advanced' | 'rejected' | 'aborted_quarantined';

function now(): string {
  return new Date().toISOString();
}

// A date-only value means the start of that day, UTC — the shape an agent
// actually writes ("not before 2026-09-10"). Everything is normalized to a
// full ISO instant so the queue's comparison can stay a lexicographic one.
// A string Date cannot read is rejected at the door, like a bad schedule:
// stored unchecked it would become a gate that never opens, and nothing
// would say so.
function parseNotBefore(value: string): string {
  const v = value.trim();
  // The zero-padding is not pedantry: '2026-9-10' misses the ISO date form and
  // falls through to the host's own parser, which reads it as LOCAL midnight —
  // a gate quietly off by a timezone, in the one direction nobody checks.
  const dateOnly = !v.includes('T') && !v.includes(':');
  const d = dateOnly && !/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(NaN) : new Date(dateOnly ? `${v}T00:00:00.000Z` : v);
  if (Number.isNaN(d.getTime())) {
    throw new HelmoError(
      `not_before "${value}" is not a date. Use 'YYYY-MM-DD' (zero-padded; the gate opens at 00:00 UTC that day) or a full ISO instant like '2026-09-10T14:00:00Z'.`,
    );
  }
  return d.toISOString();
}

// Marking a sitting says what the sitting is for, in one line (H-1761). A bare
// `true` marked the ticket and told the dashboard nothing, so it drew a row
// that read like backlog and Arthur skipped five of them. The line is what the
// card says; requiring it here is the only place it cannot be forgotten.
//
// The line asks what the SITTING needs — the two of you in a room — and not
// "what the human does", which is what it used to ask (R-42 I13). That older
// wording is an ACTION's line, and asking for it here is why H-2164 records a
// sitting line reading "no separate sitting is needed": the field was the only
// way past `refuseUnmarkedDeskClaim`, so an agent asserted a request it was
// denying in the same breath. Actions have their own path now.
function parseSitting(
  value: string | boolean | undefined,
  withAgent: string | undefined,
): { needs_human: boolean; sitting: string | null; sitting_with: string | null } | undefined {
  const agent = withAgent?.trim();
  if (value === undefined) {
    if (withAgent === undefined) return undefined;
    throw new HelmoError('sitting_with names the agent to sit with, so it only means something alongside needs_human. Mark the sitting in the same call.');
  }
  if (value === false) return { needs_human: false, sitting: null, sitting_with: null };
  if (value === true) {
    throw new HelmoError(
      'needs_human takes the one line the sitting needs, not `true`. Say what the sitting is for, concretely enough to decide whether to pick it up without opening the ticket — e.g. "Twenty minutes going through the three shortlisted vendors and picking one". Pass false to clear the marker.',
    );
  }
  const line = value.trim();
  if (line.length < 20 || !/\s/.test(line)) {
    throw new HelmoError(
      `needs_human "${line}" does not say what the sitting needs. Write the line the human reads on the dashboard: what the sitting is for, and roughly what it costs him.`,
    );
  }
  return { needs_human: true, sitting: line, sitting_with: agent || null };
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

// H-71: a mis-serialized tool call dumps parameter markup — and every field
// after the break — into the first free-text field, and the swallowed fields
// are silently lost. Detection lives store-side because the writing agent is,
// by definition, the one whose serialization is broken. Matches the tool-call
// tag vocabulary with or without a namespace prefix.
const TOOLCALL_MARKUP = /<\/?([a-z]+:)?(parameter|invoke|function_calls)[\s>=]/i;

function rejectSwallowedMarkup(fields: Record<string, string | undefined | null>): void {
  for (const [name, value] of Object.entries(fields)) {
    if (!value) continue;
    if (TOOLCALL_MARKUP.test(value) || value.includes(`</${name}>`)) {
      throw new HelmoError(
        `The "${name}" text contains tool-call parameter markup ("</${name}>", "<parameter name=", or similar) — the signature of a mis-serialized call, where every field after the break is swallowed into this one and silently lost (H-71). Nothing was stored. Re-send the write with each field as its own parameter. If you are deliberately quoting such markup, break the tag (e.g. "< parameter") so it cannot be mistaken for a serialization fault.`,
      );
    }
  }
}

const IMMUTABLE_COMMIT_REF = /^[^\s@]+@[0-9a-f]{40}$/;

function normalizeArtifacts(input: ProductArtifact[] | undefined): ProductArtifact[] {
  if (!input?.length) throw new HelmoError('Product completion requires at least one artifact: {ref: "repo@<full 40-character commit>", author: "name"}.');
  const artifacts = input.map((a) => ({ ref: a.ref?.trim(), author: a.author?.trim() }));
  for (const a of artifacts) {
    if (!IMMUTABLE_COMMIT_REF.test(a.ref)) {
      throw new HelmoError(`Artifact ref "${a.ref}" is not immutable. Use repo@ followed by the full 40-character lowercase commit hash.`);
    }
    if (!a.author) throw new HelmoError(`Artifact ${a.ref} is missing its author name.`);
  }
  if (new Set(artifacts.map((a) => a.ref)).size !== artifacts.length) throw new HelmoError('Each completed ref must appear once.');
  return artifacts.sort((a, b) => a.ref.localeCompare(b.ref));
}

function normalizeRefs(input: string[] | undefined): string[] {
  if (!input?.length) throw new HelmoError('Acceptance verdict requires the exact refs reviewed.');
  const refs = input.map((r) => r.trim()).sort();
  for (const ref of refs) {
    if (!IMMUTABLE_COMMIT_REF.test(ref)) {
      throw new HelmoError(`Verdict ref "${ref}" is not immutable. Use repo@ followed by the full 40-character lowercase commit hash.`);
    }
  }
  if (new Set(refs).size !== refs.length) throw new HelmoError('Each reviewed ref must appear once.');
  return refs;
}

export class Store {
  private db: Database.Database;
  private installation?: Installation;
  private workflowActor?: Actor;

  constructor(path: string, installation?: Installation, workflowActor?: Actor | null) {
    this.installation = installation;
    this.workflowActor = workflowActor ?? undefined;
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    // WAL lets readers run alongside the one writer, but a second WRITER gets
    // SQLITE_BUSY with no retry window unless we ask for one — and every open
    // is a writer, since the constructor below migrates. Five seconds is far
    // beyond any legitimate write here (single-row inserts on a local file,
    // milliseconds) and exists to absorb pileups: four loops polling, a sweep
    // spawning schedule instances, the dashboard answering. It is the ceiling
    // on how long any caller stalls behind a writer, so it must stay well
    // under the callers' own patience — rev polls on 60s (H-134).
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    // The pragma alone is not enough, and the gap is silent: every write here
    // runs in a transaction that reads first (minting an id, loading a ticket),
    // so a DEFERRED begin only asks for the write lock partway through — and
    // SQLite refuses that upgrade with an instant SQLITE_BUSY rather than
    // waiting, because waiting mid-transaction is how deadlocks happen. The
    // busy_timeout never gets a chance to apply. Every write transaction below
    // therefore runs .immediate(): the lock is taken at BEGIN, where waiting is
    // safe and the timeout does its job. Removing an .immediate() reintroduces
    // H-134 without failing a single test that doesn't contend.
    this.db.exec(SCHEMA);
    // Additive migration for stores created before recurring templates (H-22).
    try {
      this.db.exec('ALTER TABLE tickets ADD COLUMN schedule TEXT');
    } catch {
      /* column already exists */
    }
    // Additive migration for stores created before the project tag (H-172).
    try {
      this.db.exec('ALTER TABLE tickets ADD COLUMN project TEXT');
    } catch {
      /* column already exists */
    }
    // Additive migration for stores created before the date gate (H-732).
    try {
      this.db.exec('ALTER TABLE tickets ADD COLUMN not_before TEXT');
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec('ALTER TABLE tickets ADD COLUMN capacity_hold TEXT');
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec('ALTER TABLE tickets ADD COLUMN needs_human INTEGER NOT NULL DEFAULT 0');
    } catch {
      /* column already exists */
    }
    // Additive migration for the line a sitting carries (H-1761). Tickets
    // marked before it exists keep needs_human with a null sitting; the
    // dashboard says so rather than guessing.
    try {
      this.db.exec('ALTER TABLE tickets ADD COLUMN sitting TEXT');
    } catch {
      /* column already exists */
    }
    // Additive migration for the agent a sitting is with (R-42 I13). Rows
    // marked before it exists keep a null, and the dashboard says it does not
    // know rather than naming a seat nobody chose.
    try {
      this.db.exec('ALTER TABLE tickets ADD COLUMN sitting_with TEXT');
    } catch {
      /* column already exists */
    }
    // Additive migration for stores created before workstream seats (H-1026).
    try {
      this.db.exec('ALTER TABLE workstreams ADD COLUMN seat TEXT');
    } catch {
      /* column already exists */
    }
    // Additive migration for stores created before spend acknowledgement (H-1715).
    try {
      this.db.exec('ALTER TABLE hygiene_dispositions ADD COLUMN at_cost REAL');
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec('ALTER TABLE tickets ADD COLUMN workflow_attempt_id TEXT');
    } catch {
      /* column already exists */
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_workflow_attempt ON tickets(workflow_attempt_id) WHERE workflow_attempt_id IS NOT NULL');
  }

  close(): void {
    this.db.close();
  }

  addWorkflowDefinition(definition: WorkflowDefinition): void {
    const workflowId = typeof definition?.workflow_id === 'string' ? definition.workflow_id.trim() : '';
    const revision = typeof definition?.revision === 'string' ? definition.revision.trim() : '';
    if (!workflowId || !revision || !Array.isArray(definition?.stages) || definition.stages.length === 0) {
      throw new HelmoError('A workflow definition requires workflow_id, revision, and at least one stage.');
    }
    if (definition.stages.some((stage) => !stage || typeof stage !== 'object' || typeof stage.id !== 'string')) {
      throw new HelmoError('Every workflow stage requires a string id.');
    }
    const ids = definition.stages.map((stage) => stage.id.trim());
    if (definition.stages.some((stage) => stage.id !== stage.id.trim())) throw new HelmoError('Workflow stage ids cannot have surrounding whitespace.');
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new HelmoError('Workflow stage ids must be non-empty and unique.');
    const known = new Set(ids);
    for (const stage of definition.stages) {
      if (stage.after !== undefined && (!Array.isArray(stage.after) || stage.after.some((id) => typeof id !== 'string' || !id.trim()))) {
        throw new HelmoError(`Workflow stage "${stage.id}" requires after to be an array of non-empty stage ids.`);
      }
      for (const prerequisite of stage.after ?? []) {
        if (!known.has(prerequisite)) throw new HelmoError(`Workflow stage "${stage.id}" names unknown prerequisite "${prerequisite}".`);
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(definition.stages.map((stage) => [stage.id, stage]));
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new HelmoError(`Workflow definition contains a cycle at stage "${id}".`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const prerequisite of byId.get(id)!.after ?? []) visit(prerequisite);
      visiting.delete(id); visited.add(id);
    };
    for (const id of ids) visit(id);
    try {
      this.db.prepare('INSERT INTO workflow_definitions (workflow_id, revision, definition, created_at) VALUES (?, ?, ?, ?)')
        .run(workflowId, revision, JSON.stringify(definition), now());
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) throw new HelmoError(`Workflow definition ${workflowId}@${revision} already exists and is immutable.`);
      throw error;
    }
  }

  getWorkflowDefinition(workflowId: string, revision: string): WorkflowDefinition | null {
    const row = this.db.prepare('SELECT definition FROM workflow_definitions WHERE workflow_id = ? AND revision = ?')
      .get(workflowId, revision) as { definition: string } | undefined;
    return row ? JSON.parse(row.definition) as WorkflowDefinition : null;
  }

  addWorkflowRun(input: { id: string; workflow_id: string; definition_revision: string }): void {
    const { id, workflow_id, definition_revision } = input;
    if (![id, workflow_id, definition_revision].every((v) => typeof v === 'string' && v.trim() === v && v.length)) throw new HelmoError('Workflow run ids and definition references must be non-empty strings without surrounding whitespace.');
    if (!this.getWorkflowDefinition(workflow_id, definition_revision)) throw new HelmoError(`Workflow definition ${workflow_id}@${definition_revision} does not exist.`);
    try { this.db.prepare("INSERT INTO workflow_runs (id, workflow_id, definition_revision, state, created_at) VALUES (?, ?, ?, 'created', ?)").run(id, workflow_id, definition_revision, now()); }
    catch (error) { if (String(error).includes('UNIQUE constraint failed')) throw new HelmoError(`Workflow run ${id} already exists and is immutable.`); throw error; }
  }

  addWorkflowAttempt(input: { id: string; run_id: string; stage_id: string; ordinal: number }): void {
    const run = this.db.prepare('SELECT workflow_id, definition_revision FROM workflow_runs WHERE id = ?').get(input.run_id) as { workflow_id: string; definition_revision: string } | undefined;
    if (!run) throw new HelmoError(`Workflow run ${input.run_id} does not exist.`);
    const definition = this.getWorkflowDefinition(run.workflow_id, run.definition_revision)!;
    if (!definition.stages.some((stage) => stage.id === input.stage_id)) throw new HelmoError(`Stage ${input.stage_id} is not in ${run.workflow_id}@${run.definition_revision}.`);
    if (!input.id?.trim() || input.id.trim() !== input.id || !Number.isInteger(input.ordinal) || input.ordinal < 1) throw new HelmoError('Workflow attempts require an exact id and a positive integer ordinal.');
    try { this.db.prepare("INSERT INTO workflow_attempts (id, run_id, stage_id, ordinal, state, created_at) VALUES (?, ?, ?, ?, 'created', ?)").run(input.id, input.run_id, input.stage_id, input.ordinal, now()); }
    catch (error) { if (String(error).includes('UNIQUE constraint failed')) throw new HelmoError(`Workflow attempt ${input.id} or its run/stage/ordinal already exists.`); throw error; }
  }

  recordWorkflowOutcome(input: { attempt_id: string; outcome: WorkflowOutcome }): { attempt_id: string; outcome: WorkflowOutcome } {
    if (!input?.attempt_id?.trim() || !['advanced', 'rejected', 'aborted_quarantined'].includes(input.outcome)) throw new HelmoError('Workflow outcomes require an exact attempt_id and a supported outcome.');
    return this.db.transaction(() => {
      const attempt = this.db.prepare('SELECT state FROM workflow_attempts WHERE id = ?').get(input.attempt_id) as { state: string } | undefined;
      if (!attempt) throw new HelmoError(`Workflow attempt ${input.attempt_id} does not exist.`);
      const prior = this.db.prepare('SELECT outcome FROM workflow_outcomes WHERE attempt_id = ?').get(input.attempt_id) as { outcome: string } | undefined;
      if (prior) {
        const recorded = JSON.parse(prior.outcome) as { outcome: WorkflowOutcome };
        if (recorded.outcome !== input.outcome) throw new HelmoError(`Workflow attempt ${input.attempt_id} already has mutually exclusive outcome ${recorded.outcome}.`);
        return { attempt_id: input.attempt_id, outcome: recorded.outcome };
      }
      if (input.outcome === 'aborted_quarantined' ? attempt.state !== 'quarantined' : attempt.state !== 'running') throw new HelmoError(`Workflow attempt ${input.attempt_id} cannot record ${input.outcome} from state ${attempt.state}.`);
      this.db.prepare('INSERT INTO workflow_outcomes (attempt_id, outcome, created_at) VALUES (?, ?, ?)').run(input.attempt_id, JSON.stringify({ outcome: input.outcome }), now());
      this.db.prepare("UPDATE workflow_attempts SET state = 'complete' WHERE id = ?").run(input.attempt_id);
      return { attempt_id: input.attempt_id, outcome: input.outcome };
    }).immediate();
  }

  retryWorkflowAttempt(input: { id: string; predecessor_attempt_id: string; diagnosis_manifest_id: string; change_manifest_id: string }): void {
    this.db.transaction(() => {
      const predecessor = this.db.prepare(`SELECT a.run_id, a.stage_id, a.ordinal, o.outcome FROM workflow_attempts a LEFT JOIN workflow_outcomes o ON o.attempt_id = a.id WHERE a.id = ?`).get(input.predecessor_attempt_id) as { run_id: string; stage_id: string; ordinal: number; outcome: string | null } | undefined;
      if (!predecessor?.outcome) throw new HelmoError('A retry requires a predecessor with a terminal outcome.');
      const outcome = (JSON.parse(predecessor.outcome) as { outcome: WorkflowOutcome }).outcome;
      if (!['rejected', 'aborted_quarantined'].includes(outcome)) throw new HelmoError(`Outcome ${outcome} cannot be retried.`);
      for (const [kind, id] of [['diagnosis', input.diagnosis_manifest_id], ['change', input.change_manifest_id]] as const) {
        const manifest = this.db.prepare('SELECT attempt_id, kind FROM workflow_manifests WHERE id = ?').get(id) as { attempt_id: string; kind: string } | undefined;
        if (!manifest || manifest.attempt_id !== input.predecessor_attempt_id || manifest.kind !== kind) throw new HelmoError(`Retry ${kind} evidence must be a ${kind} manifest on the predecessor attempt.`);
      }
      const existing = this.db.prepare('SELECT predecessor_attempt_id, diagnosis_manifest_id, change_manifest_id FROM workflow_retries WHERE attempt_id = ?').get(input.id) as Record<string, string> | undefined;
      if (existing) {
        if (existing.predecessor_attempt_id === input.predecessor_attempt_id && existing.diagnosis_manifest_id === input.diagnosis_manifest_id && existing.change_manifest_id === input.change_manifest_id) return;
        throw new HelmoError(`Workflow retry ${input.id} already exists with different evidence.`);
      }
      this.addWorkflowAttempt({ id: input.id, run_id: predecessor.run_id, stage_id: predecessor.stage_id, ordinal: predecessor.ordinal + 1 });
      this.db.prepare('INSERT INTO workflow_retries (attempt_id, predecessor_attempt_id, diagnosis_manifest_id, change_manifest_id, created_at) VALUES (?, ?, ?, ?, ?)').run(input.id, input.predecessor_attempt_id, input.diagnosis_manifest_id, input.change_manifest_id, now());
    }).immediate();
  }

  addWorkflowManifest(manifest: WorkflowManifest): void {
    if (!manifest?.id?.trim() || manifest.id.trim() !== manifest.id || !manifest.attempt_id?.trim() || !manifest.kind?.trim()) throw new HelmoError('Workflow manifests require exact id, attempt_id, and kind values.');
    if (!Array.isArray(manifest.subjects) || !manifest.subjects.length || manifest.subjects.some((v) => typeof v !== 'string' || !v.trim()) || new Set(manifest.subjects).size !== manifest.subjects.length) throw new HelmoError('Workflow manifests require unique, non-empty exact subjects.');
    if (!Array.isArray(manifest.creators) || !manifest.creators.length || manifest.creators.some((a) => !a?.name?.trim() || !ACTOR_KINDS.includes(a.kind))) throw new HelmoError('Workflow manifests require at least one creator with an exact name and actor kind.');
    if (manifest.kind === 'operation') {
      const fields = ['target', 'recipient', 'tenant', 'data_class', 'visibility', 'cost', 'effect'] as const;
      if (!manifest.operation || fields.some((field) => typeof manifest.operation![field] !== 'string' || !manifest.operation![field].trim() || manifest.operation![field].trim() !== manifest.operation![field])) throw new HelmoError(`Operation manifests require exact ${fields.join(', ')} values.`);
      if (typeof manifest.operation.is_test !== 'boolean' || typeof manifest.operation.recipient_in_registry !== 'boolean') throw new HelmoError('Operation manifests require exact is_test and recipient_in_registry evidence.');
    } else if (manifest.operation) throw new HelmoError('Only operation manifests may carry operation fields.');
    if (!this.db.prepare('SELECT 1 FROM workflow_attempts WHERE id = ?').get(manifest.attempt_id)) throw new HelmoError(`Workflow attempt ${manifest.attempt_id} does not exist.`);
    if (manifest.supersedes_manifest_id) {
      const prior = this.db.prepare('SELECT attempt_id, kind FROM workflow_manifests WHERE id = ?').get(manifest.supersedes_manifest_id) as { attempt_id: string; kind: string } | undefined;
      if (!prior || prior.attempt_id !== manifest.attempt_id || prior.kind !== manifest.kind) throw new HelmoError('A superseding manifest must replace an existing manifest from the same attempt and kind.');
    }
    try { this.db.transaction(() => {
      this.db.prepare('INSERT INTO workflow_manifests (id, attempt_id, kind, manifest, created_at) VALUES (?, ?, ?, ?, ?)').run(manifest.id, manifest.attempt_id, manifest.kind, JSON.stringify(manifest), now());
      if (manifest.supersedes_manifest_id) this.invalidateWorkflowFromManifest(manifest.supersedes_manifest_id, `manifest:${manifest.id}`);
    })(); }
    catch (error) { if (String(error).includes('UNIQUE constraint failed')) throw new HelmoError(`Workflow manifest ${manifest.id} already exists and is immutable.`); throw error; }
  }

  private invalidateWorkflowFromManifest(manifestId: string, source: string): void {
    const rows = this.db.prepare(`SELECT DISTINCT a.attempt_id FROM workflow_admissions a
      WHERE EXISTS (SELECT 1 FROM json_each(a.admission, '$.requirements') r
        WHERE json_extract(r.value, '$.manifest_id') = ?)`)
      .all(manifestId) as { attempt_id: string }[];
    this.invalidateWorkflowAttempts(rows.map((row) => row.attempt_id), 'manifest_superseded', source);
  }

  private invalidateWorkflowFromDecision(decisionId: string, source: string): void {
    const rows = this.db.prepare(`SELECT DISTINCT a.attempt_id FROM workflow_admissions a
      WHERE EXISTS (SELECT 1 FROM json_each(a.admission, '$.requirements') r
        WHERE json_extract(r.value, '$.decision_id') = ?)`)
      .all(decisionId) as { attempt_id: string }[];
    this.invalidateWorkflowAttempts(rows.map((row) => row.attempt_id), 'decision_revoked', source);
  }

  private invalidateWorkflowAttempts(seedIds: string[], reason: string, source: string): void {
    const queue = [...seedIds];
    const affected = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (affected.has(id)) continue;
      affected.add(id);
      const row = this.db.prepare(`SELECT a.run_id, a.stage_id, r.workflow_id, r.definition_revision
        FROM workflow_attempts a JOIN workflow_runs r ON r.id = a.run_id WHERE a.id = ?`).get(id) as
        { run_id: string; stage_id: string; workflow_id: string; definition_revision: string } | undefined;
      if (!row) continue;
      const definition = this.getWorkflowDefinition(row.workflow_id, row.definition_revision);
      const descendants = new Set([row.stage_id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const stage of definition?.stages ?? []) if ((stage.after ?? []).some((p) => descendants.has(p)) && !descendants.has(stage.id)) {
          descendants.add(stage.id); changed = true;
        }
      }
      const downstream = this.db.prepare(`SELECT id FROM workflow_attempts WHERE run_id = ? AND stage_id IN (${[...descendants].map(() => '?').join(',')})`)
        .all(row.run_id, ...descendants) as { id: string }[];
      for (const candidate of downstream) if (!affected.has(candidate.id)) queue.push(candidate.id);
    }
    const insert = this.db.prepare('INSERT INTO workflow_invalidations (attempt_id, reason, source, created_at) VALUES (?, ?, ?, ?)');
    const quarantine = this.db.prepare("UPDATE workflow_attempts SET state = 'quarantined' WHERE id = ?");
    for (const id of affected) {
      if (!this.db.prepare('SELECT 1 FROM workflow_invalidations WHERE attempt_id = ? AND reason = ? AND source = ?').get(id, reason, source)) insert.run(id, reason, source, now());
      quarantine.run(id);
    }
  }

  addWorkflowRequirement(requirement: WorkflowRequirement): void {
    if (!requirement?.id?.trim() || !requirement.scope?.trim() || !requirement.subject_manifest_id?.trim()) throw new HelmoError('Workflow requirements require id, scope, and an exact subject manifest.');
    if (!this.getWorkflowDefinition(requirement.workflow_id, requirement.definition_revision)) throw new HelmoError(`Workflow definition ${requirement.workflow_id}@${requirement.definition_revision} does not exist.`);
    if (requirement.stage_id && !this.getWorkflowDefinition(requirement.workflow_id, requirement.definition_revision)!.stages.some((stage) => stage.id === requirement.stage_id)) throw new HelmoError(`Workflow requirement ${requirement.id} names unknown stage ${requirement.stage_id}.`);
    const subject = this.db.prepare(`SELECT r.workflow_id, r.definition_revision FROM workflow_manifests m
      JOIN workflow_attempts a ON a.id = m.attempt_id JOIN workflow_runs r ON r.id = a.run_id WHERE m.id = ?`).get(requirement.subject_manifest_id) as { workflow_id: string; definition_revision: string } | undefined;
    if (!subject) throw new HelmoError(`Subject manifest ${requirement.subject_manifest_id} does not exist.`);
    if (subject.workflow_id !== requirement.workflow_id || subject.definition_revision !== requirement.definition_revision) throw new HelmoError(`Subject manifest ${requirement.subject_manifest_id} belongs to ${subject.workflow_id}@${subject.definition_revision}, not ${requirement.workflow_id}@${requirement.definition_revision}.`);
    const allowed = new Set(['pass', 'fail', 'selection']);
    if (!requirement.allowed_verdicts?.length || requirement.allowed_verdicts.some((v) => !allowed.has(v))) throw new HelmoError('Workflow requirements need at least one allowed verdict.');
    if (!requirement.authorities?.length || requirement.authorities.some((a) => !a?.name?.trim() || !ACTOR_KINDS.includes(a.kind))) throw new HelmoError('Workflow requirements need at least one exact actor authority.');
    if (!['none', 'different_from_manifest_creators'].includes(requirement.independence)) throw new HelmoError('Workflow requirement independence is invalid.');
    try { this.db.prepare('INSERT INTO workflow_requirements (id, workflow_id, definition_revision, requirement, created_at) VALUES (?, ?, ?, ?, ?)').run(requirement.id, requirement.workflow_id, requirement.definition_revision, JSON.stringify(requirement), now()); }
    catch (error) { if (String(error).includes('UNIQUE constraint failed')) throw new HelmoError(`Workflow requirement ${requirement.id} already exists and is immutable.`); throw error; }
  }

  recordWorkflowDecision(decision: Omit<WorkflowDecision, 'actor'>): WorkflowDecision {
    const actor = this.workflowActor;
    if (!actor) throw new HelmoError('Workflow decisions require a trusted runtime actor; caller-supplied identity is not accepted.');
    validateActor(actor);
    if (!decision?.id?.trim() || !decision.source?.trim()) throw new HelmoError('Workflow decisions require an immutable id and original decision source.');
    const row = this.db.prepare('SELECT requirement FROM workflow_requirements WHERE id = ?').get(decision.requirement_id) as { requirement: string } | undefined;
    if (!row) throw new HelmoError(`Workflow requirement ${decision.requirement_id} does not exist.`);
    const requirement = JSON.parse(row.requirement) as WorkflowRequirement;
    if (decision.manifest_id !== requirement.subject_manifest_id) throw new HelmoError(`Decision manifest ${decision.manifest_id} is stale or outside requirement ${requirement.id}; expected ${requirement.subject_manifest_id}.`);
    if (!requirement.authorities.some((a) => a.name === actor.name && a.kind === actor.kind)) throw new HelmoError(`Actor ${actor.kind}:${actor.name} is not authorized for workflow requirement ${requirement.id}.`);
    const manifestRow = this.db.prepare('SELECT manifest FROM workflow_manifests WHERE id = ?').get(decision.manifest_id) as { manifest: string } | undefined;
    if (!manifestRow) throw new HelmoError(`Workflow manifest ${decision.manifest_id} does not exist.`);
    const manifest = JSON.parse(manifestRow.manifest) as WorkflowManifest;
    if (requirement.independence === 'different_from_manifest_creators' && manifest.creators.some((a) => a.name === actor.name)) throw new HelmoError(`Actor "${actor.name}" created subject manifest ${manifest.id} and cannot decide independent scope ${requirement.scope}.`);
    if (decision.verdict === 'revocation') {
      if (!decision.revokes_decision_id) throw new HelmoError('A workflow revocation must name the exact prior decision it revokes.');
      const prior = this.db.prepare('SELECT requirement_id, manifest_id, decision FROM workflow_decisions WHERE id = ?').get(decision.revokes_decision_id) as { requirement_id: string; manifest_id: string; decision: string } | undefined;
      if (!prior || prior.requirement_id !== requirement.id || prior.manifest_id !== manifest.id || (JSON.parse(prior.decision) as WorkflowDecision).verdict === 'revocation') throw new HelmoError('A workflow revocation must target a standing decision in the same requirement and manifest scope.');
      if (this.db.prepare("SELECT 1 FROM workflow_decisions WHERE json_extract(decision, '$.revokes_decision_id') = ?").get(decision.revokes_decision_id)) throw new HelmoError(`Workflow decision ${decision.revokes_decision_id} is already revoked.`);
    } else if (!requirement.allowed_verdicts.includes(decision.verdict)) throw new HelmoError(`Verdict ${decision.verdict} is not allowed for workflow requirement ${requirement.id}.`);
    const stored: WorkflowDecision = { ...decision, actor };
    const existing = this.db.prepare('SELECT decision FROM workflow_decisions WHERE requirement_id = ? AND manifest_id = ? ORDER BY rowid')
      .all(requirement.id, manifest.id).map((row) => JSON.parse((row as { decision: string }).decision) as WorkflowDecision);
    const revoked = new Set(existing.filter((item) => item.verdict === 'revocation').map((item) => item.revokes_decision_id));
    const superseded = existing.filter((item) => item.verdict !== 'revocation' && !revoked.has(item.id)).at(-1);
    try { this.db.transaction(() => {
      this.db.prepare('INSERT INTO workflow_decisions (id, requirement_id, manifest_id, decision, created_at) VALUES (?, ?, ?, ?, ?)').run(decision.id, decision.requirement_id, decision.manifest_id, JSON.stringify(stored), now());
      if (decision.verdict === 'revocation') this.invalidateWorkflowFromDecision(decision.revokes_decision_id!, `decision:${decision.id}`);
      else if (superseded) this.invalidateWorkflowFromDecision(superseded.id, `decision:${decision.id}`);
    })(); }
    catch (error) { if (String(error).includes('UNIQUE constraint failed')) throw new HelmoError(`Workflow decision ${decision.id} already exists and is immutable.`); throw error; }
    return stored;
  }

  /** Check and record the permission that opens execution of one bound
   * attempt. The caller must already be inside the ticket mutation's IMMEDIATE
   * transaction: the decisions read here, the admission, and the status/event
   * write are one SQLite commit rather than a queued snapshot. */
  private admitWorkflow(ticketId: string, attemptId: string, operation: string, launchId?: string): Record<string, unknown> {
    const attempt = this.db.prepare(`SELECT a.stage_id, a.state, r.id AS run_id, r.workflow_id, r.definition_revision
      FROM workflow_attempts a JOIN workflow_runs r ON r.id = a.run_id WHERE a.id = ?`).get(attemptId) as
      { stage_id: string; state: string; run_id: string; workflow_id: string; definition_revision: string } | undefined;
    if (!attempt) {
      throw new HelmoError(`workflow_admission_denied ${JSON.stringify({ attempt_id: attemptId, missing: ['attempt'], stale: [], failed: [] })}`);
    }
    if (attempt.state === 'quarantined') {
      throw new HelmoError(`workflow_admission_denied ${JSON.stringify({ attempt_id: attemptId, missing: [], stale: ['invalidation'], failed: [] })}`);
    }
    const definition = this.getWorkflowDefinition(attempt.workflow_id, attempt.definition_revision);
    if (!definition) {
      throw new HelmoError(`workflow_admission_denied ${JSON.stringify({ attempt_id: attemptId, missing: [], stale: ['definition'], failed: [] })}`);
    }
    const stage = definition.stages.find((candidate) => candidate.id === attempt.stage_id);
    if (!stage) {
      throw new HelmoError(`workflow_admission_denied ${JSON.stringify({ attempt_id: attemptId, missing: [], stale: ['stage'], failed: [] })}`);
    }

    const missing: string[] = [];
    const stale: string[] = [];
    const failed: string[] = [];
    for (const prerequisite of stage.after ?? []) {
      const prior = this.db.prepare(`SELECT o.outcome, a.state FROM workflow_attempts a
        LEFT JOIN workflow_outcomes o ON o.attempt_id = a.id
        WHERE a.run_id = ? AND a.stage_id = ? ORDER BY a.ordinal DESC LIMIT 1`).get(attempt.run_id, prerequisite) as { outcome: string | null; state: string } | undefined;
      if (!prior?.outcome || prior.state === 'quarantined' || (JSON.parse(prior.outcome) as { outcome?: string }).outcome !== 'advanced') missing.push(`stage:${prerequisite}`);
    }

    const requirements = this.db.prepare('SELECT id, requirement FROM workflow_requirements WHERE workflow_id = ? AND definition_revision = ? ORDER BY id')
      .all(attempt.workflow_id, attempt.definition_revision) as { id: string; requirement: string }[];
    const admitted: { requirement_id: string; manifest_id: string; decision_id: string; verdict: string }[] = [];
    for (const row of requirements) {
      const requirement = JSON.parse(row.requirement) as WorkflowRequirement;
      if (requirement.stage_id && requirement.stage_id !== attempt.stage_id) continue;
      const decisions = this.db.prepare('SELECT decision FROM workflow_decisions WHERE requirement_id = ? AND manifest_id = ? ORDER BY rowid')
        .all(requirement.id, requirement.subject_manifest_id).map((r) => JSON.parse((r as { decision: string }).decision) as WorkflowDecision);
      const revoked = new Set(decisions.filter((d) => d.verdict === 'revocation').map((d) => d.revokes_decision_id));
      const standing = decisions.filter((d) => d.verdict !== 'revocation' && !revoked.has(d.id)).at(-1);
      if (!standing) {
        (decisions.length ? stale : missing).push(`requirement:${requirement.id}`);
      } else if (standing.verdict === 'fail') {
        failed.push(`requirement:${requirement.id}`);
      } else {
        admitted.push({ requirement_id: requirement.id, manifest_id: requirement.subject_manifest_id, decision_id: standing.id, verdict: standing.verdict });
      }
    }
    if (missing.length || stale.length || failed.length) {
      throw new HelmoError(`workflow_admission_denied ${JSON.stringify({ attempt_id: attemptId, missing, stale, failed })}`);
    }
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events').get() as { seq: number }).seq;
    const admission = {
      id: `admission:${attemptId}:${operation}:${seq}`,
      ticket_id: ticketId,
      attempt_id: attemptId,
      operation,
      workflow_id: attempt.workflow_id,
      definition_revision: attempt.definition_revision,
      requirements: admitted,
      ...(launchId ? { launch_id: launchId } : {}),
    };
    this.db.prepare('INSERT INTO workflow_admissions (id, attempt_id, admission, created_at) VALUES (?, ?, ?, ?)')
      .run(admission.id, attemptId, JSON.stringify(admission), now());
    this.db.prepare("UPDATE workflow_attempts SET state = 'running' WHERE id = ?").run(attemptId);
    return admission;
  }

  /** Atomically select Rev's next candidate and, when it is workflow-bound,
   * record the exact permission consumed by this one model launch. */
  launchAdmission(workstream: string, assignee: string, launchId: string): Record<string, unknown> {
    if (!workstream.trim() || !assignee.trim() || !launchId.trim()) throw new HelmoError('launch-admit requires exact non-empty workstream, assignee, and launch-id values.');
    return this.db.transaction(() => {
      const ticket = this.listTickets({ ready: true, workstream, caller: assignee, limit: 1 })[0];
      if (!ticket) return { admitted: false, launch_id: launchId };
      if (!ticket.workflow_attempt_id) return { admitted: true, ticket_id: ticket.id, workflow_attempt_id: null, admission_id: null, launch_id: launchId };
      const prior = this.db.prepare("SELECT admission FROM workflow_admissions WHERE attempt_id = ? AND json_extract(admission, '$.operation') = 'launch' ORDER BY rowid DESC LIMIT 1")
        .get(ticket.workflow_attempt_id) as { admission: string } | undefined;
      if (prior) {
        const admission = JSON.parse(prior.admission) as Record<string, unknown>;
        if (admission.launch_id === launchId) return { admitted: true, ticket_id: ticket.id, workflow_attempt_id: ticket.workflow_attempt_id, admission_id: admission.id, launch_id: launchId };
        throw new HelmoError(`workflow_admission_denied ${JSON.stringify({ ticket_id: ticket.id, attempt_id: ticket.workflow_attempt_id, missing: [], stale: ['launch'], failed: [] })}`);
      }
      const admission = this.admitWorkflow(ticket.id, ticket.workflow_attempt_id, 'launch', launchId);
      return { admitted: true, ticket_id: ticket.id, workflow_attempt_id: ticket.workflow_attempt_id, admission_id: admission.id, launch_id: launchId };
    }).immediate();
  }

  /** Resolve one launch receipt by both immutable identities. The expanded
   * evidence is intentionally read from the ids captured in the admission,
   * never from whatever happens to be current now. */
  launchReceipt(admissionId: string, launchId: string): Record<string, unknown> {
    if (!admissionId?.trim() || !launchId?.trim()) throw new HelmoError('launch-receipt requires exact non-empty admission-id and launch-id values.');
    const row = this.db.prepare('SELECT admission, created_at FROM workflow_admissions WHERE id = ?').get(admissionId) as { admission: string; created_at: string } | undefined;
    if (!row) throw new HelmoError(`Launch admission ${admissionId} does not exist.`);
    let admission: Record<string, unknown>;
    try { admission = JSON.parse(row.admission) as Record<string, unknown>; }
    catch { throw new HelmoError(`Launch admission ${admissionId} is corrupt.`); }
    if (admission.operation !== 'launch' || admission.launch_id !== launchId) throw new HelmoError(`Launch admission ${admissionId} does not match launch ${launchId}.`);
    const requirements = admission.requirements;
    if (!Array.isArray(requirements)) throw new HelmoError(`Launch admission ${admissionId} is corrupt.`);
    const evidence = requirements.map((item) => {
      const captured = item as { requirement_id?: string; manifest_id?: string; decision_id?: string; verdict?: string };
      if (![captured.requirement_id, captured.manifest_id, captured.decision_id, captured.verdict].every((v) => typeof v === 'string' && v.length)) throw new HelmoError(`Launch admission ${admissionId} is corrupt.`);
      const requirement = this.db.prepare('SELECT requirement FROM workflow_requirements WHERE id = ?').get(captured.requirement_id) as { requirement: string } | undefined;
      const manifest = this.db.prepare('SELECT manifest FROM workflow_manifests WHERE id = ?').get(captured.manifest_id) as { manifest: string } | undefined;
      const decision = this.db.prepare('SELECT decision FROM workflow_decisions WHERE id = ?').get(captured.decision_id) as { decision: string } | undefined;
      if (!requirement || !manifest || !decision) throw new HelmoError(`Launch admission ${admissionId} has unavailable evidence.`);
      try { return { requirement: JSON.parse(requirement.requirement), manifest: JSON.parse(manifest.manifest), decision: JSON.parse(decision.decision) }; }
      catch { throw new HelmoError(`Launch admission ${admissionId} has corrupt evidence.`); }
    });
    return { ...admission, created_at: row.created_at, evidence };
  }

  /** Re-check the exact captured authority in one snapshot. This read never
   * repairs or substitutes evidence: changed authority makes the launch stale. */
  revalidateLaunch(admissionId: string, launchId: string): Record<string, unknown> {
    return this.db.transaction(() => {
      const receipt = this.launchReceipt(admissionId, launchId);
      const attemptId = receipt.attempt_id as string;
      const attempt = this.db.prepare(`SELECT a.stage_id, a.state, r.workflow_id, r.definition_revision
        FROM workflow_attempts a JOIN workflow_runs r ON r.id = a.run_id WHERE a.id = ?`).get(attemptId) as
        { stage_id: string; state: string; workflow_id: string; definition_revision: string } | undefined;
      const missing: string[] = [];
      const stale: string[] = [];
      const failed: string[] = [];
      if (!attempt) stale.push('attempt');
      else {
        if (attempt.workflow_id !== receipt.workflow_id || attempt.definition_revision !== receipt.definition_revision) stale.push('attempt');
        if (attempt.state === 'quarantined' || this.db.prepare('SELECT 1 FROM workflow_invalidations WHERE attempt_id = ? LIMIT 1').get(attemptId)) stale.push('invalidation');
        const captured = new Map((receipt.requirements as { requirement_id: string; manifest_id: string; decision_id: string }[])
          .map((item) => [item.requirement_id, item]));
        const current = this.db.prepare('SELECT id, requirement FROM workflow_requirements WHERE workflow_id = ? AND definition_revision = ? ORDER BY id')
          .all(attempt.workflow_id, attempt.definition_revision) as { id: string; requirement: string }[];
        const applicable = new Set<string>();
        for (const row of current) {
          const requirement = JSON.parse(row.requirement) as WorkflowRequirement;
          if (requirement.stage_id && requirement.stage_id !== attempt.stage_id) continue;
          applicable.add(requirement.id);
          const item = captured.get(requirement.id);
          const decisions = this.db.prepare('SELECT decision FROM workflow_decisions WHERE requirement_id = ? AND manifest_id = ? ORDER BY rowid')
            .all(requirement.id, requirement.subject_manifest_id).map((decisionRow) => JSON.parse((decisionRow as { decision: string }).decision) as WorkflowDecision);
          const revoked = new Set(decisions.filter((decision) => decision.verdict === 'revocation').map((decision) => decision.revokes_decision_id));
          const standing = decisions.filter((decision) => decision.verdict !== 'revocation' && !revoked.has(decision.id)).at(-1);
          if (!standing) (decisions.length ? stale : missing).push(`requirement:${requirement.id}`);
          else if (standing.verdict === 'fail') failed.push(`requirement:${requirement.id}`);
          else if (!item || item.manifest_id !== requirement.subject_manifest_id || item.decision_id !== standing.id) stale.push(`requirement:${requirement.id}`);
        }
        for (const id of captured.keys()) if (!applicable.has(id)) stale.push(`requirement:${id}`);
      }
      if (missing.length || stale.length || failed.length) throw new HelmoError(`workflow_admission_denied ${JSON.stringify({ admission_id: admissionId, attempt_id: attemptId, missing: [...new Set(missing)], stale: [...new Set(stale)], failed: [...new Set(failed)] })}`);
      return { valid: true, admission_id: admissionId, launch_id: launchId, attempt_id: attemptId };
    }).immediate();
  }

  /** Mark one exact launch unusable. Replays return the same state, while a
   * mismatched identity cannot touch the attempt or any neighboring branch. */
  quarantineLaunch(admissionId: string, launchId: string, reason: string): Record<string, unknown> {
    if (!reason?.trim()) throw new HelmoError('launch-quarantine requires a non-empty reason.');
    return this.db.transaction(() => {
      const receipt = this.launchReceipt(admissionId, launchId);
      const attemptId = receipt.attempt_id as string;
      const source = `launch:${admissionId}`;
      const prior = this.db.prepare("SELECT reason FROM workflow_invalidations WHERE attempt_id = ? AND reason LIKE 'launch_quarantined:%' AND source = ?").get(attemptId, source) as { reason: string } | undefined;
      const attempt = this.db.prepare('SELECT state FROM workflow_attempts WHERE id = ?').get(attemptId) as { state: string } | undefined;
      if (!attempt) throw new HelmoError(`Workflow attempt ${attemptId} does not exist.`);
      if (attempt.state === 'complete' && !prior) throw new HelmoError(`Workflow attempt ${attemptId} is already complete and cannot be quarantined.`);
      const recordedReason = prior?.reason.slice('launch_quarantined:'.length) ?? reason;
      if (!prior) this.db.prepare('INSERT INTO workflow_invalidations (attempt_id, reason, source, created_at) VALUES (?, ?, ?, ?)').run(attemptId, `launch_quarantined:${reason}`, source, now());
      this.db.prepare("UPDATE workflow_attempts SET state = 'quarantined' WHERE id = ? AND state != 'complete'").run(attemptId);
      return { quarantined: true, admission_id: admissionId, launch_id: launchId, attempt_id: attemptId, reason: recordedReason };
    }).immediate();
  }

  private refuseQuarantinedWorkflowMutation(ticketId: string, operation: string): void {
    const row = this.db.prepare(`SELECT a.id FROM tickets t
      JOIN workflow_attempts a ON a.id = t.workflow_attempt_id
      WHERE t.id = ? AND a.state = 'quarantined'`).get(ticketId) as { id: string } | undefined;
    if (row) {
      throw new HelmoError(`workflow_admission_denied ${JSON.stringify({ attempt_id: row.id, operation, missing: [], stale: ['invalidation'], failed: [] })}`);
    }
  }

  /** Durable name claimed by the first explicitly named writer. A derived-only
   *  installation deliberately leaves old single-store use unchanged. */
  /** The installation this store was opened as, for a surface that has to
   *  qualify a record reference with it or check one against it (H-2502).
   *  Undefined for a store opened without one — a library caller or a test —
   *  where a qualified reference has nothing to check and is refused rather
   *  than assumed. */
  installationTarget(): Installation | undefined {
    return this.installation;
  }

  installationIdentity(): { process: string | null; stored: string | null; clear: boolean } {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'installation_name'").get() as { value: string } | undefined;
    const processName = this.installation?.label ?? null;
    return { process: processName, stored: row?.value ?? null, clear: !processName || !row || namesInstallation(this.installation as Installation, row.value) };
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

  /** Current product acceptance for a ticket. Generic ticket status and type
   *  do not participate: acceptance exists only after an explicit completion
   *  event. A newer completion always invalidates an older verdict.
   *
   *  The decision itself is `projectAcceptance` in ./acceptance.ts — a pure
   *  function over the event log, so the deploy gate that measures this rule
   *  against a live store runs the same code rather than a copy of it. */
  productAcceptance(ticketId: string, expectedRefs?: string[]): ProductAcceptance {
    this.getTicket(ticketId);
    const rows = this.db
      .prepare("SELECT * FROM events WHERE ticket_id = ? AND event_type IN ('product_completed','acceptance_verdict') ORDER BY seq")
      .all(ticketId) as Record<string, unknown>[];
    // normalizeRefs here, not in the projection: rejecting a caller's
    // unusable ref is validation of the question, and the replay asks none.
    return projectAcceptance(rows.map(rowToEvent), expectedRefs ? normalizeRefs(expectedRefs) : undefined);
  }

  /** Latest recorded human-readable update for each requested ticket. This is
   *  one bounded query for feed rows, and deliberately excludes spend: meter
   *  write-back is not progress even when it is the newest event. */
  latestProgress(ticketIds: string[]): Map<string, TicketProgress> {
    const ids = [...new Set(ticketIds)];
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT e.ticket_id, e.ts, e.actor, json_extract(e.payload, '$.note') AS note
           FROM events e
           JOIN (
             SELECT ticket_id, MAX(seq) AS seq FROM events
              WHERE ticket_id IN (${placeholders}) AND event_type != 'spend'
                AND json_type(payload, '$.note') = 'text'
                AND TRIM(json_extract(payload, '$.note')) != ''
              GROUP BY ticket_id
           ) latest ON latest.seq = e.seq`,
      )
      .all(...ids) as { ticket_id: string; ts: string; actor: string; note: string }[];
    return new Map(rows.map((r) => {
      const actor = JSON.parse(r.actor) as Actor;
      const note = Array.from(r.note).slice(0, 280).join('');
      return [r.ticket_id, { at: r.ts, note, actor: { name: actor.name, kind: actor.kind } }];
    }));
  }

  lastAnswer(ticketId: string): Answer | null {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE ticket_id = ? AND event_type = 'answered' ORDER BY seq DESC LIMIT 1")
      .get(ticketId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Answer) : null;
  }

  /** Every ask on this ticket the human has already answered, keyed by the
   *  fingerprint `presentation.ts` computes. Only one question is pending at a
   *  time — a return refuses a ticket already `awaiting_human` — so the
   *  `returned` event standing before an `answered` one is the ask that answer
   *  replies to. */
  answeredAsks(ticketId: string): Map<string, { answer: Answer; at: string; by: string }> {
    const rows = this.db
      .prepare(
        "SELECT event_type, actor, payload, ts FROM events WHERE ticket_id = ? AND event_type IN ('returned', 'answered') ORDER BY seq",
      )
      .all(ticketId) as { event_type: string; actor: string; payload: string; ts: string }[];
    const answered = new Map<string, { answer: Answer; at: string; by: string }>();
    let pending: string | null = null;
    for (const r of rows) {
      if (r.event_type === 'returned') {
        const req = JSON.parse(r.payload) as HumanRequest;
        // The mirror of the clear in `actedRequests`, and unreachable for the
        // mirror reason: `answerTicket` refuses a pending action, so an action
        // return is never followed by an `answered`.
        pending = req.kind === 'action' ? null : questionFingerprint(req as Question);
      } else if (pending) {
        answered.set(pending, {
          answer: JSON.parse(r.payload) as Answer,
          at: r.ts,
          by: (JSON.parse(r.actor) as Actor).name,
        });
        pending = null;
      }
    }
    return answered;
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

  /** Every actor name this store has ever recorded, mapped to the kind their
   *  most recent event declared. Store-wide and read once per page render.
   *
   *  The view needs a kind to draw an actor: an agent and a human wear
   *  different frames (R-11 H-713). Tickets carry only an assignee *name*, so
   *  without this the view would have to guess a kind from the name, which is
   *  exactly the assertion the design system forbids — the first agent to run
   *  under a human's name, or a crew member who gained an orchestrator
   *  harness, would be drawn wrong and nothing would say so. Here the kind is
   *  read from the record that stated it.
   *
   *  Most recent wins because a name's kind can legitimately change; the old
   *  events are still true of when they were written, and the current answer
   *  is the one a dashboard is asking for. */
  actorKinds(): Map<string, ActorKind> {
    const rows = this.db
      .prepare(
        `SELECT json_extract(actor, '$.name') AS name, json_extract(actor, '$.kind') AS kind
           FROM events WHERE seq IN (SELECT MAX(seq) FROM events GROUP BY json_extract(actor, '$.name'))`,
      )
      .all() as { name: string | null; kind: string | null }[];
    const kinds = new Map<string, ActorKind>();
    for (const r of rows) {
      if (!r.name || !r.kind) continue;
      if ((ACTOR_KINDS as readonly string[]).includes(r.kind)) kinds.set(r.name, r.kind as ActorKind);
    }
    return kinds;
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
    // Assignment is explicit routing (H-661): in a caller's ready queue, a
    // workstream filter scopes only the UNASSIGNED pool — a ticket assigned to
    // the caller is ready wherever it lives. ANDing the workstream over the
    // assignee clause left a ticket routed to a loop's agent from another
    // workstream invisible to the loop forever (wake fired, ready said 0).
    const routedReady = filter.ready && filter.caller && filter.workstream;
    if (filter.workstream && !routedReady) { clauses.push('workstream = ?'); params.push(filter.workstream); }
    if (filter.project) { clauses.push('project = ?'); params.push(filter.project); }
    if (filter.assignee) {
      clauses.push('assignee = ?');
      params.push(filter.assignee);
      // A template's assignee routes the instances it spawns; it is not a
      // reservation of the standing template itself. The loop's first queue
      // read is an assignee query, so returning templates here offers work that
      // the claim path correctly refuses (H-440).
      clauses.push('schedule IS NULL');
    }
    if (filter.type) { clauses.push('type = ?'); params.push(filter.type); }
    if (filter.priority_max !== undefined) { clauses.push('priority <= ?'); params.push(filter.priority_max); }
    if (filter.ready) {
      clauses.push("status = 'open'");
      clauses.push('schedule IS NULL'); // templates are standing work, never claimable
      clauses.push('needs_human = 0');
      // Date gate (H-732): work that genuinely cannot start until a date is
      // withheld rather than offered. Shouting it in the body was the only
      // tool available, and it cost every reader a full ticket read to learn
      // it must not act — H-718 was read and released seven times in one day.
      clauses.push(EXECUTABLE_DATE);
      params.push(now());
      clauses.push(EXECUTABLE_HOLD);
      params.push(now());
      if (routedReady) {
        clauses.push('((workstream = ? AND assignee IS NULL) OR assignee = ?)');
        params.push(filter.workstream, filter.caller);
      } else if (filter.caller) { clauses.push('(assignee IS NULL OR assignee = ?)'); params.push(filter.caller); }
      else clauses.push('assignee IS NULL');
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ?? 20;
    const offset = filter.cursor ?? 0;
    // Terminal statuses sort last (H-669): every loop is told to open with
    // {assignee: <name>}, and that query paged history first — an agent with 20
    // closed tickets read "all done" and missed its live assignment. Within each
    // group the old priority/age order stands; the view buckets by status, so
    // this only reorders across a boundary it already draws.
    const rows = this.db
      .prepare(
        `SELECT * FROM tickets ${where}
         ORDER BY (status IN ('done','cancelled')) ASC, priority ASC, created_at ASC
         LIMIT ? OFFSET ?`,
      )
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

  /** True when `caller` created this ticket and nobody else has judged it.
   *  Human and orchestrator events count even when the orchestrator relaying
   *  the decision shares the filer's name. Scheduler-spawned instances are
   *  judged by their template: standing work an agent set up for itself is
   *  still self-filed. */
  private selfFiledUntouched(id: string, caller: string): boolean {
    const created = this.db
      .prepare(
        `SELECT json_extract(actor, '$.name') AS creator, json_extract(payload, '$.spawned_from') AS template
         FROM events WHERE ticket_id = ? AND event_type = 'created'`,
      )
      .get(id) as { creator: string | null; template: string | null } | undefined;
    if (!created) return false;
    // The scheduler is the store's clock and spend is the meter's bookkeeping —
    // neither is judgment, so neither counts as the second pair of eyes (H-242:
    // rev meters every loop session onto the tickets it touched, including the
    // ones the agent just filed).
    const others = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE ticket_id = ? AND event_type != 'spend' AND json_extract(actor, '$.name') NOT IN (?, 'helmo-scheduler')")
      .get(id, caller) as { n: number };
    const directed = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE ticket_id = ? AND event_type != 'spend' AND json_extract(actor, '$.name') != 'helmo-scheduler' AND json_extract(actor, '$.kind') IN ('human', 'orchestrator')")
      .get(id) as { n: number };
    if (others.n > 0 || directed.n > 0) return false;
    if (created.template) return this.selfFiledUntouched(created.template, caller);
    return created.creator === caller;
  }

  /** The agent whose filing judgment governs this ticket. Scheduler instances
   *  inherit the author of their standing template. */
  private filingCreator(id: string): string | null {
    const created = this.db
      .prepare(
        `SELECT json_extract(actor, '$.name') AS creator, json_extract(payload, '$.spawned_from') AS template
         FROM events WHERE ticket_id = ? AND event_type = 'created'`,
      )
      .get(id) as { creator: string | null; template: string | null } | undefined;
    if (!created) return null;
    return created.template ? this.filingCreator(created.template) : created.creator;
  }

  /** The tickets the triage rule is withholding from `caller`'s ready queue —
   *  returned alongside the queue so the filer sees why, instead of wondering
   *  where their ticket went. */
  selfFiledPending(caller: string): string[] {
    // A gated ticket is reported under its gate instead, even when the filer
    // is also the caller: it already names the date that releases it, which is
    // the more useful of the two answers, and one id in two lists just makes
    // the reader check both for the same ticket.
    const rows = this.db
      .prepare(
        `SELECT id FROM tickets WHERE status = 'open' AND schedule IS NULL AND needs_human = 0
           AND ${EXECUTABLE_DATE} AND ${EXECUTABLE_HOLD} AND (assignee IS NULL OR assignee = ?)
         ORDER BY priority ASC, created_at ASC`,
      )
      .all(now(), now(), caller) as { id: string }[];
    return rows.map((r) => r.id).filter((id) => !this.isBlocked(id) && this.selfFiledUntouched(id, caller));
  }

  /** The tickets a date gate is withholding from `caller`'s ready queue, each
   *  with the instant that releases it — returned alongside the queue so a
   *  reader learns "come back on the 10th" from one line rather than paying a
   *  ticket read to find it shouted in a body (H-732). Withheld, not hidden. */
  gatedPending(caller: string): { id: string; not_before: string }[] {
    const rows = this.db
      .prepare(
        `SELECT id, not_before FROM tickets
         WHERE status = 'open' AND schedule IS NULL AND needs_human = 0 AND not_before > ?
           AND (assignee IS NULL OR assignee = ?)
         ORDER BY not_before ASC, priority ASC`,
      )
      .all(now(), caller) as { id: string; not_before: string }[];
    return rows.filter((r) => !this.isBlocked(r.id));
  }

  /** Deliberate spending holds stay disclosed beside a ready query, but never
   *  enter its executable set. This is independent of ticket priority. */
  capacityHeldPending(caller: string): { id: string; capacity_hold: CapacityHold }[] {
    const rows = this.db
      .prepare(
        `SELECT id, capacity_hold FROM tickets
         WHERE status = 'open' AND schedule IS NULL AND needs_human = 0 AND capacity_hold IS NOT NULL
           AND (json_extract(capacity_hold, '$.release.until') IS NULL OR json_extract(capacity_hold, '$.release.until') <= ?)
           AND (assignee IS NULL OR assignee = ?)
         ORDER BY priority ASC, created_at ASC`,
      )
      .all(now(), caller) as { id: string; capacity_hold: string }[];
    return rows.map((r) => ({ id: r.id, capacity_hold: JSON.parse(r.capacity_hold) as CapacityHold }));
  }

  /** Open tickets reserved for a sitting with the operator. */
  withHumanPending(caller: string): string[] {
    const rows = this.db.prepare(
      `SELECT id FROM tickets
       WHERE status = 'open' AND schedule IS NULL AND needs_human = 1
         AND ${EXECUTABLE_HOLD}
         AND (assignee IS NULL OR assignee = ?)
       ORDER BY priority ASC, created_at ASC`,
    ).all(now(), caller) as { id: string }[];
    return rows.map((r) => r.id).filter((id) => !this.isBlocked(id));
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

    // Orphan rows: a ticket with no events at all. THE INVARIANT of this store
    // is that tickets are a materialized view of events, so such a row was not
    // written by Helmo — it went straight into the table. It is reported rather
    // than repaired: what to do with someone else's write is a human's call,
    // and the event log has nothing to reconstruct it from (H-448).
    // The tell is a missing 'created' event, not an empty history: a foreign
    // row that later actors touched through the front door (as bosun's
    // hand-written '446' was — cancelled and spend-charged before anyone
    // noticed it was never minted, H-463) accumulates events and would pass
    // a no-events-at-all test forever.
    for (const r of this.db
      .prepare(`SELECT id FROM tickets t WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.ticket_id = t.id AND e.event_type = 'created')`)
      .all() as { id: string }[]) {
      findings.push({
        check: 'orphan_ticket',
        ticket_id: r.id,
        detail: 'row has no created event — Helmo did not mint this ticket; something wrote to the table directly',
      });
    }

    // Self-filed work withheld from its filer needs another actor's judgment,
    // but a reservation to that same filer hides it from every other ready
    // queue. Keep this store-wide so cultivation can supply the second eyes.
    for (const r of this.db
      .prepare(
        `SELECT id, assignee, created_at FROM tickets
         WHERE status = 'open' AND schedule IS NULL AND needs_human = 0
           AND ${EXECUTABLE_DATE}
           AND ${EXECUTABLE_HOLD}
         ORDER BY priority ASC, created_at ASC`,
      )
      .all(nowTs.toISOString(), nowTs.toISOString()) as { id: string; assignee: string | null; created_at: string }[]) {
      if (this.isBlocked(r.id)) continue;
      const creator = this.filingCreator(r.id);
      if (!creator || !this.selfFiledUntouched(r.id, creator)) continue;
      findings.push({
        check: 'awaiting_second_eyes',
        ticket_id: r.id,
        detail: `filed by ${creator}, reserved to ${r.assignee ?? 'the unassigned pool'}; untouched by anyone else since ${r.created_at}`,
      });
    }

    // Done without evidence: a claim, not a record (first-class here; the view
    // already badges it per-row). A question ticket the human closed via
    // helmo_answer_ticket is exempt — its closure IS on the record, as the
    // answer (H-81); only 'done' resolutions matter since cancelled tickets
    // are never flagged here.
    for (const r of this.db
      .prepare(
        `SELECT id FROM tickets t WHERE status = 'done' AND evidence = '[]'
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.ticket_id = t.id AND e.event_type = 'answered'
                         AND json_extract(e.payload, '$.resolution') = 'done')`,
      )
      .all() as { id: string }[]) {
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

    // Aging questions — and aging actions, which wait in the same queue and
    // are reported as what they are rather than as questions.
    for (const r of this.db
      .prepare("SELECT id, updated_at, question FROM tickets WHERE status = 'awaiting_human' AND updated_at < ?")
      .all(hoursAgo(AGING_QUESTION_HOURS)) as { id: string; updated_at: string; question: string | null }[]) {
      const kind = r.question && (JSON.parse(r.question) as HumanRequest).kind === 'action' ? 'action' : 'question';
      findings.push({ check: 'aging_question', ticket_id: r.id, detail: `${kind} waiting ${Math.floor(age(r.updated_at) / 24)}d` });
    }

    // Spend anomalies: cost far above the workstream norm (H-19 made cost real).
    // Recurring templates accumulate the cost of every run forever, so they
    // are neither a comparable unit nor a useful peer for one-off tickets.
    const spent = this.db
      .prepare('SELECT id, workstream, cost_usd_total AS cost FROM tickets WHERE cost_usd_total > 0 AND schedule IS NULL')
      .all() as { id: string; workstream: string; cost: number }[];
    const byWs = new Map<string, { id: string; cost: number }[]>();
    const costs = new Map(spent.map((s) => [s.id, s.cost]));
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

    // Silent assignees (H-61): an open reservation whose assignee has written
    // nothing anywhere for 7d — or never at all (mistyped, renamed, retired) —
    // while the rest of the store was active. The activity guard keeps a
    // store-wide quiet week from lighting up every reservation; in_progress
    // holders are stale_claim's territory at 24h.
    for (const r of this.db
      .prepare(
        `SELECT t.id, t.assignee,
                (SELECT MAX(ts) FROM events WHERE json_extract(actor, '$.name') = t.assignee) AS last
         FROM tickets t
         WHERE t.status = 'open' AND t.assignee IS NOT NULL AND t.schedule IS NULL AND t.needs_human = 0
           AND EXISTS (SELECT 1 FROM events e WHERE e.ts >= ?
                       AND json_extract(e.actor, '$.name') NOT IN (t.assignee, 'helmo-scheduler'))
         GROUP BY t.id HAVING last IS NULL OR last < ?`,
      )
      .all(hoursAgo(SILENT_ASSIGNEE_HOURS), hoursAgo(SILENT_ASSIGNEE_HOURS)) as { id: string; assignee: string; last: string | null }[]) {
      // A live blocker already explains why the reservation has not moved.
      // Once it closes, isBlocked() clears by itself and the untouched
      // reservation becomes visible here again.
      if (this.isBlocked(r.id)) continue;
      findings.push({
        check: 'silent_assignee',
        ticket_id: r.id,
        detail: r.last
          ? `reserved for "${r.assignee}", silent everywhere for ${Math.floor(age(r.last) / 24)}d`
          : `reserved for "${r.assignee}", who has never written an event — mistyped, renamed, or retired?`,
      });
    }

    // Unseated pools (H-1026): open, unassigned, non-template work in a
    // workstream with no seat is ready to no loop — rev loops draw only from
    // their bound stream's pool and tickets in their name. One finding per
    // stream: the fix is a seat, not a disposition per ticket.
    // Only work a seat could actually run is counted (H-2556): a stream whose
    // pool is entirely held for capacity, or gated to a future date, is not
    // stranded for want of routing, and asking Arthur to seat it is a decision
    // he cannot usefully make — R-25's parked white paper asked him to seat
    // 'voice' a week after he put it on ice. Both gates are self-clearing, so
    // the finding returns of its own accord when the work becomes runnable.
    for (const r of this.db
      .prepare(
        `SELECT t.workstream, COUNT(*) AS n FROM tickets t
         WHERE t.status = 'open' AND t.assignee IS NULL AND t.schedule IS NULL AND t.needs_human = 0
           AND ${EXECUTABLE_DATE}
           AND ${EXECUTABLE_HOLD}
           AND NOT EXISTS (SELECT 1 FROM workstreams w WHERE w.name = t.workstream AND w.seat IS NOT NULL)
         GROUP BY t.workstream`,
      )
      .all(nowTs.toISOString(), nowTs.toISOString()) as { workstream: string; n: number }[]) {
      findings.push({
        check: 'unseated_pool',
        workstream: r.workstream,
        detail: `${r.n} unassigned open ticket${r.n === 1 ? '' : 's'} in '${r.workstream}', which has no seat — a loop bound elsewhere never sees them; set a seat with workstream-set or reserve each by hand`,
      });
    }

    // Unaccounted work (H-1126): open, startable work carrying nothing that
    // says what it is for — no project tag, no obj:OBJ-n label, no acct: label,
    // and not in a stream whose work accounts for itself. Arthur's ruling at the Monday
    // retrospective is that intent lives in the charter and the roadmap, not
    // in prose steering copied onto Helmo, so the sweeping agent should start
    // from a list rather than a read of the whole queue. The check makes no
    // judgment about whether the accounting is honest, or about roadmap
    // status: that is the sweeper's, from a roadmap Helmo deliberately cannot
    // see. Recurring instances are exempt — a standing sweep IS the estate
    // functioning, and its template already carries the why.
    for (const r of this.db
      .prepare(
        `SELECT t.id, t.workstream, t.labels FROM tickets t
         WHERE t.status = 'open' AND t.schedule IS NULL AND t.needs_human = 0
           AND (t.project IS NULL OR trim(t.project) = '')
           AND ${EXECUTABLE_DATE}
           AND ${EXECUTABLE_HOLD}
           AND NOT EXISTS (SELECT 1 FROM events e WHERE e.ticket_id = t.id AND e.event_type = 'created'
                             AND json_extract(e.payload, '$.spawned_from') IS NOT NULL)
         ORDER BY priority ASC, created_at ASC`,
      )
      .all(nowTs.toISOString(), nowTs.toISOString()) as { id: string; workstream: string; labels: string }[]) {
      if (ACCOUNTED_WORKSTREAMS.has(r.workstream)) continue;
      const labels = (JSON.parse(r.labels) as string[]).map((l) => l.trim());
      if (labels.some((l) => /^obj:OBJ-\d+$/i.test(l))) continue;
      if (labels.some((l) => ACCOUNTING_LABELS.has(l.toLowerCase()))) continue;
      if (this.isBlocked(r.id)) continue;
      findings.push({
        check: 'unaccounted_work',
        ticket_id: r.id,
        detail: `'${r.workstream}' work filed by ${this.filingCreator(r.id) ?? '?'} with no project tag, no obj: label and no acct: label — nothing on it says what it is for`,
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

    // Disposed findings (H-81): examined once, judgment recorded, never
    // re-reported. On a terminal ticket the disposition stands forever, since
    // nothing about the ticket can change again. A live ticket carries an
    // at_cost instead (H-1715): the acknowledgement holds only while the spend
    // it answered for holds, and the finding returns once the ticket has cost
    // half as much again.
    const disposed = new Map(
      (
        this.db.prepare('SELECT check_name, ticket_id, at_cost FROM hygiene_dispositions').all() as {
          check_name: string;
          ticket_id: string;
          at_cost: number | null;
        }[]
      ).map((d) => [`${d.check_name}:${d.ticket_id}`, d.at_cost]),
    );
    return findings.filter((f) => {
      if (!f.ticket_id || !disposed.has(`${f.check}:${f.ticket_id}`)) return true;
      const at = disposed.get(`${f.check}:${f.ticket_id}`);
      if (at == null) return false; // terminal-ticket disposition: stands
      return (costs.get(f.ticket_id) ?? 0) > at * SPEND_ACK_REGROWTH;
    });
  }

  /** Catch up recurring templates: spawn an instance for each template whose
   *  next occurrence has passed (H-22). Called from every ticket-list read —
   *  Helmo has no daemon, so the read path is the clock. Skip-if-in-motion: no
   *  new instance while a previous one is in_progress, awaiting_human, or
   *  carries a human answer. A plain open instance nobody has started is
   *  superseded — cancelled by the scheduler — when the next slot comes due;
   *  before H-618 it silently stalled the schedule for as long as it sat. After
   *  downtime, only the latest missed slot spawns — a backlog of stale
   *  instances would be silt, not work. Returns spawned ids. */
  materializeDue(nowTs: Date = new Date()): string[] {
    const templates = (
      this.db.prepare("SELECT * FROM tickets WHERE schedule IS NOT NULL AND status = 'open'").all() as Record<string, unknown>[]
    ).map(rowToTicket);
    const spawned: string[] = [];
    for (const t of templates) {
      // Blocking check and insert share one IMMEDIATE transaction: as two
      // separate steps, two concurrent readers both saw no open instance and
      // both spawned (H-169, twins 8ms apart). Nested createTicket becomes a
      // savepoint inside it.
      const id = this.db.transaction((): string | null => {
        const live = this.db
          .prepare(
            `SELECT i.id, i.status,
                    EXISTS(SELECT 1 FROM events e WHERE e.ticket_id = i.id AND e.event_type = 'answered') AS answered
             FROM deps d JOIN tickets i ON i.id = d.from_id
             WHERE d.to_id = ? AND d.type = 'parent' AND i.status IN ('open','in_progress','awaiting_human')`,
          )
          .all(t.id) as { id: string; status: string; answered: number }[];
        if (live.some((i) => i.status !== 'open' || i.answered)) return null;
        const lastDue = (
          this.db
            .prepare("SELECT MAX(json_extract(payload, '$.due')) AS due FROM events WHERE event_type = 'created' AND json_extract(payload, '$.spawned_from') = ?")
            .get(t.id) as { due: string | null }
        ).due;
        const sched = parseSchedule(t.schedule!);
        let due = sched.next(new Date(lastDue ?? t.created_at));
        if (due > nowTs) return null;
        for (let n = sched.next(due); n <= nowTs; n = sched.next(due)) due = n; // latest missed slot only
        const dueIso = due.toISOString();
        for (const i of live) {
          this.updateTicket(SCHEDULER_ACTOR, {
            ticket_id: i.id,
            status: 'cancelled',
            note: `Superseded by the ${dueIso.slice(0, 16)}Z slot of ${t.id} — still unclaimed when the next occurrence came due (H-618).`,
          });
        }
        // An explicit template assignee is deliberate routing and wins over
        // the workstream's default seat, as it does for ordinary filings.
        // Unassigned templates take the workstream seat through createTicket.
        return this.createTicket(SCHEDULER_ACTOR, {
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
        }).id;
      }).immediate();
      if (id) spawned.push(id);
    }
    return spawned;
  }

  /** Highest event sequence number — the wake cursor for harnesses. */
  maxSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events').get() as { s: number };
    return row.s;
  }

  /** Count of ready tickets in scope (open, unblocked, unassigned-or-reserved-
   *  for-caller). Reserved-for-caller crosses the workstream filter (H-661). */
  readyCount(workstream?: string, caller?: string): number {
    return this.listTickets({ ready: true, workstream, caller, limit: 1000 }).length;
  }

  /** The whole idle-poll answer, read as ONE snapshot.
   *
   *  Every field here feeds a single harness decision — wake or re-idle, and at
   *  what cursor — so they have to describe one instant. Read as separate
   *  statements they do not: each takes its own WAL snapshot, and a handoff
   *  committing between two of them is seen by one and not the other. rev
   *  logged a wake reporting `ready=0` that way (rev H-1895), and the same
   *  window can put max_seq past an event the ready set had not yet seen —
   *  which is worse, because the loop then re-idles at a cursor beyond the
   *  handoff and sleeps through the very wake this call exists to deliver. The
   *  transaction holds one snapshot across all of them, and the ready set is
   *  read once and reused, so newly_ready can never name a ticket missing from
   *  ready_ids. */
  wakeCheck(seq: number, workstream?: string, assignee?: string): {
    max_seq: number;
    ready_count: number;
    ready_ids: string[];
    newly_ready_count: number;
    newly_ready_ids: string[];
    held_count?: number;
    changed_since: boolean;
  } {
    return this.db.transaction(() => {
      const maxSeq = this.maxSeq();
      const ready = this.listTickets({ ready: true, workstream, caller: assignee, limit: 1000 });
      const newlyReadyIds = assignee ? this.newlyReadyFrom(ready, seq, assignee) : [];
      return {
        max_seq: maxSeq,
        ready_count: ready.length,
        ready_ids: ready.map((ticket) => ticket.id),
        newly_ready_count: newlyReadyIds.length,
        newly_ready_ids: newlyReadyIds,
        // held_count only when the caller is identified: work already in hand.
        // With ready_count it lets a harness spot the probe case — nothing to
        // draw, nothing mid-flight — and run that pass cheap (rev H-412).
        ...(assignee ? { held_count: this.heldCount(assignee) } : {}),
        changed_since: this.scopeChangedSince(seq, workstream, assignee),
      };
      // .immediate() for the reason in the constructor: the ready read
      // materializes due schedule instances, so this transaction writes after
      // reading and a DEFERRED begin would meet an unwaitable upgrade.
    }).immediate();
  }

  /** Currently-ready tickets whose route or gate opened after `seq`.
   *
   *  The current-ready query remains the authority for routing, blockers,
   *  schedules, gates, and self-triage. This read only narrows that bounded set
   *  to candidates with a readiness-causing event after the cursor, or a date
   *  gate that crossed after the cursor's timestamp. Keeping event archaeology
   *  out of the state calculation makes notes and close-out noise inert while
   *  preserving the exact ready semantics used by listTickets. */
  newlyReadySince(seq: number, workstream: string | undefined, caller: string): string[] {
    return this.newlyReadyFrom(this.listTickets({ ready: true, workstream, caller, limit: 1000 }), seq, caller);
  }

  /** The narrowing half of newlyReadySince, over a ready set the caller already
   *  holds — so wakeCheck reports both from one read rather than two. */
  private newlyReadyFrom(ready: Ticket[], seq: number, caller: string): string[] {
    if (!ready.length) return [];

    const candidates = new Set(
      (this.db
        .prepare(
          `SELECT DISTINCT ticket_id AS id FROM events
           WHERE seq > ? AND (
             event_type = 'created'
             OR (event_type = 'unlinked' AND json_extract(payload, '$.type') = 'blocks')
             OR (event_type = 'answered' AND json_extract(payload, '$.resolution') = 'resume')
             OR (event_type = 'updated' AND (
               json_type(payload, '$.diffs.assignee') IS NOT NULL
               OR json_extract(payload, '$.diffs.status.to') = 'open'
               OR json_type(payload, '$.diffs.workstream') IS NOT NULL
               OR json_type(payload, '$.diffs.not_before') IS NOT NULL
               OR json_type(payload, '$.diffs.capacity_hold') IS NOT NULL
               OR json_extract(payload, '$.diffs.needs_human.to') = 0
             ))
           )`,
        )
        .all(seq) as { id: string }[])
        .map((r) => r.id),
    );

    // Self-filed work becomes ready on the first second-pair-of-eyes touch.
    // That edge is actor-sensitive rather than payload-sensitive: a note is
    // enough to release triage, but later notes must not re-wake the seat.
    // Recurring instances inherit the template's filing judgment, just as the
    // canonical ready query does in selfFiledUntouched().
    for (const t of ready) {
      if (this.filingCreator(t.id) !== caller) continue;
      const releasedAt = this.selfTriageReleaseSeq(t.id, caller);
      if (releasedAt !== null && releasedAt > seq) candidates.add(t.id);
    }

    // Closing either kind of terminal blocker opens the waiting ticket, not
    // the blocker itself. Deps are already indexed by their primary key's
    // from_id prefix; events use idx_events_ticket.
    for (const r of this.db
      .prepare(
        `SELECT DISTINCT d.from_id AS id
         FROM events e JOIN deps d ON d.to_id = e.ticket_id AND d.type = 'blocks'
         WHERE e.seq > ? AND (
           (e.event_type = 'updated' AND json_extract(e.payload, '$.diffs.status.to') IN ('done','cancelled'))
           OR (e.event_type = 'answered' AND json_extract(e.payload, '$.resolution') IN ('done','cancelled'))
         )`,
      )
      .all(seq) as { id: string }[]) candidates.add(r.id);

    const cursor = this.db
      .prepare('SELECT ts FROM events WHERE seq <= ? ORDER BY seq DESC LIMIT 1')
      .get(seq) as { ts: string } | undefined;
    if (cursor) {
      const current = now();
      for (const t of ready) {
        if (t.not_before && t.not_before > cursor.ts && t.not_before <= current) candidates.add(t.id);
      }
    }

    return ready.map((t) => t.id).filter((id) => candidates.has(id));
  }

  /** Sequence of the first event that releases a self-filing's triage gate. */
  private selfTriageReleaseSeq(id: string, caller: string | null): number | null {
    if (!caller) return null;
    const created = this.db
      .prepare("SELECT json_extract(payload, '$.spawned_from') AS template FROM events WHERE ticket_id = ? AND event_type = 'created'")
      .get(id) as { template: string | null } | undefined;
    if (!created) return null;

    const row = this.db
      .prepare(
        `SELECT MIN(seq) AS seq FROM events
         WHERE ticket_id = ? AND event_type != 'spend'
           AND json_extract(actor, '$.name') != 'helmo-scheduler'
           AND (json_extract(actor, '$.name') != ? OR json_extract(actor, '$.kind') IN ('human','orchestrator'))`,
      )
      .get(id, caller) as { seq: number | null };
    const inherited = created.template ? this.selfTriageReleaseSeq(created.template, caller) : null;
    if (row.seq === null) return inherited;
    if (inherited === null) return row.seq;
    return Math.min(row.seq, inherited);
  }

  /** In_progress tickets assigned to `assignee`, each with the actor that put
   *  it in_progress and when — the same-seat guard's raw material (rev H-558).
   *  Two live sessions sharing one crew name (a rev loop and a desk subagent)
   *  write indistinguishable `name`s; the claiming actor's `session` stamp is
   *  what tells the seat's own mid-flight work from a foreign hold. A ticket
   *  whose claim event cannot be found is reported with null actor/ts — the
   *  caller decides what unattributable means. */
  seatHolds(assignee: string): { ticket_id: string; claim_actor: Actor | null; claimed_at: string | null }[] {
    const rows = this.db
      .prepare("SELECT id FROM tickets WHERE status = 'in_progress' AND assignee = ?")
      .all(assignee) as { id: string }[];
    return rows.map(({ id }) => {
      const ev = this.db
        .prepare(
          `SELECT actor, ts FROM events WHERE ticket_id = ?
             AND ((event_type = 'updated' AND json_extract(payload, '$.diffs.status.to') = 'in_progress')
               OR (event_type = 'created' AND json_extract(payload, '$.status') = 'in_progress'))
           ORDER BY seq DESC LIMIT 1`,
        )
        .get(id) as { actor: string; ts: string } | undefined;
      return { ticket_id: id, claim_actor: ev ? (JSON.parse(ev.actor) as Actor) : null, claimed_at: ev?.ts ?? null };
    });
  }

  /** Count of in_progress tickets assigned to `assignee` — work already in
   *  hand. A harness that knows this alongside readyCount can tell "the agent
   *  has nothing to draw AND nothing mid-flight" — the probe case (rev H-412):
   *  that iteration only answers "is there anything to do?" and can run on the
   *  cheapest model. */
  heldCount(assignee: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tickets WHERE status = 'in_progress' AND assignee = ?")
      .get(assignee) as { n: number };
    return row.n;
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

  /** Count of events written by `actorName` since `seq` — a harness's "did my
   *  agent produce?" check.
   *
   *  `advancingOnly` narrows it to events that moved something: a ticket
   *  created, linked, disposed, returned to a human, or an update carrying a
   *  real diff. A note-only update does not count. Writing "still blocked,
   *  nothing to do" is the cheapest possible event and, counted as production,
   *  it re-certifies a loop as busy and buys it another whole iteration —
   *  which is how rev's ladder lost the chance to idle (H-412). */
  actorActivitySince(actorName: string, seq: number, advancingOnly = false, session?: string): number {
    const advancing = advancingOnly
      ? `AND NOT (event_type = 'updated'
                  AND (json_extract(payload, '$.diffs') IS NULL
                       OR json_extract(payload, '$.diffs') = '{}'))`
      : '';
    const sessionFilter = session ? "AND json_extract(actor, '$.session') = ?" : '';
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE seq > ? AND json_extract(actor, '$.name') = ? ${sessionFilter} ${advancing}`)
      .get(...(session ? [seq, actorName, session] : [seq, actorName])) as { n: number };
    return row.n;
  }

  /** Answer events since `seq`, oldest first — the record of who answered a
   *  returned ticket, and how. `session` narrows to one actor session: the
   *  dashboard's /answer route writes as the operator with session
   *  'dashboard', and that route is gated only by loopback, so any same-user
   *  process could forge an approval in the human's name (H-143). Replaying
   *  those answers daily is how a forged one gets caught — and this method is
   *  why the sweep doing the replay never opens the store file itself (H-936).
   *  Read-only; `answer` is truncated to a scannable line. */
  answersSince(seq: number, session?: string): AnswerEvent[] {
    const filter = session ? "AND json_extract(actor, '$.session') = ?" : '';
    const rows = this.db
      .prepare(
        `SELECT seq, ts, ticket_id, actor, payload FROM events
         WHERE seq > ? AND event_type = 'answered' ${filter} ORDER BY seq`,
      )
      .all(...(session ? [seq, session] : [seq])) as {
      seq: number;
      ts: string;
      ticket_id: string;
      actor: string;
      payload: string;
    }[];
    return rows.map((r) => {
      const a = JSON.parse(r.actor) as Actor;
      const p = JSON.parse(r.payload) as Answer;
      return {
        seq: r.seq,
        ts: r.ts,
        ticket_id: r.ticket_id,
        actor: { name: a.name, kind: a.kind, ...(a.session ? { session: a.session } : {}) },
        resolution: p.resolution,
        chosen_option: p.chosen_option,
        answer: Array.from(p.answer ?? '').slice(0, 200).join(''),
      };
    });
  }

  /** Acceptance verdicts since `seq`, oldest first — the same replay as
   *  `answersSince`, for the other write that can let work through unread.
   *  A verdict is recorded in the reviewer's name, Helmo's actor is
   *  caller-supplied, and the store file is user-writable, so a forged PASS
   *  is only caught by showing every verdict to the reviewer it names
   *  (H-1830). `actorName` narrows to one reviewer, `workstream` to the
   *  ticket's CURRENT stream. The join is a LEFT one on purpose: a verdict
   *  whose ticket has since vanished is the loudest thing this read can
   *  find, and an inner join would silently drop it. `max_seq` comes from
   *  the caller's own read so its checkpoint advances without a second
   *  query — same reason as `answers`, and the same reason the sweep doing
   *  the replay never opens the store file itself (H-936).
   *  Read-only; `note` is truncated to a scannable line. */
  verdictsSince(seq: number, actorName?: string, workstream?: string): VerdictEvent[] {
    const params: (string | number)[] = [seq];
    let filter = '';
    if (actorName) {
      filter += " AND json_extract(e.actor, '$.name') = ?";
      params.push(actorName);
    }
    if (workstream) {
      filter += ' AND t.workstream = ?';
      params.push(workstream);
    }
    const rows = this.db
      .prepare(
        `SELECT e.seq, e.ts, e.ticket_id, e.actor, e.payload, t.workstream FROM events e
         LEFT JOIN tickets t ON t.id = e.ticket_id
         WHERE e.seq > ? AND e.event_type = 'acceptance_verdict' ${filter} ORDER BY e.seq`,
      )
      .all(...params) as {
      seq: number;
      ts: string;
      ticket_id: string;
      actor: string;
      payload: string;
      workstream: string | null;
    }[];
    return rows.map((r) => {
      const a = JSON.parse(r.actor) as Actor;
      const p = JSON.parse(r.payload) as { refs?: string[]; verdict: 'pass' | 'fail'; note?: string };
      return {
        seq: r.seq,
        ts: r.ts,
        ticket_id: r.ticket_id,
        workstream: r.workstream ?? '',
        actor: { name: a.name, kind: a.kind, ...(a.session ? { session: a.session } : {}) },
        refs: p.refs ?? [],
        verdict: p.verdict,
        note: Array.from(p.note ?? '').slice(0, 200).join(''),
      };
    });
  }

  /** Tickets `actorName` wrote events on since `seq`, most-touched first — a
   *  harness's spend-attribution window. */
  actorTicketsSince(actorName: string, seq: number, session?: string): { id: string; events: number }[] {
    const sessionFilter = session ? "AND json_extract(actor, '$.session') = ?" : '';
    return this.db
      .prepare(
        `SELECT ticket_id AS id, COUNT(*) AS events FROM events
         WHERE seq > ? AND json_extract(actor, '$.name') = ? ${sessionFilter}
         GROUP BY ticket_id ORDER BY events DESC, MIN(seq) ASC`,
      )
      .all(...(session ? [seq, actorName, session] : [seq, actorName])) as { id: string; events: number }[];
  }

  /** Spend `actorName` self-reported on its own writes since `seq` (meter
   *  'spend' events excluded) — what a harness nets out of its metered figure
   *  so a session lands in the totals exactly once (H-57). */
  actorSelfSpendSince(actorName: string, seq: number, session?: string): { tokens: number; cost_usd: number } {
    const sessionFilter = session ? "AND json_extract(actor, '$.session') = ?" : '';
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(json_extract(payload, '$.tokens')), 0) AS tokens,
                COALESCE(SUM(json_extract(payload, '$.cost_usd')), 0) AS cost
         FROM events
         WHERE seq > ? AND event_type != 'spend' AND json_extract(actor, '$.name') = ? ${sessionFilter}`,
      )
      .get(...(session ? [seq, actorName, session] : [seq, actorName])) as { tokens: number; cost: number };
    return { tokens: row.tokens, cost_usd: row.cost };
  }

  /** The same self-reported spend, per ticket — so a harness can cancel each
   *  guess on the ticket that carries it rather than pushing one session-wide
   *  correction onto whichever ticket it charges (H-187: that left a ticket at
   *  −62k tokens while its neighbour kept the +80k guess). */
  actorSelfSpendByTicketSince(actorName: string, seq: number, session?: string): { id: string; tokens: number; cost_usd: number }[] {
    const sessionFilter = session ? "AND json_extract(actor, '$.session') = ?" : '';
    return this.db
      .prepare(
        `SELECT ticket_id AS id,
                COALESCE(SUM(json_extract(payload, '$.tokens')), 0) AS tokens,
                COALESCE(SUM(json_extract(payload, '$.cost_usd')), 0) AS cost_usd
         FROM events
         WHERE seq > ? AND event_type != 'spend' AND json_extract(actor, '$.name') = ? ${sessionFilter}
         GROUP BY ticket_id HAVING tokens != 0 OR cost_usd != 0
         ORDER BY MIN(seq) ASC`,
      )
      .all(...(session ? [seq, actorName, session] : [seq, actorName])) as { id: string; tokens: number; cost_usd: number }[];
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
    rejectSwallowedMarkup({ note: input.note });
    return this.db.transaction(() => {
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE workstream = ?').get(from) as { n: number }).n;
      const steering = this.db.prepare('SELECT 1 FROM workstreams WHERE name = ?').get(from);
      if (!n && !steering) throw new HelmoError(`No tickets or steering under '${from}' — nothing to rename.`);
      if (steering && this.db.prepare('SELECT 1 FROM workstreams WHERE name = ?').get(to)) {
        throw new HelmoError(
          `Both '${from}' and '${to}' carry steering — merge budget/seat deliberately via workstream-set, then rename.`,
        );
      }
      this.append(now(), `ws:${to}`, 'workstream_renamed', actor, { from, to, tickets: n, note: input.note });
      this.applyWorkstreamRenamed({ from, to });
      return { moved: n };
    }).immediate();
  }

  private applyWorkstreamRenamed(payload: Record<string, unknown>): void {
    this.db.prepare('UPDATE tickets SET workstream = ? WHERE workstream = ?').run(payload['to'], payload['from']);
    this.db.prepare('UPDATE workstreams SET name = ? WHERE name = ?').run(payload['to'], payload['from']);
  }

  /** One workstream with its steering and spend-to-date. Exists for names with
   *  tickets but no steering row too — budget/seat are simply null there. */
  getWorkstreamInfo(name: string): WorkstreamInfo {
    const row = this.db.prepare('SELECT * FROM workstreams WHERE name = ?').get(name) as Workstream | undefined;
    const spent = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd_total), 0) AS s FROM tickets WHERE workstream = ?')
      .get(name) as { s: number };
    const budget = row?.budget_usd ?? null;
    return {
      name,
      budget_usd: budget,
      seat: row?.seat ?? null,
      updated_at: row?.updated_at ?? '',
      spent_usd: spent.s,
      // Zero is the supported "no cap" sentinel. It still discloses measured
      // spend, but there is no finite remainder to subtract it from (H-267).
      remaining_usd: budget === null || budget === 0 ? null : budget - spent.s,
    };
  }

  listWorkstreamInfo(): WorkstreamInfo[] {
    const names = new Set(this.listWorkstreams());
    for (const r of this.db.prepare('SELECT name FROM workstreams').all() as { name: string }[]) names.add(r.name);
    return [...names].sort().map((n) => this.getWorkstreamInfo(n));
  }

  // ---------- writes (every write = append event + materialize, atomically) ----------

  /** Record the exact source snapshots a builder says are complete. This is
   *  separate from closing a ticket: generic reviews retain their ordinary
   *  lifecycle, while product acceptance gains a deliberately invoked gate. */
  recordProductCompletion(actor: Actor, input: { ticket_id: string; artifacts: ProductArtifact[]; note: string }): ProductAcceptance {
    validateActor(actor);
    this.getTicket(input.ticket_id); // terminal tickets remain writable through this append-only record
    if (!input.note?.trim()) throw new HelmoError('note is required on product completion: say what is ready for independent review.');
    rejectSwallowedMarkup({ note: input.note });
    const artifacts = normalizeArtifacts(input.artifacts);
    return this.db.transaction(() => {
      this.append(now(), input.ticket_id, 'product_completed', actor, { artifacts, note: input.note });
      return this.productAcceptance(input.ticket_id);
    }).immediate();
  }

  /** Record an independent verdict against the latest completion's exact
   *  refs. Ref mismatch and authors reviewing their own commits are rejected;
   *  no prose PASS or generic done status can reach accepted state. */
  recordAcceptanceVerdict(actor: Actor, input: { ticket_id: string; refs: string[]; verdict: 'pass' | 'fail'; note: string }): ProductAcceptance {
    validateActor(actor);
    this.getTicket(input.ticket_id);
    if (!input.note?.trim()) throw new HelmoError('note is required on an acceptance verdict: say what the review established.');
    if (input.verdict !== 'pass' && input.verdict !== 'fail') throw new HelmoError('verdict must be "pass" or "fail".');
    rejectSwallowedMarkup({ note: input.note });
    const current = this.productAcceptance(input.ticket_id);
    if (!current.completion) throw new HelmoError(`${input.ticket_id} has no product completion to review. Record immutable refs and authors first.`);
    const refs = normalizeRefs(input.refs);
    const expected = current.completion.artifacts.map((a) => a.ref).sort();
    if (JSON.stringify(refs) !== JSON.stringify(expected)) {
      throw new HelmoError(`Verdict refs do not match the latest completion exactly. Expected ${JSON.stringify(expected)}; got ${JSON.stringify(refs)}. Review the current refs or record a new completion.`);
    }
    if (current.completion.actor.name === actor.name || current.completion.artifacts.some((a) => a.author === actor.name)) {
      throw new HelmoError(`Actor "${actor.name}" recorded this completion or is named as an artifact author and cannot accept it. Hand the exact refs to a non-author reviewer.`);
    }
    return this.db.transaction(() => {
      this.append(now(), input.ticket_id, 'acceptance_verdict', actor, { refs, verdict: input.verdict, note: input.note });
      return this.productAcceptance(input.ticket_id);
    }).immediate();
  }

  /** Set a workstream's budget and/or seat — the human's steering (H-55).
   *  Agent-kind writes are rejected in the store, not just the tool docs: an
   *  agent must never set or raise the budget of the stream it draws from.
   *  Events ride the log under ticket_id `ws:<name>` so steering stays
   *  derivable and attributed like everything else. Steering is numbers and
   *  names only: a prose `goal` was a standing instruction every agent read
   *  on every queue pass, outside caps and review — retired H-1186, and a
   *  write carrying one is refused so the channel cannot quietly reopen. */
  setWorkstream(actor: Actor, input: { name: string; budget_usd?: number; seat?: string }): WorkstreamInfo {
    validateActor(actor);
    if ('goal' in input) {
      throw new HelmoError(
        'Workstream goals were retired (H-1186): standing prose in a store field is agent context outside caps and review. Intent lives in the seat\'s profile or the project body; steering here is budget_usd and seat only.',
      );
    }
    if (actor.kind === 'agent') {
      throw new HelmoError(
        'Workstream budgets and seats are operator steering — writable only by kind "human" or "orchestrator" (relaying a decision the human stated explicitly). An agent setting its own stream\'s budget or seat is the failure this field exists to prevent.',
      );
    }
    if (!input.name?.trim()) throw new HelmoError('name is required: which workstream is being steered.');
    if (input.budget_usd === undefined && input.seat === undefined) {
      throw new HelmoError('Provide budget_usd and/or seat — an empty steering write is noise.');
    }
    if (input.budget_usd !== undefined && !(input.budget_usd >= 0)) {
      throw new HelmoError('budget_usd must be a non-negative number (0 clears the pressure checks but keeps disclosure).');
    }
    return this.db.transaction(() => {
      const ts = now();
      const payload: Record<string, unknown> = { name: input.name };
      if (input.budget_usd !== undefined) payload['budget_usd'] = input.budget_usd;
      // '' clears the seat, matching the empty-string convention for clearing
      // project, not_before, and a named handoff receiver.
      if (input.seat !== undefined) payload['seat'] = input.seat.trim();
      this.append(ts, `ws:${input.name}`, 'workstream_set', actor, payload);
      this.applyWorkstreamSet(ts, payload);
      return this.getWorkstreamInfo(input.name);
    }).immediate();
  }

  /** The standing notice (H-172) is RETIRED (H-1126, Arthur's ruling at the
   *  Monday retrospective 2026-09-07): a hand-maintained line of current
   *  priority is a copy of what the charter and the roadmap already say, and
   *  copies drift. There is no writer any more; the table, the replay of
   *  historical `notice_set` events, and this reader remain so the event log
   *  still rebuilds byte-for-byte — the record is the record. Nothing reads a
   *  notice into a queue response or the dashboard. */
  getNotice(): Notice | null {
    const row = this.db.prepare('SELECT text, provenance, updated_at FROM notice WHERE id = 1').get() as Notice | undefined;
    return row && row.text.trim() ? row : null;
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
    rejectSwallowedMarkup({ title: input.title, body: input.body });
    if (input.schedule) {
      parseSchedule(input.schedule); // reject bad expressions at the door
      if (input.status === 'in_progress') throw new HelmoError('A recurring template is standing work — it cannot be in_progress; its instances are.');
    }
    if (input.not_before) input = { ...input, not_before: parseNotBefore(input.not_before) };
    if (input.workflow_attempt_id !== undefined && (!input.workflow_attempt_id.trim() || input.workflow_attempt_id.trim() !== input.workflow_attempt_id)) {
      throw new HelmoError('workflow_attempt_id must be a non-empty exact id without surrounding whitespace.');
    }
    const sitting = parseSitting(input.needs_human, input.sitting_with);
    const status = input.status ?? 'open';
    if (status === 'in_progress') refuseUnmarkedDeskClaim(actor, Boolean(sitting?.needs_human));
    if (status === 'in_progress' && !input.assignee) input = { ...input, assignee: actor.name };
    // Workstream seat (H-1026): an unassigned filing is reserved to the
    // stream's seat at the door, so it is ready for that seat's loop from the
    // moment it exists. Rev loops see only their bound stream's pool plus
    // tickets in their name; a pool nobody is bound to was ready to no one.
    // Self-triage still applies — the filer's own ticket waits for a touch.
    if (!input.assignee && !input.schedule) {
      const seat = this.workstreamSeat(input.workstream);
      if (seat) input = { ...input, assignee: seat };
    }
    for (const d of input.deps ?? []) this.getTicket(d.to); // existence check before mint

    return this.db.transaction(() => {
      if (input.workflow_attempt_id) {
        if (!this.db.prepare('SELECT 1 FROM workflow_attempts WHERE id = ?').get(input.workflow_attempt_id)) {
          throw new HelmoError(`Workflow attempt ${input.workflow_attempt_id} does not exist; the ticket was not created.`);
        }
        if (this.db.prepare('SELECT id FROM tickets WHERE workflow_attempt_id = ?').get(input.workflow_attempt_id)) {
          throw new HelmoError(`Workflow attempt ${input.workflow_attempt_id} is already immutably bound to a ticket; it cannot be cloned.`);
        }
      }
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
      if (input.project) payload['project'] = input.project;
      if (input.schedule) payload['schedule'] = input.schedule;
      if (input.not_before) payload['not_before'] = input.not_before;
      if (sitting?.needs_human) { payload['needs_human'] = true; payload['sitting'] = sitting.sitting; payload['sitting_with'] = sitting.sitting_with; }
      if (input.spawned_from) { payload['spawned_from'] = input.spawned_from; payload['due'] = input.due; }
      if (input.workflow_attempt_id) payload['workflow_attempt_id'] = input.workflow_attempt_id;
      this.append(ts, id, 'created', actor, payload);
      this.applyCreated(ts, payload);
      for (const d of input.deps ?? []) {
        this.checkNoBlocksCycle(id, d.to, d.type);
        this.append(ts, id, 'linked', actor, { to: d.to, type: d.type });
        this.applyLinked(id, d.to, d.type, true);
      }
      if (status === 'in_progress' && input.workflow_attempt_id) this.admitWorkflow(id, input.workflow_attempt_id, 'create_in_progress');
      return this.getTicket(id);
    }).immediate();
  }

  updateTicket(actor: Actor, input: UpdateInput): UpdateResult {
    validateActor(actor);
    if (!input.note?.trim()) {
      throw new HelmoError('note is required on every update: one or two lines, human terms, saying what actually happened. Notes are the story the human reads.');
    }
    rejectSwallowedMarkup({
      note: input.note,
      title: input.title,
      body: input.body,
      body_append: input.body_append,
      body_patch_old: input.body_patch?.old,
      body_patch_new: input.body_patch?.new,
      uncertainty_note: input.uncertainty_note,
    });
    if (Object.prototype.hasOwnProperty.call(input, 'workflow_attempt_id')) {
      throw new HelmoError('workflow_attempt_id is an immutable ticket binding; it cannot be changed or removed.');
    }
    const t = this.getTicket(input.ticket_id);
    const warnings: string[] = [];
    const diffs: Record<string, { from: unknown; to: unknown }> = {};
    const suppliedKeys = Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);

    const bodyModes = [input.body, input.body_append, input.body_patch].filter((v) => v !== undefined).length;
    if (bodyModes > 1) {
      throw new HelmoError('Pass only one of body, body_append or body_patch. body replaces the whole field; the other modes preserve untouched text.');
    }
    if (input.body_append !== undefined) {
      if (!input.body_append) throw new HelmoError('body_append must not be empty.');
      input = { ...input, body: t.body + input.body_append };
    } else if (input.body_patch !== undefined) {
      if (!input.body_patch.old) throw new HelmoError('body_patch.old is required as the stale-write anchor.');
      const first = t.body.indexOf(input.body_patch.old);
      const last = t.body.lastIndexOf(input.body_patch.old);
      if (first === -1) throw new HelmoError('body_patch is stale: its old anchor is not in the current body. Nothing was written.');
      if (first !== last) throw new HelmoError('body_patch is ambiguous: its old anchor occurs more than once. Nothing was written.');
      input = {
        ...input,
        body: t.body.slice(0, first) + input.body_patch.new + t.body.slice(first + input.body_patch.old.length),
      };
    }

    if (t.status === 'done' || t.status === 'cancelled') {
      const forbidden = suppliedKeys.filter((key) => !['ticket_id', 'note', 'evidence'].includes(key));
      if (forbidden.length) {
        throw new HelmoError(
          `${t.id} is ${t.status} — terminal. Only append-only note and evidence are accepted; ${forbidden.join(', ')} would rewrite closed state. If follow-up work is needed, helmo_create_ticket a new one with a 'relates' link to ${t.id}.`,
        );
      }
    }
    if (input.handoff_to && input.status) {
      throw new HelmoError('Pass either handoff_to or status, not both — a handoff sets status itself (open, reserved for the receiver).');
    }
    if (input.capacity_hold) {
      rejectSwallowedMarkup({
        reason: input.capacity_hold.reason,
        provenance: input.capacity_hold.provenance,
        reconsider_when: input.capacity_hold.reconsider_when,
      });
      for (const field of ['reason', 'provenance', 'reconsider_when'] as const) {
        if (!input.capacity_hold[field].trim()) throw new HelmoError(`capacity_hold.${field} is required.`);
      }
      if (input.capacity_hold.release) {
        rejectSwallowedMarkup({
          batch_id: input.capacity_hold.release.batch_id,
          until: input.capacity_hold.release.until,
          stop_conditions: input.capacity_hold.release.stop_conditions,
          shared_reserve: input.capacity_hold.release.shared_reserve,
        });
        for (const field of ['batch_id', 'until', 'stop_conditions', 'shared_reserve'] as const) {
          if (!input.capacity_hold.release[field].trim()) throw new HelmoError(`capacity_hold.release.${field} is required.`);
        }
        input = {
          ...input,
          capacity_hold: {
            ...input.capacity_hold,
            release: { ...input.capacity_hold.release, until: parseNotBefore(input.capacity_hold.release.until) },
          },
        };
      }
      if (t.status !== 'open') throw new HelmoError(`Only open work can be held for capacity; ${t.id} is ${t.status}.`);
    }

    if (t.schedule && (input.status === 'in_progress' || input.status === 'done')) {
      const live = this.db
        .prepare(
          `SELECT i.id FROM deps d JOIN tickets i ON i.id = d.from_id
           WHERE d.to_id = ? AND d.type = 'parent' AND i.status IN ('open','in_progress','awaiting_human')
           ORDER BY i.created_at DESC LIMIT 1`,
        )
        .get(t.id) as { id: string } | undefined;
      const instance = live ? ` — work its instance ${live.id}` : '';
      throw new HelmoError(`${t.id} is a recurring template${instance}; templates retire only by cancelling.`);
    }

    // status transitions
    if (input.status) {
      if (t.status === 'awaiting_human' && t.action) {
        throw new HelmoError(
          `${t.id} is awaiting_human — it is asking the human to DO something, not to decide it: "${t.action.action}". Its status moves when the action is reported, and helmo_report_action is how you record it. IF THEY HAVE DONE IT — at the desk, in conversation, anywhere — record it now with helmo_report_action, saying what they actually did; that resumes the work and is not permission for anything. If they have NOT done it, leave it: you may still add notes and evidence.`,
        );
      }
      if (t.status === 'awaiting_human') {
        throw new HelmoError(
          `${t.id} is awaiting_human — its status moves when the human's answer is recorded, and helmo_answer_ticket is how you record it. IF THE HUMAN HAS ANSWERED — in a meeting, at the desk, anywhere — relay it now with helmo_answer_ticket (resolution 'done' closes it, 'resume' reopens it for whoever takes it next); that is a normal thing for any agent to do, not a role you need. Quote their reasoning, not just the choice. If they have NOT answered, leave it: you may still add notes and evidence.`,
        );
      }
      if (input.status === 'in_progress' && t.status === 'open') refuseUnmarkedDeskClaim(actor, t.needs_human);
      // Triage enforcement (H-56): the ready-queue withholding (H-55) is a
      // rule, not advice — an agent may not claim its own untouched filing
      // directly either. Sits upstream of the reservation checks on purpose:
      // takeover exists for stale claims and never releases self-triage.
      // Agents only — a human or orchestrator IS the second pair of eyes.
      if (input.status === 'in_progress' && t.status === 'open' && actor.kind === 'agent' && this.selfFiledUntouched(t.id, actor.name)) {
        throw new HelmoError(
          `${t.id} is your own filing, untouched by anyone else — executing your own discoveries takes a second pair of eyes first (the same triage rule that withholds it from your ready queue). Any event by a human, an orchestrator relaying the human, or another agent releases it: a meeting answer, a note, a handoff, a priority change. takeover does not apply — it exists for stale claims, not self-triage. If this cannot wait, helmo_return_to_human with the case for urgency; if you are starting genuinely new work, create the ticket with status 'in_progress' in the same call instead of filing it and drawing it back later.`,
        );
      }
      if (input.status === 'in_progress' && t.capacity_hold && !capacityReleased(t.capacity_hold)) {
        throw new HelmoError(`${t.id} is held for capacity: ${t.capacity_hold.reason} Record a fresh bounded release or remove the hold in a separate update before claiming it.`);
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
      // Putting work down is not giving it up (H-954). Releasing to 'open'
      // drops the claim and leaves the reservation standing, so work routed to
      // a seat is still that seat's when its next session starts. Clearing the
      // assignee here returned H-952 to a pool no builder watched: the loop
      // woke on its own unfinished work, its ready query said 0, and it idled.
      // Repooling is real, so it is now said out loud — handoff_to ''.
      if (input.status === 'done') {
        const hasEvidence = t.evidence.length > 0 || (input.evidence?.length ?? 0) > 0;
        if (!hasEvidence) {
          warnings.push('done_without_evidence: done was recorded, but with no evidence link the human sees a claim, not a record. Add evidence via another update if any exists.');
        }
      }
    }

    // An empty handoff_to clears the named receiver. In a seated workstream the
    // pool has one deterministic owner, so the stream seat becomes the new
    // reservation; an unseated stream still returns to the shared pool.
    if (input.handoff_to !== undefined) {
      if (t.status === 'in_progress' && t.assignee && t.assignee !== actor.name) {
        throw new HelmoError(`${t.id} is held by "${t.assignee}"; only the holder can hand it off.`);
      }
      if (t.status === 'awaiting_human') {
        throw new HelmoError(`${t.id} is awaiting_human; it cannot be handed off until answered.`);
      }
      diffs['status'] = { from: t.status, to: 'open' };
      const workstream = input.workstream ?? t.workstream;
      const assignee = input.handoff_to || this.workstreamSeat(workstream);
      diffs['assignee'] = { from: t.assignee, to: assignee };
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

    // An empty-string project clears the tag; the column goes back to NULL.
    if (input.project === '') input = { ...input, project: null };
    // Same for the date gate — '' opens it now, a date moves it (H-732).
    if (input.not_before === '') input = { ...input, not_before: null };
    else if (input.not_before) input = { ...input, not_before: parseNotBefore(input.not_before) };
    for (const field of ['title', 'body', 'priority', 'workstream', 'project', 'not_before', 'confidence', 'uncertainty_note'] as const) {
      const v = input[field];
      if (v !== undefined && v !== (t as unknown as Record<string, unknown>)[field]) {
        diffs[field] = { from: (t as unknown as Record<string, unknown>)[field], to: v };
      }
    }
    // The marker and its line are one fact, so they move together (H-1761):
    // a sitting can never be marked without saying what it needs, and
    // clearing it takes the line away with it.
    const sitting = parseSitting(input.needs_human, input.sitting_with);
    if (sitting) {
      if (sitting.needs_human !== t.needs_human) diffs['needs_human'] = { from: t.needs_human, to: sitting.needs_human };
      if (sitting.sitting !== t.sitting) diffs['sitting'] = { from: t.sitting, to: sitting.sitting };
      if (sitting.sitting_with !== t.sitting_with) diffs['sitting_with'] = { from: t.sitting_with, to: sitting.sitting_with };
    }
    // Moving genuinely unassigned work into a seated stream is another way it
    // can enter that pool. Keep the same ownership invariant at this door.
    if (input.workstream && input.workstream !== t.workstream && !t.assignee && input.handoff_to === undefined) {
      const seat = this.workstreamSeat(input.workstream);
      if (seat) diffs['assignee'] = { from: null, to: seat };
    }
    if (input.labels !== undefined && JSON.stringify(input.labels) !== JSON.stringify(t.labels)) {
      diffs['labels'] = { from: t.labels, to: input.labels };
    }
    if (input.capacity_hold !== undefined && JSON.stringify(input.capacity_hold) !== JSON.stringify(t.capacity_hold)) {
      diffs['capacity_hold'] = { from: t.capacity_hold, to: input.capacity_hold };
    }
    // A priority change is the store-level signal that urgency changed. It
    // cannot silently leave an old spending judgment masking newly urgent
    // work; a fresh hold can be recorded in the same update if still right.
    if (t.capacity_hold && input.priority !== undefined && input.priority !== t.priority && input.capacity_hold === undefined) {
      diffs['capacity_hold'] = { from: t.capacity_hold, to: null };
    }
    if (input.evidence?.length) {
      diffs['evidence'] = { from: t.evidence, to: [...t.evidence, ...input.evidence] };
    }
    if (input.confidence && input.confidence !== 'routine' && !input.uncertainty_note && !t.uncertainty_note) {
      warnings.push(`confidence '${input.confidence}' with no uncertainty_note — say WHERE the doubt is; that is what makes the review efficient.`);
    }

    return this.db.transaction(() => {
      const ts = now();
      if (t.workflow_attempt_id && (input.status === 'done' || input.status === 'cancelled' || input.labels !== undefined)) {
        this.refuseQuarantinedWorkflowMutation(t.id, input.status ?? 'relabel');
      }
      if (t.workflow_attempt_id && (input.status === 'in_progress' || input.handoff_to !== undefined)) {
        this.admitWorkflow(t.id, t.workflow_attempt_id, input.handoff_to !== undefined ? 'handoff' : 'claim');
      }
      const payload: Record<string, unknown> = { diffs, note: input.note };
      if (input.tokens) payload['tokens'] = input.tokens;
      if (input.cost_usd) payload['cost_usd'] = input.cost_usd;
      if (input.takeover) payload['takeover'] = true;
      if (input.handoff_to !== undefined) payload['handoff_to'] = input.handoff_to;
      this.append(ts, t.id, 'updated', actor, payload);
      this.applyUpdated(ts, t.id, payload);
      return { ticket: this.getTicket(t.id), warnings };
    }).immediate();
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
    rejectSwallowedMarkup({ note: input.note });
    this.getTicket(ticketId);
    return this.db.transaction(() => {
      // A total below zero is impossible, so a delta that would take one there
      // is bad arithmetic upstream: floor at zero and say so in the event,
      // loudly, rather than let the record carry a negative (H-187).
      const cur = this.getTicket(ticketId);
      let tokens = input.tokens;
      let cost = input.cost_usd;
      const clamped: string[] = [];
      if (tokens && cur.tokens_total + tokens < 0) {
        clamped.push(`tokens ${tokens} floored to ${-cur.tokens_total}`);
        tokens = -cur.tokens_total;
      }
      if (cost && cur.cost_usd_total + cost < 0) {
        clamped.push(`cost_usd ${cost} floored to ${-cur.cost_usd_total}`);
        cost = -cur.cost_usd_total;
      }
      const payload: Record<string, unknown> = {
        note: clamped.length ? `${input.note} [CLAMPED: would have taken the total below zero — ${clamped.join('; ')}]` : input.note,
      };
      if (clamped.length) process.stderr.write(`helmo record-spend ${ticketId}: ${clamped.join('; ')}\n`);
      if (tokens) payload['tokens'] = tokens;
      if (cost) payload['cost_usd'] = cost;
      this.append(now(), ticketId, 'spend', actor, payload);
      this.applySpend(ticketId, payload);
      return this.getTicket(ticketId);
    }).immediate();
  }

  /** Record that a hygiene finding was examined and dealt with, so sweeps stop
   *  re-spending attention on it (H-81).
   *
   *  On a terminal ticket the judgment stands forever: nothing about the ticket
   *  can change again, so nothing live is masked.
   *
   *  The one live-ticket case is spend_anomaly (H-1715). Every other check
   *  reports a state that either holds or does not, and masking one on open
   *  work could hide a real problem indefinitely; spend_anomaly reports a
   *  number that only grows, and "this spend is accounted for" stays true
   *  until the number moves. So a live acknowledgement is recorded AT the
   *  figure it answered for, and the finding returns on its own once the
   *  ticket has cost half as much again — at which point it can be
   *  acknowledged afresh. Without this, a long-lived blocked ticket that trips
   *  the check re-surfaces every sweep, and each re-reading is itself metered
   *  onto the ticket: the spiral that produced H-1715.
   *
   *  Like spend, this is bookkeeping, not motion — it never touches status or
   *  updated_at. Append-once per (check, ticket) while the judgment holds. */
  disposeHygieneFinding(actor: Actor, input: { check: string; ticket_id: string; reason: string }): void {
    validateActor(actor);
    if (!(HYGIENE_CHECKS as readonly string[]).includes(input.check)) {
      throw new HelmoError(`Unknown hygiene check "${input.check}". Checks: ${HYGIENE_CHECKS.join(', ')}.`);
    }
    if (!input.reason?.trim()) {
      throw new HelmoError('reason is required on hygiene-dispose: say why this finding is dealt with, for the next sweep to read.');
    }
    rejectSwallowedMarkup({ reason: input.reason });
    const t = this.getTicket(input.ticket_id);
    const live = t.status !== 'done' && t.status !== 'cancelled';
    if (live && input.check !== 'spend_anomaly') {
      throw new HelmoError(`${t.id} is ${t.status} — on live work only 'spend_anomaly' can be acknowledged. A '${input.check}' finding clears by acting on the ticket itself.`);
    }
    const existing = this.db
      .prepare('SELECT reason, at_cost FROM hygiene_dispositions WHERE check_name = ? AND ticket_id = ?')
      .get(input.check, t.id) as { reason: string; at_cost: number | null } | undefined;
    if (existing && (existing.at_cost == null || t.cost_usd_total <= existing.at_cost * SPEND_ACK_REGROWTH)) {
      throw new HelmoError(
        existing.at_cost == null
          ? `'${input.check}' on ${t.id} is already disposed ("${existing.reason}") — nothing to record.`
          : `'${input.check}' on ${t.id} is already acknowledged at $${existing.at_cost.toFixed(2)} ("${existing.reason}") and the finding is not being reported — nothing to record. It returns above $${(existing.at_cost * SPEND_ACK_REGROWTH).toFixed(2)}.`,
      );
    }
    this.db.transaction(() => {
      const ts = now();
      const payload: Record<string, unknown> = { check: input.check, reason: input.reason };
      if (live) payload['at_cost'] = t.cost_usd_total;
      this.append(ts, t.id, 'hygiene_disposed', actor, payload);
      this.applyHygieneDisposed(ts, t.id, actor, payload);
    }).immediate();
  }

  returnToHuman(actor: Actor, ticketId: string, q: QuestionInput): Ticket {
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
    // None, two, or three (H-939). Options used to be mandatory, and the cost
    // of that showed up in the meetings: an asker whose recommendation stood on
    // its own still had to name a second course to satisfy the schema, and the
    // human then read a manufactured alternative as a real one. One option is
    // that same problem with the disguise off. Four is past what anyone holds
    // in their head while being asked to pick — and past the a/b/c the reading
    // surfaces letter.
    const options = q.options ?? [];
    if (options.length === 1 || options.length > 3) {
      throw new HelmoError('options: give 2 or 3 genuinely equal choices, each {label, consequence} — or none at all. When your recommendation is the answer, leave options out and let it stand; do not manufacture alternatives to fill the field.');
    }
    for (const o of options) {
      if (!o.label?.trim() || !o.consequence?.trim()) throw new HelmoError('Every option needs both label and consequence (what happens if chosen, including cost/risk).');
    }
    rejectSwallowedMarkup({ situation: q.situation, question: q.question, recommendation: q.recommendation, if_unanswered: q.if_unanswered });
    // Normalised on the way in: every reader downstream sees an array.
    // The kind is explicit from the first write; a stored request without
    // one is a decision written before kinds existed (R-42 I13).
    const { operation_manifest_id, ...question } = q;
    const stored: HumanRequest = { kind: 'decision', ...question, options };
    return this.db.transaction(() => {
      if (operation_manifest_id) {
        const manifestRow = this.db.prepare('SELECT manifest FROM workflow_manifests WHERE id = ?').get(operation_manifest_id) as { manifest: string } | undefined;
        const manifest = manifestRow ? JSON.parse(manifestRow.manifest) as WorkflowManifest : undefined;
        const superseded = this.db.prepare("SELECT 1 FROM workflow_manifests WHERE json_extract(manifest, '$.supersedes_manifest_id') = ?").get(operation_manifest_id);
        const coveredSyntheticTest = manifest?.operation
          && manifest.operation.is_test === true
          && manifest.operation.recipient_in_registry === true
          && manifest.operation.data_class === 'synthetic'
          && manifest.operation.visibility === 'private'
          && manifest.operation.cost === 'none'
          && manifest.operation.effect === 'non_destructive';
        if (manifest?.kind === 'operation' && coveredSyntheticTest && !superseded) {
          const requirementRows = this.db.prepare("SELECT requirement FROM workflow_requirements WHERE json_extract(requirement, '$.subject_manifest_id') = ? ORDER BY id").all(operation_manifest_id) as { requirement: string }[];
          for (const requirementRow of requirementRows) {
            const requirement = JSON.parse(requirementRow.requirement) as WorkflowRequirement;
            if (requirement.scope !== 'test_authority') continue;
            const decisions = this.db.prepare('SELECT decision FROM workflow_decisions WHERE requirement_id = ? AND manifest_id = ? ORDER BY rowid')
              .all(requirement.id, operation_manifest_id).map((row) => JSON.parse((row as { decision: string }).decision) as WorkflowDecision);
            const revoked = new Set(decisions.filter((decision) => decision.verdict === 'revocation').map((decision) => decision.revokes_decision_id));
            const standing = decisions.filter((decision) => decision.verdict !== 'revocation' && !revoked.has(decision.id)).at(-1);
            if (standing && standing.verdict !== 'fail') {
              const ts = now();
              this.append(ts, t.id, 'human_return_covered', actor, { operation_manifest_id, requirement_id: requirement.id, decision_id: standing.id, operation: manifest.operation });
              return this.getTicket(t.id);
            }
          }
        }
      }
      // Inside the transaction for the same reason the answer's fingerprint
      // check is (H-1053): the answer can land between the caller's read and
      // its write. That is exactly the shape this refuses — on H-2099 a single
      // live session returned a question, had it answered 35 seconds later,
      // rewrote the body, and then returned the byte-identical ask again,
      // apparently never seeing the answer arrive. The human's dashboard drew
      // a decision he had already made, and the session was metered for it.
      const already = this.answeredAsks(t.id).get(questionFingerprint(stored));
      if (already) {
        const said = already.answer.answer.replace(/\s+/g, ' ').trim();
        throw new HelmoError(
          `${t.id} has already had this exact ask answered — ${already.by} answered it at ${already.at}: "${said.length > 200 ? `${said.slice(0, 200)}…` : said}"${already.answer.chosen_option ? ` (chose: ${already.answer.chosen_option})` : ''}. Read it with helmo_get_ticket (last_answer) and act on it; asking again spends a meeting slot on a decision already made. If you do still need the human, say what is new: a situation that accounts for that answer and names what it left open. A byte-identical re-ask is the signature of a session that did not see the answer land, not of a second question.`,
        );
      }
      const ts = now();
      this.append(ts, t.id, 'returned', actor, stored as unknown as Record<string, unknown>);
      this.db
        .prepare("UPDATE tickets SET status = 'awaiting_human', assignee = NULL, question = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(stored), ts, t.id);
      return this.getTicket(t.id);
    }).immediate();
  }

  /** `expectQuestion` is the fingerprint of the ask the answerer was looking at
   *  (`presentation.ts` `questionFingerprint`). It is checked INSIDE the write
   *  transaction, because the gap between drawing a card and clicking it is
   *  long enough for another session to answer the ticket and the agent to
   *  return a fresh question — and consent belongs to the ask it was given
   *  for, not to the ticket id (H-1053). */
  answerTicket(actor: Actor, ticketId: string, a: Answer, expectQuestion?: string): Ticket {
    validateActor(actor);
    const t = this.getTicket(ticketId);
    if (t.status !== 'awaiting_human') {
      throw new HelmoError(`${t.id} is ${t.status}, not awaiting_human — there is no pending question to answer.`);
    }
    // The whole point of separating the kinds (R-42 I13): an action is not
    // answered, it is done. Letting this through would write question = NULL
    // and silently discard the action request.
    if (t.action) {
      throw new HelmoError(
        `${t.id} is asking the human to DO something, not to decide it: "${t.action.action}". There is no answer to record. When they have done it, record that with helmo_report_action; a completed action is not permission and does not close the ticket.`,
      );
    }
    if (!a.answer?.trim()) throw new HelmoError('answer is required: the decision plus the human\'s reasoning and any new constraints.');
    rejectSwallowedMarkup({ answer: a.answer });
    const resolution = a.resolution ?? 'resume';
    return this.db.transaction(() => {
      const ts = now();
      if (expectQuestion !== undefined) {
        const cur = this.getTicket(t.id);
        if (cur.status !== 'awaiting_human' || !cur.question || questionFingerprint(cur.question) !== expectQuestion) {
          throw new HelmoError(`${t.id} is no longer asking what was on screen — reload and read the current question before answering.`);
        }
      }
      const assignee = resolution === 'resume' ? this.workstreamSeat(t.workstream) : null;
      if (resolution === 'resume' && t.workflow_attempt_id) this.admitWorkflow(t.id, t.workflow_attempt_id, 'answer_resume');
      if (resolution !== 'resume') this.refuseQuarantinedWorkflowMutation(t.id, `answer_${resolution}`);
      this.append(ts, t.id, 'answered', actor, { ...a, resolution, assignee } as unknown as Record<string, unknown>);
      if (resolution === 'resume') {
        this.db.prepare("UPDATE tickets SET status = 'open', assignee = ?, question = NULL, updated_at = ? WHERE id = ?").run(assignee, ts, t.id);
      } else {
        this.db
          .prepare('UPDATE tickets SET status = ?, assignee = NULL, question = NULL, updated_at = ?, closed_at = ? WHERE id = ?')
          .run(resolution, ts, ts, t.id);
      }
      return this.getTicket(t.id);
    }).immediate();
  }

  /** Ask the human to DO something (R-42 I13). The same axis as a question —
   *  `awaiting_human`, claim released, nobody working it — because that is what
   *  a pending request is. What differs is the response: an action comes back
   *  through `reportAction`, never through an answer, so a completed action can
   *  never be recorded as permission.
   *
   *  `why_human` is required. Arthur's complaint was not that agents asked him
   *  to do things, it was that he could not tell "please do this" from "may I
   *  do this"; an asker who cannot say why their own hands will not serve owes
   *  a decision instead. */
  requestAction(actor: Actor, ticketId: string, r: ActionRequest): Ticket {
    validateActor(actor);
    const t = this.getTicket(ticketId);
    if (t.status !== 'open' && t.status !== 'in_progress') {
      throw new HelmoError(`${t.id} is ${t.status}; only open or in_progress tickets can be handed an action for the human.`);
    }
    if (!r.situation?.trim()) {
      throw new HelmoError('situation is required: what you were doing and where it stands, for someone who has not read the ticket.');
    }
    if (!r.action?.trim()) {
      throw new HelmoError('action is required: what the human does, concretely enough to act on without opening the ticket, and roughly what it costs them.');
    }
    if (!r.why_human?.trim()) {
      throw new HelmoError(
        'why_human is required: say why this needs the human\'s own hands rather than yours. If an agent could do it and you only want it approved first, this is a decision, not an action — return it with helmo_return_to_human and let them answer it.',
      );
    }
    rejectSwallowedMarkup({ situation: r.situation, action: r.action, why_human: r.why_human, if_unanswered: r.if_unanswered });
    const stored: { kind: 'action' } & ActionRequest = { kind: 'action', ...r };
    return this.db.transaction(() => {
      // The same guard the re-ask has, for the same reason (H-2126): a session
      // that did not see the report land would otherwise put a job the human
      // has already done back on their dashboard.
      const already = this.actedRequests(t.id).get(actionFingerprint(stored));
      if (already) {
        const said = already.report.did.replace(/\s+/g, ' ').trim();
        throw new HelmoError(
          `${t.id} has already had this exact action reported done — ${already.by} recorded it at ${already.at}: "${said.length > 200 ? `${said.slice(0, 200)}…` : said}". Read it with helmo_get_ticket and act on it. If something about it did not work, say what: an action that accounts for what they already did and names what is still missing.`,
        );
      }
      const ts = now();
      this.append(ts, t.id, 'returned', actor, stored as unknown as Record<string, unknown>);
      this.db
        .prepare("UPDATE tickets SET status = 'awaiting_human', assignee = NULL, question = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(stored), ts, t.id);
      return this.getTicket(t.id);
    }).immediate();
  }

  /** The human reporting that they did it. This resumes the work and does
   *  nothing else: there is no resolution to pass and no option to choose, so
   *  it cannot close a ticket, cannot grant anything, and is not the agent's
   *  later verification that the action worked. Those are three separate
   *  records, and this signature is what keeps them from collapsing into one.
   *
   *  `expectRequest` is the fingerprint of the request the reporter was looking
   *  at, checked inside the write transaction for the same reason the answer's
   *  is (H-1053): consent belongs to the request it was given for, not to the
   *  ticket id. */
  reportAction(actor: Actor, ticketId: string, report: ActionReport, expectRequest?: string): Ticket {
    validateActor(actor);
    const t = this.getTicket(ticketId);
    if (t.status !== 'awaiting_human') {
      throw new HelmoError(`${t.id} is ${t.status}, not awaiting_human — there is no pending action to report.`);
    }
    if (t.question) {
      throw new HelmoError(
        `${t.id} is asking the human to DECIDE something, not to do it: "${t.question.question}". Record what they said with helmo_answer_ticket, quoting their reasoning.`,
      );
    }
    if (!report.did?.trim()) {
      throw new HelmoError('did is required: what the human actually did, in their own words. "Done" tells the next session nothing about what state the world is in now.');
    }
    rejectSwallowedMarkup({ did: report.did });
    return this.db.transaction(() => {
      const ts = now();
      if (expectRequest !== undefined) {
        const cur = this.getTicket(t.id);
        if (cur.status !== 'awaiting_human' || !cur.action || actionFingerprint(cur.action) !== expectRequest) {
          throw new HelmoError(`${t.id} is no longer asking for what was on screen — reload and read the current request before reporting it done.`);
        }
      }
      const assignee = this.workstreamSeat(t.workstream);
      if (t.workflow_attempt_id) this.admitWorkflow(t.id, t.workflow_attempt_id, 'action_resume');
      this.append(ts, t.id, 'acted', actor, { did: report.did, assignee } as unknown as Record<string, unknown>);
      this.db.prepare("UPDATE tickets SET status = 'open', assignee = ?, question = NULL, updated_at = ? WHERE id = ?").run(assignee, ts, t.id);
      return this.getTicket(t.id);
    }).immediate();
  }

  /** Actions on this ticket that have been reported done, by fingerprint. The
   *  action half of `answeredAsks`, kept separate because a report is not an
   *  answer and has no resolution or chosen option to carry. */
  actedRequests(ticketId: string): Map<string, { report: ActionReport; at: string; by: string }> {
    const rows = this.db
      .prepare("SELECT event_type, actor, payload, ts FROM events WHERE ticket_id = ? AND event_type IN ('returned', 'acted') ORDER BY seq")
      .all(ticketId) as { event_type: string; actor: string; payload: string; ts: string }[];
    const done = new Map<string, { report: ActionReport; at: string; by: string }>();
    let pending: string | null = null;
    for (const r of rows) {
      if (r.event_type === 'returned') {
        const req = JSON.parse(r.payload) as HumanRequest;
        // Belt-and-braces, and known to be unreachable: a decision return
        // cannot be followed by an `acted`, because `reportAction` refuses a
        // pending decision and `requestAction` refuses an awaiting_human
        // ticket. The refusals are the guard; this clear only means that if
        // one ever stops holding, a report is dropped rather than recorded
        // against the wrong request. No test covers it — nothing legal gets
        // here.
        pending = req.kind === 'action' ? actionFingerprint(req) : null;
      } else if (pending) {
        done.set(pending, { report: JSON.parse(r.payload) as ActionReport, at: r.ts, by: (JSON.parse(r.actor) as Actor).name });
        pending = null;
      }
    }
    return done;
  }

  linkTickets(actor: Actor, fromId: string, toId: string, type: DepType, action: 'add' | 'remove'): void {
    validateActor(actor);
    this.getTicket(fromId);
    this.getTicket(toId);
    if (fromId === toId) throw new HelmoError('A ticket cannot link to itself.');
    this.db.transaction(() => {
      const ts = now();
      if (type === 'parent') this.refuseQuarantinedWorkflowMutation(fromId, action === 'add' ? 'reparent' : 'unparent');
      if (action === 'add') {
        this.checkNoBlocksCycle(fromId, toId, type);
        this.append(ts, fromId, 'linked', actor, { to: toId, type });
        this.applyLinked(fromId, toId, type, true);
      } else {
        this.append(ts, fromId, 'unlinked', actor, { to: toId, type });
        this.applyLinked(fromId, toId, type, false);
      }
      this.db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(ts, fromId);
    }).immediate();
  }

  // ---------- rebuild (the invariant) ----------

  /** Reconstruct tickets + deps purely from the event log. Used by tests to enforce
   *  that materialized state is always derivable from events. */
  rebuild(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM tickets; DELETE FROM deps; DELETE FROM workstreams; DELETE FROM hygiene_dispositions; DELETE FROM notice;');
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
          case 'notice_set':
            this.applyNoticeSet(ev.ts, ev.payload);
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
              this.db.prepare("UPDATE tickets SET status = 'open', assignee = ?, question = NULL, updated_at = ? WHERE id = ?")
                .run(ev.payload['assignee'] ?? null, ev.ts, ev.ticket_id);
            } else {
              this.db
                .prepare('UPDATE tickets SET status = ?, assignee = NULL, question = NULL, updated_at = ?, closed_at = ? WHERE id = ?')
                .run(res, ev.ts, ev.ts, ev.ticket_id);
            }
            break;
          }
          case 'acted':
            this.db.prepare("UPDATE tickets SET status = 'open', assignee = ?, question = NULL, updated_at = ? WHERE id = ?")
              .run(ev.payload['assignee'] ?? null, ev.ts, ev.ticket_id);
            break;
          case 'spend':
            this.applySpend(ev.ticket_id, ev.payload);
            break;
          case 'hygiene_disposed':
            this.applyHygieneDisposed(ev.ts, ev.ticket_id, ev.actor, ev.payload);
            break;
          case 'linked':
            this.applyLinked(ev.ticket_id, ev.payload['to'] as string, ev.payload['type'] as DepType, true);
            break;
          case 'unlinked':
            this.applyLinked(ev.ticket_id, ev.payload['to'] as string, ev.payload['type'] as DepType, false);
            break;
        }
      }
    }).immediate();
  }

  dumpState(): { tickets: Ticket[]; deps: Dep[]; workstreams: Workstream[]; dispositions: Record<string, unknown>[]; notice: Notice | null } {
    const tickets = (this.db.prepare('SELECT * FROM tickets ORDER BY id').all() as Record<string, unknown>[]).map(rowToTicket);
    const deps = this.db.prepare('SELECT * FROM deps ORDER BY from_id, to_id, type').all() as Dep[];
    const workstreams = this.db.prepare('SELECT * FROM workstreams ORDER BY name').all() as Workstream[];
    const dispositions = this.db.prepare('SELECT * FROM hygiene_dispositions ORDER BY check_name, ticket_id').all() as Record<string, unknown>[];
    return { tickets, deps, workstreams, dispositions, notice: this.getNotice() };
  }

  /** Remove a ticket row that Helmo never created.
   *
   *  The ONLY rows this will touch are ones with no events at all. That is the
   *  whole safety property: this store's invariant is that tickets are a
   *  materialized view of the event log, so a row with no events is not a
   *  ticket — it is a write that came from outside, and removing it takes
   *  nothing away from the log, which never knew about it. A row with even one
   *  event has history, and history is not deleted here at any bar.
   *
   *  Returns the row as it was, so the caller can record what it removed. Added
   *  under H-448, when bosun inserted a ticket straight into the table and the
   *  only sanctioned repair was "Arthur runs SQL by hand" — which is exactly
   *  the habit that caused the incident. */
  purgeOrphan(ticketId: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as Record<string, unknown> | undefined;
    if (!row) throw new HelmoError(`${ticketId} does not exist.`);
    const events = (this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE ticket_id = ?').get(ticketId) as { n: number }).n;
    if (events > 0) {
      throw new HelmoError(
        `${ticketId} has ${events} event(s) — it is a real ticket with history, not an orphan row. This command only removes rows the event log has never heard of. Cancel it instead.`,
      );
    }
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM deps WHERE from_id = ? OR to_id = ?').run(ticketId, ticketId);
      this.db.prepare('DELETE FROM hygiene_dispositions WHERE ticket_id = ?').run(ticketId);
      this.db.prepare('DELETE FROM tickets WHERE id = ?').run(ticketId);
    })();
    return row;
  }

  // ---------- internals ----------

  /** Mint the next ticket id.
   *
   *  The counter alone used to be trusted, which made a single id it had
   *  already issued unrecoverable: the INSERT collides, the transaction rolls
   *  back, the counter rolls back with it, and the SAME id is minted forever.
   *  Every write blocks — and because `wake-check` materializes due recurring
   *  instances, so does every harness poll. On 2026-08-27 that took the whole
   *  fleet down for forty minutes over one bad row (H-448).
   *
   *  So the table gets a vote. The counter can only ever move forward past the
   *  highest id that exists, which recovers from drift in one step and cannot
   *  loop. A counter found behind the table is an anomaly, not routine: it
   *  says a row exists that this method never issued, so it is reported to
   *  stderr and surfaced by the `orphan_ticket` hygiene check. */
  private mintId(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'next_id'").get() as { value: string } | undefined;
    const counter = row ? parseInt(row.value, 10) : 1;
    const maxRow = this.db
      .prepare("SELECT MAX(CAST(SUBSTR(id, 3) AS INTEGER)) AS m FROM tickets WHERE id LIKE 'H-%'")
      .get() as { m: number | null } | undefined;
    const floor = (maxRow?.m ?? 0) + 1;
    const n = Math.max(Number.isFinite(counter) ? counter : 1, floor);
    if (n !== counter) {
      console.error(
        `helmo: next_id was ${counter} but H-${floor - 1} already exists — advancing to H-${n}. ` +
          `A ticket row was created that Helmo did not mint; run 'helmo-cli hygiene' for the orphan_ticket check.`,
      );
    }
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('next_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n + 1));
    return `H-${n}`;
  }

  private append(ts: string, ticketId: string, type: string, actor: Actor, payload: Record<string, unknown>): void {
    this.assertInstallationForWrite();
    this.db
      .prepare('INSERT INTO events (ts, ticket_id, event_type, actor, payload) VALUES (?, ?, ?, ?, ?)')
      .run(ts, ticketId, type, JSON.stringify(actor), JSON.stringify(payload));
  }

  private assertInstallationForWrite(): void {
    if (!this.installation) return;
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'installation_name'").get() as { value: string } | undefined;
    if (row && !namesInstallation(this.installation, row.value)) {
      throw new HelmoError(
        `Installation target UNCLEAR: process names '${this.installation.label}', but this store belongs to '${row.value}'. Nothing was written. Point HELMO_HOME or HELMO_DB at the intended installation.`,
      );
    }
    if (!row && this.installation.source !== 'derived') {
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('installation_name', ?)").run(this.installation.label);
    }
  }

  private workstreamSeat(name: string): string | null {
    return this.getWorkstreamInfo(name).seat ?? null;
  }

  private applyCreated(ts: string, p: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO tickets (id, title, body, workstream, project, type, labels, status, priority, assignee, schedule, not_before, needs_human, sitting, sitting_with, workflow_attempt_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p['id'], p['title'], p['body'], p['workstream'], p['project'] ?? null, p['type'],
        JSON.stringify(p['labels'] ?? []), p['status'] ?? 'open', p['priority'] ?? 2, p['assignee'] ?? null,
        p['schedule'] ?? null, p['not_before'] ?? null, p['needs_human'] ? 1 : 0, p['sitting'] ?? null, p['sitting_with'] ?? null,
        p['workflow_attempt_id'] ?? null, ts, ts,
      );
  }

  private applyUpdated(ts: string, id: string, payload: Record<string, unknown>): void {
    const diffs = (payload['diffs'] ?? {}) as Record<string, { from: unknown; to: unknown }>;
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [ts];
    const jsonFields = new Set(['labels', 'evidence']);
    for (const [field, d] of Object.entries(diffs)) {
      if (!['title', 'body', 'workstream', 'project', 'type', 'labels', 'status', 'priority', 'assignee', 'evidence', 'confidence', 'uncertainty_note', 'blast_radius', 'not_before', 'needs_human', 'sitting', 'sitting_with', 'capacity_hold'].includes(field)) continue;
      sets.push(`${field} = ?`);
      params.push(
        field === 'needs_human'
          ? (d.to ? 1 : 0)
          : jsonFields.has(field) || field === 'capacity_hold'
            ? (d.to === null ? null : JSON.stringify(d.to))
            : (d.to as never),
      );
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

  private applyHygieneDisposed(ts: string, ticketId: string, actor: Actor, p: Record<string, unknown>): void {
    // A live spend acknowledgement replaces the one it outgrew (H-1715), so
    // the row always carries the figure the current judgment answered for.
    // Terminal dispositions carry no figure and, being append-once, never
    // reach the update arm.
    this.db
      .prepare(
        `INSERT INTO hygiene_dispositions (check_name, ticket_id, actor, reason, ts, at_cost) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (check_name, ticket_id) DO UPDATE SET actor = excluded.actor, reason = excluded.reason, ts = excluded.ts, at_cost = excluded.at_cost`,
      )
      .run(p['check'], ticketId, actor.name, p['reason'], ts, (p['at_cost'] as number | undefined) ?? null);
  }

  private applyWorkstreamSet(ts: string, p: Record<string, unknown>): void {
    // COALESCE keeps the field a partial write did not carry — replaying the
    // log reproduces exactly the same partial-update semantics. Historical
    // payloads still carry `goal`; it lands in its column and nothing reads it.
    this.db
      .prepare(
        `INSERT INTO workstreams (name, goal, budget_usd, seat, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           goal = COALESCE(excluded.goal, workstreams.goal),
           budget_usd = COALESCE(excluded.budget_usd, workstreams.budget_usd),
           seat = CASE WHEN excluded.seat IS NULL THEN workstreams.seat
                       WHEN excluded.seat = '' THEN NULL ELSE excluded.seat END,
           updated_at = excluded.updated_at`,
      )
      .run(p['name'], p['goal'] ?? null, p['budget_usd'] ?? null, p['seat'] ?? null, ts);
  }

  private applyNoticeSet(ts: string, p: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO notice (id, text, provenance, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET text = excluded.text, provenance = excluded.provenance, updated_at = excluded.updated_at`,
      )
      .run(p['text'], p['provenance'], ts);
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
    ...splitRequest(row['question'] as string | null),
    capacity_hold: row['capacity_hold'] ? JSON.parse(row['capacity_hold'] as string) : null,
    needs_human: Boolean(row['needs_human']),
    sitting: (row['sitting'] as string | null) ?? null,
    sitting_with: (row['sitting_with'] as string | null) ?? null,
  };
}

/** One stored column, two read fields (R-42 I13). `question` keeps its exact
 *  meaning — the pending DECISION — so answer.ts, view.ts, tools.ts and every
 *  external `get_ticket` consumer are unchanged, and a reader that knows only
 *  about questions sees null on an action ticket instead of misreading the
 *  action as a decision it could ratify.
 *
 *  A request stored before `kind` existed has none, and reads as the decision
 *  it was. Nothing infers a kind from prose. */
function splitRequest(stored: string | null): { question: Question | null; action: ActionRequest | null } {
  if (!stored) return { question: null, action: null };
  const r = JSON.parse(stored) as HumanRequest;
  return r.kind === 'action' ? { question: null, action: r } : { question: r as Question, action: null };
}

function capacityReleased(hold: CapacityHold): boolean {
  return !!hold.release && hold.release.until > now();
}

function rowToEvent(row: Record<string, unknown>): HelmoEvent {
  return {
    ...(row as unknown as HelmoEvent),
    actor: JSON.parse(row['actor'] as string),
    payload: JSON.parse(row['payload'] as string),
  };
}
