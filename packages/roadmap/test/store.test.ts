import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { formatR46Plan } from '../src/migrate-lib.js';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

const mason: Actor = { name: 'mason', kind: 'agent', model: 'claude-fable-5', version: 'test' };
const bosun: Actor = { name: 'bosun', kind: 'agent', model: 'claude-fable-5', version: 'test' };
const arthur: Actor = { name: 'arthur', kind: 'human' };

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roadmap-'));
  store = new Store(join(dir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('projects', () => {
  it('adds the R-46 reading columns when an existing store is opened', () => {
    store.close();
    const legacyPath = join(dir, 'legacy.db');
    const legacy = new Database(legacyPath);
    legacy.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'parked', parked_reason TEXT,
      unpark_condition TEXT, actual_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
    )`);
    legacy.close();

    store = new Store(legacyPath);
    const check = new Database(legacyPath, { readonly: true });
    const names = (check.pragma('table_info(projects)') as { name: string }[]).map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining(['readiness', 'health', 'health_reason', 'archived']));
    check.close();
  });
  it('an idea costs a title and nothing else', () => {
    const p = store.createProject(mason, { title: 'Run a hackathon at the co-working space' });
    expect(p.id).toBe('R-1');
    expect(p.status).toBe('Proposed');
    expect(p.readiness).toBe('raw idea');
    expect(p.body).toBe('');
  });

  it('rejects an agent actor without model/version', () => {
    expect(() => store.createProject({ name: 'x', kind: 'agent' }, { title: 't' })).toThrow(/model/);
  });

  it('updates require a note and canceled projects are permanent', () => {
    const p = store.createProject(mason, { title: 'T' });
    expect(() => store.updateProject(mason, { project_id: p.id, note: '', title: 'T2' })).toThrow(/note/);
    store.updateProject(bosun, { project_id: p.id, note: 'ran its course', status: 'Canceled' });
    expect(() => store.updateProject(mason, { project_id: p.id, note: 'reopen', status: 'Proposed' })).toThrow(/terminal/);
  });

  it('archiving hides a finished record, and is the one write a canceled one still takes', () => {
    const live = store.createProject(mason, { title: 'live' });
    expect(() => store.updateProject(mason, { project_id: live.id, note: 'tidy the list', archived: true }))
      .toThrow(/only a Completed or Canceled project can be archived/);

    store.updateProject(bosun, { project_id: live.id, note: 'superseded by R-47', status: 'Canceled' });
    const { project } = store.updateProject(bosun, { project_id: live.id, note: 'off the surfaces', archived: true });
    expect(project.archived).toBe(1);
    expect(project.status).toBe('Canceled');
    // Hiding is a display fact; the judgment behind it stays refused.
    expect(() => store.updateProject(bosun, { project_id: live.id, note: 'and reword it', archived: false, title: 'new' })).toThrow(/terminal/);
    expect(store.updateProject(bosun, { project_id: live.id, note: 'back on the surfaces', archived: false }).project.archived).toBe(0);
  });

  it('pausing without an exit warns', () => {
    const p = store.createProject(mason, { title: 'T' });
    const { warnings } = store.updateProject(mason, { project_id: p.id, note: 'not now', status: 'Paused' });
    expect(warnings.some((w) => w.includes('unpark_condition'))).toBe(true);
  });
});

describe('the readiness gate', () => {
  const judge = (actor: Actor, id: string, note: string) =>
    store.recordReadinessVerdict(actor, { project_id: id, reviewed_revision: store.readinessRevision(id), verdict: 'pass', note });

  it('the description shaper cannot make their own commitment-readiness judgment', () => {
    const p = store.createProject(mason, { title: 'T', body: 'the full plan' });
    expect(() => judge(mason, p.id, 'done shaping')).toThrow(/other than the description's shaper|shaped by you/);
    const { project } = judge(bosun, p.id, 'enough is known to decide whether to commit');
    expect(project.readiness).toBe('shaped');
    expect(project.status).toBe('Proposed'); // readiness is a field, never the status
  });

  it('retitling is not shaping the description', () => {
    const p = store.createProject(mason, { title: 'Working title', body: 'first sketch' });
    store.updateProject(bosun, { project_id: p.id, note: 'shaped the proposition', body: 'enough evidence and scope to decide whether to commit' });
    store.updateProject(mason, { project_id: p.id, note: 'settled the name', title: 'Final title' });

    expect(judge(mason, p.id, 'independently judged ready to commit').project.readiness).toBe('shaped');
  });

  it('a reshape by the reviewer themselves is still their own work', () => {
    const p = store.createProject(mason, { title: 'T', body: 'first sketch' });
    store.updateProject(bosun, { project_id: p.id, note: 'expanded it', body: 'a newly complete description' });
    expect(() => judge(bosun, p.id, 'and it reads ready to me')).toThrow(/shaped by you|description's shaper/);
    expect(store.getProject(p.id).readiness).toBe('raw idea');
  });

  it('the human is never gated', () => {
    const p = store.createProject(mason, { title: 'T', body: 'plan' });
    store.updateProject(arthur, { project_id: p.id, note: 'rewrote it myself', body: 'the plan, in my words' });
    expect(judge(arthur, p.id, 'good enough').project.readiness).toBe('shaped');
  });
});

describe('readiness verdicts', () => {
  it('preserves every reviewer verdict and the strictest verdict governs', () => {
    const p = store.createProject(mason, { title: 'T', body: 'complete plan', status: 'shaping' });
    const revision = store.readinessRevision(p.id);
    store.recordReadinessVerdict(bosun, { project_id: p.id, reviewed_revision: revision, verdict: 'pass', note: 'enough is known' });
    expect(store.getProject(p.id).readiness).toBe('shaped');
    store.recordReadinessVerdict({ name: 'proof', kind: 'agent', model: 'claude-fable-5', version: 'test' }, {
      project_id: p.id, reviewed_revision: revision, verdict: 'fail', note: 'the rollback is missing',
    });
    const review = store.readinessReview(p.id)!;
    expect(review.state).toBe('contested');
    expect(review.verdicts.map((v) => v.verdict)).toEqual(['pass', 'fail']);
    expect(store.getProject(p.id).readiness).toBe('raw idea');
  });

  it('lets a reviewer correct only their own verdict', () => {
    const p = store.createProject(mason, { title: 'T', body: 'complete plan', status: 'shaping' });
    const revision = store.readinessRevision(p.id);
    store.recordReadinessVerdict(bosun, { project_id: p.id, reviewed_revision: revision, verdict: 'fail', note: 'missing proof' });
    store.recordReadinessVerdict(bosun, { project_id: p.id, reviewed_revision: revision, verdict: 'pass', note: 'proof supplied' });
    expect(store.readinessReview(p.id)?.state).toBe('ready');
    expect(store.readinessReview(p.id)?.verdicts).toHaveLength(1);
    expect(store.getEvents(p.id).filter((e) => e.event_type === 'readiness_verdict_recorded')).toHaveLength(2);
  });

  it('refuses a stale reviewed revision without changing state or history', () => {
    const p = store.createProject(mason, { title: 'T', body: 'first plan', status: 'shaping' });
    const revision = store.readinessRevision(p.id);
    store.updateProject(mason, { project_id: p.id, note: 'changed scope', body: 'second plan' });
    const before = JSON.stringify(store.dumpState());
    const events = store.getEvents(p.id).length;
    expect(() => store.recordReadinessVerdict(bosun, {
      project_id: p.id, reviewed_revision: revision, verdict: 'pass', note: 'old plan looked ready',
    })).toThrow(/stale/);
    expect(store.getEvents(p.id)).toHaveLength(events);
    expect(JSON.stringify(store.dumpState())).toBe(before);
  });

  it('rebuild preserves the governing set and projected status', () => {
    const p = store.createProject(mason, { title: 'T', body: 'complete plan', status: 'shaping' });
    const revision = store.readinessRevision(p.id);
    store.recordReadinessVerdict(bosun, { project_id: p.id, reviewed_revision: revision, verdict: 'pass', note: 'ready' });
    store.updateProject(bosun, { project_id: p.id, note: 'clearer title', title: 'T, clarified' });
    const before = JSON.stringify(store.dumpState());
    store.rebuild();
    expect(JSON.stringify(store.dumpState())).toBe(before);
    expect(store.readinessReview(p.id)).toBeNull();
    expect(store.getProject(p.id).readiness).toBe('raw idea');
  });
});

describe('health readings', () => {
  it('records explained health as its own event and rebuilds it', () => {
    const p = store.createProject(mason, { title: 'T' });
    expect(() => store.recordHealth(mason, { project_id: p.id, health: 'At risk', reason: '' })).toThrow(/reason/);
    store.recordHealth(mason, { project_id: p.id, health: 'At risk', reason: 'The only delivery ticket is held.' });
    expect(store.getProject(p.id)).toMatchObject({ health: 'At risk', health_reason: 'The only delivery ticket is held.' });
    expect(store.getEvents(p.id).at(-1)?.event_type).toBe('health_recorded');
    const before = JSON.stringify(store.dumpState());
    store.rebuild();
    expect(JSON.stringify(store.dumpState())).toBe(before);
  });
});

describe('the go, and the work phase it opens', () => {
  function shapedProject(title: string): string {
    const p = store.createProject(mason, { title, body: 'a description worth judging' });
    store.recordReadinessVerdict(bosun, { project_id: p.id, reviewed_revision: store.readinessRevision(p.id), verdict: 'pass', note: 'enough is known' });
    return p.id;
  }

  it('only a shaped project, only via the recorded human decision', () => {
    const a = shapedProject('A');
    const raw = store.createProject(mason, { title: 'C' });

    expect(() => store.updateProject(mason, { project_id: a, note: 'go', status: 'Planned' as never })).toThrow(/go-ahead/);
    expect(() => store.setShipNext(mason, { project_id: raw.id, decided_by: 'arthur', reason: 'r' })).toThrow(/shaped/);
    expect(() => store.setShipNext(mason, { project_id: a, decided_by: '', reason: 'r' })).toThrow(/decided_by/);

    const { project, ship_next_count } = store.setShipNext(mason, { project_id: a, decided_by: 'arthur', reason: 'unblocks the fleet' });
    expect(project.status).toBe('Planned'); // authorized, and nothing underway yet
    expect(ship_next_count).toBe(1);
    expect(store.authorizedProjects().map((p) => p.id)).toEqual([a]);
  });

  it('the work phase holds the authorized and the underway together', () => {
    const a = shapedProject('A');
    const b = shapedProject('B');
    store.setShipNext(mason, { project_id: a, decided_by: 'arthur', reason: 'go' });
    store.updateProject(mason, { project_id: a, note: 'claimed its first ticket', status: 'Active' });
    const { ship_next_count } = store.setShipNext(mason, { project_id: b, decided_by: 'arthur', reason: 'also go' });
    expect(ship_next_count).toBe(2); // no demotion: one Active, one Planned
    expect(store.getProject(a).status).toBe('Active');
    expect(store.authorizedProjects().map((p) => p.id)).toEqual([a, b]);
  });

  it('nothing starts or ships that the human never declared go on', () => {
    const shaped = shapedProject('S');
    expect(() => store.updateProject(mason, { project_id: shaped, note: 'started it', status: 'Active' }))
      .toThrow(/declared go on/);
    expect(() => store.updateProject(mason, { project_id: shaped, note: 'shipped it', status: 'Monitoring' }))
      .toThrow(/only an Active project/);

    const a = shapedProject('A');
    store.setShipNext(mason, { project_id: a, decided_by: 'arthur', reason: 'go' });
    // Authorized is not underway: a go alone does not reach the shipped family.
    expect(() => store.updateProject(mason, { project_id: a, note: 'straight to watching', status: 'Monitoring' }))
      .toThrow(/only an Active project/);
    store.updateProject(mason, { project_id: a, note: 'work in flight', status: 'Active' });
    store.updateProject(mason, { project_id: a, note: 'built, watching', status: 'Monitoring' });
    expect(store.getProject(a).status).toBe('Monitoring');
    expect(store.getProject(a).closed_at).toBeTruthy();
    // Monitoring → Completed stays open (records the human's maintenance call).
    store.updateProject(mason, { project_id: a, note: 'quiet for weeks; Arthur calls the outcome verified', status: 'Completed' });
    expect(store.getProject(a).status).toBe('Completed');
    expect(store.authorizedProjects()).toEqual([]);
  });

  it('a paused delivery resumes without a second go, and its health is a separate fact', () => {
    const a = shapedProject('A');
    store.setShipNext(mason, { project_id: a, decided_by: 'arthur', reason: 'go' });
    store.updateProject(mason, { project_id: a, note: 'work in flight', status: 'Active' });
    store.updateProject(arthur, { project_id: a, note: 'pending an evidence-backed plan', status: 'Paused', unpark_condition: 'Arthur authorizes resumption' });
    store.recordHealth(mason, { project_id: a, health: 'Off track', reason: 'Both delivery tickets carry a capacity hold only Arthur can release.' });
    expect(store.getProject(a)).toMatchObject({ status: 'Paused', health: 'Off track' });
    store.updateProject(mason, { project_id: a, note: 'Arthur released the hold', status: 'Active' });
    expect(store.getProject(a).status).toBe('Active');
  });
});

// Events are never rewritten, and a row keeps the word it was written with
// until the one-shot migration writes the new one. Every gate, tier and
// listing has to read the old vocabulary correctly in the meantime.
function writeLegacyEvents(events: [string, string, Record<string, unknown>][]): void {
  const raw = new Database(join(dir, 'test.db'));
  const insert = raw.prepare('INSERT INTO events (ts, subject_id, event_type, actor, payload) VALUES (?, ?, ?, ?, ?)');
  events.forEach(([id, type, payload], i) => {
    insert.run(`2026-09-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, id, type, JSON.stringify(mason), JSON.stringify(payload));
  });
  raw.close();
  store.rebuild();
}

const created = (id: string, status: string): [string, string, Record<string, unknown>] =>
  [id, 'created', { id, title: id, body: 'written in the old words', status }];

describe('a store written before R-46', () => {
  it('reads every pre-R-46 word in today\'s vocabulary, and replays its events unchanged', () => {
    writeLegacyEvents([
      created('R-90', 'parked'),
      created('R-91', 'shaping'),
      created('R-92', 'ready'),
      created('R-93', 'shipped_watching'),
      created('R-94', 'shipped_stable'),
      created('R-95', 'archived'),
      created('R-96', 'ready'),
      // A pre-R-46 go carries no status in its payload: replaying it must
      // still materialize 'ship_next', the word it wrote when it happened.
      ['R-96', 'ship_next_set', { decided_by: 'arthur', reason: 'the 2026-09 go' }],
    ]);

    expect(store.getProject('R-96').status).toBe('ship_next');
    expect(store.authorizedProjects().map((p) => p.id)).toEqual(['R-96']);
    expect(store.shippedProjects().map((p) => p.id).sort()).toEqual(['R-93', 'R-94']);
    // The ranked list drops the shipped and terminal families whatever word
    // they carry, and tiers the rest by what those words always meant.
    expect(store.rankProjects().map((r) => r.project.id)).toEqual(['R-96', 'R-91', 'R-92', 'R-90']);
    expect(store.rankProjects()[0]!.explanation).toContain('ACTIVE');

    // The shipped door admits the legacy source: a go is a go.
    store.updateProject(mason, { project_id: 'R-96', note: 'built, watching', status: 'Monitoring' });
    expect(store.getProject('R-96')).toMatchObject({ status: 'Monitoring', closed_at: expect.any(String) });

    // A legacy archive is still terminal, and hiding it does not reopen it.
    expect(() => store.updateProject(mason, { project_id: 'R-95', note: 'reopen', status: 'Proposed' })).toThrow(/terminal/);
    expect(store.updateProject(mason, { project_id: 'R-95', note: 'off the surfaces', archived: true }).project.archived).toBe(1);
    expect(store.getProject('R-95').status).toBe('archived');
  });

  it('judges a legacy row\'s readiness as a field, leaving its stored word alone', () => {
    writeLegacyEvents([created('R-97', 'parked')]);
    const { project } = store.recordReadinessVerdict(bosun, {
      project_id: 'R-97', reviewed_revision: store.readinessRevision('R-97'), verdict: 'pass', note: 'enough is known',
    });
    expect(project).toMatchObject({ status: 'parked', readiness: 'shaped' });
    // And that shaped reading is what the go gate reads.
    expect(store.setShipNext(mason, { project_id: 'R-97', decided_by: 'arthur', reason: 'go' }).project.status).toBe('Planned');
  });
});

describe('the R-46 vocabulary migration', () => {
  // The whole estate as it stood on 2026-10-20, one row per class, plus the
  // two rows nobody can map by rule: R-32, the only parked row ever
  // authorized, and an archive with no recorded judgment.
  function legacyEstate(): void {
    writeLegacyEvents([
      created('R-2', 'parked'), // a raw idea, never authorized
      created('R-4', 'archived'), // shelved: superseded
      created('R-18', 'archived'), // shelved: closed on instruction
      created('R-22', 'shaping'),
      created('R-39', 'archived'), // shelved: delivered through its successors
      created('R-8', 'shipped_stable'),
      created('R-11', 'shipped_watching'),
      created('R-46', 'ship_next'),
      created('R-50', 'ready'),
      created('R-60', 'archived'), // no judgment recorded for this one
      // R-32: a go, then stood down. The status word is `parked` like R-2's,
      // and only its history says the two are different facts.
      created('R-32', 'ready'),
      ['R-32', 'ship_next_set', { decided_by: 'arthur', reason: 'release 2A' }],
      ['R-32', 'updated', { note: 'paused pending a plan', diffs: { status: { from: 'ship_next', to: 'parked' } } }],
    ]);
  }

  it('maps every stored word to the reading it always had, and says why per row', () => {
    legacyEstate();
    const plan = store.migrateR46(mason, { apply: true });
    expect(plan.applied).toBe(true);

    const read = (id: string) => {
      const p = store.getProject(id);
      return { status: p.status, readiness: p.readiness, archived: p.archived };
    };
    // An idea nobody authorized, and the delivery that was — same old word.
    expect(read('R-2')).toEqual({ status: 'Proposed', readiness: 'raw idea', archived: 0 });
    expect(read('R-32')).toEqual({ status: 'Paused', readiness: 'shaped', archived: 0 });
    // Refinement was a status; it is a field now.
    expect(read('R-22')).toEqual({ status: 'Proposed', readiness: 'shaped', archived: 0 });
    expect(read('R-50')).toEqual({ status: 'Proposed', readiness: 'shaped', archived: 0 });
    // The go, and the two shipped words.
    expect(read('R-46').status).toBe('Active');
    expect(read('R-11').status).toBe('Monitoring');
    expect(read('R-8').status).toBe('Completed');
    // The three judgment calls: what became of it, then hidden.
    expect(read('R-39')).toMatchObject({ status: 'Completed', archived: 1 });
    expect(read('R-4')).toMatchObject({ status: 'Canceled', archived: 1 });
    expect(read('R-18')).toMatchObject({ status: 'Canceled', archived: 1 });

    const why = (id: string) => store.getEvents(id).at(-1)!.payload['note'] as string;
    expect(why('R-32')).toContain('the go is on the record and the delivery was stood down');
    expect(why('R-2')).toContain('no go on the record');
    expect(why('R-4')).toContain('superseded by R-47');
    expect(why('R-2')).toContain('no judgment was re-made');
  });

  it('leaves an archive nobody judged alone, and asks for the call', () => {
    legacyEstate();
    const plan = store.migrateR46(mason, { apply: true });
    expect(plan.undecided.map((u) => u.id)).toEqual(['R-60']);
    expect(plan.undecided[0]!.reason).toMatch(/archived with no recorded judgment/);
    // Untouched, and still reading as Canceled until someone decides.
    expect(store.getProject('R-60').status).toBe('archived');
    expect(store.getEvents('R-60')).toHaveLength(1);
  });

  it('writes nothing without --apply, and the plan is the report', () => {
    legacyEstate();
    const before = JSON.stringify(store.dumpState());
    const plan = store.migrateR46(mason, { apply: false });
    expect(plan.applied).toBe(false);
    expect(plan.decisions).toHaveLength(10);
    expect(JSON.stringify(store.dumpState())).toBe(before);

    const report = formatR46Plan(plan);
    expect(report).toContain('plan only, nothing written: 10 of 11 rows');
    // Every count states its denominator in the same sentence.
    expect(report).toContain('10 of 11 rows migrate; 0 already carry a new word; 1 await');
    expect(report).toContain('parked → Paused: 1');
    expect(report).toContain('parked → Proposed: 1');
    expect(report).toContain('Re-run with --apply');
  });

  it('is a one-shot: a second run has nothing to write', () => {
    legacyEstate();
    store.migrateR46(mason, { apply: true });
    const events = store.dumpState()['projects']!.length;

    const again = store.migrateR46(mason, { apply: true });
    expect(again.decisions).toHaveLength(0);
    expect(again.already).toEqual(['R-2', 'R-4', 'R-8', 'R-11', 'R-18', 'R-22', 'R-32', 'R-39', 'R-46', 'R-50'].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))));
    // The unjudged archive is neither migrated nor counted as done.
    expect(again.undecided.map((u) => u.id)).toEqual(['R-60']);
    expect(store.dumpState()['projects']!.length).toBe(events);

    // And the report for an already-migrated store says that plainly,
    // instead of printing denominators with no rows under them.
    const report = formatR46Plan(again);
    expect(report).toContain('nothing to migrate: 10 of 11 rows already carry a word from the seven');
    expect(report).toContain('R-60');
    expect(report).not.toContain('--apply');
  });

  it('rewrites no event and fabricates no closing date, and replays exactly', () => {
    legacyEstate();
    const history = store.getEvents('R-32').map((e) => `${e.event_type}:${JSON.stringify(e.payload)}`);
    const beforeCount = (['R-2', 'R-4', 'R-32'] as const).map((id) => store.getEvents(id).length);

    store.migrateR46(mason, { apply: true });

    // Every prior event stands exactly as recorded; the migration only appends.
    expect(store.getEvents('R-32').map((e) => `${e.event_type}:${JSON.stringify(e.payload)}`).slice(0, 3)).toEqual(history);
    expect((['R-2', 'R-4', 'R-32'] as const).map((id) => store.getEvents(id).length)).toEqual(beforeCount.map((n) => n + 1));
    // A row that was already closed does not get today's date as its close.
    expect(store.getProject('R-8').closed_at).toBeNull();
    expect(store.getProject('R-4').closed_at).toBeNull();

    const after = JSON.stringify(store.dumpState());
    store.rebuild();
    expect(JSON.stringify(store.dumpState())).toBe(after);
  });

  it('a migrated store reads through the same gates as before', () => {
    legacyEstate();
    store.migrateR46(mason, { apply: true });

    expect(store.authorizedProjects().map((p) => p.id)).toEqual(['R-46']);
    // R-39 is Completed AND hidden: after R-46 those are two facts, so the
    // shipped family includes it and the surfaces apply the hide flag.
    expect(store.shippedProjects().map((p) => p.id).sort()).toEqual(['R-11', 'R-39', 'R-8']);
    expect(store.shippedProjects().filter((p) => !p.archived).map((p) => p.id).sort()).toEqual(['R-11', 'R-8']);
    // A Paused delivery is still a paused delivery: it takes no go without a
    // readiness verdict of its own, and it is not in the ranked work phase.
    expect(store.rankProjects().map((r) => r.project.id)).toEqual(['R-46', 'R-22', 'R-50', 'R-2', 'R-32']);
    // Terminal is still terminal after the rename.
    expect(() => store.updateProject(mason, { project_id: 'R-4', note: 'reopen', status: 'Proposed' })).toThrow(/terminal/);
  });
});

