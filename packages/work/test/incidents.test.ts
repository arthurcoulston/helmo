import { afterEach, describe, expect, test } from 'vitest';
import { Store } from '../src/store.js';
import type { Actor } from '../src/types.js';

const actor: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1' };
const at = '2026-01-01T00:00:00.000Z';
const known = <T>(value: T, source_ref = 'work:event:1', recorded_at = at) => ({ state: 'known' as const, value, source_ref, recorded_at });
const unknown = { state: 'unknown' as const, reason: 'not_recorded' as const };
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function opened(store: Store) {
  const ticket = store.createTicket(actor, { title: 'Service interruption', body: 'Fixture', workstream: 'ops', type: 'incident' });
  store.recordIncidentEvent(actor, ticket.id, {
    stage: known('investigating'), owner: known('mason'), detection: known({ by: 'human', happened_at: at }),
    affected: known('operator view'), happening_now: known(true), cause: unknown, containment: unknown,
    fix: unknown, recovery_evidence: [], recurrence_evidence: [], human_report_acknowledgement: unknown,
    remaining_work: [],
  }, at);
  return ticket.id;
}

describe('incident projection', () => {
  test('guards ordered transitions and does not mistake mitigation for resolution', () => {
    const store = new Store(':memory:'); stores.push(store); const id = opened(store);
    expect(() => store.recordIncidentEvent(actor, id, { stage: known('resolved') })).toThrow(/not allowed/);
    expect(() => store.recordIncidentEvent(actor, id, { stage: known('mitigated') })).toThrow(/containment/);
    store.recordIncidentEvent(actor, id, { stage: known('mitigated'), containment: known('service disabled'), happening_now: known(false) });
    expect(store.incident(id)?.stage).toEqual(known('mitigated'));
    expect(() => store.recordIncidentEvent(actor, id, { stage: known('resolved') })).toThrow(/cause/);
  });

  test('requires recovery rather than recurrence evidence and preserves human acknowledgement separately', () => {
    const store = new Store(':memory:'); stores.push(store); const id = opened(store);
    store.recordIncidentEvent(actor, id, { stage: known('mitigated'), containment: known('traffic stopped') });
    expect(() => store.recordIncidentEvent(actor, id, {
      stage: known('resolved'), cause: known({ account: 'bad release pin', confidence: 'known' }), fix: known('pin corrected'),
      recurrence_evidence: [known({ ref: 'check:red' })],
    })).toThrow(/recovery evidence/);
    const done = store.recordIncidentEvent(actor, id, {
      stage: known('resolved'), cause: known({ account: 'bad release pin', confidence: 'known' }), fix: known('pin corrected'),
      recovery_evidence: [known({ ref: 'check:green' })], human_report_acknowledgement: known({ acknowledged_at: at }),
    });
    expect(done.recovery_evidence[0]).toEqual(known({ ref: 'check:green' }));
    expect(done.human_report_acknowledgement).toEqual(known({ acknowledged_at: at }));
  });
});

describe('incident notices', () => {
  const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();

  test('identification, material change and resolution are each a notice, and a re-record of the same values is not', () => {
    const store = new Store(':memory:'); stores.push(store); const id = opened(store);
    // The same values again, stamped as every real write path stamps them —
    // its own source and a later instant. Nothing has changed, and a reader
    // told otherwise learns to ignore the next notice.
    store.recordIncidentEvent(actor, id, {
      stage: known('investigating', 'work:event:2', later(5)), affected: known('operator view', 'work:event:2', later(5)),
    }, later(5));
    // Proof accumulating is not news on its own; the stage move that makes it
    // matter is what he hears about.
    store.recordIncidentEvent(actor, id, { recurrence_evidence: [known({ ref: 'check:red' })] }, later(10));
    store.recordIncidentEvent(actor, id, { stage: known('mitigated'), containment: known('service disabled'), happening_now: known(false) }, later(15));
    store.recordIncidentEvent(actor, id, {
      stage: known('resolved'), cause: known({ account: 'bad release pin', confidence: 'known' }), fix: known('pin corrected'),
      recovery_evidence: [known({ ref: 'check:green' })],
    }, later(20));

    const board = store.incidentNotices(later(30));
    expect(board.rows.map((row) => [row.moment, row.at])).toEqual([
      ['resolved', later(20)],
      ['material_change', later(15)],
      ['identified', at],
    ]);
    expect(board.rows[0]!.changed).toEqual(['stage', 'cause', 'fix']);
    expect(board.rows[1]!.changed).toEqual(['stage', 'happening_now', 'containment']);
    // Identification names no change: there was nothing to change from.
    expect(board.rows[2]!.changed).toEqual([]);
    expect(board.rows[2]!.happening_now).toBe(true);
    expect(board.unresolved).toEqual([]);
  });

  test('an unresolved incident never ages off the board, and a resolved one does', () => {
    const store = new Store(':memory:'); stores.push(store); const id = opened(store);
    const week = new Date(Date.parse(at) + 7 * 24 * 60 * 60 * 1000).toISOString();

    const open = store.incidentNotices(week);
    expect(open.rows.map((row) => row.moment)).toEqual(['identified']);
    expect(open.unresolved).toEqual([id]);
    expect(open.window_started_at > at).toBe(true);

    store.recordIncidentEvent(actor, id, { stage: known('mitigated'), containment: known('service disabled') }, later(15));
    store.recordIncidentEvent(actor, id, {
      stage: known('resolved'), cause: known({ account: 'bad release pin', confidence: 'known' }), fix: known('pin corrected'),
      recovery_evidence: [known({ ref: 'check:green' })],
    }, later(20));

    const closed = store.incidentNotices(week);
    expect(closed.rows).toEqual([]);
    // The day window hid them; it did not delete them, and the card says how
    // many it is not showing.
    expect(closed.total).toBe(3);
    expect(closed.unresolved).toEqual([]);
  });

  test('a notice is never raised by withholding the ticket from the agents', () => {
    const store = new Store(':memory:'); stores.push(store); const id = opened(store);
    const ticket = store.getTicket(id);
    expect(ticket.needs_human).toBe(false);
    expect(store.listTickets({ ready: true }).some((row) => row.id === id)).toBe(true);
  });
});
