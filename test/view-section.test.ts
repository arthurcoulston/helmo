import { afterAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';
import { ANSWER_HEADER } from '../src/answer.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1', session: 'rev:mason' };

describe('Awaiting-you section route', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helmo-section-'));
  const db = join(dir, 'helmo.db');
  let view: ChildProcess | null = null;

  afterAll(() => {
    view?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns only Helmo-rendered awaiting work with an embedding contract', async () => {
    const seed = new Store(db);
    const ticket = seed.createTicket(builder, {
      title: 'Choose the front door',
      body: 'The landing needs one Helmo-rendered decision.',
      workstream: 'estate-ui',
      type: 'build',
    });
    seed.returnToHuman(builder, ticket.id, {
      situation: 'There are two routes.',
      question: 'Use one?',
      options: [
        { label: 'yes', consequence: 'the shell keeps Helmo semantics' },
        { label: 'no', consequence: 'the shell owns a second renderer' },
      ],
      recommendation: 'yes — one renderer keeps the meanings together.',
      if_unanswered: 'The landing stays split.',
    });
    seed.updateTicket(builder, { ticket_id: ticket.id, note: 'last <recorded> & update' });
    seed.close();

    view = spawn(process.execPath, ['--import', 'tsx', 'src/view.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, HELMO_DB: db, HELMO_VIEW_PORT: '0', HELMO_VIEW_HOST: '127.0.0.1', HELMO_OPERATOR: 'arthur' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the view never reported ready')), 15_000);
      view!.once('error', reject);
      view!.once('exit', (code) => reject(new Error(`the view exited before ready (${code})`)));
      view!.on('message', (message) => {
        if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'helmo-view-ready') return;
        clearTimeout(timer);
        resolve((message as { port: number }).port);
      });
    });

    const url = `http://127.0.0.1:${port}/?section=awaiting`;
    let response: Response | null = null;
    for (let i = 0; i < 60 && !response; i++) {
      try {
        response = await fetch(url);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    expect(response, 'the view never came up').not.toBeNull();
    expect(response!.status).toBe(200);
    const html = await response!.text();
    expect(html).toContain('class="section-reading" data-helmo-section="awaiting" data-count="1"');
    expect(html).toContain('<section class="hero" data-helmo-section="awaiting" data-count="1">');
    expect(html).toContain('class="qcard"');
    expect(html).toContain('<span class="opt-letter">a</span>yes');
    expect(html).toContain('<span class="opt-letter">b</span>no');
    expect(html).toContain('yes — one renderer keeps the meanings together.');
    expect(html).toContain('If unanswered: The landing stays split.');
    expect(html).toContain('last &lt;recorded&gt; &amp; update');
    expect(html).toContain('Ratify recommendation');
    expect(html).not.toContain('<header class="top">');
    expect(html).not.toContain('Needs grooming');
    expect(html).not.toContain('In motion</h2>');

    const unknown = await fetch(`http://127.0.0.1:${port}/?section=missing`);
    expect(unknown.status).toBe(404);

    const nonce = html.match(/data-answer="([0-9a-f]{32})"/)?.[1];
    const fingerprint = html.match(/data-ask="([0-9a-f]{16})"/)?.[1];
    expect(nonce).toBeTruthy();
    expect(fingerprint).toBeTruthy();
    const stale = await fetch(`http://127.0.0.1:${port}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ANSWER_HEADER]: nonce! },
      body: JSON.stringify({ ticket_id: ticket.id, ratify: true, question_fingerprint: '0'.repeat(16) }),
    });
    expect(stale.status).toBe(409);
    const legacy = await fetch(`http://127.0.0.1:${port}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ANSWER_HEADER]: nonce! },
      body: JSON.stringify({ ticket_id: ticket.id, reasoning: 'drop it', resolution: 'cancelled' }),
    });
    expect(legacy.status).toBe(400);
    const answered = await fetch(`http://127.0.0.1:${port}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ANSWER_HEADER]: nonce! },
      body: JSON.stringify({ ticket_id: ticket.id, ratify: true, question_fingerprint: fingerprint }),
    });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ ok: true, id: ticket.id, status: 'open' });
    const inspect = new Store(db);
    expect(inspect.lastAnswer(ticket.id)).toMatchObject({
      answer: 'Ratified from the dashboard',
      chosen_option: 'yes — one renderer keeps the meanings together.',
      resolution: 'resume',
    });
    expect(inspect.getEvents(ticket.id).find((event) => event.event_type === 'answered')?.actor).toMatchObject({
      name: 'arthur', kind: 'human', session: 'dashboard',
    });
    inspect.close();
    const after = await (await fetch(url)).text();
    expect(after).not.toContain(`data-ticket="${ticket.id}"`);
  });
});
