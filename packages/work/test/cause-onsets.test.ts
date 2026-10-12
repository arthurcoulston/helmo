import { afterEach, describe, expect, test, vi } from 'vitest';
import { Store } from '../src/store.js';
import type { Actor, CapacityHold } from '../src/types.js';

const actor: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1' };
const human: Actor = { name: 'arthur', kind: 'human' };
const hold = (reason: string): CapacityHold => ({ reason, provenance: 'a test', reconsider_when: 'never' });
const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); vi.useRealTimers(); });

const at = (iso: string) => vi.setSystemTime(new Date(iso));
const fresh = () => { const s = new Store(':memory:'); stores.push(s); return s; };
const file = (s: Store, extra: Partial<Parameters<Store['createTicket']>[1]> = {}) =>
  s.createTicket(actor, { title: 'a ticket', body: 'b', workstream: 'w', type: 'build', ...extra });
const onset = (s: Store, id: string, cause: string) =>
  s.causeOnsets([id]).find((o) => o.cause === cause) ?? null;

describe('causeOnsets', () => {
  test('dates a hold to the write that recorded it, not to the reading', () => {
    vi.useFakeTimers();
    at('2026-03-01T00:00:00.000Z');
    const s = fresh();
    const t = file(s);
    at('2026-03-05T12:00:00.000Z');
    s.updateTicket(actor, { ticket_id: t.id, capacity_hold: hold('parked'), note: 'held' });
    at('2026-03-20T00:00:00.000Z');
    expect(onset(s, t.id, 'hold')).toEqual({ id: t.id, cause: 'hold', at: '2026-03-05T12:00:00.000Z', source: 'updated' });
  });

  test('a hold amended mid-run keeps the original onset, because the cause never lapsed', () => {
    vi.useFakeTimers();
    at('2026-03-01T00:00:00.000Z');
    const s = fresh();
    const t = file(s);
    at('2026-03-02T00:00:00.000Z');
    s.updateTicket(actor, { ticket_id: t.id, capacity_hold: hold('first reason'), note: 'held' });
    at('2026-03-09T00:00:00.000Z');
    s.updateTicket(actor, { ticket_id: t.id, capacity_hold: hold('the reason, restated'), note: 'reworded' });
    expect(onset(s, t.id, 'hold')?.at).toBe('2026-03-02T00:00:00.000Z');
  });

  test('a hold lifted and re-applied dates to the later run, not the first one', () => {
    vi.useFakeTimers();
    at('2026-03-01T00:00:00.000Z');
    const s = fresh();
    const t = file(s);
    at('2026-03-02T00:00:00.000Z');
    s.updateTicket(actor, { ticket_id: t.id, capacity_hold: hold('first'), note: 'held' });
    at('2026-03-03T00:00:00.000Z');
    s.updateTicket(actor, { ticket_id: t.id, capacity_hold: null, note: 'released' });
    at('2026-03-10T00:00:00.000Z');
    s.updateTicket(actor, { ticket_id: t.id, capacity_hold: hold('again'), note: 'held again' });
    expect(onset(s, t.id, 'hold')?.at).toBe('2026-03-10T00:00:00.000Z');
  });

  test('a gate set at filing dates to the created event, which carries no diff at all', () => {
    vi.useFakeTimers();
    at('2026-03-01T09:00:00.000Z');
    const s = fresh();
    const t = file(s, { not_before: '2026-09-01' });
    expect(onset(s, t.id, 'date_gate')).toEqual({ id: t.id, cause: 'date_gate', at: '2026-03-01T09:00:00.000Z', source: 'created' });
  });

  test('a gate moved later keeps the onset of the run, since the work was withheld throughout', () => {
    vi.useFakeTimers();
    at('2026-03-01T00:00:00.000Z');
    const s = fresh();
    const t = file(s, { not_before: '2026-04-01' });
    at('2026-03-15T00:00:00.000Z');
    s.updateTicket(actor, { ticket_id: t.id, not_before: '2026-05-01', note: 'pushed out' });
    expect(onset(s, t.id, 'date_gate')?.at).toBe('2026-03-01T00:00:00.000Z');
  });

  test('a cleared gate yields no onset at all, because the cause is not in force', () => {
    vi.useFakeTimers();
    at('2026-03-01T00:00:00.000Z');
    const s = fresh();
    const t = file(s, { not_before: '2026-04-01' });
    at('2026-03-15T00:00:00.000Z');
    s.updateTicket(actor, { ticket_id: t.id, not_before: '', note: 'opened now' });
    expect(s.causeOnsets([t.id])).toEqual([]);
  });

  test('a returned question dates missing_human_input, which writes no status diff', () => {
    vi.useFakeTimers();
    at('2026-03-01T00:00:00.000Z');
    const s = fresh();
    const t = file(s, { status: 'in_progress', assignee: 'mason' });
    at('2026-03-04T08:30:00.000Z');
    s.returnToHuman(actor, t.id, { situation: 's', question: 'q', recommendation: 'r' });
    expect(onset(s, t.id, 'missing_human_input')).toEqual({ id: t.id, cause: 'missing_human_input', at: '2026-03-04T08:30:00.000Z', source: 'returned' });
  });

  test('an answered question leaves no onset behind', () => {
    vi.useFakeTimers();
    at('2026-03-01T00:00:00.000Z');
    const s = fresh();
    const t = file(s, { status: 'in_progress', assignee: 'mason' });
    at('2026-03-04T00:00:00.000Z');
    s.returnToHuman(actor, t.id, { situation: 's', question: 'q', recommendation: 'r' });
    at('2026-03-05T00:00:00.000Z');
    s.answerTicket(human, t.id, { answer: 'do it', resolution: 'resume' });
    expect(s.causeOnsets([t.id])).toEqual([]);
  });

  test('a pending action is dated too, and its own returned event is the source', () => {
    vi.useFakeTimers();
    at('2026-03-01T00:00:00.000Z');
    const s = fresh();
    const t = file(s, { status: 'in_progress', assignee: 'mason' });
    at('2026-03-06T00:00:00.000Z');
    s.requestAction(actor, t.id, { situation: 's', action: 'click the thing', why_human: 'only his hands reach it' });
    expect(onset(s, t.id, 'missing_human_input')?.at).toBe('2026-03-06T00:00:00.000Z');
  });

  test('a sitting marked at filing is dated from the created payload', () => {
    vi.useFakeTimers();
    at('2026-03-02T07:00:00.000Z');
    const s = fresh();
    const t = file(s, { needs_human: 'Five minutes in the dashboard' });
    expect(onset(s, t.id, 'missing_human_input')).toEqual({ id: t.id, cause: 'missing_human_input', at: '2026-03-02T07:00:00.000Z', source: 'created' });
  });

  test('a cleared sitting marker is not an onset', () => {
    vi.useFakeTimers();
    at('2026-03-02T00:00:00.000Z');
    const s = fresh();
    const t = file(s, { needs_human: 'Ten minutes at the dashboard to answer this' });
    at('2026-03-03T00:00:00.000Z');
    s.updateTicket(actor, { ticket_id: t.id, needs_human: false, note: 'sat with him' });
    expect(s.causeOnsets([t.id])).toEqual([]);
  });

  test('two human conditions at once date to the EARLIER, since the cause held from then', () => {
    vi.useFakeTimers();
    at('2026-03-01T00:00:00.000Z');
    const s = fresh();
    const t = file(s, { status: 'in_progress', assignee: 'mason', needs_human: 'Ten minutes at the dashboard, marked first' });
    at('2026-03-08T00:00:00.000Z');
    s.returnToHuman(actor, t.id, { situation: 's', question: 'q', recommendation: 'r' });
    const found = onset(s, t.id, 'missing_human_input');
    expect(found?.at).toBe('2026-03-01T00:00:00.000Z');
    expect(found?.source).toBe('created');
  });

  test('a hold and a gate on one ticket are dated separately, so the projection reads the one its exclusion names', () => {
    vi.useFakeTimers();
    at('2026-03-01T00:00:00.000Z');
    const s = fresh();
    const t = file(s, { not_before: '2026-06-01' });
    at('2026-03-11T00:00:00.000Z');
    s.updateTicket(actor, { ticket_id: t.id, capacity_hold: hold('also held'), note: 'held' });
    expect(s.causeOnsets([t.id]).map((o) => [o.cause, o.at])).toEqual([
      ['hold', '2026-03-11T00:00:00.000Z'],
      ['date_gate', '2026-03-01T00:00:00.000Z'],
    ]);
  });

  test('a ticket with no cause in force, and an unknown id, each yield nothing rather than throwing', () => {
    const s = fresh();
    const t = file(s);
    expect(s.causeOnsets([t.id, 'H-nonexistent'])).toEqual([]);
    expect(s.causeOnsets([])).toEqual([]);
  });

  test('many ids are answered in one pass, each with its own instants', () => {
    vi.useFakeTimers();
    at('2026-03-01T00:00:00.000Z');
    const s = fresh();
    const a = file(s);
    const b = file(s);
    at('2026-03-04T00:00:00.000Z');
    s.updateTicket(actor, { ticket_id: a.id, capacity_hold: hold('a'), note: 'held' });
    at('2026-03-17T00:00:00.000Z');
    s.updateTicket(actor, { ticket_id: b.id, capacity_hold: hold('b'), note: 'held' });
    expect(s.causeOnsets([a.id, b.id])).toEqual([
      { id: a.id, cause: 'hold', at: '2026-03-04T00:00:00.000Z', source: 'updated' },
      { id: b.id, cause: 'hold', at: '2026-03-17T00:00:00.000Z', source: 'updated' },
    ]);
  });
});

