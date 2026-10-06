import { afterAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resultDisplay } from '../src/presentation.js';
import { Store } from '../src/store.js';
import { Actor, Evidence } from '../src/types.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1', session: 'rev:mason' };

// The surface used to decide what a ticket PRODUCED from how its ref was
// SPELLED: every `kind: "url"` became the result, every commit and file became
// review evidence. Measured on the live stores at 2026-10-06, that described
// 2,153 closed personal-estate tickets and 525 Good Plumb ones as having
// produced nothing. Each case below is a numbered row of §3 of
// `crew:projects/r39/RESULT-ROLE-CONTRACT.md`, which is the acceptance table.
describe('The result-role projection reads purpose, never format', () => {
  const item = (kind: string, ref: string, role?: string): Evidence =>
    ({ kind, ref, ...(role ? { role } : {}) }) as Evidence;
  const CONTRACT = 'crew:projects/r39/RESULT-ROLE-CONTRACT.md';
  const BOOK = 'https://goodplumb.co.uk/book';

  it('§3.1 gives a file the result position a URL used to monopolise', () => {
    const display = resultDisplay([item('file', CONTRACT, 'result')]);
    expect(display.primary).toEqual({ at: 0 });
    expect(display.others).toEqual([]);
    expect(display.unstated).toEqual([]);
  });

  it('§3.2 reads a URL result from its role, not its scheme', () => {
    expect(resultDisplay([item('url', BOOK, 'result')]).primary).toEqual({ at: 0 });
  });

  it('§3.3 keeps a supporting URL out of the result position', () => {
    const display = resultDisplay([item('file', CONTRACT, 'result'), item('url', 'https://ci/run/1234', 'supporting')]);
    expect(display.primary).toEqual({ at: 0 });
    expect(display.supporting).toEqual([{ at: 1 }]);
    expect(display.others).toEqual([]);
  });

  it('§3.4 separates a review of the result from the result', () => {
    const display = resultDisplay([item('url', BOOK, 'result'), item('url', 'https://x/REVIEW-ward.md', 'review')]);
    expect(display.primary).toEqual({ at: 0 });
    expect(display.review).toEqual([{ at: 1 }]);
    expect(display.supporting).toEqual([]);
  });

  it('§3.5 makes an operational change its own result', () => {
    const display = resultDisplay([item('commit', 'helmo@76f395d', 'result'), item('file', '~/.helmo/rev.json', 'supporting')]);
    expect(display.primary).toEqual({ at: 0 });
    expect(display.supporting).toEqual([{ at: 1 }]);
    expect(display.unstated).toEqual([]);
  });

  it('§3.6a says no result is recorded rather than inventing one', () => {
    expect(resultDisplay([])).toEqual({ primary: null, others: [], supporting: [], review: [], unstated: [] });
  });

  it('§3.6b keeps an unreachable ref as the result, reachability being the client’s reading', () => {
    const display = resultDisplay([item('url', 'http://localhost:4400/#H-1', 'result')]);
    expect(display.primary).toEqual({ at: 0 });
    expect(display.unstated).toEqual([]);
  });

  it('§3.L1 still offers a legacy URL, labelled a guess', () => {
    const display = resultDisplay([item('url', BOOK)]);
    expect(display.primary).toEqual({ at: 0, inferred: true });
  });

  it('§3.L2 lists the legacy commit and file instead of claiming they produced nothing', () => {
    const display = resultDisplay([item('commit', 'helmo@9177e4b'), item('file', CONTRACT)]);
    expect(display.primary).toBeNull();
    expect(display.unstated).toEqual([{ at: 0 }, { at: 1 }]);
  });

  // §5.5: the store's `evidence` is a JSON column and the personal store holds
  // a `kind: "test"` written around the tool boundary (H-884). A projection
  // switching exhaustively on five kinds has a real record it cannot classify.
  it('classifies an out-of-enum kind instead of dropping or crashing on it', () => {
    const display = resultDisplay([item('test', 'the H-884 item')]);
    expect(display.primary).toBeNull();
    expect(display.unstated).toEqual([{ at: 0 }]);
  });

  // `role` is written into that same JSON column, so it is open in exactly the
  // same way. An unreadable value must not become a result by default.
  it('refuses to promote an unreadable role value', () => {
    const display = resultDisplay([item('url', BOOK, 'primary')]);
    expect(display.primary).toBeNull();
    expect(display.unstated).toEqual([{ at: 0 }]);
  });

  // §2.2: more than one result is reported as more than one result. The button
  // goes to the latest append; nothing is hidden to make the display singular.
  it('§2.2 shows every result and gives the action to the latest', () => {
    const display = resultDisplay([item('commit', 'helmo@aaa', 'result'), item('url', BOOK, 'result')]);
    expect(display.primary).toEqual({ at: 1 });
    expect(display.others).toEqual([{ at: 0 }]);
  });

  // §2.4's fallback exists so no EXISTING record regresses. A record that
  // states a role is not an existing record, so a guess never takes the action
  // from it — the shape H-2968's own evidence has: a roled commit, then a
  // pushed-to-GitHub URL appended without one.
  it('never lets an inferred result outrank a recorded one', () => {
    const display = resultDisplay([item('commit', 'helmo@9177e4b', 'result'), item('url', 'https://github.com/x/commit/9177e4b')]);
    expect(display.primary).toEqual({ at: 0 });
    expect(display.others).toEqual([{ at: 1, inferred: true }]);
  });

  // §2.3: evidence stays append-only, so a mis-stated role is corrected by
  // appending the same ref with the intended role. The ref appears once.
  it('§2.3 corrects a role by append and shows the ref once', () => {
    const display = resultDisplay([item('file', CONTRACT, 'supporting'), item('file', CONTRACT, 'result')]);
    expect(display.primary).toEqual({ at: 1, corrected: true });
    expect(display.supporting).toEqual([]);
    expect(display.others).toEqual([]);
  });

  it('does not call a re-stated identical role a correction', () => {
    expect(resultDisplay([item('file', CONTRACT, 'result'), item('file', CONTRACT, 'result')]).primary).toEqual({ at: 1 });
  });

  it('§2.3 leaves legacy duplicate refs exactly as they rendered', () => {
    const display = resultDisplay([item('url', BOOK), item('url', BOOK)]);
    expect(display.primary).toEqual({ at: 1, inferred: true });
    expect(display.others).toEqual([{ at: 0, inferred: true }]);
  });

  it('lets a recorded role claim a ref an unroled item repeats', () => {
    const display = resultDisplay([item('url', BOOK, 'supporting'), item('url', BOOK)]);
    expect(display.primary).toBeNull();
    expect(display.supporting).toEqual([{ at: 0 }]);
    expect(display.unstated).toEqual([]);
  });
});

