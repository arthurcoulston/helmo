import Database from 'better-sqlite3';
import { boundNote, LatestProgress } from '@helmo/core';
import {
  ACTOR_KINDS, Actor, ActorKind, AUTHORIZED, Bet, Citation, Claim, Dep, DepType, EFFORT_SIZES, Horizon, LEGACY_STATUSES, Objective,
  Health, Project, ProjectSnapshot, Ranked, Readiness, ReadinessReview, ReadinessVerdict, RoadmapError, RoadmapEvent, SHIPPED, Status, STATUSES, statusReading, StoredStatus, TERMINAL, VALUE_LEVELS,
} from './types.js';
import { Installation, namesInstallation } from './install.js';
import { planR46, R46Facts, R46Judgments, R46Plan } from './migrate-lib.js';

export interface CreateInput {
  title: string;
  body?: string; // a title and a sentence — any required field would strangle the backlog at birth
  // A new project is Proposed; how refined it is, is `readiness`. The two
  // pre-R-46 words stay accepted for callers still mid-migration.
  status?: 'Proposed' | 'parked' | 'shaping';
}

export interface UpdateInput {
  project_id: string;
  note: string;
  // The revision this update was decided against (from a read). Optional, and
  // omitting it keeps the pre-existing last-write-wins behavior; passing it
  // makes the write conditional — see `assertRevision`.
  if_revision?: number;
  status?: Exclude<Status, 'Planned'>; // Planned only via setShipNext — it is the human's call
  archived?: boolean; // hide a Completed or Canceled row from the surfaces
  title?: string;
  body?: string;
  parked_reason?: string;
  unpark_condition?: string;
}

/** The stored words — today's and every pre-R-46 one — whose reading falls in
 *  a family. SQL reads the status column raw, and rows carry the old word
 *  until the migration runs, so a family filter has to name both vocabularies.
 *  Every value comes from our own constants; nothing here is caller input. */
const storedIn = (family: readonly Status[]): string =>
  [...STATUSES, ...LEGACY_STATUSES]
    .filter((stored) => family.includes(statusReading(stored)))
    .map((stored) => `'${stored}'`)
    .join(', ');

const CLOSED_SQL = storedIn([...SHIPPED, ...TERMINAL]);
const SHIPPED_SQL = storedIn(SHIPPED);
const AUTHORIZED_SQL = storedIn(AUTHORIZED);

/** Pre-R-46 rows carry their refinement in the status word rather than the
 *  field: `shaping` and `ready` were both descriptions someone had worked on,
 *  and the migration maps both to shaped. Read it either way so The List keeps
 *  its order in the window before the migration writes the field. */
const readinessOf = (p: Project): Readiness =>
  p.readiness === 'shaped' || p.status === 'shaping' || p.status === 'ready' ? 'shaped' : 'raw idea';

