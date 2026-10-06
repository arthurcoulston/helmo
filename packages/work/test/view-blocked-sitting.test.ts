import { afterAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1', session: 'rev:mason' };
const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'test', version: '1' };

const hold = (reason: string) => ({
  reason,
  provenance: 'Arthur in the capacity review',
  reconsider_when: 'Arthur resumes the stream.',
});

// The operator reads this page to choose what he can usefully do NOW. A ticket
// that needs him only after a prerequisite finishes was drawn in "Awaiting you"
// and counted there, so what he could actually pick up was mixed in with what
// he could not reach: "If something is blocked and will need me after it is
// blocked, the block is the primary status, not the waiting for me" (H-202).
describe('a current impediment outranks a later sitting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helmo-sitting-'));
  const db = join(dir, 'helmo.db');
  let view: ChildProcess | null = null;
  let data: any;

  afterAll(() => {
    view?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (seed: Store, title: string, extra: Record<string, unknown> = {}) =>
    seed.createTicket(builder, { title, body: `${title}.`, workstream: 'helmo-dev', type: 'build', ...extra });

  // Named so each assertion below says which case it is proving.
  let reachable: { id: string };
  let prereq: { id: string };
  let behindOne: { id: string };
  let behindTwo: { id: string };
  let behindCleared: { id: string };
  let gatedSitting: { id: string };
  let heldSitting: { id: string };
  let question: { id: string };
  let closed: { id: string };

  it('serves the page', async () => {
    const seed = new Store(db);

    // Human-ready, unblocked: nothing stands in front of him.
    reachable = make(seed, 'Two clicks in Cloudflare', {
      needs_human: 'Two clicks in the Cloudflare dashboard to add one routing rule.',
    });

    // One unfinished prerequisite, and the sitting comes after it.
    prereq = make(seed, 'The Ops proposal');
    behindOne = make(seed, 'Accept the Ops proposal with Arthur', {
      needs_human: 'Half an hour reading the proposal and saying yes or no.',
      deps: [{ to: prereq.id, type: 'blocks' as const }],
    });

    // Several prerequisites, one of them unfinished: still blocked.
    const done = make(seed, 'The finished prerequisite');
    behindTwo = make(seed, 'Sitting behind two prerequisites', {
      needs_human: 'Ten minutes once both halves land.',
      deps: [
        { to: done.id, type: 'blocks' as const },
        { to: prereq.id, type: 'blocks' as const },
      ],
    });
    seed.updateTicket(builder, { ticket_id: done.id, status: 'done', note: 'shipped', evidence: [{ kind: 'commit', ref: 'helmo@abc1234' }] });

    // The blocker has cleared, so the retained human step is actionable again.
    const cleared = make(seed, 'The prerequisite that finished');
    behindCleared = make(seed, 'Sitting whose blocker has cleared', {
      needs_human: 'Five minutes now that the build is up.',
      deps: [{ to: cleared.id, type: 'blocks' as const }],
    });
    seed.updateTicket(builder, { ticket_id: cleared.id, status: 'done', note: 'shipped', evidence: [{ kind: 'commit', ref: 'helmo@def5678' }] });

    // A date gate and a capacity hold are impediments of their own, and each
    // keeps its actual reason rather than reading as a request to him.
    gatedSitting = make(seed, 'Sitting held behind a date', {
      needs_human: 'Ten minutes once the quarter closes.',
      not_before: '2099-01-01',
    });
    heldSitting = make(seed, 'Sitting under a deliberate hold', {
      needs_human: 'A decision once the stream restarts.',
    });
    seed.updateTicket(orch, {
      ticket_id: heldSitting.id,
      note: 'parking this until the directive lands',
      capacity_hold: hold('Permit Power is parked pending the directive.'),
    });

    // A genuine question that resolves its own blocker stays actionable, even
    // though a prerequisite is open: answering it is the work.
    question = make(seed, 'Which provider account should this use');
    seed.returnToHuman(builder, question.id, {
      situation: 'The Worker needs an account and both would work.',
      question: 'Which account should the Worker use?',
      recommendation: 'Use the company account.',
    });

    // A terminal record carrying a stale marker is still terminal.
    closed = make(seed, 'Finished work that once wanted a sitting', {
      needs_human: 'Two minutes to confirm the redirect.',
    });
    seed.updateTicket(builder, { ticket_id: closed.id, status: 'done', note: 'done and confirmed', evidence: [{ kind: 'url', ref: 'https://example.test/' }] });
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

    data = (await (await fetch(`http://127.0.0.1:${port}/api/v1/work`)).json()).data;
  });
  const row = (id: string) => data.record.rows.find((r: { id: string }) => r.id === id);
  it('withholds impeded sittings and names the actual impediment', () => {
    for (const t of [behindOne, behindTwo, gatedSitting, heldSitting]) {
      expect(row(t.id).display.group).toBe('blocked');
      expect(data.awaiting.sittings.some((r: { id: string }) => r.id === t.id)).toBe(false);
    }
    expect(row(behindOne.id).display.waits_on).toContain(prereq.id);
    expect(row(gatedSitting.id).not_before).toBe('2099-01-01T00:00:00.000Z');
    expect(row(heldSitting.id).display.held).toBe(true);
    expect(row(heldSitting.id).sitting).toContain('A decision once the stream restarts.');
  });
  it('keeps reachable sittings and decisions actionable, and terminal records terminal', () => {
    for (const t of [reachable, behindCleared]) expect(data.awaiting.sittings.some((r: { id: string }) => r.id === t.id)).toBe(true);
    expect(data.awaiting.decisions.some((r: { id: string }) => r.id === question.id)).toBe(true);
    expect(data.awaiting.sittings.length + data.awaiting.decisions.length).toBe(3);
    expect(row(closed.id).display.group).toBe('done');
  });
});
