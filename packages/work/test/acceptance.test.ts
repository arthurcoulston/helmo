import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'gpt-5.6-sol', version: 'codex-cli 0.153.2', session: 'rev:mason' };
const proof: Actor = { name: 'proof', kind: 'agent', model: 'gpt-6-astra', version: 'rev 0.4', session: 'rev:proof' };
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
  it('lets a non-author review the current completion without taking the builder\'s claim', () => {
    const s = new Store(':memory:');
    const t = ticket(s);
    const pending = complete(s, t.id);
    const refs = pending.completion!.artifacts.map((artifact) => artifact.ref);

    expect(() => s.updateTicket(proof, {
      ticket_id: t.id,
      note: 'Trying to take the builder\'s held ticket.',
      status: 'in_progress',
    })).toThrow(/held by "mason"/);
    expect(s.recordAcceptanceVerdict(proof, {
      ticket_id: t.id,
      refs,
      verdict: 'pass',
      note: 'The current completed source passes independently.',
    })).toMatchObject({ state: 'accepted', reason: 'independently_accepted' });
    expect(s.getTicket(t.id)).toMatchObject({ status: 'in_progress', assignee: 'mason' });
  });

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

  // VERDICT-SET-CONTRACT.md §2 (R-39 A1, H-2432). Before this, the governing
  // verdict was .at(-1): on H-94 a PASS landed 557 ms after a FAIL and erased
  // it from the release path.
  describe('the verdict set', () => {
    const ward: Actor = { name: 'ward', kind: 'agent', model: 'gpt-6-astra', version: 'rev 0.4', session: 'rev:ward' };

    function verdict(s: Store, id: string, actor: Actor, v: 'pass' | 'fail', ref = sha('a')) {
      return s.recordAcceptanceVerdict(actor, { ticket_id: id, refs: [ref], verdict: v, note: `Reviewed: ${v}.` });
    }

    it('keeps a FAIL standing under a later PASS from another reviewer', () => {
      const s = new Store(':memory:');
      const t = ticket(s);
      complete(s, t.id);
      verdict(s, t.id, proof, 'fail');
      const after = verdict(s, t.id, ward, 'pass');
      expect(after).toMatchObject({ state: 'failed', reason: 'contested' });
      expect(after.verdict).toMatchObject({ actor: proof, verdict: 'fail' });
      expect(after.verdicts.map((v) => [v.actor.name, v.verdict])).toEqual([['proof', 'fail'], ['ward', 'pass']]);
    });

    it('reports the same disagreement the same way whichever order it arrives in', () => {
      const s = new Store(':memory:');
      const t = ticket(s);
      complete(s, t.id);
      verdict(s, t.id, ward, 'pass');
      expect(verdict(s, t.id, proof, 'fail')).toMatchObject({ state: 'failed', reason: 'contested' });
    });

    it('separates reviewers who agree it failed from reviewers who disagree', () => {
      const s = new Store(':memory:');
      const t = ticket(s);
      complete(s, t.id);
      verdict(s, t.id, proof, 'fail');
      expect(verdict(s, t.id, ward, 'fail')).toMatchObject({ state: 'failed', reason: 'review_failed' });
    });

    it('lets a reviewer correct their own verdict without anyone overwriting anyone else', () => {
      const s = new Store(':memory:');
      const t = ticket(s);
      complete(s, t.id);
      verdict(s, t.id, proof, 'fail');
      const corrected = verdict(s, t.id, proof, 'pass');
      expect(corrected).toMatchObject({ state: 'accepted', reason: 'independently_accepted' });
      // The superseded opinion is still reported; it is only no longer theirs.
      expect(corrected.verdicts).toHaveLength(2);
      expect(corrected.verdict).toMatchObject({ verdict: 'pass' });
    });

    it('clears a standing FAIL only with a new completion, never with a later PASS', () => {
      const s = new Store(':memory:');
      const t = ticket(s);
      complete(s, t.id);
      verdict(s, t.id, proof, 'fail');
      expect(verdict(s, t.id, ward, 'pass').state).toBe('failed');
      complete(s, t.id, sha('b'));
      expect(s.productAcceptance(t.id)).toMatchObject({ state: 'pending', reason: 'stale_verdict', verdicts: [] });
      expect(verdict(s, t.id, proof, 'pass', sha('b'))).toMatchObject({ state: 'accepted', verdicts: [{ refs: [sha('b')] }] });
    });

    it('keeps one qualifying PASS sufficient — no quorum was introduced here', () => {
      const s = new Store(':memory:');
      const t = ticket(s);
      complete(s, t.id);
      expect(verdict(s, t.id, proof, 'pass')).toMatchObject({ state: 'accepted', reason: 'independently_accepted' });
    });

    it('still accepts a second reviewer at the door, so disagreement is never destroyed on write', () => {
      const s = new Store(':memory:');
      const t = ticket(s);
      complete(s, t.id);
      verdict(s, t.id, proof, 'pass');
      expect(() => verdict(s, t.id, ward, 'fail')).not.toThrow();
      expect(s.getEvents(t.id).filter((e) => e.event_type === 'acceptance_verdict')).toHaveLength(2);
    });

    it('reports no verdicts where there is nothing that qualifies', () => {
      const s = new Store(':memory:');
      const t = ticket(s);
      complete(s, t.id);
      expect(s.productAcceptance(t.id).verdicts).toEqual([]);
    });
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
      status: 'done', completion_account: { category: 'maintenance', summary: 'Closed by a test fixture.' },
      note: 'The documentation review is complete.',
      evidence: [{ kind: 'file', ref: '/tmp/review.txt' }],
    });
    expect(s.productAcceptance(t.id)).toMatchObject({ state: 'not_requested', reason: 'no_completion' });
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: 'reopen it', status: 'open' })).toThrow(/terminal/);
    expect(() => complete(s, t.id)).not.toThrow();
    expect(s.getTicket(t.id).status).toBe('done');
  });
});

