// The read feed (R-11 H-832). Two halves: feed() is pure, so the ordering and
// the omissions are checked directly; the route is checked by starting the
// view against a temp database and fetching it, because the whole deliverable
// is that ONE address serves JSON and a grep of the source would pass on a
// router that never reaches it.
import { describe, expect, it, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOSED_TAIL, feed, markFor } from '../src/feed.js';
import { Store } from '../src/store.js';
import { Actor, Question } from '../src/types.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'claude-opus-5', version: '0.5' };
const arthur: Actor = { name: 'Arthur Coulston', kind: 'human' };
const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '0.1' };

const ask: Question = {
  situation: 'The shell needs a Helmo feed and Helmo has none.',
  question: 'Serve the queue as JSON beside the page?',
  options: [
    { label: 'yes', consequence: 'one more read route on a port nothing fronts' },
    { label: 'no', consequence: 'the shell opens the store itself' },
  ],
  recommendation: 'yes',
};

function create(s: Store, over: Record<string, unknown> = {}) {
  return s.createTicket(builder, {
    title: 'Build the importer',
    body: 'Goal: import CSVs. Constraint: keep memory under 1GB.',
    workstream: 'estate-ui',
    type: 'build',
    ...over,
  });
}

const all = (s: Store) => s.listTickets({ limit: 1000 });
const reading = (s: Store) => feed(all(s), s.actorKinds());
const ids = (s: Store) => reading(s).tickets.map((t) => t.id);

describe('who has a face', () => {
  it('gives a crew name its own mark, a human without one `person`, and a stranger none', () => {
    expect(markFor('mason', 'agent')).toBe('mason');
    expect(markFor('Arthur Coulston', 'human')).toBe('person');
    // The shape that matters: a newly opened seat is a name the sprite has
    // never met, and it renders bare rather than borrowing someone's mark.
    expect(markFor('newcomer-loop', 'agent')).toBeNull();
  });

  it('omits the actor entirely when the assignee has no mark, rather than sending a half one', () => {
    const s = new Store(':memory:');
    const t = create(s, { assignee: 'newcomer-loop' });
    const row = reading(s).tickets.find((r) => r.id === t.id)!;
    expect(row.assignee).toBe('newcomer-loop');
    // `<use>` at a symbol the sprite lacks draws NOTHING — no error anywhere —
    // so a mark the consumer cannot dress must not be sent at all.
    expect(row.actor).toBeUndefined();
  });

  it('reads the kind off the record rather than guessing it from the name', () => {
    const s = new Store(':memory:');
    // Arthur has written on this store as a human; the feed must frame him as
    // one without anything here saying so.
    s.updateTicket(arthur, { ticket_id: create(s).id, note: 'mine now', handoff_to: 'Arthur Coulston' });
    const row = reading(s).tickets[0]!;
    expect(row.actor).toEqual({ mark: 'person', kind: 'human' });
  });
});

describe('what the reading carries', () => {
  it('puts every live ticket before every closed one, and the closed newest first', () => {
    const s = new Store(':memory:');
    const older = create(s, { title: 'closed first' });
    const newer = create(s, { title: 'closed second' });
    const live = create(s, { title: 'still open' });
    s.updateTicket(builder, { ticket_id: older.id, note: 'done', status: 'done' });
    s.updateTicket(builder, { ticket_id: newer.id, note: 'done', status: 'done' });

    expect(ids(s)).toEqual([live.id, newer.id, older.id]);
  });

  it('caps the closed tail, keeping the most recent — even when they closed in the same instant', () => {
    const s = new Store(':memory:');
    const closed = Array.from({ length: CLOSED_TAIL + 5 }, (_, i) => {
      const t = create(s, { title: `finished ${i}` });
      s.updateTicket(builder, { ticket_id: t.id, note: 'done', status: 'done' });
      return t.id;
    });
    // All of these close inside the same millisecond, which is the shape a
    // meeting produces and the one a stable sort gets backwards.
    const got = ids(s);
    expect(got.length).toBe(CLOSED_TAIL);
    expect(got[0]).toBe(closed.at(-1));
    expect(got).toEqual([...closed].reverse().slice(0, CLOSED_TAIL));
  });

  it('counts cancelled work as closed, not as live', () => {
    const s = new Store(':memory:');
    const t = create(s);
    s.updateTicket(builder, { ticket_id: t.id, note: 'moot', status: 'cancelled' });
    expect(reading(s).tickets[0]!.status).toBe('cancelled');
    expect(reading(s).tickets[0]!.closed_at).not.toBeNull();
  });

  it('carries no ticket body — this is a queue reading, not a mirror of the record', () => {
    const s = new Store(':memory:');
    create(s);
    // The body is the handoff document and it is long; every ticket's full
    // record is one tap away on the page this is served beside.
    expect(JSON.stringify(reading(s))).not.toContain('import CSVs');
  });

  it('carries explicit acceptance state without implying a reviewer is active', () => {
    const s = new Store(':memory:');
    const t = create(s, { status: 'in_progress' });
    s.recordProductCompletion(builder, {
      ticket_id: t.id,
      artifacts: [{ ref: `helmo@${'a'.repeat(40)}`, author: builder.name }],
      note: 'Ready for independent review.',
    });
    const row = feed(all(s), s.actorKinds(), new Date(), (id) => s.productAcceptance(id)).tickets[0]!;
    expect(row.acceptance).toEqual({ state: 'pending', reason: 'missing_verdict' });
    expect(row).not.toHaveProperty('reviewer_active');
  });

  it('omits progress on a new ticket and bounds the latest recorded note', () => {
    const s = new Store(':memory:');
    const fresh = create(s);
    const changed = create(s);
    const long = `<updated & recorded> ${'🙂'.repeat(300)}`;
    s.updateTicket(builder, { ticket_id: changed.id, note: long });
    s.recordSpend(builder, changed.id, { tokens: 9, note: 'metering is bookkeeping, not progress' });
    const progress = s.latestProgress([fresh.id, changed.id]);
    const rows = feed(all(s), s.actorKinds(), new Date(), undefined, (id) => progress.get(id)).tickets;
    expect(rows.find((r) => r.id === fresh.id)!.progress).toBeUndefined();
    expect(rows.find((r) => r.id === changed.id)!.progress).toEqual({
      at: expect.any(String),
      note: Array.from(long).slice(0, 280).join(''),
      actor: { name: builder.name, kind: builder.kind },
    });
  });
});

