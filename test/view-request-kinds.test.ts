/* The three hero cards, in the served document (R-42 I13).
 *
 * Arthur's complaint was that he could not tell what a ticket wanted from him:
 * "it is often unclear whether they want him to act or want permission to act
 * themselves". The store answered it first (the `kind` on the request, H-2521);
 * this file is the half he actually reads. It asserts what the page SAYS and
 * what controls it offers, because a distinction that exists only in the
 * database is one the operator never sees.
 *
 * Read against the served bytes rather than the renderer: the renderer is
 * private to view.ts, and the page is what a mistake here would reach.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionFingerprint } from '../src/presentation.js';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';
import { serveRecord } from './support/served-record.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1', session: 'rev:mason' };

const dir = mkdtempSync(join(tmpdir(), 'helmo-kinds-'));
const db = join(dir, 'helmo.db');
let view: ChildProcess | null = null;
let origin = '';
let html = '';
const id: Record<string, string> = {};
let actFingerprint = '';

/** One card's markup, from its own article element to the next one. Asserting
 *  on the whole document would let a string that belongs to the decision card
 *  satisfy a claim about the action card. */
function card(ticketId: string): string {
  const at = html.indexOf(`id="${ticketId}"`);
  expect(at, `${ticketId} is not drawn on the page at all`).toBeGreaterThan(-1);
  const from = html.lastIndexOf('<article', at);
  const next = html.indexOf('<article', at);
  return html.slice(from, next === -1 ? undefined : next);
}

/** Every button class on one card. `copy` is on every ticket reference the
 *  page draws and is not a response to anything, so a card "with no control"
 *  means a card whose only button is that one — which is a claim `<button`
 *  cannot express. */
function buttons(cardHtml: string): string[] {
  return [...cardHtml.matchAll(/<button[^>]*\bclass="([^"]+)"/g)].map((m) => m[1]!);
}

beforeAll(async () => {
  const seed = new Store(db);
  const make = (title: string, extra: Record<string, unknown> = {}) =>
    seed.createTicket(builder, { title, body: `${title}. Goal, constraints, current state.`, workstream: 'estate-ui', type: 'ops', ...extra });

  const decision = make('Which account should the Worker use');
  seed.returnToHuman(builder, decision.id, {
    situation: 'Both accounts would work and the deposit is due Friday.',
    question: 'Which account should the Worker use?',
    options: [
      { label: 'the company account', consequence: 'one bill, one owner' },
      { label: 'the personal account', consequence: 'nothing to set up today, a migration later' },
    ],
    recommendation: 'the company account',
  });
  id['decision'] = decision.id;

  const action = make('Add the routing rule the Worker needs');
  seed.requestAction(builder, action.id, {
    situation: 'The Worker is deployed and answering, but mail to the new address bounces.',
    action: 'Two clicks in the provider dashboard: add an Email Routing rule for the new address.',
    why_human: 'The dashboard is the only place the rule can be added and no agent holds that account.',
    if_unanswered: 'The address keeps bouncing and the form has nowhere to send its replies.',
  });
  id['action'] = action.id;
  actFingerprint = actionFingerprint(seed.getTicket(action.id).action!);

  id['sitting'] = make('Go through the release gates', {
    needs_human: 'Twenty minutes reading the gates and saying which ones still apply.',
    sitting_with: 'mason',
  }).id;
  id['anonymousSitting'] = make('A sitting recorded before the field existed', {
    needs_human: 'Half an hour on the phone with the registrar.',
  }).id;
  id['unreadable'] = make('A row that arrived awaiting him with nothing attached').id;
  seed.close();

  // A row awaiting the human with NO request at all. Nothing in the API can
  // produce it — both request paths write a request — so it is written here
  // the only way it arises in the wild: straight into the tickets table, the
  // way a copy or a migration between stores puts it there. This is the case
  // that used to be counted in "awaits you" and drawn nowhere.
  const raw = new Database(db);
  const moved = raw
    .prepare("UPDATE tickets SET status = 'awaiting_human', question = NULL WHERE id = ?")
    .run(id['unreadable']);
  expect(moved.changes).toBe(1);
  raw.close();

  ({ view, origin } = await serveRecord(db));
  const res = await fetch(`${origin}/`);
  html = await res.text();
  expect(res.status).toBe(200);
}, 60_000);

afterAll(() => {
  view?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe('each hero card says which kind of request it is', () => {
  it('names a decision, and still offers ratify and every stored choice', () => {
    const c = card(id['decision']!);
    expect(c).toContain('class="qcard"');
    expect(c).toMatch(/class="kind decides"[^>]*>[^<]*Decision needed/);
    expect(c).toContain('Ratify recommendation');
    expect(c).toContain('class="option choice"');
    // Not the other kinds' controls, and not their labels.
    expect(c).not.toContain('class="acted"');
    expect(c).not.toContain('Action for you');
    expect(c).not.toContain('Needs a sitting');
  });

  it('names an action for him, with a control that reports rather than approves', () => {
    const c = card(id['action']!);
    expect(c).toContain('class="acard"');
    expect(c).toMatch(/class="kind acts"[^>]*>[^<]*Action for you/);
    expect(c).toContain('Two clicks in the provider dashboard');
    // why_human is on the face of the card: it is what separates this from a
    // decision, so it cannot be behind the disclosure.
    expect(c.slice(0, c.indexOf('<details'))).toContain('no agent holds that account');
    expect(c).toContain('class="acted"');
    expect(c).toContain('done it');
    // The consent token is the action's own fingerprint, not a question's.
    expect(c).toContain(`data-act="${actFingerprint}"`);
    // Nothing on this card can ratify, choose, or read as permission.
    expect(c).not.toContain('Ratify');
    expect(c).not.toContain('class="option choice"');
    expect(c).not.toContain('data-ask=');
    expect(c).not.toContain('Recommends');
  });

  it('names the agent to sit with, and offers no control at all', () => {
    const c = card(id['sitting']!);
    expect(c).toContain('class="scard"');
    expect(c).toMatch(/class="kind sits"[^>]*>[\s\S]*?Needs a sitting/);
    expect(c).toContain('with <span class="actor">');
    expect(c).toContain('mason');
    expect(c).toContain('Twenty minutes reading the gates');
    // The response to a sitting happens in the sitting, so the only button on
    // the card is the reference's copy control.
    expect(buttons(c)).toEqual(['copy']);
    expect(c).not.toContain('Ratify');
  });

  it('says nothing about who to sit with when the record does not know', () => {
    const c = card(id['anonymousSitting']!);
    expect(c).toContain('Needs a sitting');
    expect(c).not.toContain('with <span class="actor">');
    expect(c).toContain('Half an hour on the phone');
  });

  it('draws a row awaiting him that carries no request, rather than counting it and hiding it', () => {
    const c = card(id['unreadable']!);
    expect(c).toMatch(/class="kind unreadable"/);
    expect(c).toContain('neither a decision nor an action');
    // Nothing to respond to, so nothing that responds.
    expect(buttons(c)).toEqual(['copy']);
  });

  it('counts every pending request in the one place he reads the number', () => {
    // Three on the awaiting_human axis — a decision, an action, and the row
    // with no readable request — plus two sittings.
    expect(html).toMatch(/data-helmo-section="awaiting" data-count="5"/);
    expect(html).toMatch(/<div class="stat-n">5<\/div>\s*<div class="stat-l">await you/);
  });

  it('draws the three kinds in ascending cost to him: a word, his hands, his diary', () => {
    const order = ['qcard', 'acard', 'scard'].map((cls) => html.indexOf(`class="${cls}"`));
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