describe('claims, citations, ranking', () => {
  it('judgments are never naked numbers', () => {
    const p = store.createProject(mason, { title: 'T' });
    expect(() => store.recordClaim(mason, { project_id: p.id, kind: 'value', level: 'high', reason: ' ' })).toThrow(/reason/);
    expect(() => store.recordClaim(mason, { project_id: p.id, kind: 'effort', reason: 'r' })).toThrow(/size/);
    const c = store.recordClaim(mason, { project_id: p.id, kind: 'effort', size: 'L', predicted_usd: 40, reason: 'store + view + seam' });
    expect(c.author).toBe('mason');
    expect(c.predicted_usd).toBe(40);
  });

  it('citations need a real objective and a how-claim', () => {
    const p = store.createProject(mason, { title: 'T' });
    expect(() => store.cite(mason, { project_id: p.id, objective_id: 'OBJ-9', claim: 'x' })).toThrow(/not in the charter/);
    store.setCharterItem(mason, { shape: 'objective', statement: 'Ship in public', horizon: 'standing', rank: 1, source: '~/charter.md' });
    expect(() => store.cite(mason, { project_id: p.id, objective_id: 'OBJ-1' })).toThrow(/claim/);
    const cites = store.cite(mason, { project_id: p.id, objective_id: 'OBJ-1', claim: 'because it ships publicly alongside Helmo' });
    expect(cites).toHaveLength(1);
  });

  it('rank derives from facts first, judgments within tier, and explains itself', () => {
    store.setCharterItem(mason, { shape: 'objective', statement: 'O1', horizon: 'near', rank: 1, source: 's' });
    const ready = store.createProject(mason, { title: 'ready-high', status: 'shaping' });
    store.updateProject(bosun, { project_id: ready.id, note: 'ok', status: 'ready' });
    const readyLow = store.createProject(mason, { title: 'ready-low', status: 'shaping' });
    store.updateProject(bosun, { project_id: readyLow.id, note: 'ok', status: 'ready' });
    const shaping = store.createProject(mason, { title: 'shaping', status: 'shaping' });
    const parked = store.createProject(mason, { title: 'parked' });

    store.recordClaim(mason, { project_id: ready.id, kind: 'value', level: 'high', reason: 'r' });
    store.recordClaim(mason, { project_id: readyLow.id, kind: 'value', level: 'low', reason: 'r' });
    store.cite(mason, { project_id: ready.id, objective_id: 'OBJ-1', claim: 'directly' });

    const order = store.rankProjects().map((r) => r.project.title);
    expect(order).toEqual(['ready-high', 'ready-low', 'shaping', 'parked']);

    const top = store.rankProjects()[0]!;
    expect(top.explanation).toContain('1st');
    expect(top.explanation).toContain('shaped, no blockers');
    expect(top.explanation).toContain('advances OBJ-1');
    expect(top.explanation).toContain('value high (mason');
  });

  it('a blocked project sinks below shaping and the blocker releases by shipping', () => {
    const a = store.createProject(mason, { title: 'A', status: 'shaping' });
    store.updateProject(bosun, { project_id: a.id, note: 'ok', status: 'ready' });
    const b = store.createProject(mason, { title: 'B', status: 'shaping' });
    store.link(mason, a.id, b.id, 'blocks', 'add');

    expect(store.blockedBy(a.id)).toEqual([b.id]);
    const order = store.rankProjects().map((r) => r.project.title);
    expect(order).toEqual(['B', 'A']); // shaping B outranks blocked-ready A

    store.updateProject(bosun, { project_id: b.id, note: 'ok', status: 'ready' });
    store.setShipNext(mason, { project_id: b.id, decided_by: 'arthur', reason: 'go' });
    store.updateProject(bosun, { project_id: b.id, note: 'done, watching', status: 'shipped_watching' });
    expect(store.blockedBy(a.id)).toEqual([]);
  });

  it('a blocked project never floats above the unblocked prerequisite it waits on (H-441)', () => {
    // The 2026-08-27 board shape: keystone R-12 parked and unblocked; R-13,
    // R-14 parked and waiting on it; R-15 parked and waiting on R-14. The old
    // tiering put blocked (4) above parked (5), ranking the keystone last.
    const keystone = store.createProject(mason, { title: 'keystone' });
    const waiter1 = store.createProject(mason, { title: 'waiter1' });
    const waiter2 = store.createProject(mason, { title: 'waiter2' });
    const chained = store.createProject(mason, { title: 'chained' });
    store.link(mason, waiter1.id, keystone.id, 'blocks', 'add');
    store.link(mason, waiter2.id, keystone.id, 'blocks', 'add');
    store.link(mason, chained.id, waiter2.id, 'blocks', 'add');
    store.recordClaim(mason, { project_id: keystone.id, kind: 'value', level: 'high', reason: 'r' });
    store.recordClaim(mason, { project_id: waiter1.id, kind: 'value', level: 'high', reason: 'r' });

    const order = store.rankProjects().map((r) => r.project.title);
    expect(order[0]).toBe('keystone');
    expect(order.indexOf('keystone')).toBeLessThan(order.indexOf('waiter1'));
    expect(order.indexOf('keystone')).toBeLessThan(order.indexOf('waiter2'));
  });

  it('blocks cycles are refused', () => {
    const a = store.createProject(mason, { title: 'A' });
    const b = store.createProject(mason, { title: 'B' });
    store.link(mason, a.id, b.id, 'blocks', 'add');
    expect(() => store.link(mason, b.id, a.id, 'blocks', 'add')).toThrow(/cycle/);
  });
});