// The projection has to reach the client, which reads it off the work document
// rather than off `evidence`. This is the wiring, served from the real route.
describe('The served record carries the result projection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helmo-result-role-'));
  const db = join(dir, 'helmo.db');
  let view: ChildProcess | null = null;

  afterAll(() => {
    view?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports primary, supporting and unstated on every closed row', async () => {
    const seed = new Store(db);
    const close = (title: string, evidence: Evidence[]) => {
      const t = seed.createTicket(builder, { title, body: `${title}.`, workstream: 'estate-ui', type: 'build' });
      seed.updateTicket(builder, { ticket_id: t.id, status: 'done', note: 'Closing with evidence.', evidence });
      return t.id;
    };
    const operational = close('An operational change states its result', [
      { kind: 'commit', ref: 'helmo@76f395d', role: 'result' },
      { kind: 'file', ref: '~/.helmo/rev.json', role: 'supporting' },
    ]);
    const legacy = close('A legacy commit and file', [
      { kind: 'commit', ref: 'helmo@9177e4b' },
      { kind: 'file', ref: 'crew:projects/r39/RESULT-ROLE-CONTRACT.md' },
    ]);
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

    const data = (await (await fetch(`http://127.0.0.1:${port}/api/v1/work`)).json()).data;
    const result = (id: string) => data.record.rows.find((row: { id: string }) => row.id === id).display.result;
    expect(result(operational)).toEqual({ primary: { at: 0 }, others: [], supporting: [{ at: 1 }], review: [], unstated: [] });
    expect(result(legacy)).toEqual({ primary: null, others: [], supporting: [], review: [], unstated: [{ at: 0 }, { at: 1 }] });
  });
});
