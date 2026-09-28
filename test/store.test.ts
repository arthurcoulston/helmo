import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  it('an idea costs a title and nothing else', () => {
    const p = store.createProject(mason, { title: 'Run a hackathon at the co-working space' });
    expect(p.id).toBe('R-1');
    expect(p.status).toBe('parked');
    expect(p.body).toBe('');
  });

  it('rejects an agent actor without model/version', () => {
    expect(() => store.createProject({ name: 'x', kind: 'agent' }, { title: 't' })).toThrow(/model/);
  });

  it('updates require a note and archived projects are permanent', () => {
    const p = store.createProject(mason, { title: 'T', status: 'shaping' });
    expect(() => store.updateProject(mason, { project_id: p.id, note: '', status: 'ready' })).toThrow(/note/);
    store.updateProject(bosun, { project_id: p.id, note: 'ran its course', status: 'archived' });
    expect(() => store.updateProject(mason, { project_id: p.id, note: 'reopen', status: 'shaping' })).toThrow(/terminal/);
  });

  it('parking without an exit warns', () => {
    const p = store.createProject(mason, { title: 'T', status: 'shaping' });
    const { warnings } = store.updateProject(mason, { project_id: p.id, note: 'not now', status: 'parked' });
    expect(warnings.some((w) => w.includes('unpark_condition'))).toBe(true);
  });
});

describe('the ready gate', () => {
  it('the description shaper cannot make their own commitment-readiness judgment', () => {
    const p = store.createProject(mason, { title: 'T', body: 'the full plan', status: 'shaping' });
    expect(() => store.updateProject(mason, { project_id: p.id, note: 'done shaping', status: 'ready' })).toThrow(/second pair of eyes|other than the shaper|shaped by you/);
    const { project } = store.updateProject(bosun, { project_id: p.id, note: 'enough is known to decide whether to commit', status: 'ready' });
    expect(project.status).toBe('ready');
  });

  it('retitling is not shaping the description', () => {
    const p = store.createProject(mason, { title: 'Working title', body: 'first sketch', status: 'shaping' });
    store.updateProject(bosun, { project_id: p.id, note: 'shaped the proposition', body: 'enough evidence and scope to decide whether to commit' });
    store.updateProject(mason, { project_id: p.id, note: 'settled the name', title: 'Final title' });

    const { project } = store.updateProject(mason, { project_id: p.id, note: 'independently judged ready to commit', status: 'ready' });
    expect(project.status).toBe('ready');
  });

  it('an agent cannot reshape and declare ready in one update', () => {
    const p = store.createProject(mason, { title: 'T', body: 'first sketch', status: 'shaping' });
    expect(() => store.updateProject(bosun, {
      project_id: p.id,
      note: 'expanded it and called it ready',
      body: 'a newly complete description',
      status: 'ready',
    })).toThrow(/shaped by you|description's shaper/);
    expect(store.getProject(p.id).body).toBe('first sketch');
    expect(store.getProject(p.id).status).toBe('shaping');
  });

  it('the human is never gated', () => {
    const p = store.createProject(mason, { title: 'T', body: 'plan', status: 'shaping' });
    const { project } = store.updateProject(arthur, { project_id: p.id, note: 'good enough', status: 'ready' });
    expect(project.status).toBe('ready');
  });
});

describe('ship next — the work phase', () => {
  function readyProject(title: string): string {
    const p = store.createProject(mason, { title, status: 'shaping' });
    store.updateProject(bosun, { project_id: p.id, note: 'ready', status: 'ready' });
    return p.id;
  }

  it('only a ready project, only via the recorded human decision', () => {
    const a = readyProject('A');
    const parked = store.createProject(mason, { title: 'C' });

    expect(() => store.updateProject(mason, { project_id: a, note: 'go', status: 'ship_next' as never })).toThrow(/ship_next/);
    expect(() => store.setShipNext(mason, { project_id: parked.id, decided_by: 'arthur', reason: 'r' })).toThrow(/ready/);
    expect(() => store.setShipNext(mason, { project_id: a, decided_by: '', reason: 'r' })).toThrow(/decided_by/);

    const { ship_next_count } = store.setShipNext(mason, { project_id: a, decided_by: 'arthur', reason: 'unblocks the fleet' });
    expect(ship_next_count).toBe(1);
    expect(store.shipNextProjects().map((p) => p.id)).toEqual([a]);
  });

  it('several may hold it at once — the count is the resistance signal', () => {
    const a = readyProject('A');
    const b = readyProject('B');
    store.setShipNext(mason, { project_id: a, decided_by: 'arthur', reason: 'go' });
    const { ship_next_count } = store.setShipNext(mason, { project_id: b, decided_by: 'arthur', reason: 'also go' });
    expect(ship_next_count).toBe(2);
    expect(store.getProject(a).status).toBe('ship_next'); // no demotion
  });

  it('nothing ships that the human never declared go on', () => {
    const shaped = store.createProject(mason, { title: 'S', status: 'shaping' });
    expect(() => store.updateProject(mason, { project_id: shaped.id, note: 'shipped it', status: 'shipped_watching' })).toThrow(/go-ahead|ship_next/);
    // The human is not gated; agents move a project only out of ship_next.
    const a = readyProject('A');
    store.setShipNext(mason, { project_id: a, decided_by: 'arthur', reason: 'go' });
    store.updateProject(mason, { project_id: a, note: 'built, watching', status: 'shipped_watching' });
    expect(store.getProject(a).status).toBe('shipped_watching');
    expect(store.getProject(a).closed_at).toBeTruthy();
    // watching → stable stays open (records the human's maintenance call).
    store.updateProject(mason, { project_id: a, note: 'quiet for weeks; Arthur calls it worth keeping', status: 'shipped_stable' });
    expect(store.getProject(a).status).toBe('shipped_stable');
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
    expect(top.explanation).toContain('ready, no blockers');
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
