// POST /answer, the one route on the dashboard that writes (H-90) — and since
// H-1052 the one the estate shell carries from Arthur's phone, which is why
// its refusals are pinned here rather than trusted to the buttons that call
// it. Ward's review (H-1053) found the route still honouring the free-text
// payload of a form that no longer exists on any page: a caller reaching this
// origin could record any answer, or close and cancel a ticket, as Arthur.
import { describe, expect, it } from 'vitest';
import { answerRequest, ANSWER_HEADER } from '../src/answer.js';
import { questionFingerprint } from '../src/presentation.js';
import { Store } from '../src/store.js';
import { Actor, Question } from '../src/types.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'claude-opus-5', version: '0.5' };

const ask: Question = {
  situation: 'The deposit is due Friday and the venue holds nothing without it.',
  question: 'Pay the deposit?',
  options: [],
  recommendation: 'pay it — the date matters more than the money',
};

function asking(): { store: Store; id: string; fingerprint: string } {
  const store = new Store(':memory:');
  const t = store.createTicket(builder, {
    title: 'Book the venue',
    body: 'Goal: hold the date. Constraint: deposit is non-refundable.',
    workstream: 'estate-ui',
    type: 'build',
  });
  store.returnToHuman(builder, t.id, ask);
  return { store, id: t.id, fingerprint: questionFingerprint(store.getTicket(t.id).question!) };
}

const ctx = (store: Store) => ({ operator: 'arthur', nonce: 'n0nce', sameOrigin: new Set(['http://127.0.0.1:4400']), store });
const headers = (over: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  [ANSWER_HEADER]: 'n0nce',
  ...over,
});

describe('the answer route', () => {
  it('ratifies the recommendation on the question that was on screen', () => {
    const { store, id, fingerprint } = asking();
    const out = answerRequest(headers(), JSON.stringify({ ticket_id: id, ratify: true, question_fingerprint: fingerprint }), ctx(store));
    expect(out.code).toBe(200);
    const after = store.getTicket(id);
    expect(after.status).toBe('open');
    expect(store.lastAnswer(id)?.chosen_option).toBe(ask.recommendation);
    // Recorded as the human it was configured for, through the channel it
    // came in on — an answer with no meeting behind it says so.
    const answered = store.getEvents(id).find((e) => e.event_type === 'answered')!;
    expect(answered.actor).toMatchObject({ name: 'arthur', kind: 'human', session: 'dashboard' });
  });

  it('refuses the free-text payload the old form used to send', () => {
    const { store, id } = asking();
    const legacy = [
      { ticket_id: id, reasoning: 'no, do the other thing', resolution: 'resume' },
      { ticket_id: id, reasoning: 'drop it', resolution: 'cancelled' },
      { ticket_id: id, chosen_option: 'b', resolution: 'done' },
    ];
    for (const body of legacy) {
      const out = answerRequest(headers(), JSON.stringify(body), ctx(store));
      expect(out.code).toBe(400);
    }
    // Nothing was recorded, and above all nothing was closed.
    expect(store.getTicket(id).status).toBe('awaiting_human');
    expect(store.lastAnswer(id)).toBeNull();
  });

  it('will not ratify without saying which question it means', () => {
    const { store, id } = asking();
    const out = answerRequest(headers(), JSON.stringify({ ticket_id: id, ratify: true }), ctx(store));
    expect(out.code).toBe(400);
    expect(store.getTicket(id).status).toBe('awaiting_human');
  });

  it('refuses a click on a card whose question has been replaced since it drew', () => {
    // The phone case: the card sits, another session answers, the agent comes
    // back with a different question — and the button under Arthur's thumb is
    // still pointing at the ticket. Consent belongs to the ask, not the id.
    const { store, id, fingerprint } = asking();
    answerRequest(headers(), JSON.stringify({ ticket_id: id, ratify: true, question_fingerprint: fingerprint }), ctx(store));
    store.returnToHuman(builder, id, { ...ask, recommendation: 'cancel the booking and eat the fee' });
    const stale = answerRequest(headers(), JSON.stringify({ ticket_id: id, ratify: true, question_fingerprint: fingerprint }), ctx(store));
    expect(stale.code).toBe(409);
    expect(store.getTicket(id).status).toBe('awaiting_human');
    expect(store.lastAnswer(id)?.chosen_option).toBe(ask.recommendation);
  });

  it('takes the second of two clicks as nothing at all', () => {
    const { store, id, fingerprint } = asking();
    const body = JSON.stringify({ ticket_id: id, ratify: true, question_fingerprint: fingerprint });
    expect(answerRequest(headers(), body, ctx(store)).code).toBe(200);
    expect(answerRequest(headers(), body, ctx(store)).code).toBe(400);
    expect(store.getEvents(id).filter((e) => e.event_type === 'answered')).toHaveLength(1);
  });

  it('holds its browser gates and its operator switch', () => {
    const { store, id, fingerprint } = asking();
    const body = JSON.stringify({ ticket_id: id, ratify: true, question_fingerprint: fingerprint });
    expect(answerRequest(headers(), body, { ...ctx(store), operator: null }).code).toBe(403);
    expect(answerRequest(headers({ 'content-type': 'text/plain' }), body, ctx(store)).code).toBe(403);
    expect(answerRequest(headers({ origin: 'https://example.invalid' }), body, ctx(store)).code).toBe(403);
    expect(answerRequest(headers({ 'sec-fetch-site': 'cross-site' }), body, ctx(store)).code).toBe(403);
    expect(answerRequest(headers({ [ANSWER_HEADER]: 'stale' }), body, ctx(store)).code).toBe(403);
    expect(answerRequest(headers(), 'ticket_id=' + id, ctx(store)).code).toBe(400);
    expect(store.getTicket(id).status).toBe('awaiting_human');
  });
});
