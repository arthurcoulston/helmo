// POST /acted, the second write route on the dashboard (R-42 I13). Its
// refusals are pinned here rather than trusted to the one button that calls
// it, for the same reason POST /answer's are: the estate shell carries this
// origin to Arthur's phone, and a route is reachable by anything that can
// reach the origin.
//
// The thing this file is really protecting is the distinction. A decision
// comes back as permission; an action comes back as a report that the world
// changed. If either route could do the other's job, the field that keeps them
// apart in the store is decoration.
import { describe, expect, it } from 'vitest';
import { actedRequest } from '../src/acted.js';
import { answerRequest, ANSWER_HEADER } from '../src/answer.js';
import { actionFingerprint, questionFingerprint } from '../src/presentation.js';
import { Store } from '../src/store.js';
import { ActionRequest, Actor, Question } from '../src/types.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'claude-opus-5', version: '0.6' };

const request: ActionRequest = {
  situation: 'The Worker is deployed and answering, but mail to the new address bounces.',
  action: 'Two clicks in the provider dashboard: add an Email Routing rule for the new address.',
  why_human: 'The dashboard is the only place the rule can be added and no agent holds that account.',
  if_unanswered: 'The address keeps bouncing and the form has nowhere to send its replies.',
};

const decision: Question = {
  situation: 'Both accounts would work and the deposit is due Friday.',
  question: 'Which account should the Worker use?',
  options: [
    { label: 'the company account', consequence: 'one bill, one owner' },
    { label: 'the personal account', consequence: 'nothing to set up today, a migration later' },
  ],
  recommendation: 'the company account',
};

function ticket(store: Store, title: string) {
  return store.createTicket(builder, { title, body: `${title}. Goal, constraints and current state.`, workstream: 'estate-ui', type: 'ops' });
}

function acting(): { store: Store; id: string; fingerprint: string } {
  const store = new Store(':memory:');
  const t = ticket(store, 'Add the routing rule the Worker needs');
  store.requestAction(builder, t.id, request);
  return { store, id: t.id, fingerprint: actionFingerprint(store.getTicket(t.id).action!) };
}

const ctx = (store: Store) => ({ operator: 'arthur', nonce: 'n0nce', sameOrigin: new Set(['http://127.0.0.1:4400']), store });
const headers = (over: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  [ANSWER_HEADER]: 'n0nce',
  ...over,
});

