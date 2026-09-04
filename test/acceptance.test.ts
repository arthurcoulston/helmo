import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'gpt-5.6-sol', version: 'codex-cli 0.153.2' };
const proof: Actor = { name: 'proof', kind: 'agent', model: 'gpt-6-astra', version: 'rev 0.4' };
const sha = (digit: string) => `helmo@${digit.repeat(40)}`;

function ticket(s: Store, type = 'build') {
  return s.createTicket(builder, {
    title: 'Ship the acceptance gate',
    body: 'Add an independent product acceptance record bound to immutable source.',
    workstream: 'helmo-dev',
    type,
    status: 'in_progress',
  });
}

function complete(s: Store, id: string, ref = sha('a'), author = builder.name) {
  return s.recordProductCompletion(builder, {
    ticket_id: id,
    artifacts: [{ ref, author }],
    note: 'This exact source is ready for review.',
  });
}

describe('explicit product acceptance', () => {
  it('accepts only a non-author verdict against the exact completed refs', () => {
    const s = new Store(':memory:');
    const t = ticket(s);
    expect(complete(s, t.id)).toMatchObject({ state: 'pending', reason: 'missing_verdict' });
    const accepted = s.recordAcceptanceVerdict(proof, {
      ticket_id: t.id,
      refs: [sha('a')],
      verdict: 'pass',
      note: 'The acceptance suite passes against this source.',
    });
    expect(accepted).toMatchObject({
      state: 'accepted',
      reason: 'independently_accepted',
      verdict: { actor: proof, refs: [sha('a')], verdict: 'pass' },
    });
    expect(s.productAcceptance(t.id, [sha('a')]).state).toBe('accepted');
    expect(s.productAcceptance(t.id, [sha('b')])).toMatchObject({ state: 'pending', reason: 'stale_verdict' });
  });

  it('does not accept a completion with no verdict', () => {
    const s = new Store(':memory:');
    const t = ticket(s);
    complete(s, t.id);
    expect(s.productAcceptance(t.id)).toMatchObject({ state: 'pending', reason: 'missing_verdict', verdict: null });
  });

  it('rejects self-certification by the completion recorder even when the declared author is someone else', () => {
    const s = new Store(':memory:');
    const t = ticket(s);
    complete(s, t.id, sha('a'), 'pair-author');
    expect(() => s.recordAcceptanceVerdict(builder, {
      ticket_id: t.id,
      refs: [sha('a')],
      verdict: 'pass',
      note: 'I declare my own remediation passed.',
    })).toThrow(/cannot accept/);
    expect(s.productAcceptance(t.id)).toMatchObject({ state: 'pending', reason: 'missing_verdict' });
  });

  it('rejects a reviewer named as an artifact author', () => {
    const s = new Store(':memory:');
    const t = ticket(s);
    complete(s, t.id, sha('a'), proof.name);
    expect(() => s.recordAcceptanceVerdict(proof, {
      ticket_id: t.id,
      refs: [sha('a')],
      verdict: 'pass',
      note: 'Reviewing my own commit.',
    })).toThrow(/cannot accept/);
  });

  it('records FAIL, then makes it stale when remediation is handed back', () => {
    const s = new Store(':memory:');
    const t = ticket(s);
    complete(s, t.id);
    expect(s.recordAcceptanceVerdict(proof, {
      ticket_id: t.id,
      refs: [sha('a')],
      verdict: 'fail',
      note: 'The negative case still prints green.',
    })).toMatchObject({ state: 'failed', reason: 'review_failed' });

    complete(s, t.id, sha('b'));
    expect(s.productAcceptance(t.id)).toMatchObject({ state: 'pending', reason: 'stale_verdict', verdict: null });
    expect(() => s.recordAcceptanceVerdict(proof, {
      ticket_id: t.id,
      refs: [sha('a')],
      verdict: 'pass',
      note: 'This was the old source.',
    })).toThrow(/do not match/);
    expect(s.recordAcceptanceVerdict(proof, {
      ticket_id: t.id,
      refs: [sha('b')],
      verdict: 'pass',
      note: 'The remediated source passes.',
    }).state).toBe('accepted');
  });

  it('requires full immutable commit refs and survives event-log rebuild', () => {
    const s = new Store(':memory:');
    const t = ticket(s);
    expect(() => complete(s, t.id, 'helmo@abc1234')).toThrow(/not immutable/);
    complete(s, t.id);
    s.recordAcceptanceVerdict(proof, { ticket_id: t.id, refs: [sha('a')], verdict: 'pass', note: 'Passed.' });
    const before = s.productAcceptance(t.id);
    s.rebuild();
    expect(s.productAcceptance(t.id)).toEqual(before);
  });

  it('leaves ordinary review closure valid and can attach acceptance to terminal history', () => {
    const s = new Store(':memory:');
    const t = ticket(s, 'review');
    s.updateTicket(builder, {
      ticket_id: t.id,
      status: 'done',
      note: 'The documentation review is complete.',
      evidence: [{ kind: 'file', ref: '/tmp/review.txt' }],
    });
    expect(s.productAcceptance(t.id)).toMatchObject({ state: 'not_requested', reason: 'no_completion' });
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: 'reopen it', status: 'open' })).toThrow(/terminal/);
    expect(() => complete(s, t.id)).not.toThrow();
    expect(s.getTicket(t.id).status).toBe('done');
  });
});