export interface UpdateResult {
  project: Project;
  revision: number; // after this write — pass it back as the next if_revision
  warnings: string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor      TEXT NOT NULL,
  payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_subject ON events(subject_id);
CREATE TABLE IF NOT EXISTS projects (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'Proposed',
  readiness        TEXT NOT NULL DEFAULT 'raw idea',
  health           TEXT,
  health_reason    TEXT,
  archived         INTEGER NOT NULL DEFAULT 0,
  parked_reason    TEXT,
  unpark_condition TEXT,
  actual_usd       REAL NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  closed_at        TEXT
);
CREATE TABLE IF NOT EXISTS deps (
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  type    TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, type)
);
CREATE TABLE IF NOT EXISTS claims (
  project_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  level         TEXT,
  size          TEXT,
  predicted_usd REAL,
  reason        TEXT NOT NULL,
  author        TEXT NOT NULL,
  ts            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_project ON claims(project_id);
CREATE TABLE IF NOT EXISTS citations (
  project_id   TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  claim        TEXT NOT NULL,
  PRIMARY KEY (project_id, objective_id)
);
CREATE TABLE IF NOT EXISTS objectives (
  id         TEXT PRIMARY KEY,
  statement  TEXT NOT NULL,
  horizon    TEXT NOT NULL,
  rank       INTEGER NOT NULL,
  source     TEXT NOT NULL,
  derived_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bets (
  id         TEXT PRIMARY KEY,
  statement  TEXT NOT NULL,
  stake      TEXT NOT NULL,
  falsifier  TEXT NOT NULL,
  source     TEXT NOT NULL,
  derived_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function now(): string {
  return new Date().toISOString();
}

function validateActor(actor: Actor): void {
  if (!actor?.name || !actor?.kind) {
    throw new RoadmapError(
      'No actor identity. Configure ROADMAP_ACTOR (JSON with at least {"name", "kind"}) in the MCP server environment, or pass an "actor" param. Provenance requires knowing who writes.',
    );
  }
  if (actor.kind === 'agent' && (!actor.model || !actor.version)) {
    throw new RoadmapError(
      `Actor "${actor.name}" has kind "agent" but is missing model and/or version. Agents must identify their model ID and harness version — this is what makes corrections verifiable.`,
    );
  }
}

// Same hazard as Helmo's H-71: a mis-serialized tool call dumps parameter
// markup — and every field after the break — into the first free-text field.
const TOOLCALL_MARKUP = /<\/?([a-z]+:)?(parameter|invoke|function_calls)[\s>=]/i;

function rejectSwallowedMarkup(fields: Record<string, string | undefined | null>): void {
  for (const [name, value] of Object.entries(fields)) {
    if (!value) continue;
    if (TOOLCALL_MARKUP.test(value) || value.includes(`</${name}>`)) {
      throw new RoadmapError(
        `The "${name}" text contains tool-call parameter markup — the signature of a mis-serialized call, where every field after the break is swallowed into this one and silently lost. Nothing was stored. Re-send the write with each field as its own parameter. If you are deliberately quoting such markup, break the tag (e.g. "< parameter").`,
      );
    }
  }
}

export class Store {
  private db: Database.Database;
  private installation?: Installation;

  /** The agent this process serves as the installation's leader (H-2073), or
   *  null. The leader directs the roadmap: it may judge its own shaping ready
   *  and move a project into work or the shipped family without passing
   *  through the human's go. Planned itself is still entered only through
   *  roadmap_set_ship_next, and every write still records the true actor. Set
   *  by the server only for its own pinned identity, so no other seat's
   *  process carries it. Unset by default. */
  private leader: string | null = null;

  setLeader(name: string | null): void {
    this.leader = name?.trim() ? name : null;
  }

  /** Honour a configured leader (ROADMAP_LEADER) only in the leader's own
   *  process: it must name the actor this server is pinned to, so a variable
   *  copied into another seat's launcher grants that seat nothing. */
  pinLeader(configured: string | undefined, pinned: Actor | null): void {
    this.setLeader(configured && pinned?.kind === 'agent' && pinned.name === configured ? configured : null);
  }

  private isLeader(actor: Actor): boolean {
    return this.leader !== null && actor.kind === 'agent' && actor.name === this.leader;
  }

  constructor(path: string, installation?: Installation) {
    this.installation = installation;
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    // Write transactions read before they write (minting an id, loading a
    // project), so every one below runs .immediate() — a deferred begin would
    // hit an instant SQLITE_BUSY on the lock upgrade instead of waiting
    // (Helmo's H-134; same engine, same trap).
    this.db.exec(SCHEMA);
    this.addProjectReadingColumns();
  }

  /** SQLite's CREATE TABLE does not add columns to an existing table. */
  private addProjectReadingColumns(): void {
    const columns = new Set(
      (this.db.pragma('table_info(projects)') as { name: string }[]).map((column) => column.name),
    );
    const additions = [
      ['readiness', "TEXT NOT NULL DEFAULT 'raw idea'"],
      ['health', 'TEXT'],
      ['health_reason', 'TEXT'],
      ['archived', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const;
    for (const [name, definition] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${definition}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /** The installation this store was opened as, for a surface that has to
   *  qualify a record reference with it or check one against it (H-2506).
   *  Undefined for a store opened without one — a library caller or a test —
   *  where a qualified reference has nothing to check and is refused rather
   *  than assumed. */
  installationTarget(): Installation | undefined {
    return this.installation;
  }

  /** Durable name claimed by the first explicitly named writer. A derived-only
   *  installation deliberately leaves old single-store use unchanged. */
  installationIdentity(): { process: string | null; stored: string | null; clear: boolean } {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'installation_name'").get() as { value: string } | undefined;
    const processName = this.installation?.label ?? null;
    return { process: processName, stored: row?.value ?? null, clear: !processName || !row || namesInstallation(this.installation as Installation, row.value) };
  }

  // ---------- reads ----------

  getProject(id: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new RoadmapError(`Project "${id}" not found. IDs look like "R-4"; use roadmap_list_projects to find the one you mean.`);
    }
    return row as unknown as Project;
  }

  getDeps(id: string): { outgoing: Dep[]; incoming: Dep[] } {
    return {
      outgoing: this.db.prepare('SELECT * FROM deps WHERE from_id = ?').all(id) as Dep[],
      incoming: this.db.prepare('SELECT * FROM deps WHERE to_id = ?').all(id) as Dep[],
    };
  }

  /** The project's revision: the seq of the last event recorded against it.
   *  Every write appends one, so a revision that has not moved means nothing
   *  about the project has. It is not a new fact — the event log already held
   *  it — but a caller must not have to read a precondition off the tail of a
   *  history array. A project always has its 'created' event, so a real
   *  revision is >= 1. */
  revisionOf(id: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS rev FROM events WHERE subject_id = ?')
      .get(id) as { rev: number };
    return row.rev;
  }

  /** Everything one read of a project returns, taken under a single snapshot.
   *
   *  `revisionOf` called beside a separate `getProject` is two SQLite snapshots,
   *  and a second connection that commits between them hands the caller the old
   *  body with the new revision. That revision then passes `assertRevision`, and
   *  the readiness judgment lands on text nobody read — the exact corruption the
   *  precondition exists to stop, rebuilt out of the read side instead of the
   *  write side. So the facts are read together or not at all.
   *
   *  The transaction is DEFERRED, unlike every write above: nothing here upgrades
   *  a lock, so there is no SQLITE_BUSY to wait out, and a WAL read transaction
   *  holds one consistent snapshot from its first statement to its commit.
   *
   *  `revision` covers this project's OWN record. `blocked_by` and incoming
   *  `deps` are facts about other projects — a blocker archived, a relation
   *  added from elsewhere — and those move without touching this project's
   *  events. A caller whose decision turns on the dependency graph cannot treat
   *  this token as covering it. */
  projectSnapshot(id: string): ProjectSnapshot {
    return this.db.transaction(() => ({
      project: this.getProject(id),
      revision: this.revisionOf(id),
      readiness_revision: this.readinessRevision(id),
      blocked_by: this.blockedBy(id),
      deps: this.getDeps(id),
      claims: this.getClaims(id),
      citations: this.getCitations(id),
      events: this.getEvents(id),
      readiness: this.readinessReview(id),
    }))();
  }

  readinessRevision(id: string, throughSeq?: number): number {
    this.getProject(id);
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(seq), 0) AS rev FROM events
       WHERE subject_id = ? AND event_type != 'readiness_verdict_recorded' AND (? IS NULL OR seq <= ?)`,
    ).get(id, throughSeq ?? null, throughSeq ?? null) as { rev: number };
    return row.rev;
  }

  readinessReview(id: string, throughSeq?: number): ReadinessReview | null {
    const reviewed_revision = this.readinessRevision(id, throughSeq);
    const rows = this.db.prepare(
      `SELECT ts, actor, payload FROM events
       WHERE subject_id = ? AND event_type = 'readiness_verdict_recorded'
         AND json_extract(payload, '$.reviewed_revision') = ? AND (? IS NULL OR seq <= ?) ORDER BY seq`,
    ).all(id, reviewed_revision, throughSeq ?? null, throughSeq ?? null) as { ts: string; actor: string; payload: string }[];
    if (!rows.length) return null;
    const latest = new Map<string, ReadinessVerdict>();
    for (const row of rows) {
      const actor = JSON.parse(row.actor) as Actor;
      const payload = JSON.parse(row.payload) as { verdict: 'pass' | 'fail'; note: string; reviewed_revision: number };
      latest.set(actor.name, { ...payload, reviewer: actor.name, ts: row.ts });
    }
    const verdicts = [...latest.values()];
    const fails = verdicts.filter((v) => v.verdict === 'fail').length;
    const passes = verdicts.filter((v) => v.verdict === 'pass').length;
    return { reviewed_revision, state: fails ? (passes ? 'contested' : 'failed') : 'ready', verdicts };
  }

  /** The latest authored progress note per project, in the shape Work's store
   *  returns for a ticket — the rows of both areas are drawn through one shared
   *  preview, so they have to carry one field (H-2988).
   *
   *  'actual_recorded' is excluded for the same reason Work's `latestProgress`
   *  excludes 'spend': a cost rollup is accounting, and "Rollup of 10 tickets
   *  tagged project R-10 via helmo work get + cost_usd_total sum" shown as where
   *  R-10 stands tells the reader nothing about the project. Measured on the
   *  live record before excluding it — four projects' newest note is a rollup,
   *  and all four have an earlier 'updated' note behind it, so the exclusion
   *  costs no coverage at all.
   *
   *  A project with no note is absent rather than empty: twelve parked projects
   *  have never been updated since they were filed, and the preview says so in
   *  words instead of drawing a blank line. */
  latestProgress(projectIds: string[]): Map<string, LatestProgress> {
    const ids = [...new Set(projectIds)];
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT e.subject_id, e.ts, e.actor, json_extract(e.payload, '$.note') AS note
           FROM events e
           JOIN (
             SELECT subject_id, MAX(seq) AS seq FROM events
              WHERE subject_id IN (${placeholders}) AND event_type = 'updated'
                AND json_type(payload, '$.note') = 'text'
                AND TRIM(json_extract(payload, '$.note')) != ''
              GROUP BY subject_id
           ) latest ON latest.seq = e.seq`,
      )
      .all(...ids) as { subject_id: string; ts: string; actor: string; note: string }[];
    return new Map(rows.map((r) => {
      const actor = JSON.parse(r.actor) as Actor;
      return [r.subject_id, { at: r.ts, note: boundNote(r.note), actor: { name: actor.name, kind: actor.kind } }];
    }));
  }

  getEvents(subjectId: string): RoadmapEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE subject_id = ? ORDER BY seq').all(subjectId) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }

  /** The kind each name last wrote under, store-wide (R-11 H-714).
   *
   *  The view draws an actor's frame from their kind, and a claim's author or a
   *  ship-next decider arrives as a bare name — the payload records who decided,
   *  not what they are. This answers from the record rather than mapping a name
   *  to a kind: whatever mason last wrote as is what mason is drawn as. An event
   *  that carries its own actor is better still, and the view prefers it.
   *
   *  A name that has never written is absent, and the view renders it as plain
   *  text. One query, one map, once per render. */
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

  getClaims(projectId: string): Claim[] {
    return this.db.prepare('SELECT kind, level, size, predicted_usd, reason, author, ts FROM claims WHERE project_id = ? ORDER BY ts').all(projectId) as Claim[];
  }

  /** The latest claim of a kind is the one ranking uses; history stays. */
  latestClaim(projectId: string, kind: 'value' | 'effort'): Claim | null {
    const row = this.db
      .prepare('SELECT kind, level, size, predicted_usd, reason, author, ts FROM claims WHERE project_id = ? AND kind = ? ORDER BY ts DESC, rowid DESC LIMIT 1')
      .get(projectId, kind) as Claim | undefined;
    return row ?? null;
  }

  getCitations(projectId: string): Citation[] {
    return this.db.prepare('SELECT objective_id, claim FROM citations WHERE project_id = ? ORDER BY objective_id').all(projectId) as Citation[];
  }

  listObjectives(): Objective[] {
    return this.db.prepare('SELECT * FROM objectives ORDER BY rank, id').all() as Objective[];
  }

  listBets(): Bet[] {
    return this.db.prepare('SELECT * FROM bets ORDER BY id').all() as Bet[];
  }

  /** Blocked is computed from dependencies, never remembered. A blocker
   *  releases its hold by shipping (or being canceled). */
  blockedBy(id: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT d.to_id FROM deps d JOIN projects p ON p.id = d.to_id
           WHERE d.from_id = ? AND d.type = 'blocks' AND p.status NOT IN (${CLOSED_SQL})`,
        )
        .all(id) as { to_id: string }[]
    ).map((r) => r.to_id);
  }

  /** The current work phase — every project the human has declared go on,
   *  Planned (nothing underway yet) and Active alike. Several may hold it;
   *  the count itself is a signal the surfaces show. */
  authorizedProjects(): Project[] {
    return this.db.prepare(`SELECT * FROM projects WHERE status IN (${AUTHORIZED_SQL}) ORDER BY id`).all() as unknown as Project[];
  }

  /** Post-ship projects (Monitoring, then Completed) — off the ranked list
   *  but not out of sight: Monitoring carries loose ends someone still owes.
   *
   *  A hidden row is here too. Before R-46, `archived` was a status, so
   *  shelving a delivered initiative also took it out of the shipped family;
   *  now the two are separate facts and this read answers only the status
   *  one. A caller drawing a list applies `archived` itself — the Roadmap
   *  view does, which is why a shelved row appears in Archived and not twice. */
  shippedProjects(): Project[] {
    return this.db
      .prepare(`SELECT * FROM projects WHERE status IN (${SHIPPED_SQL}) ORDER BY status, closed_at DESC`)
      .all() as unknown as Project[];
  }

  /** The derived order (PRODUCT.md): facts the store knows set the tier —
   *  Active, Planned, shaped, blocked, raw or Paused — and judgments order
   *  within it. Rank is never set by hand, and every position carries its
   *  one-line explanation. Shipped, completed and canceled projects are not
   *  ranked: the list is the competition for what gets worked, and they are
   *  past it. */
  rankProjects(): Ranked[] {
    const rows = this.db
      .prepare(`SELECT * FROM projects WHERE status NOT IN (${CLOSED_SQL})`)
      .all() as unknown as Project[];

    const entries = rows.map((p) => {
      const blocked = this.blockedBy(p.id);
      const citations = this.getCitations(p.id);
      const value = this.latestClaim(p.id, 'value');
      const effort = this.latestClaim(p.id, 'effort');
      // Inactivity outranks blocked-ness, and reads from two facts now that
      // `parked` has split: a pause is the human's own statement of it, and a
      // raw idea is nobody's next move either. A blocker must not float
      // either one above the unblocked prerequisite it waits on (H-441).
      const reading = statusReading(p.status);
      const tier =
        reading === 'Active' ? 0 :
        reading === 'Paused' ? 4 :
        readinessOf(p) === 'raw idea' ? 4 :
        blocked.length ? 3 :
        reading === 'Planned' ? 1 : 2;
      // Project rank inherits from objective rank: the human orders a dozen
      // objectives once; the best-ranked citation carries that hand down here.
      const objRanks = citations
        .map((c) => (this.db.prepare('SELECT rank FROM objectives WHERE id = ?').get(c.objective_id) as { rank: number } | undefined)?.rank)
        .filter((r): r is number => r !== undefined);
      const bestObj = objRanks.length ? Math.min(...objRanks) : Infinity;
      const valueOrd = value?.level ? VALUE_LEVELS.indexOf(value.level) : VALUE_LEVELS.length; // unassessed sorts last in tier
      const effortOrd = effort?.size ? EFFORT_SIZES.indexOf(effort.size) : EFFORT_SIZES.length;
      return { p, blocked, citations, value, effort, tier, bestObj, valueOrd, effortOrd };
    });

    // Within a tier the actionable prerequisite comes first: a human working
    // the list top-down should never hit projects they cannot start before
    // the one they can (H-441).
    entries.sort((a, b) =>
      a.tier - b.tier ||
      Number(a.blocked.length > 0) - Number(b.blocked.length > 0) ||
      a.bestObj - b.bestObj ||
      a.valueOrd - b.valueOrd ||
      a.effortOrd - b.effortOrd ||
      a.p.created_at.localeCompare(b.p.created_at),
    );

    return entries.map((e, i) => {
      // The stored word is what the explanation says, so a row not yet
      // migrated reads in the vocabulary it was actually written with.
      const reading = statusReading(e.p.status);
      const tierWord =
        reading === 'Active' ? 'ACTIVE' :
        e.blocked.length ? `${e.p.status}, waits on ${e.blocked.join(', ')}` :
        reading === 'Planned' ? `${e.p.status}, nothing underway` :
        readinessOf(e.p) === 'shaped' ? `${e.p.status}, shaped, no blockers` : e.p.status;
      const parts = [tierWord];
      const topCite = e.citations.length
        ? e.citations.reduce((best, c) => {
            const r = (this.db.prepare('SELECT rank FROM objectives WHERE id = ?').get(c.objective_id) as { rank: number } | undefined)?.rank ?? Infinity;
            return r < best.rank ? { id: c.objective_id, rank: r } : best;
          }, { id: e.citations[0]!.objective_id, rank: Infinity })
        : null;
      if (topCite) parts.push(`advances ${topCite.id}`);
      else if (this.listObjectives().length) parts.push('advances nothing stated');
      if (e.value) parts.push(`value ${e.value.level} (${e.value.author}, ${e.value.ts.slice(5, 10)})`);
      if (e.effort) parts.push(`effort ${e.effort.size}${e.effort.predicted_usd ? ` ~$${e.effort.predicted_usd}` : ''}`);
      return {
        project: e.p,
        rank: i + 1,
        explanation: `${ordinal(i + 1)} — ${parts.join(', ')}`,
        blocked_by: e.blocked,
        citations: e.citations,
        value: e.value,
        effort: e.effort,
      };
    });
  }

  // ---------- writes (every write = append event + materialize, atomically) ----------

  createProject(actor: Actor, input: CreateInput): Project {
    validateActor(actor);
    if (!input.title?.trim()) throw new RoadmapError('title is required — it is the only thing that is. A sentence of body helps the first sweep assess fit.');
    rejectSwallowedMarkup({ title: input.title, body: input.body });
    return this.db.transaction(() => {
      const id = this.mintId('R');
      const ts = now();
      const payload: Record<string, unknown> = { id, title: input.title, body: input.body ?? '', status: input.status ?? 'Proposed' };
      this.append(ts, id, 'created', actor, payload);
      this.applyCreated(ts, payload);
      return this.getProject(id);
    }).immediate();
  }

  updateProject(actor: Actor, input: UpdateInput): UpdateResult {
    validateActor(actor);
    if (!input.note?.trim()) {
      throw new RoadmapError('note is required on every update: one or two lines, human terms, saying what changed and why. Notes are the story the human reads.');
    }
    if (input.if_revision !== undefined && !(Number.isInteger(input.if_revision) && input.if_revision >= 1)) {
      throw new RoadmapError(
        `if_revision must be the revision number a read gave you — an integer of 1 or more; got ${JSON.stringify(input.if_revision)}. Omit it entirely if this write does not depend on what the project currently says.`,
      );
    }
    rejectSwallowedMarkup({ note: input.note, title: input.title, body: input.body, parked_reason: input.parked_reason, unpark_condition: input.unpark_condition });
    const p = this.getProject(input.project_id);
    const warnings: string[] = [];
    const diffs: Record<string, { from: unknown; to: unknown }> = {};

    const was = statusReading(p.status);
    // Terminal takes no new judgments. Hiding is the one exception: `archived`
    // says whether a surface draws the row, not what became of it, and the
    // migration has to be able to shelve a record it just canceled.
    if (TERMINAL.includes(was) && !this.hidingOnly(p, input)) {
      throw new RoadmapError(`${p.id} is ${p.status} — terminal. The record is permanent; a revived idea is a new project with a 'relates' link. Only 'archived' (hide the row) may still be set.`);
    }

    if (input.status && input.status !== p.status) {
      if (input.status === ('Planned' as string)) {
        throw new RoadmapError('Planned is entered only through the human\'s recorded go-ahead — roadmap_set_ship_next, never a plain status write.');
      }
      // Nothing ships that the human never declared go on. Active is reachable
      // only from a recorded go (or a pause of one), and the shipped family
      // only from Active or from within itself — so no row reaches Monitoring
      // without passing the gate. Pre-R-46 words come through the same doors:
      // `ship_next` and `shipping` read as Active, `shipped*` as the family.
      // The installation's leader (H-2073) directs the roadmap and passes these
      // two gates as the human does.
      if (actor.kind !== 'human' && !this.isLeader(actor)) {
        if (input.status === 'Active' && !AUTHORIZED.includes(was) && was !== 'Paused') {
          throw new RoadmapError(
            `${p.id} is ${p.status} — work starts on a project the human has declared go on. Record the go first (roadmap_set_ship_next), then move it to Active.`,
          );
        }
        if (SHIPPED.includes(input.status) && was !== 'Active' && !SHIPPED.includes(was)) {
          throw new RoadmapError(
            `${p.id} is ${p.status} — only an Active project can move to ${input.status}. Shipping starts with the human's go-ahead (roadmap_set_ship_next); work the list, don't skip the gate.`,
          );
        }
      }
      if (input.status === 'Paused' && !input.unpark_condition && !p.unpark_condition) {
        warnings.push('Paused with no unpark_condition — a paused project should record what would resume it, or the pause rots silently instead of being retested.');
      }
      diffs['status'] = { from: p.status, to: input.status };
    }

    if (input.archived !== undefined && input.archived !== (p.archived === 1)) {
      // The flag hides a finished record; it is not a way to retire a live one.
      const to = statusReading((input.status as StoredStatus | undefined) ?? p.status);
      if (input.archived && to !== 'Completed' && to !== 'Canceled') {
        throw new RoadmapError(
          `${p.id} reads ${to} — only a Completed or Canceled project can be archived. Archiving is hiding a finished record, not a status: say what became of it first.`,
        );
      }
      diffs['archived'] = { from: p.archived, to: input.archived ? 1 : 0 };
    }

    for (const field of ['title', 'body', 'parked_reason', 'unpark_condition'] as const) {
      const v = input[field];
      if (v !== undefined && v !== (p as unknown as Record<string, unknown>)[field]) {
        diffs[field] = { from: (p as unknown as Record<string, unknown>)[field], to: v };
      }
    }

    // A recorded verdict governs exactly the state it reviewed. Any later
    // project write starts a new round; keeping shaped readiness would leave
    // a stale judgment projected as current. The legacy status projection is
    // also reset while old callers still write it directly.
    if (this.readinessReview(p.id)) {
      // A row still stored as `ready` carries its verdict in the status word;
      // reset that projection too, unless this write sets the status itself.
      if (p.status === 'ready' && diffs['status'] === undefined) diffs['status'] = { from: 'ready', to: 'shaping' };
      diffs['readiness'] = { from: p.readiness, to: 'raw idea' };
    }

    return this.db.transaction(() => {
      // The read above, every rule checked against it, and the diffs computed
      // from it all happened BEFORE the write lock was taken. So the
      // precondition is compared here and nowhere else: checked outside, it is
      // checked at the moment it cannot hold.
      if (input.if_revision !== undefined) this.assertRevision(p.id, input.if_revision);
      const ts = now();
      const payload: Record<string, unknown> = { diffs, note: input.note };
      this.append(ts, p.id, 'updated', actor, payload);
      this.applyUpdated(ts, p.id, payload);
      return { project: this.getProject(p.id), revision: this.revisionOf(p.id), warnings };
    }).immediate();
  }

  recordReadinessVerdict(
    actor: Actor,
    input: { project_id: string; reviewed_revision: number; verdict: 'pass' | 'fail'; note: string },
  ): { project: Project; readiness: ReadinessReview } {
    validateActor(actor);
    if (!input.note?.trim()) throw new RoadmapError('note is required: say what made the project ready or what remains unresolved.');
    if (!(Number.isInteger(input.reviewed_revision) && input.reviewed_revision >= 1)) {
      throw new RoadmapError('reviewed_revision must be the readiness revision returned by roadmap_get_project.');
    }
    rejectSwallowedMarkup({ note: input.note });
    const p = this.getProject(input.project_id);
    const was = statusReading(p.status);
    if (was !== 'Proposed' && was !== 'Paused') {
      throw new RoadmapError(`${p.id} is ${p.status} — readiness is judged before the human declares work, not after it ships.`);
    }
    if (actor.kind === 'agent' && !this.isLeader(actor) && this.lastShaper(p.id) === actor.name) {
      throw new RoadmapError(`${p.id} was last shaped by you — its readiness verdict needs a reviewer other than the description's shaper.`);
    }
    return this.db.transaction(() => {
      const current = this.readinessRevision(p.id);
      if (current !== input.reviewed_revision) {
        throw new RoadmapError(`${p.id} changed after the reviewed snapshot: revision ${input.reviewed_revision} is stale; the current readiness revision is ${current}. Nothing was written.`);
      }
      const ts = now();
      this.append(ts, p.id, 'readiness_verdict_recorded', actor, {
        verdict: input.verdict, note: input.note, reviewed_revision: input.reviewed_revision,
      });
      const readiness = this.readinessReview(p.id)!;
      this.applyReadinessVerdict(ts, p.id, readiness.state === 'ready' ? 'shaped' : 'raw idea');
      return { project: this.getProject(p.id), readiness };
    }).immediate();
  }

  recordHealth(
    actor: Actor,
    input: { project_id: string; health: Health | null; reason: string },
  ): Project {
    validateActor(actor);
    const p = this.getProject(input.project_id);
    if (!input.reason?.trim()) throw new RoadmapError('reason is required: health is a judgment, never an unexplained badge.');
    rejectSwallowedMarkup({ reason: input.reason });
    return this.db.transaction(() => {
      const ts = now();
      this.append(ts, p.id, 'health_recorded', actor, {
        health: input.health, reason: input.reason,
      });
      this.applyHealth(ts, p.id, input.health, input.reason);
      return this.getProject(p.id);
    }).immediate();
  }

  /** True when the only thing an update changes about a terminal project is
   *  whether the surfaces draw it. A note is still required: hiding a record
   *  is a decision someone has to be able to read later. */
  private hidingOnly(p: Project, input: UpdateInput): boolean {
    if (input.archived === undefined || input.archived === (p.archived === 1)) return false;
    const touches = (['status', 'title', 'body', 'parked_reason', 'unpark_condition'] as const)
      .some((f) => input[f] !== undefined && input[f] !== (p as unknown as Record<string, unknown>)[f]);
    return !touches;
  }

  /** Refuse a write whose project moved after the caller read it.
   *
   *  Every rule in `updateProject` is a rule about STATE — a terminal project
   *  takes no writes, only a ship_next project ships, the description's shaper
   *  cannot judge it ready — and each is decided against a read that finished
   *  before the write began. Without this, two writers interleave and the
   *  second one's rules were checked against a project that no longer exists:
   *  the classic case is one seat declaring 'ready' while another rewrites the
   *  body, leaving a readiness judgment standing on text nobody reviewed.
   *
   *  The caller cannot close that window from outside, because there is no
   *  outside: a proxy or a client that reads, decides, and then writes has the
   *  same race, and compensating afterwards with a second write is one more
   *  unchecked write, not atomicity. So the precondition belongs in the same
   *  transaction as the write, which is here. */
  private assertRevision(id: string, expected: number): void {
    const current = this.revisionOf(id);
    if (current === expected) return;
    const moved = this.db
      .prepare(
        `SELECT event_type, json_extract(actor, '$.name') AS name FROM events
         WHERE subject_id = ? AND seq > ? ORDER BY seq`,
      )
      .all(id, expected) as { event_type: string; name: string | null }[];
    const what = moved.length
      ? `Since then: ${moved.map((e) => `${e.event_type} by ${e.name ?? 'an unrecorded actor'}`).join(', ')}.`
      : `Revision ${expected} is not one ${id} has ever been at — check that you read it from this project.`;
    throw new RoadmapError(
      `${id} has moved since you read it: you decided against revision ${expected}, it is now at ${current}. ${what} Nothing was written. Re-read the project, decide again against what it says now, and re-send with the revision you got — the state you judged is not the state you would have written over.`,
    );
  }

  /** The actor who last wrote this project's description — the shaper the
   *  ready gate must exclude. A retitle does not reshape the project. */
  private lastShaper(id: string): string | null {
    const row = this.db
      .prepare(
        `SELECT json_extract(actor, '$.name') AS name FROM events
         WHERE subject_id = ? AND (event_type = 'created'
           OR (event_type = 'updated' AND json_extract(payload, '$.diffs.body') IS NOT NULL))
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(id) as { name: string | null } | undefined;
    return row?.name ?? null;
  }

  recordClaim(
    actor: Actor,
    input: { project_id: string; kind: 'value' | 'effort'; level?: string; size?: string; predicted_usd?: number; reason: string },
  ): Claim {
    validateActor(actor);
    const p = this.getProject(input.project_id);
    if (TERMINAL.includes(statusReading(p.status))) throw new RoadmapError(`${p.id} is ${p.status} — terminal projects take no new judgments.`);
    if (!input.reason?.trim()) {
      throw new RoadmapError('reason is required — a judgment without its one-line why is a naked number, and naked numbers decay into decoration.');
    }
    if (input.kind === 'value' && !VALUE_LEVELS.includes(input.level as never)) {
      throw new RoadmapError(`value claims need level: ${VALUE_LEVELS.join('|')}.`);
    }
    if (input.kind === 'effort' && !EFFORT_SIZES.includes(input.size as never)) {
      throw new RoadmapError(`effort claims need size: ${EFFORT_SIZES.join('|')} (predicted_usd optional but is what makes the estimate falsifiable against the metered actual).`);
    }
    rejectSwallowedMarkup({ reason: input.reason });
    return this.db.transaction(() => {
      const ts = now();
      const payload: Record<string, unknown> = { kind: input.kind, reason: input.reason };
      if (input.kind === 'value') payload['level'] = input.level;
      if (input.kind === 'effort') { payload['size'] = input.size; if (input.predicted_usd !== undefined) payload['predicted_usd'] = input.predicted_usd; }
      this.append(ts, p.id, 'claim_recorded', actor, payload);
      this.applyClaim(ts, p.id, actor, payload);
      return this.latestClaim(p.id, input.kind)!;
    }).immediate();
  }

  cite(actor: Actor, input: { project_id: string; objective_id: string; claim?: string; action?: 'add' | 'remove' }): Citation[] {
    validateActor(actor);
    const p = this.getProject(input.project_id);
    const action = input.action ?? 'add';
    if (action === 'add') {
      if (!this.db.prepare('SELECT 1 FROM objectives WHERE id = ?').get(input.objective_id)) {
        throw new RoadmapError(`Objective "${input.objective_id}" is not in the charter projection. Objectives: ${this.listObjectives().map((o) => o.id).join(', ') || '(none derived yet)'}.`);
      }
      if (!input.claim?.trim()) {
        throw new RoadmapError('claim is required: one line on HOW this project advances the objective — that is what makes the citation checkable and lets the human disagree with the mapping instead of a number.');
      }
    }
    rejectSwallowedMarkup({ claim: input.claim });
    this.db.transaction(() => {
      const ts = now();
      if (action === 'add') {
        this.append(ts, p.id, 'cited', actor, { objective_id: input.objective_id, claim: input.claim });
        this.applyCited(ts, p.id, { objective_id: input.objective_id, claim: input.claim }, true);
      } else {
        this.append(ts, p.id, 'uncited', actor, { objective_id: input.objective_id });
        this.applyCited(ts, p.id, { objective_id: input.objective_id }, false);
      }
    }).immediate();
    return this.getCitations(p.id);
  }

  link(actor: Actor, fromId: string, toId: string, type: DepType, action: 'add' | 'remove'): void {
    validateActor(actor);
    this.getProject(fromId);
    this.getProject(toId);
    if (fromId === toId) throw new RoadmapError('A project cannot link to itself.');
    this.db.transaction(() => {
      const ts = now();
      if (action === 'add') {
        this.checkNoBlocksCycle(fromId, toId, type);
        this.append(ts, fromId, 'linked', actor, { to: toId, type });
        this.applyLinked(ts, fromId, toId, type, true);
      } else {
        this.append(ts, fromId, 'unlinked', actor, { to: toId, type });
        this.applyLinked(ts, fromId, toId, type, false);
      }
    }).immediate();
  }

  /** Entry to the work phase, and it is the human's decision — an agent only
   *  records it, with attribution, the way Helmo's answer route works.
   *  Several projects may hold ship_next at once, but with resistance: the
   *  returned count is the signal, and a growing set is a problem. */
  setShipNext(actor: Actor, input: { project_id: string; decided_by: string; reason: string }): { project: Project; ship_next_count: number } {
    validateActor(actor);
    const p = this.getProject(input.project_id);
    if (!input.decided_by?.trim()) throw new RoadmapError('decided_by is required: the human who made the call. Entering the work phase is never an agent\'s own judgment.');
    if (!input.reason?.trim()) throw new RoadmapError('reason is required: the human\'s one-line why, so the fleet reads a decision, not a flag.');
    // A go needs a shaped description: enough is known for an informed
    // commitment. 'shipping' is the pre-v2 name for the work phase, and those
    // rows re-enter through this same human-gated door during migration
    // (H-672); 'ready' and 'shaping' are the pre-R-46 words for shaped.
    const was = statusReading(p.status);
    if ((p.status as string) !== 'shipping' && !(was === 'Proposed' && readinessOf(p) === 'shaped')) {
      throw new RoadmapError(
        `${p.id} is ${p.status}, readiness ${readinessOf(p)} — only a shaped project can be declared Planned. Shaped means an independent reviewer judged that enough is known for the human to make an informed commitment (roadmap_record_readiness_verdict).`,
      );
    }
    rejectSwallowedMarkup({ reason: input.reason });
    return this.db.transaction(() => {
      const ts = now();
      // The status rides in the payload so replay stays faithful on both
      // sides of the rename: a pre-R-46 event has no `status` and still
      // materializes `ship_next`, exactly as it did when it was written.
      const payload: Record<string, unknown> = { decided_by: input.decided_by, reason: input.reason, status: 'Planned' };
      this.append(ts, p.id, 'ship_next_set', actor, payload);
      this.applyShipNext(ts, p.id, payload);
      return { project: this.getProject(p.id), ship_next_count: this.authorizedProjects().length };
    }).immediate();
  }

  /** Progress and cost are read back from Helmo's metered tickets by the
   *  sweep, never self-reported — this records that rollup. Absolute, not a
   *  delta: the rollup is recomputed each sweep. */
  recordActual(actor: Actor, input: { project_id: string; actual_usd: number; note: string }): Project {
    validateActor(actor);
    const p = this.getProject(input.project_id);
    if (!(input.actual_usd >= 0)) throw new RoadmapError('actual_usd must be a non-negative number — it is the metered total to date.');
    if (!input.note?.trim()) throw new RoadmapError('note is required: say where the rollup came from (e.g. which Helmo project tag, how many tickets).');
    rejectSwallowedMarkup({ note: input.note });
    return this.db.transaction(() => {
      const ts = now();
      const payload = { actual_usd: input.actual_usd, note: input.note };
      this.append(ts, p.id, 'actual_recorded', actor, payload);
      this.applyActual(p.id, payload);
      return this.getProject(p.id);
    }).immediate();
  }

  /** Upsert one charter projection item. The charter itself lives wherever
   *  its author keeps it; this records the derived projection, with `source`
   *  pointing home so drift is visible rather than silent. */
  setCharterItem(
    actor: Actor,
    input: {
      shape: 'objective' | 'bet';
      id?: string;
      statement: string;
      source: string;
      horizon?: Horizon; // objectives
      rank?: number; // objectives
      stake?: string; // bets
      falsifier?: string; // bets
    },
  ): Objective | Bet {
    validateActor(actor);
    if (!input.statement?.trim()) throw new RoadmapError('statement is required: the short quotable line a citation will point at.');
    if (!input.source?.trim()) throw new RoadmapError('source is required: the pointer back to the authoritative document this was derived from.');
    if (input.shape === 'objective') {
      if (!input.horizon) throw new RoadmapError('objectives need horizon: near|long|standing.');
      if (!(typeof input.rank === 'number' && input.rank >= 1)) {
        throw new RoadmapError('objectives need rank (1 = top): the human\'s ordering of the few durable things is what project rank inherits from.');
      }
    } else if (!input.stake?.trim() || !input.falsifier?.trim()) {
      throw new RoadmapError('bets need stake (what rides on this being true) and falsifier (what would show it false).');
    }
    rejectSwallowedMarkup({ statement: input.statement, stake: input.stake, falsifier: input.falsifier });
    return this.db.transaction(() => {
      const ts = now();
      const id = input.id ?? this.mintId(input.shape === 'objective' ? 'OBJ' : 'BET');
      if (input.id && input.shape === 'objective' && !input.id.startsWith('OBJ-')) throw new RoadmapError(`"${input.id}" is not an objective id (OBJ-n).`);
      if (input.id && input.shape === 'bet' && !input.id.startsWith('BET-')) throw new RoadmapError(`"${input.id}" is not a bet id (BET-n).`);
      const payload: Record<string, unknown> =
        input.shape === 'objective'
          ? { id, statement: input.statement, horizon: input.horizon, rank: input.rank, source: input.source }
          : { id, statement: input.statement, stake: input.stake, falsifier: input.falsifier, source: input.source };
      this.append(ts, id, input.shape === 'objective' ? 'objective_set' : 'bet_set', actor, payload);
      this.applyCharterItem(ts, input.shape, payload);
      const table = input.shape === 'objective' ? 'objectives' : 'bets';
      return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Objective | Bet;
    }).immediate();
  }

  // ---------- the R-46 vocabulary migration (one-shot) ----------

  /** Rewrite every stored status word to the reading it always had, once per
   *  store. See migrate-lib.ts for the per-row rules; this is the writer.
   *
   *  It appends its own `updated` events rather than going through
   *  `updateProject`, deliberately and for every row, not just the awkward
   *  ones. That path exists to check new DECISIONS: it refuses a terminal
   *  source (so a shelved row could not be mapped at all), it
   *  refuses a plain write to Planned, it gates Active behind a recorded go,
   *  and it resets a standing readiness verdict on any write — which would
   *  undo the very field this migration is here to fill. None of those rules
   *  is wrong; none of them is about a rename. So the gates stay exactly as
   *  they are for live callers, the migration writes the word and the reason
   *  in one event, and `rebuild()` replays it like any other update.
   *
   *  Without `apply` nothing is written and the plan is the report. */
  migrateR46(actor: Actor, input: { apply: boolean; shelved?: R46Judgments }): R46Plan {
    if (input.apply) validateActor(actor);
    const facts = this.r46Facts();
    const plan = planR46(facts, input.shelved);
    if (!input.apply || !plan.decisions.length) return plan;
    const before = new Map(facts.map((f) => [f.id, f]));
    return this.db.transaction(() => {
      for (const d of plan.decisions) {
        const was = before.get(d.id)!;
        const diffs: Record<string, { from: unknown; to: unknown }> = { status: { from: d.from, to: d.status } };
        if (d.readiness && d.readiness !== was.readiness) diffs['readiness'] = { from: was.readiness, to: d.readiness };
        if (d.archive && !was.archived) diffs['archived'] = { from: 0, to: 1 };
        const readiness = diffs['readiness'] ? `, readiness ${d.readiness}` : '';
        const hidden = diffs['archived'] ? ', and hidden from the surfaces' : '';
        const payload: Record<string, unknown> = {
          diffs,
          note:
            `R-46 vocabulary: ${d.from} → ${d.status}${readiness}${hidden}. ${d.reason}. ` +
            'The stored word was renamed to the reading it always had; no judgment was re-made and no event was rewritten.',
        };
        const ts = now();
        this.append(ts, d.id, 'updated', actor, payload);
        this.applyUpdated(ts, d.id, payload);
      }
      return { ...plan, applied: true };
    }).immediate();
  }

  /** Every row as the migration planner needs to read it. */
  private r46Facts(): R46Facts[] {
    const authorized = this.everAuthorized();
    const rows = this.db
      .prepare('SELECT id, title, status, readiness, archived FROM projects ORDER BY CAST(substr(id, 3) AS INTEGER)')
      .all() as { id: string; title: string; status: StoredStatus; readiness: Readiness; archived: number }[];
    return rows.map((r) => ({
      id: r.id, title: r.title, status: r.status, readiness: r.readiness,
      archived: r.archived === 1, ever_authorized: authorized.has(r.id),
    }));
  }

  /** The projects whose history holds the human's go — a `ship_next_set`, or
   *  a status move into or out of the authorized family. It is the fact that
   *  separates a never-started idea from a stood-down delivery, which the
   *  single `parked` word could not. Old and new words both count: the
   *  events carry whichever vocabulary was current when they were written. */
  private everAuthorized(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT subject_id, event_type,
                json_extract(payload, '$.diffs.status.from') AS from_status,
                json_extract(payload, '$.diffs.status.to')   AS to_status
           FROM events WHERE event_type IN ('ship_next_set', 'updated')`,
      )
      .all() as { subject_id: string; event_type: string; from_status: string | null; to_status: string | null }[];
    const authorized = new Set<string>();
    for (const row of rows) {
      if (row.event_type === 'ship_next_set') {
        authorized.add(row.subject_id);
        continue;
      }
      for (const value of [row.from_status, row.to_status]) {
        if (value && AUTHORIZED.includes(statusReading(value))) authorized.add(row.subject_id);
      }
    }
    return authorized;
  }

  // ---------- rebuild (the invariant) ----------

  /** Reconstruct all materialized state purely from the event log. Tests
   *  enforce that this always reproduces what the writes built. */
  rebuild(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM projects; DELETE FROM deps; DELETE FROM claims; DELETE FROM citations; DELETE FROM objectives; DELETE FROM bets;');
      const rows = this.db.prepare('SELECT * FROM events ORDER BY seq').all() as Record<string, unknown>[];
      for (const row of rows) {
        const ev = rowToEvent(row);
        switch (ev.event_type) {
          case 'created': this.applyCreated(ev.ts, ev.payload); break;
          case 'updated': this.applyUpdated(ev.ts, ev.subject_id, ev.payload); break;
          case 'claim_recorded': this.applyClaim(ev.ts, ev.subject_id, ev.actor, ev.payload); break;
          case 'cited': this.applyCited(ev.ts, ev.subject_id, ev.payload, true); break;
          case 'uncited': this.applyCited(ev.ts, ev.subject_id, ev.payload, false); break;
          case 'linked': this.applyLinked(ev.ts, ev.subject_id, ev.payload['to'] as string, ev.payload['type'] as DepType, true); break;
          case 'unlinked': this.applyLinked(ev.ts, ev.subject_id, ev.payload['to'] as string, ev.payload['type'] as DepType, false); break;
          case 'ship_next_set': this.applyShipNext(ev.ts, ev.subject_id, ev.payload); break;
          case 'health_recorded': this.applyHealth(ev.ts, ev.subject_id, ev.payload['health'] as Health | null, ev.payload['reason'] as string); break;
          case 'actual_recorded': this.applyActual(ev.subject_id, ev.payload); break;
          case 'objective_set': this.applyCharterItem(ev.ts, 'objective', ev.payload); break;
          case 'bet_set': this.applyCharterItem(ev.ts, 'bet', ev.payload); break;
          case 'readiness_verdict_recorded': {
            const readiness = this.readinessReview(ev.subject_id, ev.seq);
            if (readiness) this.applyReadinessVerdict(ev.ts, ev.subject_id, readiness.state === 'ready' ? 'shaped' : 'raw idea');
            break;
          }
        }
      }
    }).immediate();
  }

  dumpState(): Record<string, unknown[]> {
    const all = (t: string) => this.db.prepare(`SELECT * FROM ${t}`).all() as unknown[];
    return {
      projects: all('projects ORDER BY id'),
      deps: all('deps ORDER BY from_id, to_id, type'),
      claims: all('claims ORDER BY project_id, ts, rowid'),
      citations: all('citations ORDER BY project_id, objective_id'),
      objectives: all('objectives ORDER BY id'),
      bets: all('bets ORDER BY id'),
    };
  }

  // ---------- internals ----------

  private mintId(prefix: string): string {
    const key = `next_${prefix}`;
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    const n = row ? parseInt(row.value, 10) : 1;
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(n + 1));
    return `${prefix}-${n}`;
  }

  private append(ts: string, subjectId: string, type: string, actor: Actor, payload: Record<string, unknown>): void {
    this.assertInstallationForWrite();
    this.db
      .prepare('INSERT INTO events (ts, subject_id, event_type, actor, payload) VALUES (?, ?, ?, ?, ?)')
      .run(ts, subjectId, type, JSON.stringify(actor), JSON.stringify(payload));
  }

  private assertInstallationForWrite(): void {
    if (!this.installation) return;
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'installation_name'").get() as { value: string } | undefined;
    if (row && !namesInstallation(this.installation, row.value)) {
      throw new RoadmapError(
        `Installation target UNCLEAR: process names '${this.installation.label}', but this store belongs to '${row.value}'. Nothing was written. Point ROADMAP_HOME or ROADMAP_DB at the intended installation.`,
      );
    }
    if (!row && this.installation.source !== 'derived') {
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('installation_name', ?)").run(this.installation.label);
    }
  }

  private applyCreated(ts: string, p: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO projects (id, title, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      // The fallback is replay fidelity, not a default: a created event with
      // no status is pre-R-46 and materialized 'parked' when it was written.
      .run(p['id'], p['title'], p['body'] ?? '', p['status'] ?? 'parked', ts, ts);
  }

  private applyUpdated(ts: string, id: string, payload: Record<string, unknown>): void {
    const diffs = (payload['diffs'] ?? {}) as Record<string, { from: unknown; to: unknown }>;
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [ts];
    for (const [field, d] of Object.entries(diffs)) {
      if (!['title', 'body', 'status', 'readiness', 'archived', 'parked_reason', 'unpark_condition'].includes(field)) continue;
      sets.push(`${field} = ?`);
      params.push(d.to as never);
    }
    // closed_at marks leaving the active pipeline: set on first entry into
    // the shipped/terminal family (legacy 'shipped'/'abandoned' included),
    // kept on moves within it.
    const status = diffs['status']?.to as string | undefined;
    const from = diffs['status']?.from as string | undefined;
    const closed = (v: string | undefined) => v !== undefined && [...SHIPPED, ...TERMINAL].includes(statusReading(v));
    if (closed(status) && !closed(from)) {
      sets.push('closed_at = ?');
      params.push(ts);
    }
    params.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  private applyReadinessVerdict(ts: string, id: string, readiness: 'raw idea' | 'shaped'): void {
    this.db.prepare('UPDATE projects SET readiness = ?, updated_at = ? WHERE id = ?').run(readiness, ts, id);
  }

  private applyHealth(ts: string, id: string, health: Health | null, reason: string): void {
    this.db.prepare('UPDATE projects SET health = ?, health_reason = ?, updated_at = ? WHERE id = ?')
      .run(health, reason, ts, id);
  }

  private applyClaim(ts: string, id: string, actor: Actor, p: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO claims (project_id, kind, level, size, predicted_usd, reason, author, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p['kind'], p['level'] ?? null, p['size'] ?? null, p['predicted_usd'] ?? null, p['reason'], actor.name, ts);
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(ts, id);
  }

  // Both bump updated_at HERE, not in the calling write method: what an
  // apply function skips, rebuild() skips too, and the invariant breaks on
  // exactly that skipped field (caught live during the H-672 migration).
  private applyCited(ts: string, id: string, p: Record<string, unknown>, add: boolean): void {
    if (add) {
      this.db
        .prepare('INSERT INTO citations (project_id, objective_id, claim) VALUES (?, ?, ?) ON CONFLICT(project_id, objective_id) DO UPDATE SET claim = excluded.claim')
        .run(id, p['objective_id'], p['claim']);
    } else {
      this.db.prepare('DELETE FROM citations WHERE project_id = ? AND objective_id = ?').run(id, p['objective_id']);
    }
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(ts, id);
  }

  private applyLinked(ts: string, fromId: string, toId: string, type: DepType, add: boolean): void {
    if (add) {
      this.db.prepare('INSERT OR IGNORE INTO deps (from_id, to_id, type) VALUES (?, ?, ?)').run(fromId, toId, type);
    } else {
      this.db.prepare('DELETE FROM deps WHERE from_id = ? AND to_id = ? AND type = ?').run(fromId, toId, type);
    }
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(ts, fromId);
  }

  private applyShipNext(ts: string, id: string, payload: Record<string, unknown>): void {
    // 'demoted' only appears in pre-v2 events, from when exactly one project
    // could hold ship_next; replaying them must reproduce the old effect.
    const demoted = payload['demoted'] as string | null | undefined;
    if (demoted) this.db.prepare("UPDATE projects SET status = 'ready', updated_at = ? WHERE id = ?").run(ts, demoted);
    // Pre-R-46 events carry no status: they moved the project to `ship_next`,
    // and replaying them must still say exactly that.
    const status = (payload['status'] as string | undefined) ?? 'ship_next';
    this.db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id);
  }

  private applyActual(id: string, payload: Record<string, unknown>): void {
    this.db.prepare('UPDATE projects SET actual_usd = ? WHERE id = ?').run(payload['actual_usd'], id);
  }

  private applyCharterItem(ts: string, shape: 'objective' | 'bet', p: Record<string, unknown>): void {
    if (shape === 'objective') {
      this.db
        .prepare(
          `INSERT INTO objectives (id, statement, horizon, rank, source, derived_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET statement = excluded.statement, horizon = excluded.horizon,
             rank = excluded.rank, source = excluded.source, derived_at = excluded.derived_at`,
        )
        .run(p['id'], p['statement'], p['horizon'], p['rank'], p['source'], ts);
    } else {
      this.db
        .prepare(
          `INSERT INTO bets (id, statement, stake, falsifier, source, derived_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET statement = excluded.statement, stake = excluded.stake,
             falsifier = excluded.falsifier, source = excluded.source, derived_at = excluded.derived_at`,
        )
        .run(p['id'], p['statement'], p['stake'], p['falsifier'], p['source'], ts);
    }
  }

  private checkNoBlocksCycle(fromId: string, toId: string, type: DepType): void {
    if (type !== 'blocks') return;
    const seen = new Set<string>();
    const stack = [toId];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === fromId) {
        throw new RoadmapError(`Adding blocks ${fromId} -> ${toId} would create a cycle: these projects would wait on each other forever.`);
      }
      if (seen.has(cur)) continue;
      seen.add(cur);
      const next = this.db.prepare("SELECT to_id FROM deps WHERE from_id = ? AND type = 'blocks'").all(cur) as { to_id: string }[];
      for (const n of next) stack.push(n.to_id);
    }
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'] as const;
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? 'th'}`;
}

function rowToEvent(row: Record<string, unknown>): RoadmapEvent {
  return {
    ...(row as unknown as RoadmapEvent),
    actor: JSON.parse(row['actor'] as string),
    payload: JSON.parse(row['payload'] as string),
  };
}