describe('causeOnsets: clearing paths that write no diff', () => {
  test('an answer that lifts the sitting marker ends the cause, though no needs_human diff is written', () => {
    vi.useFakeTimers();
    at('2026-03-01T00:00:00.000Z');
    const s = fresh();
    const t = file(s, { status: 'in_progress', assignee: 'mason', needs_human: 'Ten minutes at the dashboard, marked first' });
    at('2026-03-08T00:00:00.000Z');
    s.returnToHuman(actor, t.id, { situation: 's', question: 'q', recommendation: 'r' });
    at('2026-03-09T00:00:00.000Z');
    s.answerTicket(human, t.id, { answer: 'carry on', resolution: 'resume' });
    // Both conditions are gone: the question is answered and the marker lifted
    // by the same `answered` event. Nothing in the diffs says the second part.
    expect(s.getTicket(t.id).needs_human).toBe(false);
    expect(s.causeOnsets([t.id])).toEqual([]);
  });
  test('a question answered and then asked again dates to the LATER wait, not the first one', () => {
    vi.useFakeTimers();
    at('2026-03-01T00:00:00.000Z');
    const s = fresh();
    const t = file(s, { status: 'in_progress', assignee: 'mason' });
    at('2026-03-02T00:00:00.000Z');
    s.returnToHuman(actor, t.id, { situation: 's', question: 'first', recommendation: 'r' });
    at('2026-03-03T00:00:00.000Z');
    s.answerTicket(human, t.id, { answer: 'carry on', resolution: 'resume' });
    at('2026-03-18T00:00:00.000Z');
    s.returnToHuman(actor, t.id, { situation: 's', question: 'second', recommendation: 'r' });
    // The ticket is awaiting now and was awaiting on 2026-03-02, but not
    // throughout: dating this to the first question would hand a reader checking
    // in on the 10th a wait that had already been answered.
    expect(onset(s, t.id, 'missing_human_input')?.at).toBe('2026-03-18T00:00:00.000Z');
  });
  test('a sitting marker lifted and re-marked dates to the later run', () => {
    vi.useFakeTimers();
    at('2026-03-01T00:00:00.000Z');
    const s = fresh();
    const t = file(s, { needs_human: 'Ten minutes at the dashboard, first time' });
    at('2026-03-02T00:00:00.000Z');
    s.updateTicket(actor, { ticket_id: t.id, needs_human: false, note: 'sat with him' });
    at('2026-03-14T00:00:00.000Z');
    s.updateTicket(actor, { ticket_id: t.id, needs_human: 'Ten minutes at the dashboard, once more', note: 'needs him again' });
    expect(onset(s, t.id, 'missing_human_input')?.at).toBe('2026-03-14T00:00:00.000Z');
  });
});
