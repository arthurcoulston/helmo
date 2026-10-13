import { afterEach, describe, expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { CHECK_NEXT_ACTION } from '../src/issue-recording.js';
import type { Actor } from '../src/types.js';

// The production path (H-3216). Before this, hygiene answered "what is wrong
// now" and the issue log could only be written by a fixture, so every row the
// shipped Issues view could show was one a test had put there.

const actor: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1' };
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function store(): Store {
  const s = new Store(':memory:');
  stores.push(s);
  return s;
}

/** A ticket closed with no evidence, which `done_without_evidence` reports, and
 *  which sits in a seatless workstream so `unseated_pool` has something too. */
function closedWithoutEvidence(s: Store, workstream = 'estate-ui'): string {
  const id = s.createTicket(actor, { title: 'Ship the thing', body: 'Goal: ship. Current state: shipped.', workstream, type: 'build', assignee: 'mason', status: 'in_progress' }).id;
  s.updateTicket(actor, { ticket_id: id, status: 'done', note: 'Shipped.', completion_account: { category: 'feature', summary: 'Shipped the thing.' } });
  return id;
}

describe('recording what the checks find', () => {
  test('records one row per current finding, with the check-owned next action and the resolved owner', () => {
    const s = store();
    const id = closedWithoutEvidence(s);
    const recorded = s.recordCheckObservations(actor, '2026-03-01T00:00:00.000Z');

    const mine = recorded.find((r) => r.check === 'done_without_evidence' && r.subject_ref === id);
    expect(mine).toMatchObject({ owner: 'mason' });
    const row = s.issuesSnapshot('2026-03-01T00:00:00.000Z').active.find((r) => r.key === mine!.key)!;
    expect(row).toMatchObject({ subject_kind: 'ticket', subject_ref: id, observation_count: 1, recurrence_count: 0 });
    // The next action is the check's, written in code: a finding's free-text
    // detail never becomes a command.
    expect(row.disposition.state === 'active' && row.disposition.next_action).toEqual({
      state: 'known', value: CHECK_NEXT_ACTION.done_without_evidence,
      source_ref: 'check:done_without_evidence', recorded_at: '2026-03-01T00:00:00.000Z',
    });
    expect(row.detail).toMatchObject({ state: 'known', source_ref: 'work:hygiene:done_without_evidence' });
  });

  test('gives a workstream-scoped finding a workstream subject, not an empty ticket ref', () => {
    const s = store();
    s.createTicket(actor, { title: 'Pool work', body: 'Goal: something. Current state: open.', workstream: 'orphaned-stream', type: 'ops', labels: ['acct:estate'] });
    const recorded = s.recordCheckObservations(actor, '2026-03-01T00:00:00.000Z');

    const pool = recorded.find((r) => r.check === 'unseated_pool');
    expect(pool).toMatchObject({ subject_ref: 'orphaned-stream' });
    const row = s.issuesSnapshot('2026-03-01T00:00:00.000Z').active.find((r) => r.key === pool!.key)!;
    expect(row.subject_kind).toBe('workstream');
    // The stream has no seat — that is the finding — so the owner is a known
    // nobody rather than Unknown: the record does say the seat is empty.
    expect(row.disposition.owner).toMatchObject({ state: 'known', value: null, source_ref: 'work:workstream:orphaned-stream' });
  });

  test('a second sweep moves one row rather than filing a duplicate', () => {
    const s = store();
    const id = closedWithoutEvidence(s);
    const key = s.recordCheckObservations(actor, '2026-03-01T00:00:00.000Z').find((r) => r.subject_ref === id)!.key;
    s.recordCheckObservations(actor, '2026-03-02T00:00:00.000Z');

    const matching = s.issuesSnapshot('2026-03-02T00:00:00.000Z').active.filter((r) => r.key === key);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      observation_count: 2, first_observed_at: '2026-03-01T00:00:00.000Z', latest_observed_at: '2026-03-02T00:00:00.000Z',
    });
  });

  test('a finding that stops being reported leaves its issue active', () => {
    const s = store();
    const id = closedWithoutEvidence(s);
    const key = s.recordCheckObservations(actor, '2026-03-01T00:00:00.000Z').find((r) => r.subject_ref === id)!.key;
    // Suppressing the CHECK is a different act from disposing the ISSUE: the
    // sweep stops seeing it, and the issue is still unresolved.
    s.disposeHygieneFinding(actor, { check: 'done_without_evidence', ticket_id: id, reason: 'Examined; the closure is correct.' });
    expect(s.hygiene().some((f) => f.check === 'done_without_evidence' && f.ticket_id === id)).toBe(false);

    s.recordCheckObservations(actor, '2026-03-05T00:00:00.000Z');
    const row = s.issuesSnapshot('2026-03-05T00:00:00.000Z').active.find((r) => r.key === key)!;
    expect(row).toMatchObject({ observation_count: 1, disposition: { state: 'active' } });
  });
});

