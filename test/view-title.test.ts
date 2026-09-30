import { afterAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

const builder: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1', session: 'rev:mason' };

// A long title is split at the handle its writer already wrote, and the quieter
// half is presentation only (H-2476). The property that makes that safe is that
// NOTHING is lost: what a reader selects, finds in the page or hears from a
// screen reader has to be the stored title, character for character. So these
// render the real page and compare its text against the record, rather than
// reading the source for the shape of the call.

/** The one title span for a row, sliced at its own matching close so a
 *  neighbouring row can never be read as part of it. Returns what a reader
 *  gets — tags dropped, the view's four entities put back — and whether the
 *  quieter second half is present. */
function titleSpan(html: string, cls: string, id: string): { text: string; split: boolean; raw: string } {
  const row = html.slice(html.indexOf(`id="${id}"`));
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
    raw: inner,
    split: inner.includes('<span class="tdetail">'),
    text: inner
      .replace(/<[^>]+>/g, '')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"'),
  };
}

describe('a long title scans like a short one, and still says everything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helmo-title-'));
  const db = join(dir, 'helmo.db');
  let view: ChildProcess | null = null;

  afterAll(() => {
    view?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders every title exactly as stored, split or not', async () => {
    const seed = new Store(db);
    const make = (title: string) =>
      seed.createTicket(builder, { title, body: 'Seeded for the title test.', workstream: 'helmo-dev', type: 'build' });

    // Shapes taken from the 400 real titles measured in H-2476.
    const cases: Array<{ t: { id: string }; title: string; split: boolean; why: string }> = [];
    const add = (title: string, split: boolean, why: string) => cases.push({ t: make(title), title, split, why });

    add('Daily GitHub listen: sweep published repos for outside activity', true, 'the common colon handle');
    add('A ticket row exists that Helmo never created — it wedged the whole fleet', true, 'an em dash handle');
    add('Release 1: make harness decisions and record changes trustworthy', true, 'a four-character lead still counts');
    add(
      'An installation picks one version and every part of it loads that version, with no fallback',
      false,
      'one sentence, no authored break, so it renders as it always did'
    );
    add('Daily backlog sweep', false, 'short and already a handle');
    add(
      'The whole first clause of this title runs on well past the cap before it: finally breaks',
      false,
      'a break past 48 characters would promote half a sentence, not a handle'
    );
    add('Rotate the key: today', false, 'a remainder too short to be worth quieting');
    add('Fix <script> & "quoted" markup: the tags must stay inert in both halves', true, 'escaping survives the split');

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

    for (const c of cases) {
      // The invariant. Whatever the split decides, the reader gets the record.
      const drawn = titleSpan(html, 'rtitle', c.t.id);
      expect(drawn.text, `${c.t.id} must render its stored title exactly`).toBe(c.title);
      expect(drawn.split, `${c.t.id}: ${c.why}`).toBe(c.split);
    }

    // The split is a real change, not a no-op that the invariant would also pass.
    expect(html).toContain('<span class="tdetail">');

    // Markup in a title stays inert on both sides of the split. The page has
    // its own <script>, so this has to be asked of the title span itself.
    const markup = titleSpan(html, 'rtitle', cases[cases.length - 1].t.id);
    expect(markup.split).toBe(true);
    expect(markup.raw).toContain('&lt;script&gt;');
    expect(markup.raw).not.toContain('<script>');
  });
});