describe('charter projection and actuals', () => {
  it('objectives and bets upsert by id with drift-visible provenance', () => {
    const o = store.setCharterItem(mason, { shape: 'objective', statement: 'v1', horizon: 'near', rank: 2, source: 'doc' });
    const o2 = store.setCharterItem(mason, { shape: 'objective', id: o.id, statement: 'v2', horizon: 'near', rank: 1, source: 'doc' });
    expect(o2.id).toBe(o.id);
    expect(store.listObjectives()).toHaveLength(1);
    expect(store.listObjectives()[0]!.statement).toBe('v2');

    const bet = store.setCharterItem(mason, { shape: 'bet', statement: 'agents can shape well', stake: 'the shaping loop', falsifier: 'ready projects bounce off builders', source: 'doc' });
    expect(bet.id).toBe('BET-1');
    expect(() => store.setCharterItem(mason, { shape: 'bet', statement: 's', source: 'doc' })).toThrow(/stake/);
  });

  it('actuals are absolute rollups', () => {
    const p = store.createProject(mason, { title: 'T' });
    store.recordActual(bosun, { project_id: p.id, actual_usd: 12.5, note: '3 tickets tagged r-1' });
    store.recordActual(bosun, { project_id: p.id, actual_usd: 20, note: '5 tickets tagged r-1' });
    expect(store.getProject(p.id).actual_usd).toBe(20);
  });
});