describe('the report route', () => {
  it('records the action the card was drawn for, and resumes the work', () => {
    const { store, id, fingerprint } = acting();
    const out = actedRequest(headers(), JSON.stringify({ ticket_id: id, done: true, action_fingerprint: fingerprint }), ctx(store));
    expect(out.code).toBe(200);
    const after = store.getTicket(id);
    expect(after.status).toBe('open');
    expect(after.action).toBeNull();
    expect(after.question).toBeNull();
    // The whole point of the separate shape: nothing here reads as permission.
    const events = store.getEvents(id);
    const acted = events.filter((e) => e.event_type === 'acted');
    expect(acted).toHaveLength(1);
    expect(events.filter((e) => e.event_type === 'answered')).toHaveLength(0);
    // No words were typed, so none are invented — and the record says so
    // rather than claiming Arthur described what he did.
    const did = (acted[0]!.payload as { did: string }).did;
    expect(did).toContain('no words added');
    expect(did).toContain(request.action);
  });

  it('refuses a report of an action nobody asked for', () => {
    const store = new Store(':memory:');
    const t = ticket(store, 'Nothing pending here');
    const out = actedRequest(headers(), JSON.stringify({ ticket_id: t.id, done: true, action_fingerprint: 'whatever' }), ctx(store));
    expect(out.code).toBe(400);
    expect(String(out.body['error'])).toMatch(/no action waiting/);
  });

  it('refuses to report a DECISION done — that is the confusion it exists to end', () => {
    const store = new Store(':memory:');
    const t = ticket(store, 'Which account should the Worker use');
    store.returnToHuman(builder, t.id, decision);
    const out = actedRequest(
      headers(),
      JSON.stringify({ ticket_id: t.id, done: true, action_fingerprint: questionFingerprint(store.getTicket(t.id).question!) }),
      ctx(store),
    );
    expect(out.code).toBe(400);
    expect(String(out.body['error'])).toMatch(/DECIDE/);
    expect(store.getTicket(t.id).status).toBe('awaiting_human');
  });

  it('refuses to answer an ACTION as though it were a question', () => {
    const { store, id, fingerprint } = acting();
    const ratified = answerRequest(headers(), JSON.stringify({ ticket_id: id, ratify: true, question_fingerprint: fingerprint }), ctx(store));
    expect(ratified.code).toBe(400);
    expect(store.getTicket(id).status).toBe('awaiting_human');
  });

  it('refuses a report bound to a request that is no longer the one on screen', () => {
    const { store, id } = acting();
    const out = actedRequest(headers(), JSON.stringify({ ticket_id: id, done: true, action_fingerprint: 'a stale fingerprint' }), ctx(store));
    expect(out.code).toBe(409);
    expect(store.getTicket(id).status).toBe('awaiting_human');
  });

  it('refuses the same report twice: the second click cannot re-open settled work', () => {
    const { store, id, fingerprint } = acting();
    const body = JSON.stringify({ ticket_id: id, done: true, action_fingerprint: fingerprint });
    expect(actedRequest(headers(), body, ctx(store)).code).toBe(200);
    expect(actedRequest(headers(), body, ctx(store)).code).toBe(400);
  });

  it('carries no free text, no answer, no resolution and no chosen option', () => {
    const { store, id, fingerprint } = acting();
    for (const payload of [
      { did: 'I added the rule and also changed the MX records' },
      { answer: 'go ahead' },
      { resolution: 'done' },
      { chosen_option: 'the company account' },
      { ratify: true },
      { choice: 'a' },
    ]) {
      const out = actedRequest(headers(), JSON.stringify({ ticket_id: id, done: true, action_fingerprint: fingerprint, ...payload }), ctx(store));
      expect(out.code, JSON.stringify(payload)).toBe(400);
      expect(store.getTicket(id).status, JSON.stringify(payload)).toBe('awaiting_human');
    }
  });

  it('will not take a report that does not say done', () => {
    const { store, id, fingerprint } = acting();
    for (const done of [false, 'yes', 1, null]) {
      const out = actedRequest(headers(), JSON.stringify({ ticket_id: id, done, action_fingerprint: fingerprint }), ctx(store));
      expect(out.code, String(done)).toBe(400);
    }
    expect(actedRequest(headers(), JSON.stringify({ ticket_id: id, action_fingerprint: fingerprint }), ctx(store)).code).toBe(400);
    expect(actedRequest(headers(), JSON.stringify({ ticket_id: id, done: true }), ctx(store)).code).toBe(400);
    expect(store.getTicket(id).status).toBe('awaiting_human');
  });

  it('is behind the same operator, origin and token gate as the answer route', () => {
    const { store, id, fingerprint } = acting();
    const body = JSON.stringify({ ticket_id: id, done: true, action_fingerprint: fingerprint });
    expect(actedRequest(headers(), body, { ...ctx(store), operator: null }).code).toBe(403);
    expect(actedRequest(headers({ 'content-type': 'text/plain' }), body, ctx(store)).code).toBe(403);
    expect(actedRequest(headers({ origin: 'https://example.invalid' }), body, ctx(store)).code).toBe(403);
    expect(actedRequest(headers({ 'sec-fetch-site': 'cross-site' }), body, ctx(store)).code).toBe(403);
    expect(actedRequest(headers({ [ANSWER_HEADER]: 'stale' }), body, ctx(store)).code).toBe(403);
    expect(actedRequest(headers(), `ticket_id=${id}`, ctx(store)).code).toBe(400);
    expect(store.getTicket(id).status).toBe('awaiting_human');
  });
});
