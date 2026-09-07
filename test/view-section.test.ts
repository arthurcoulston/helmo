import { afterAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1', session: 'rev:mason' };

describe('Awaiting-you section route', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helmo-section-'));
  const db = join(dir, 'helmo.db');
  const port = 4481;
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
      recommendation: 'yes — one renderer keeps the meanings together.',
      if_unanswered: 'The landing stays split.',
    });
    seed.close();

    view = spawn(process.execPath, ['--import', 'tsx', 'src/view.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, HELMO_DB: db, HELMO_VIEW_PORT: String(port), HELMO_VIEW_HOST: '127.0.0.1', HELMO_OPERATOR: 'arthur' },
      stdio: 'ignore',
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
    expect(html).toContain('Ratify recommendation');
    expect(html).not.toContain('<header class="top">');
    expect(html).not.toContain('Needs grooming');
    expect(html).not.toContain('In motion</h2>');

    const unknown = await fetch(`http://127.0.0.1:${port}/?section=missing`);
    expect(unknown.status).toBe(404);
  });
});