describe('the update precondition', () => {
  it('a read hands back a revision, and the write that used it is accepted', () => {
    const p = store.createProject(mason, { title: 'T', body: 'first sketch', status: 'shaping' });
    const rev = store.revisionOf(p.id);
    expect(rev).toBeGreaterThanOrEqual(1);
    const { project, revision } = store.updateProject(mason, {
      project_id: p.id,
      note: 'shaped it up',
      body: 'the full plan',
      if_revision: rev,
    });
    expect(project.body).toBe('the full plan');
    expect(revision).toBeGreaterThan(rev);
    // And the revision the write returned is immediately usable as the next one.
    expect(() => store.updateProject(mason, { project_id: p.id, note: 'more', body: 'more still', if_revision: revision })).not.toThrow();
  });

  it('a readiness judgment cannot land on a description rewritten after it was read', () => {
    // The interleaving this exists for: bosun reads a shaped project and judges
    // it ready; mason rewrites the body before bosun's write lands. Without the
    // precondition the 'ready' stands on text bosun never read.
    const p = store.createProject(mason, { title: 'T', body: 'the reviewed plan', status: 'shaping' });
    const asRead = store.revisionOf(p.id);
    store.updateProject(mason, { project_id: p.id, note: 'second thoughts', body: 'a different piece of work' });

    expect(() =>
      store.updateProject(bosun, { project_id: p.id, note: 'enough is known to commit', status: 'ready', if_revision: asRead }),
    ).toThrow(/has moved since you read it/);
    expect(store.getProject(p.id).status).toBe('shaping');
  });

  it('a refused write stores nothing at all — no event, no state change', () => {
    const p = store.createProject(mason, { title: 'T', body: 'approved scope', status: 'shaping' });
    const asRead = store.revisionOf(p.id);
    store.updateProject(bosun, { project_id: p.id, note: 'noting it', unpark_condition: 'never' });
    const state = JSON.stringify(store.dumpState());
    const events = store.getEvents(p.id).length;

    expect(() => store.updateProject(mason, { project_id: p.id, note: 'my rewrite', body: 'my scope', if_revision: asRead })).toThrow();
    expect(store.getEvents(p.id).length).toBe(events);
    expect(JSON.stringify(store.dumpState())).toBe(state);
    store.rebuild();
    expect(JSON.stringify(store.dumpState())).toBe(state);
  });

  it('the refusal names who moved it, and a revision the project never had says so', () => {
    const p = store.createProject(mason, { title: 'T', status: 'shaping' });
    const asRead = store.revisionOf(p.id);
    store.recordClaim(bosun, { project_id: p.id, kind: 'value', level: 'high', reason: 'r' });
    expect(() => store.updateProject(mason, { project_id: p.id, note: 'n', body: 'b', if_revision: asRead })).toThrow(/claim_recorded by bosun/);
    expect(() => store.updateProject(mason, { project_id: p.id, note: 'n', body: 'b', if_revision: 9999 })).toThrow(/not one R-1 has ever been at/);
  });

  it('any write against the project moves its revision, not only an update', () => {
    store.setCharterItem(mason, { shape: 'objective', statement: 'O', horizon: 'near', rank: 1, source: 's' });
    const p = store.createProject(mason, { title: 'T', status: 'shaping' });
    const other = store.createProject(mason, { title: 'Other' });
    let rev = store.revisionOf(p.id);
    for (const write of [
      () => store.recordClaim(mason, { project_id: p.id, kind: 'effort', size: 'M', reason: 'r' }),
      () => store.cite(mason, { project_id: p.id, objective_id: 'OBJ-1', claim: 'how' }),
      () => store.link(mason, p.id, other.id, 'relates', 'add'),
      () => store.recordActual(bosun, { project_id: p.id, actual_usd: 2, note: '1 ticket' }),
    ]) {
      write();
      const after = store.revisionOf(p.id);
      expect(after).toBeGreaterThan(rev);
      rev = after;
    }
    // A write recorded against a different project does not move this one's.
    store.updateProject(mason, { project_id: other.id, note: 'park', status: 'parked', unpark_condition: 'when T ships' });
    expect(store.revisionOf(p.id)).toBe(rev);
  });

  it("sees another connection's write, not only this process's", () => {
    // The race is between processes — an interactive session's and a
    // bash-loop agent's — so the comparison has to read committed state from
    // the file, not anything this Store remembers.
    const p = store.createProject(mason, { title: 'T', body: 'approved scope', status: 'shaping' });
    const asRead = store.revisionOf(p.id);
    const second = new Store(join(dir, 'test.db'));
    try {
      second.updateProject(bosun, { project_id: p.id, note: 'theirs', body: 'their scope' });
    } finally {
      second.close();
    }
    expect(() => store.updateProject(mason, { project_id: p.id, note: 'mine', body: 'my scope', if_revision: asRead })).toThrow(/has moved since you read it/);
    expect(store.getProject(p.id).body).toBe('their scope');
  });

  it('a caller that passes no revision behaves exactly as before', () => {
    const p = store.createProject(mason, { title: 'T', body: 'first', status: 'shaping' });
    store.updateProject(bosun, { project_id: p.id, note: 'theirs', body: 'theirs' });
    const { project } = store.updateProject(mason, { project_id: p.id, note: 'mine', body: 'mine' });
    expect(project.body).toBe('mine'); // last write still wins — nothing is now conditional by default
  });

  it('a revision that is not a revision is refused before anything is read', () => {
    const p = store.createProject(mason, { title: 'T', status: 'shaping' });
    for (const bad of [0, -1, 1.5, '1' as unknown as number, Number.NaN]) {
      expect(() => store.updateProject(mason, { project_id: p.id, note: 'n', body: 'b', if_revision: bad })).toThrow(/if_revision must be/);
    }
    expect(store.getEvents(p.id).length).toBe(1);
  });

  it('the precondition is compared inside the write transaction, where nothing can move', () => {
    // Structural, because this is the whole point: checked before the
    // transaction it is checked at the moment it cannot hold. The read, the
    // rule checks and the diffs all sit outside; the comparison must not.
    const src = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('updateProject(actor: Actor'), src.indexOf('private assertRevision'));
    expect(body.indexOf('assertRevision')).toBeGreaterThan(body.indexOf('this.db.transaction'));
  });
});

