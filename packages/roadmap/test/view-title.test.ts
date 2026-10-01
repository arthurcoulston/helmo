/* A long project title is split at the handle its writer already wrote, and the
 * quieter half is presentation only (H-2476, I4). The property that makes that
 * safe is that NOTHING is lost: what a reader selects, finds in the page or
 * hears from a screen reader must be the stored title, character for character.
 *
 * Unlike this repo's other view tests, this one renders the real page. The page
 * is the only place the rule has an effect, the store is two lines to seed, and
 * a source-shape assertion here would pass just as happily on a renderer that
 * silently ate half of every title.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

const mason: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1' };

/** A port nobody is on. The view prints its configured port, not its assigned
 *  one, so it cannot be asked for an ephemeral one after the fact. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** One title span, sliced at its own matching close so a neighbouring row can
 *  never be read as part of it. Returns what a reader gets — tags dropped, the
 *  view's four entities put back — and whether the quieter half is there. */
function titleSpan(html: string, cls: string, id: string): { text: string; split: boolean } {
  const row = html.slice(html.indexOf(`>${id}<`));
  const open = row.indexOf(`<span class="${cls}">`);
  expect(open, `${id} has no .${cls}`).toBeGreaterThan(-1);
  const tag = /<\/?span\b[^>]*>/g;
  tag.lastIndex = open;
  let depth = 0;
  let end = -1;
  for (let m = tag.exec(row); m; m = tag.exec(row)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) {
      end = m.index;
      break;
    }
  }
  expect(end, `${id}'s .${cls} span never closes`).toBeGreaterThan(open);
  const inner = row.slice(open, end);
  return {
    split: inner.includes('<span class="tdetail">'),
    text: inner
      .replace(/<[^>]+>/g, '')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"'),
  };
}

describe('a long project title scans like a short one, and still says everything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-title-'));
  const db = join(dir, 'roadmap.db');
  let view: ChildProcess | null = null;

  afterAll(() => {
    view?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders every title exactly as stored, split or not', async () => {
    const seed = new Store(db);
    // Shapes taken from this roadmap's own 46 live titles (H-2476).
    const cases: Array<{ id: string; title: string; split: boolean; why: string }> = [];
    const add = (title: string, split: boolean, why: string) =>
      cases.push({ id: seed.createProject(mason, { title }).id, title, split, why });

    add('Release 1A: Make every harness decision and deployed rule tell the truth', true, 'the common colon handle');
    add('Estate CI: every repo’s tests run on push, red files a ticket', true, 'a short handle, a long detail');
    add('Fleet health page — one glance says everything is alive', true, 'an em dash handle');
    add('The SOTA knowledge base for agent leaders', false, 'no authored break, so it renders as it always did');
    add('Bob’s finances: model', false, 'a remainder too short to be worth quieting');
    add('Fix <script> & "quoted" markup: the tags stay inert in both halves', true, 'escaping survives the split');
    seed.close();

    const port = await freePort();
    view = spawn(process.execPath, ['--import', 'tsx', 'src/view.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, ROADMAP_DB: db, ROADMAP_VIEW_PORT: String(port), ROADMAP_VIEW_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the view never reported ready')), 15_000);
      view!.once('error', reject);
      view!.once('exit', (code) => reject(new Error(`the view exited before ready (${code})`)));
      view!.stdout!.on('data', (d: Buffer) => {
        if (!d.toString().includes('Roadmap view:')) return;
        clearTimeout(timer);
        resolve();
      });
    });

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();

    for (const c of cases) {
      // The invariant. Whatever the split decides, the reader gets the record.
      const drawn = titleSpan(html, 'rtitle', c.id);
      expect(drawn.text, `${c.id} must render its stored title exactly`).toBe(c.title);
      expect(drawn.split, `${c.id}: ${c.why}`).toBe(c.split);
    }

    // The split is a real change, not a no-op the invariant would also pass.
    expect(html).toContain('<span class="tdetail">');
  });
});