describe('what a ticket asks', () => {
  it('carries the question while it is still asking', () => {
    const s = new Store(':memory:');
    const t = create(s);
    s.returnToHuman(builder, t.id, ask);
    expect(reading(s).tickets[0]!.asks).toBe(ask.question);
  });

  it('drops it once answered', () => {
    const s = new Store(':memory:');
    const t = create(s);
    s.returnToHuman(builder, t.id, ask);
    s.answerTicket(orch, t.id, { answer: 'yes — the shell should not hold the store', resolution: 'resume' });
    expect(reading(s).tickets[0]!.asks).toBeUndefined();
  });

  it('drops it on a closed ticket that still carries a question', () => {
    const s = new Store(':memory:');
    const t = create(s);
    s.returnToHuman(builder, t.id, ask);
    // The store will not produce this today — updateTicket refuses to move a
    // ticket out of awaiting_human at all, so only answerTicket closes one and
    // it clears the question as it goes. The feed does not lean on that: it
    // keys `asks` on the STATUS, because "asks you" is a claim about now, and
    // a queue that makes it about settled work is worse than one saying
    // nothing. Fed straight, because the invariant is what stops the store
    // from handing it over.
    const settled = { ...s.getTicket(t.id), status: 'done' as const, closed_at: new Date().toISOString() };
    expect(settled.question).not.toBeNull();
    expect(feed([settled], s.actorKinds()).tickets[0]!.asks).toBeUndefined();
  });
});

describe('the route', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helmo-feed-'));
  const db = join(dir, 'helmo.db');
  const port = 4479;
  let view: ChildProcess | null = null;

  afterAll(() => {
    view?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the reading as JSON at /tickets.json', async () => {
    const seed = new Store(db);
    const t = seed.createTicket(builder, {
      title: 'Serve the queue as JSON',
      body: 'Goal: the shell composes Helmo rather than proxying it.',
      workstream: 'estate-ui',
      type: 'build',
    });
    seed.updateTicket(builder, { ticket_id: t.id, note: 'last <recorded> & update' });
    seed.returnToHuman(builder, t.id, ask);
    seed.recordSpend(builder, t.id, { tokens: 1, note: 'metering only' });
    seed.close();

    view = spawn(process.execPath, ['--import', 'tsx', 'src/view.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, HELMO_DB: db, HELMO_VIEW_PORT: String(port), HELMO_VIEW_HOST: '127.0.0.1' },
      stdio: 'ignore',
    });

    const url = `http://127.0.0.1:${port}/tickets.json`;
    let res: Response | null = null;
    for (let i = 0; i < 60 && !res; i++) {
      try {
        res = await fetch(url);
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    expect(res, 'the view never came up').not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get('content-type')).toContain('application/json');
    const body = (await res!.json()) as { generated_at: string; tickets: { id: string; asks?: string; progress?: { note: string } }[] };
    expect(Number.isFinite(Date.parse(body.generated_at))).toBe(true);
    expect(body.tickets.map((x) => x.id)).toEqual([t.id]);
    expect(body.tickets[0]!.asks).toBe(ask.question);
    expect(body.tickets[0]!.progress?.note).toBe('last <recorded> & update');

    // The nonce is the page's CSRF friction (H-145) and it has no business
    // travelling in a feed the shell caches in a browser tab.
    const raw = await (await fetch(url)).text();
    expect(raw).not.toContain('data-answer');
    expect(raw.length).toBeLessThan(4000);
  }, 30_000);
});