describe('disposing a recorded issue', () => {
  function recorded(s: Store, at = '2026-03-01T00:00:00.000Z'): string {
    const id = closedWithoutEvidence(s);
    return s.recordCheckObservations(actor, at).find((r) => r.subject_ref === id)!.key;
  }

  test('names what each judgment is missing instead of recording an empty one', () => {
    const s = store();
    const key = recorded(s);
    expect(() => s.disposeIssue(actor, key, { state: 'accepted' })).toThrow(/needs a reason/);
    expect(() => s.disposeIssue(actor, key, { state: 'active' })).toThrow(/needs a next_action/);
    expect(() => s.disposeIssue(actor, key, { state: 'resolved' })).toThrow(/known evidence/);
    expect(() => s.disposeIssue(actor, 'check|ticket|H-404', { state: 'accepted', reason: 'none' })).toThrow(/no observation/);
  });

  test('resolves with evidence, ages into history, and reopens as recurrence on a later sweep', () => {
    const s = store();
    const key = recorded(s);
    s.disposeIssue(actor, key, { state: 'resolved', evidence: [{ ref: 'helmo@abc1234', note: 'evidence added' }] }, '2026-03-02T00:00:00.000Z');

    // Inside 30 days a resolved row is still shown; after it, History.
    expect(s.issuesSnapshot('2026-03-10T00:00:00.000Z').active.map((r) => r.key)).toContain(key);
    const aged = s.issuesSnapshot('2026-04-20T00:00:00.000Z');
    expect(aged.active.map((r) => r.key)).not.toContain(key);
    expect(aged.history.find((r) => r.key === key)).toMatchObject({ disposition: { state: 'resolved' } });

    s.recordCheckObservations(actor, '2026-04-21T00:00:00.000Z');
    expect(s.issuesSnapshot('2026-04-21T00:00:00.000Z').active.find((r) => r.key === key)).toMatchObject({
      recurrence_count: 1, observation_count: 2, disposition: { state: 'active' },
    });
  });
});

describe('recording an incident', () => {
  function opened(s: Store): string {
    const id = s.createTicket(actor, { title: 'Loop wedged', body: 'Goal: restore the loop. Current state: investigating.', workstream: 'estate-ui', type: 'incident', labels: ['acct:estate'] }).id;
    s.recordIncidentEvent(actor, id, { stage: { state: 'known', value: 'investigating', source_ref: 'test', recorded_at: '2026-03-01T00:00:00.000Z' } }, '2026-03-01T00:00:00.000Z');
    return id;
  }

  test('opens on a patch that names only the stage, leaving every other field an explicit Unknown', () => {
    const s = store();
    const record = s.incident(opened(s))!;
    expect(record.stage).toMatchObject({ state: 'known', value: 'investigating' });
    for (const field of ['owner', 'affected', 'happening_now', 'cause', 'containment', 'fix', 'human_report_acknowledgement'] as const) {
      expect(record[field], field).toEqual({ state: 'unknown', reason: 'not_recorded' });
    }
    expect(record.recovery_evidence).toEqual([]);
  });
});
