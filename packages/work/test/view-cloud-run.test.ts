import { afterAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1', session: 'rev:mason' };

async function startView(db: string): Promise<{ view: ChildProcess; port: number }> {
  const view = spawn(process.execPath, ['--import', 'tsx', 'src/view.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, HELMO_DB: db, HELMO_VIEW_PORT: '0', HELMO_VIEW_HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the view never reported ready')), 15_000);
    view.once('error', reject);
    view.once('exit', (code) => reject(new Error(`the view exited before ready (${code})`)));
    view.on('message', (message) => {
      if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'helmo-view-ready') return;
      clearTimeout(timer);
      resolve((message as { port: number }).port);
    });
  });
  return { view, port };
}

type Row = { id: string; display: { group: string; cloud_run: string | null } };

// An open ticket labelled cloud-run:<id> is work a worker released while its
// run goes on elsewhere. Drawn as gated backlog, the operator saw no work in
// progress while builds were running (H-2196).
describe('a ticket waiting on a cloud run (H-2196)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helmo-cloud-run-'));
  const db = join(dir, 'helmo.db');
  let view: ChildProcess | null = null;

  afterAll(() => {
    view?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is in motion with its run, not gated backlog, and leaves motion when the label comes off', async () => {
    const seed = new Store(db);
    const gate = new Date(Date.now() + 15 * 60_000).toISOString();
    const waiting = seed.createTicket(builder, { title: 'Build the library table', body: 'b', workstream: 'helmo-dev', type: 'build', labels: ['cloud-run:run-7-1'] });
    seed.updateTicket(builder, { ticket_id: waiting.id, note: 'dispatched; released until the next look', not_before: gate });
    const lookalike = seed.createTicket(builder, { title: 'Renew the runner key', body: 'b', workstream: 'helmo-dev', type: 'ops', labels: ['cloud-runner'] });
    seed.updateTicket(builder, { ticket_id: lookalike.id, note: 'later', not_before: gate });
    seed.close();

    const started = await startView(db);
    view = started.view;
    const rows = async (): Promise<Row[]> => (await (await fetch(`http://127.0.0.1:${started.port}/api/v1/work`)).json()).data.record.rows;
    const row = (all: Row[], id: string) => all.find((r) => r.id === id)!;

    let all = await rows();
    expect(row(all, waiting.id).display).toMatchObject({ group: 'motion', cloud_run: 'run-7-1' });
    expect(all.filter((r) => r.display.group === 'motion')).toHaveLength(1);
    // Only the exact label shape marks a run; a lookalike stays gated backlog.
    expect(row(all, lookalike.id).display).toMatchObject({ group: 'blocked', cloud_run: null });

    // Collected: the label comes off and the ticket is ordinary gated work again.
    const store = new Store(db);
    store.updateTicket(builder, { ticket_id: waiting.id, note: 'collected run-7-1: pushed', labels: [] });
    store.close();
    all = await rows();
    expect(row(all, waiting.id).display).toMatchObject({ group: 'blocked', cloud_run: null });
  });
});
