import { afterEach, describe, expect, test } from 'vitest';
import { Store } from '../src/store.js';
import type { Actor } from '../src/types.js';

const actor: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1' };
const known = <T>(value: T, source_ref: string, recorded_at: string) => ({ state: 'known' as const, value, source_ref, recorded_at });
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe('issues projection', () => {
  test('replays one stable row through resolution and recurrence without aging active work out', () => {
    const store = new Store(':memory:'); stores.push(store);
    const first = '2026-01-01T00:00:00.000Z';
    const key = store.recordIssueObservation(actor, {
      check: 'runtime_failure', subject_kind: 'runtime', subject_ref: 'mason',
      detail: known('worker failed', 'runtime:event:1', first), owner: known('mason', 'work:H-1', first),
      next_action: known('inspect or restart', 'check:runtime_failure', first),
    }, first);
    store.recordIssueObservation(actor, {
      check: 'runtime_failure', subject_kind: 'runtime', subject_ref: 'mason',
      detail: known('worker still failed', 'runtime:event:2', '2026-01-02T00:00:00.000Z'), owner: known('mason', 'work:H-1', first),
      next_action: known('inspect or restart', 'check:runtime_failure', first),
    }, '2026-01-02T00:00:00.000Z');
    store.recordIssueDisposition(actor, key, { state: 'resolved', owner: known('mason', 'work:H-1', first), evidence: [known({ ref: 'run:green' }, 'runtime:event:3', '2026-01-03T00:00:00.000Z')] }, '2026-01-03T00:00:00.000Z');
    expect(store.issuesSnapshot('2026-02-05T00:00:00.000Z')).toMatchObject({ active: [], history: [{ key, observation_count: 2 }] });
    store.recordIssueObservation(actor, {
      check: 'runtime_failure', subject_kind: 'runtime', subject_ref: 'mason',
      detail: known('failed again', 'runtime:event:4', '2026-02-06T00:00:00.000Z'), owner: known('mason', 'work:H-1', first),
      next_action: known('inspect or restart', 'check:runtime_failure', first),
    }, '2026-02-06T00:00:00.000Z');
    expect(store.issuesSnapshot('2026-04-01T00:00:00.000Z').active[0]).toMatchObject({ key, observation_count: 3, recurrence_count: 1, disposition: { state: 'active' } });
  });

  test('refuses resolution without recorded evidence and keeps exact provenance envelopes', () => {
    const store = new Store(':memory:'); stores.push(store);
    const at = '2026-01-01T00:00:00.000Z';
    const key = store.recordIssueObservation(actor, {
      check: 'missing_evidence', subject_kind: 'ticket', subject_ref: 'H-1',
      detail: { state: 'unknown', reason: 'not_recorded' }, owner: known(null, 'work:H-1', at),
      next_action: known('add evidence or correct closure', 'check:missing_evidence', at),
    }, at);
    expect(() => store.recordIssueDisposition(actor, key, { state: 'resolved', owner: known(null, 'work:H-1', at), evidence: [] })).toThrow(/known evidence/);
    expect(store.issuesSnapshot(at).active[0].detail).toEqual({ state: 'unknown', reason: 'not_recorded' });
  });
});
