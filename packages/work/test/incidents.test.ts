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