describe('the read the precondition depends on', () => {
  /** Commit a real write from a second connection the first time `fn` runs —
   *  the worst possible moment being exactly after one of the read's queries
   *  has returned and before the next one runs. */
  function commitOnceDuring(fn: () => void): () => void {
    const real = store.getProject.bind(store);
    let fired = false;
    (store as unknown as { getProject: (id: string) => unknown }).getProject = (id: string) => {
      const row = real(id);
      if (!fired) {
        fired = true;
        fn();
      }
      return row;
    };
    // Deleting the own property falls back to the prototype's method.
    return () => { delete (store as unknown as Record<string, unknown>)['getProject']; };
  }

  it('a writer committing mid-read cannot pair an old body with a new revision', () => {
    // The precondition is only as good as the read that hands out the token.
    // Read the project and its revision in two snapshots and a writer landing
    // between them gives the caller text it can no longer write over — and a
    // revision that says it can. Then 'ready' stands on the replacement, which
    // is the same corruption, rebuilt out of the read side.
    const p = store.createProject(mason, { title: 'T', body: 'the reviewed plan', status: 'shaping' });
    const second = new Store(join(dir, 'test.db'));
    const restore = commitOnceDuring(() =>
      second.updateProject(mason, { project_id: p.id, note: 'second thoughts', body: 'a different piece of work' }),
    );
    let snap;
    try {
      snap = store.projectSnapshot(p.id);
    } finally {
      restore();
      second.close();
    }

    expect(snap.project.body).toBe('the reviewed plan'); // what the read returned
    expect(() =>
      store.updateProject(bosun, { project_id: p.id, note: 'enough is known to commit', status: 'ready', if_revision: snap.revision }),
    ).toThrow(/has moved since you read it/);
    expect(store.getProject(p.id).status).toBe('shaping');
  });

  it('the snapshot hands back every fact one read of a project returns', () => {
    store.setCharterItem(mason, { shape: 'objective', statement: 'O', horizon: 'near', rank: 1, source: 's' });
    const p = store.createProject(mason, { title: 'T', body: 'plan', status: 'shaping' });
    const blocker = store.createProject(mason, { title: 'Blocker', status: 'shaping' });
    store.link(mason, p.id, blocker.id, 'blocks', 'add');
    store.recordClaim(mason, { project_id: p.id, kind: 'value', level: 'high', reason: 'r' });
    store.cite(mason, { project_id: p.id, objective_id: 'OBJ-1', claim: 'how' });

    const snap = store.projectSnapshot(p.id);
    expect(snap.project.title).toBe('T');
    expect(snap.revision).toBe(store.revisionOf(p.id));
    expect(snap.blocked_by).toEqual([blocker.id]);
    expect(snap.deps.outgoing).toHaveLength(1);
    expect(snap.claims).toHaveLength(1);
    expect(snap.citations).toHaveLength(1);
    expect(snap.events.length).toBeGreaterThan(1);
  });

  it('the revision covers this project, not the graph around it', () => {
    // A limit worth pinning down rather than discovering: blocked_by and
    // incoming deps are facts about OTHER projects, and those move without
    // appending anything here. A caller deciding on the dependency graph needs
    // more than this token, and the tool description says so.
    const p = store.createProject(mason, { title: 'T', status: 'shaping' });
    const blocker = store.createProject(mason, { title: 'Blocker', status: 'shaping' });
    const elsewhere = store.createProject(mason, { title: 'Elsewhere' });
    store.link(mason, p.id, blocker.id, 'blocks', 'add');
    const rev = store.revisionOf(p.id);
    expect(store.projectSnapshot(p.id).blocked_by).toEqual([blocker.id]);

    store.updateProject(bosun, { project_id: blocker.id, note: 'not doing it', status: 'archived' });
    store.link(bosun, elsewhere.id, p.id, 'relates', 'add');

    const after = store.projectSnapshot(p.id);
    expect(after.blocked_by).toEqual([]); // changed
    expect(after.deps.incoming).toHaveLength(1); // changed
    expect(after.revision).toBe(rev); // and the revision did not
  });
});