// H-3012. The same gate asked from the other end. Crew's publication gate
// holds a commit whose verdict is still outstanding, and it had no read for
// "which completions name this commit" — so it enumerated every live ticket,
// every ticket the outgoing messages name, and one dep hop out of those, and
// was still blind to the case it was written for: H-3002 held the PENDING
// acceptance of three outgoing commits while sitting `done`, named in none of
// their messages.
describe('acceptance holds asked by commit', () => {
  const reviewer: Actor = { name: 'ward', kind: 'agent', model: 'gpt-6-astra', version: 'rev 0.4', session: 'rev:ward' };

  function offer(s: Store, refs: string[], author = builder.name) {
    const t = ticket(s);
    s.recordProductCompletion(builder, {
      ticket_id: t.id,
      artifacts: refs.map((ref) => ({ ref, author })),
      note: 'This exact source is ready for review.',
    });
    return t.id;
  }

  function pass(s: Store, id: string, refs: string[]) {
    s.recordAcceptanceVerdict(reviewer, { ticket_id: id, refs, verdict: 'pass', note: 'Reviewed and cleared.' });
  }

  it('finds the pending hold on a done ticket, which is the case no enumeration reached', () => {
    const s = new Store(':memory:');
    const id = offer(s, [sha('a')]);
    s.updateTicket(builder, { ticket_id: id, status: 'done', completion_account: { category: 'maintenance', summary: 'Closed by a test fixture.' }, note: 'Landed; awaiting the security read.', evidence: [{ kind: 'commit', ref: sha('a') }] });

    expect(s.unresolvedCompletions({ repo: 'helmo' })).toEqual([
      { ticket_id: id, state: 'pending', reason: 'missing_verdict', refs: [sha('a')], completion_seq: expect.any(Number) },
    ]);
    expect(s.getTicket(id).status).toBe('done');
  });

  it('agrees with the per-ticket read on every ticket it returns, and drops the cleared one', () => {
    const s = new Store(':memory:');
    const held = offer(s, [sha('a')]);
    const cleared = offer(s, [sha('b')]);
    pass(s, cleared, [sha('b')]);

    const holds = s.unresolvedCompletions({ repo: 'helmo' });
    expect(holds.map((h) => h.ticket_id)).toEqual([held]);
    for (const hold of holds) {
      const perTicket = s.productAcceptance(hold.ticket_id);
      expect(hold.state).toBe(perTicket.state);
      expect(hold.reason).toBe(perTicket.reason);
    }
    expect(s.productAcceptance(cleared).state).toBe('accepted');
  });

  it('reports a FAIL as failed, so a gate reading state alone still holds', () => {
    const s = new Store(':memory:');
    const id = offer(s, [sha('c')]);
    s.recordAcceptanceVerdict(reviewer, { ticket_id: id, refs: [sha('c')], verdict: 'fail', note: 'The guard cannot fire.' });

    expect(s.unresolvedCompletions({ refs: [sha('c')] })).toMatchObject([{ ticket_id: id, state: 'failed', reason: 'review_failed' }]);
  });

  it('holds only what the CURRENT completion names, because a verdict answers the latest offer', () => {
    const s = new Store(':memory:');
    const id = offer(s, [sha('d')]);
    s.recordProductCompletion(builder, {
      ticket_id: id,
      artifacts: [{ ref: sha('e'), author: builder.name }],
      note: 'The remediation replaces it; review this instead.',
    });

    expect(s.unresolvedCompletions({ refs: [sha('d')] })).toEqual([]);
    expect(s.unresolvedCompletions({ refs: [sha('e')] })).toMatchObject([{ ticket_id: id, refs: [sha('e')] }]);
  });

  it('returns only the refs that were asked about, not the rest of the manifest', () => {
    const s = new Store(':memory:');
    const id = offer(s, [sha('a'), sha('b')]);

    expect(s.unresolvedCompletions({ refs: [sha('b')] })).toMatchObject([{ ticket_id: id, refs: [sha('b')] }]);
    expect(s.unresolvedCompletions({ repo: 'helmo' })).toMatchObject([{ ticket_id: id, refs: [sha('a'), sha('b')] }]);
  });

  it('matches a repo name as an exact prefix, never as a pattern', () => {
    const s = new Store(':memory:');
    // `helmo` must not answer for `helmo-roadmap`, and an underscore in a repo
    // name must not stand for any character — which is what a LIKE would make it.
    const work = offer(s, [`helmo@${'1'.repeat(40)}`]);
    offer(s, [`helmo-roadmap@${'2'.repeat(40)}`]);
    const underscored = offer(s, [`a_c@${'3'.repeat(40)}`]);
    offer(s, [`abc@${'4'.repeat(40)}`]);

    expect(s.unresolvedCompletions({ repo: 'helmo' }).map((h) => h.ticket_id)).toEqual([work]);
    expect(s.unresolvedCompletions({ repo: 'a_c' }).map((h) => h.ticket_id)).toEqual([underscored]);
  });

  it('says nothing is held when nothing was ever offered for those commits', () => {
    const s = new Store(':memory:');
    ticket(s); // a live ticket with no completion at all
    offer(s, [sha('a')]);

    expect(s.unresolvedCompletions({ repo: 'crew' })).toEqual([]);
    expect(s.unresolvedCompletions({ refs: [sha('f')] })).toEqual([]);
  });

  it('refuses a question with no single answer rather than guessing which one was meant', () => {
    const s = new Store(':memory:');
    expect(() => s.unresolvedCompletions({ repo: 'helmo', refs: [sha('a')] })).toThrow(/not both/);
    expect(() => s.unresolvedCompletions({})).toThrow(/Say what to ask about/);
    expect(() => s.unresolvedCompletions({ repo: '' })).toThrow(/requires its name/);
    expect(() => s.unresolvedCompletions({ repo: `helmo@${'a'.repeat(40)}` })).toThrow(/is not a repo name/);
    expect(() => s.unresolvedCompletions({ refs: ['helmo@abc1234'] })).toThrow(/not immutable/);
    expect(() => s.unresolvedCompletions({ refs: [] })).toThrow(/Say what to ask about/);
  });
});

