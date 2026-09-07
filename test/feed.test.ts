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
import { CLOSED_TAIL, feed, markFor, questionFingerprint, recordTickets, type FeedAsk } from '../src/feed.js';
import { Store } from '../src/store.js';
import { Actor, Question } from '../src/types.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'claude-opus-5', version: '0.5', session: 'rev:mason' };
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
  it('carries the human-sitting marker without changing open status', () => {
    const s = new Store(':memory:');
    const t = create(s, { needs_human: true });
    const row = reading(s).tickets.find((r) => r.id === t.id)!;
    expect(row.status).toBe('open');
    expect(row.needs_human).toBe(true);
  });

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

  it('opens the whole terminal record only when explicitly requested', () => {
    const s = new Store(':memory:');
    const closed = Array.from({ length: CLOSED_TAIL + 3 }, () => {
      const t = create(s);
      s.updateTicket(builder, { ticket_id: t.id, note: 'done', status: 'done' });
      return t.id;
    });
    const allTickets = all(s);
    expect(recordTickets(allTickets).map((t) => t.id)).toEqual([...closed].reverse().slice(0, CLOSED_TAIL));
    expect(recordTickets(allTickets, true).map((t) => t.id)).toEqual([...closed].reverse());
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

  it('identifies recurring templates for readers that separate standing work', () => {
    const s = new Store(':memory:');
    const template = create(s, { schedule: 'every 1d' });
    expect(reading(s).tickets.find((t) => t.id === template.id)!.schedule).toBe('every 1d');
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
  it('carries the whole decision while it is still asking', () => {
    const s = new Store(':memory:');
    const t = create(s);
    s.returnToHuman(builder, t.id, ask);
    // Everything Arthur decides on, in the order he reads it. If this ever
    // shrinks back to the question alone, he has to open the ticket to answer
    // it — which is the thing H-939 was filed about.
    expect(reading(s).tickets[0]!.asks).toEqual({
      fingerprint: questionFingerprint(ask),
      situation: ask.situation,
      question: ask.question,
      recommendation: ask.recommendation,
      options: [
        { letter: 'a', label: 'yes', consequence: 'one more read route on a port nothing fronts' },
        { letter: 'b', label: 'no', consequence: 'the shell opens the store itself' },
      ],
    });
  });

  it('fingerprints the ask, so a click can say which question it answered', () => {
    // The estate shell sends this back with a ratification and Helmo refuses a
    // mismatch (H-1053): a card can sit on a phone while the ticket is
    // answered and asked again, and consent belongs to the ask it was given
    // for. So every part a reader was shown has to move the value.
    const base = questionFingerprint(ask);
    expect(questionFingerprint({ ...ask })).toBe(base);
    expect(questionFingerprint({ ...ask, recommendation: 'no, wait' })).not.toBe(base);
    expect(questionFingerprint({ ...ask, question: 'Pay it late?' })).not.toBe(base);
    expect(questionFingerprint({ ...ask, situation: 'The venue has moved the deadline.' })).not.toBe(base);
    expect(questionFingerprint({ ...ask, if_unanswered: 'the date goes' })).not.toBe(base);
    expect(questionFingerprint({ ...ask, options: [ask.options[1]!, ask.options[0]!] })).not.toBe(base);
    expect(questionFingerprint({ ...ask, options: [{ ...ask.options[0]!, consequence: 'something else' }, ask.options[1]!] })).not.toBe(base);
    // And it survives the round trip through the store, or the value the page
    // draws would never match the one the route computes.
    const s = new Store(':memory:');
    const t = create(s);
    s.returnToHuman(builder, t.id, ask);
    expect(reading(s).tickets[0]!.asks!.fingerprint).toBe(questionFingerprint(s.getTicket(t.id).question!));
  });

  it('leaves options out entirely when the recommendation stands alone', () => {
    const s = new Store(':memory:');
    const t = create(s);
    s.returnToHuman(builder, t.id, { ...ask, options: undefined });
    const asks = reading(s).tickets[0]!.asks!;
    // Absent, not empty: a reader asking "is there a choice here" should be
    // reading one key, not measuring a list.
    expect(asks.options).toBeUndefined();
    expect(asks.recommendation).toBe(ask.recommendation);
  });

  it('letters three options a, b, c', () => {
    const s = new Store(':memory:');
    const t = create(s);
    s.returnToHuman(builder, t.id, {
      ...ask,
      options: [
        { label: 'yes', consequence: 'one route' },
        { label: 'no', consequence: 'the shell opens the store' },
        { label: 'later', consequence: 'the phone lands on nothing until then' },
      ],
    });
    expect(reading(s).tickets[0]!.asks!.options!.map((o) => o.letter)).toEqual(['a', 'b', 'c']);
  });

  it('letters a question stored before the cap rather than refusing to draw it', () => {
    // The contract caps a new return at three. A question written when four
    // were allowed is still in the record, and the reading is not the place it
    // gets dropped — the queue would just stop showing what it asks.
    const four: Question = {
      ...ask,
      options: ['w', 'x', 'y', 'z'].map((label) => ({ label, consequence: `picks ${label}` })),
    };
    const s = new Store(':memory:');
    const t = create(s);
    const stale = { ...s.getTicket(create(s).id), id: t.id, status: 'awaiting_human' as const, question: four };
    expect(feed([stale], s.actorKinds()).tickets[0]!.asks!.options!.map((o) => o.letter)).toEqual(['a', 'b', 'c', 'd']);
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
      env: { ...process.env, HELMO_DB: db, HELMO_VIEW_PORT: String(port), HELMO_VIEW_HOST: '127.0.0.1', HELMO_OPERATOR: 'arthur' },
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
    const body = (await res!.json()) as { generated_at: string; answer_nonce: string; tickets: { id: string; asks?: FeedAsk; progress?: { note: string } }[] };
    expect(Number.isFinite(Date.parse(body.generated_at))).toBe(true);
    expect(body.tickets.map((x) => x.id)).toEqual([t.id]);
    expect(body.tickets[0]!.asks!.question).toBe(ask.question);
    expect(body.tickets[0]!.asks!.recommendation).toBe(ask.recommendation);
    expect(body.tickets[0]!.asks!.options!.map((o) => o.letter)).toEqual(['a', 'b']);
    expect(body.tickets[0]!.progress?.note).toBe('last <recorded> & update');

    expect(body.answer_nonce).toMatch(/^[0-9a-f]{32}$/);
    const post = (payload: unknown) =>
      fetch(`http://127.0.0.1:${port}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-helmo-answer': body.answer_nonce },
        body: JSON.stringify(payload),
      });
    // Over the wire as well as in the unit: a ratification that names another
    // question is refused, and the old free-text payload no longer writes.
    const stale = await post({ ticket_id: t.id, ratify: true, question_fingerprint: '0'.repeat(16) });
    expect(stale.status).toBe(409);
    const legacy = await post({ ticket_id: t.id, reasoning: 'drop it', resolution: 'cancelled' });
    expect(legacy.status).toBe(400);
    const answered = await post({ ticket_id: t.id, ratify: true, question_fingerprint: body.tickets[0]!.asks!.fingerprint });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ ok: true, id: t.id, status: 'open' });
    const inspect = new Store(db);
    expect(inspect.lastAnswer(t.id)).toMatchObject({
      answer: 'Ratified from the dashboard',
      chosen_option: ask.recommendation,
      resolution: 'resume',
    });
    expect(inspect.getEvents(t.id).find((event) => event.event_type === 'answered')?.actor).toMatchObject({
      name: 'arthur', kind: 'human', session: 'dashboard',
    });
    inspect.close();
    const after = (await (await fetch(url)).json()) as { tickets: { id: string; asks?: FeedAsk }[] };
    expect(after.tickets[0]).not.toHaveProperty('asks');
  }, 30_000);
});