describe('the invariant', () => {
  it('rebuild from the event log reproduces the materialized state exactly', () => {
    store.setCharterItem(mason, { shape: 'objective', statement: 'O', horizon: 'long', rank: 1, source: 's' });
    const a = store.createProject(mason, { title: 'A', body: 'plan', status: 'shaping' });
    const b = store.createProject(mason, { title: 'B' });
    store.updateProject(bosun, { project_id: a.id, note: 'ok', status: 'ready' });
    store.recordClaim(mason, { project_id: a.id, kind: 'value', level: 'high', reason: 'r' });
    store.recordClaim(mason, { project_id: a.id, kind: 'effort', size: 'M', predicted_usd: 15, reason: 'r' });
    store.cite(mason, { project_id: a.id, objective_id: 'OBJ-1', claim: 'how' });
    store.link(mason, b.id, a.id, 'relates', 'add');
    store.setShipNext(mason, { project_id: a.id, decided_by: 'arthur', reason: 'go' });
    store.recordActual(bosun, { project_id: a.id, actual_usd: 3, note: '1 ticket' });
    store.updateProject(mason, { project_id: b.id, note: 'park it', status: 'parked', unpark_condition: 'when A ships' });

    const before = JSON.stringify(store.dumpState());
    store.rebuild();
    expect(JSON.stringify(store.dumpState())).toBe(before);
  });

  it('holds when a cite or link is the last event on a project (the updated_at bump lives in apply)', () => {
    store.setCharterItem(mason, { shape: 'objective', statement: 'O', horizon: 'near', rank: 1, source: 's' });
    const a = store.createProject(mason, { title: 'A' });
    const b = store.createProject(mason, { title: 'B' });
    store.cite(mason, { project_id: a.id, objective_id: 'OBJ-1', claim: 'how' });
    store.link(mason, b.id, a.id, 'relates', 'add');

    const before = JSON.stringify(store.dumpState());
    store.rebuild();
    expect(JSON.stringify(store.dumpState())).toBe(before);
  });

  it('swallowed tool-call markup is rejected at the door', () => {
    expect(() => store.createProject(mason, { title: 'x </title> <parameter name="body">oops' })).toThrow(/markup/);
  });
});

describe('the work join is not this store’s to make', () => {
  // R-47 C1: the roadmap store cannot see tickets, so the remaining-work and
  // shipped-milestone readings are joined in `packages/cli/bin/serve.js` by
  // the one process that holds both. The reading a standalone Roadmap view
  // owes is therefore ABSENT, and a surface must render that as unknown —
  // never as "nothing is outstanding". An empty array here would be this
  // store claiming to have looked, which it never can.
  it('leaves remaining work and shipped milestones off every row it serves', () => {
    const a = store.createProject(mason, { title: 'Has tickets somewhere else' });
    const rows = store.dumpState()['projects'] as Record<string, unknown>[];
    for (const row of rows) {
      expect(row).not.toHaveProperty('remaining_work');
      expect(row).not.toHaveProperty('shipped');
    }
    const snapshot = store.projectSnapshot(a.id) as unknown as Record<string, unknown>;
    expect(snapshot).not.toHaveProperty('remaining_work');
    expect(snapshot.project).not.toHaveProperty('remaining_work');
  });
});