// H-3031. The other end of the same read. `unresolvedCompletions` returns only
// `pending` and `failed`, so an accepted review and a commit nobody ever
// offered are one empty answer — and crew's publication gate, reading that
// silence as "nothing is holding this", left four commits publishable to a
// PUBLIC remote by any seat's push for seven minutes: from a technical PASS
// resolving the only completion naming them until a security clearance was
// first filed (H-3029). The pass is what opened the gate; nothing rode out
// through it. These tests are the two situations told apart.
describe('acceptance coverage: who has judged a commit', () => {
  const ward: Actor = { name: 'ward', kind: 'agent', model: 'gpt-6-astra', version: 'rev 0.4', session: 'rev:ward' };

  function offer(s: Store, refs: string[], author = builder.name) {
    const t = ticket(s);
    s.recordProductCompletion(builder, {
      ticket_id: t.id,
      artifacts: refs.map((ref) => ({ ref, author })),
      note: 'This exact source is ready for review.',
    });
    return t.id;
  }

  function pass(s: Store, id: string, refs: string[], who: Actor) {
    s.recordAcceptanceVerdict(who, { ticket_id: id, refs, verdict: 'pass', note: 'Reviewed and cleared.' });
  }

  it('tells one reviewer having passed apart from nobody having been asked — which the holds read cannot', () => {
    const s = new Store(':memory:');
    const id = offer(s, [sha('a')], 'someone-else');
    pass(s, id, [sha('a')], proof);

    // The defect, stated: both commits read identically to the gate's hold read.
    expect(s.unresolvedCompletions({ refs: [sha('a')] })).toEqual([]);
    expect(s.unresolvedCompletions({ refs: [sha('9')] })).toEqual([]);

    const [reviewed, never] = s.acceptanceCoverage([sha('a'), sha('9')]);
    expect(reviewed).toEqual({
      ref: sha('a'),
      completions: [{
        ticket_id: id,
        state: 'accepted',
        reason: 'independently_accepted',
        completion_seq: expect.any(Number),
        reviewers: [{ name: 'proof', verdict: 'pass', seq: expect.any(Number) }],
      }],
      superseded: [],
    });
    expect(never).toEqual({ ref: sha('9'), completions: [], superseded: [] });
  });

  it('reports each reviewer once, as their own standing verdict, and both sides of a disagreement', () => {
    const s = new Store(':memory:');
    const id = offer(s, [sha('b')], 'someone-else');
    s.recordAcceptanceVerdict(proof, { ticket_id: id, refs: [sha('b')], verdict: 'fail', note: 'The guard cannot fire.' });
    pass(s, id, [sha('b')], proof); // the same reviewer, changing their mind
    s.recordAcceptanceVerdict(ward, { ticket_id: id, refs: [sha('b')], verdict: 'fail', note: 'A secret rides in the history.' });

    const [row] = s.acceptanceCoverage([sha('b')]);
    expect(row.completions[0]!.reviewers).toEqual([
      { name: 'proof', verdict: 'pass', seq: expect.any(Number) },
      { name: 'ward', verdict: 'fail', seq: expect.any(Number) },
    ]);
    // §2.2 governs here exactly as it does in the per-ticket read: proof's
    // earlier FAIL is not a third row, and ward's standing FAIL is the state.
    expect(row.completions[0]!.state).toBe('failed');
    expect(s.productAcceptance(id).reason).toBe('contested');
  });

  it('carries a pending completion too, so an unanswered offer is coverage of a kind', () => {
    const s = new Store(':memory:');
    const id = offer(s, [sha('c')]);

    expect(s.acceptanceCoverage([sha('c')])).toMatchObject([
      { ref: sha('c'), completions: [{ ticket_id: id, state: 'pending', reason: 'missing_verdict', reviewers: [] }] },
    ]);
  });

  it('counts only the standing offer as coverage, and says the dropped commit was once offered', () => {
    const s = new Store(':memory:');
    const id = offer(s, [sha('d')]);
    s.recordProductCompletion(builder, {
      ticket_id: id,
      artifacts: [{ ref: sha('e'), author: builder.name }],
      note: 'The remediation replaces it; review this instead.',
    });

    const [dropped, standing] = s.acceptanceCoverage([sha('d'), sha('e')]);
    expect(dropped).toEqual({ ref: sha('d'), completions: [], superseded: [id] });
    expect(standing.completions.map((c) => c.ticket_id)).toEqual([id]);
    expect(standing.superseded).toEqual([]);
  });

  it('gathers every ticket that offered one commit, oldest offer first', () => {
    const s = new Store(':memory:');
    const first = offer(s, [sha('f')], 'someone-else');
    const second = offer(s, [sha('f'), sha('8')], 'someone-else');
    pass(s, first, [sha('f')], proof);

    const [row] = s.acceptanceCoverage([sha('f')]);
    expect(row.completions.map((c) => [c.ticket_id, c.state])).toEqual([[first, 'accepted'], [second, 'pending']]);
  });

  it('answers about exactly the commits it was asked about, and refuses an unanswerable question', () => {
    const s = new Store(':memory:');
    offer(s, [sha('a'), sha('b')]);

    expect(s.acceptanceCoverage([sha('a')]).map((r) => r.ref)).toEqual([sha('a')]);
    expect(() => s.acceptanceCoverage([])).toThrow(/Say which commits/);
    expect(() => s.acceptanceCoverage(['helmo@abc1234'])).toThrow(/not immutable/);
  });
});
