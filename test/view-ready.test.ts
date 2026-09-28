import { afterAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1', session: 'rev:mason' };
const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'test', version: '1' };

const hold = (reason: string, release?: { batch_id: string; until: string }) => ({
  reason,
  provenance: 'Arthur in the capacity review',
  reconsider_when: 'Arthur resumes the stream.',
  ...(release
    ? {
        release: {
          batch_id: release.batch_id,
          until: release.until,
          stop_conditions: 'Stop if the stream turns red.',
          shared_reserve: 'Arthur keeps a third of the budget.',
        },
      }
    : {}),
});

// The dashboard's Ready section is read as "what an agent could pick up now".
// When it disagreed with the queue the operator read the difference as a fleet
// ignoring its backlog, so these cover every gate the queue applies (H-2321).
describe('Ready honors the same gates as the work queue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helmo-ready-'));
  const db = join(dir, 'helmo.db');
  let view: ChildProcess | null = null;

  afterAll(() => {
    view?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('withholds held, gated and blocked work and offers the rest', async () => {
    const seed = new Store(db);
    const make = (title: string, extra: Record<string, unknown> = {}) =>
      seed.createTicket(builder, { title, body: `${title}.`, workstream: 'helmo-dev', type: 'build', ...extra });

    const plain = make('Plain ready work');
    const indefinite = make('Parked indefinitely');
    seed.updateTicket(orch, {
      ticket_id: indefinite.id,
      note: 'parking this until the other stream ships',
      capacity_hold: hold('The infrastructure project is parked.'),
    });
    const released = make('Held but released for this batch');
    seed.updateTicket(orch, {
      ticket_id: released.id,
      note: 'releasing this one for the batch',
      capacity_hold: hold('Held with a live release.', { batch_id: 'batch-live', until: '2099-01-01T00:00:00Z' }),
    });
    const expired = make('Held, release has run out');
    seed.updateTicket(orch, {
      ticket_id: expired.id,
      note: 'the batch release has expired',
      capacity_hold: hold('Held with an expired release.', { batch_id: 'batch-gone', until: '2020-01-01T00:00:00Z' }),
    });
    const dated = make('Cannot start until next year', { not_before: '2099-01-01' });
    const blocker = make('The prerequisite');
    const waiting = make('Waits on the prerequisite', { deps: [{ to: blocker.id, type: 'blocks' as const }] });
    const sitting = make('Needs Arthur at a keyboard', {
      needs_human: 'Two minutes in the dashboard to flip one switch.',
    });
    seed.close();

    view = spawn(process.execPath, ['--import', 'tsx', 'src/view.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, HELMO_DB: db, HELMO_VIEW_PORT: '0', HELMO_VIEW_HOST: '127.0.0.1' },
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

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const section = (name: string) => {
      const start = html.indexOf(`<h2>${name}</h2>`);
      expect(start, `the ${name} section is missing`).toBeGreaterThan(-1);
      const end = html.indexOf('</section>', start);
      return html.slice(start, end);
    };
    const readySection = section('Ready');
    const blockedSection = section('Blocked');
    const has = (where: string, t: { id: string }) => where.includes(`id="${t.id}"`);

    // Offered: nothing stands between an agent and these.
    expect(has(readySection, plain)).toBe(true);
    expect(has(readySection, blocker)).toBe(true);
    // A live bounded release is a real release — the queue offers it, so the page does.
    expect(has(readySection, released)).toBe(true);

    // Withheld, not hidden: every gate the queue applies lands on the blocked side.
    for (const t of [indefinite, expired, dated, waiting]) {
      expect(has(readySection, t), `${t.id} must not be offered as ready`).toBe(false);
      expect(has(blockedSection, t), `${t.id} belongs under Blocked`).toBe(true);
    }

    // A held ticket says why it is held, where the operator is looking.
    expect(blockedSection).toContain('⏸ on hold · The infrastructure project is parked.');
    expect(blockedSection).toContain('⏸ on hold · Held with an expired release.');
    expect(readySection).not.toContain('⏸ on hold');

    // The stats are the same reading: three offered, four withheld.
    expect(html).toContain('<div class="stat "><div class="stat-n">3</div><div class="stat-l">ready</div></div>');
    expect(html).toContain('<div class="stat "><div class="stat-n">4</div><div class="stat-l">blocked</div></div>');

    // A sitting is the operator's, and stays a hero card rather than a row.
    expect(has(readySection, sitting)).toBe(false);
    expect(has(blockedSection, sitting)).toBe(false);
    expect(html).toContain('Two minutes in the dashboard to flip one switch.');
  });
});
