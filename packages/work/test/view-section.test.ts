import { afterAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';
import { ANSWER_HEADER } from '../src/answer.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1', session: 'rev:mason' };
const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'test', version: '1' };

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
    const held = seed.createTicket(builder, {
      title: 'Review the parked work',
      body: 'This sitting should return when the hold is released.',
      workstream: 'estate-ui',
      type: 'review',
      needs_human: 'Twenty minutes with Arthur to walk the parked work.',
    });
    seed.updateTicket(orch, {
      ticket_id: held.id,
      note: 'parking this sitting until the stream resumes',
      capacity_hold: { reason: 'Another stream is active.', provenance: 'Arthur in the capacity review', reconsider_when: 'Arthur resumes estate-ui.' },
    });
    // A sitting is a hero card beside the questions, not a row below them
    // (H-1761): the line it carries is the whole reason Arthur can triage the
    // section without opening anything.
    seed.createTicket(builder, {
      title: 'Add the routing rule',
      body: '## Why this exists\n\nBackground that is NOT the sitting.',
      workstream: 'estate-ui',
      type: 'ops',
      needs_human: 'Two clicks in the Cloudflare dashboard: add an Email Routing rule.',
    });
    // A budgeted stream is exactly what the retired "Workstream steering"
    // section used to render (H-1186); the whole page below must not.
    seed.setWorkstream(orch, { name: 'estate-ui', budget_usd: 10 });
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
    expect(await response!.text()).toContain('<div id="root"></div>');
    const data = (await (await fetch(`http://127.0.0.1:${port}/api/v1/work`)).json()).data;
    expect(data.awaiting.decisions).toHaveLength(1);
    expect(data.awaiting.sittings).toHaveLength(1);
    expect(data.awaiting.decisions[0].recommendation).toBe('yes — one renderer keeps the meanings together.');
    expect(data.awaiting.decisions[0].options.map((option: { letter: string }) => option.letter)).toEqual(['a', 'b']);
    expect(data.record.rows.find((row: { id: string }) => row.id === held.id).display.group).toBe('blocked');
    const unknown = await fetch(`http://127.0.0.1:${port}/?section=missing`);
    expect(unknown.status).toBe(404);
    const nonce = data.awaiting.token;
    const fingerprint = data.awaiting.decisions[0].fingerprint;
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
      body: JSON.stringify({ ticket_id: ticket.id, choice: 'b', question_fingerprint: fingerprint }),
    });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ ok: true, id: ticket.id, status: 'open' });
    const inspect = new Store(db);
    expect(inspect.lastAnswer(ticket.id)).toMatchObject({
      answer: 'Selected b (no) from the dashboard',
      chosen_option: 'no',
      resolution: 'resume',
    });
    expect(inspect.getEvents(ticket.id).find((event) => event.event_type === 'answered')?.actor).toMatchObject({
      name: 'arthur', kind: 'human', session: 'dashboard',
    });
    inspect.close();
    const after = (await (await fetch(`http://127.0.0.1:${port}/api/v1/work`)).json()).data.awaiting;
    expect(after.decisions).toHaveLength(0);
    expect(after.sittings).toHaveLength(1);
  });
});
