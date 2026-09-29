/* A record at declared capacity, and the view process serving it (H-202).
 *
 * Shared by the two checks that need a real document rather than the source
 * of one: `view-release-floor.test.ts`, which reads the served bytes, and
 * `view-viewport-render.test.ts`, which puts them in a browser. Both need the
 * same record, and a budget is only worth anything measured on a record at
 * least as heavy as the one it protects — so the seed is built to the shape
 * of the deployed store (see `floor-budget.ts`) and reports what it wrote.
 */

import { ChildProcess, spawn } from 'node:child_process';
import { rowsDrawn } from '../../src/floor.js';
import { Store } from '../../src/store.js';
import { Actor } from '../../src/types.js';
import { CAPACITY, REAL_RECORD } from '../../src/floor.js';

export const agent: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1', session: 'rev:mason' };
export const human: Actor = { name: 'Arthur', kind: 'human', model: 'human', version: '1' };

/** Sentences long enough to wrap, with the long unbreakable refs that are the
 *  page's real overflow risk mixed in. Prose, not filler, for two reasons: the
 *  widths are read against text that behaves like the text a ticket holds, and
 *  real prose is full of apostrophes and quotation marks, each of which leaves
 *  the server as five or six escaped bytes. A fixture written without them
 *  measures a document a third lighter than the one the operator is sent. */
const SENTENCES = [
  "The body is the handoff: a different agent with no other context has to be able to pick this ticket up and continue it.",
  "Measured against the deployed service rather than a fixture, because a fixture smaller than the record is what went wrong last time.",
  "The operator's words, recorded: \"if something is blocked and will need me after it is blocked, the block is the primary status\".",
  "The prerequisite is /Users/arthur/projects/helmo/src/view.ts, which is also the longest unbreakable token this page draws.",
  "Constraint: don't redeploy the neighbouring estate, and don't read its records; the adoption is a company act on a company checkout.",
  "Acceptance needs the labels, the attention count, the filters and the ticket detail to agree, and a cosmetic badge change isn't enough.",
  "Evidence refs are immutable — repo@sha for a commit, an absolute path for a file — so a stranger can follow them months from now.",
];

/** As long as the longest token the deployed record draws (128 characters, a
 *  workspace path) — but a path is not the hard case: a browser may break
 *  after each slash in it. DIGEST is the hard case, a 64-character run with
 *  no break opportunity anywhere in it, which is what the record's commit
 *  refs actually look like and what decides whether a row fits a phone. */
const LONG_REF =
  '/Users/arthurcoulston/projects/gp-crew/agents/builder/workspace/h202-2026-09-29/snapshots/served-record-at-capacity-warm-second-fetch.log';
const DIGEST = (i: number) => `${(i * 2654435761) >>> 0}`.padStart(10, '9').repeat(7).slice(0, 64);

/** Deterministic: the same seed every run, so a timing or byte number moving
 *  is the page changing rather than the fixture. */
function bodyOf(chars: number, i: number): string {
  let out = `Working file: ${LONG_REF}\nRecorded at helmo@${DIGEST(i)}\n`;
  for (let n = 0; out.length < chars; n++) out += `${SENTENCES[(i + n) % SENTENCES.length]}\n`;
  return out.slice(0, Math.max(chars, LONG_REF.length + 16));
}

function evidenceOf(count: number, i: number) {
  return Array.from({ length: count }, (_, n) => ({
    kind: n % 3 === 0 ? ('commit' as const) : n % 3 === 1 ? ('url' as const) : ('file' as const),
    ref:
      n % 3 === 0
        ? `helmo@${DIGEST(i + n)}`
        : n % 3 === 1
          ? `https://github.com/arthurcoulston/helmo/pull/${(i % 40) + 1}`
          : LONG_REF,
    note: `${SENTENCES[(i + n) % SENTENCES.length]} ${SENTENCES[(i + n + 3) % SENTENCES.length]} Ref ${n} of ${count}.`,
  }));
}

/* The distribution the deployed store actually has, kept as arithmetic on the
   row index rather than a random draw: most rows are a few thousand bytes, a
   handful are very long, and the evidence list has a tail that reaches past a
   hundred items on one ticket (H-202 itself). */
const BODY_SIZES = [1200, 2400, 4200, 6300, 3400, 9000, 1600, 5100];
/* Open rows get the longer bodies. Evidence is only drawn beside work that is
   done (view.ts draws the evidence row under `showDone`), so on the current
   record — live work plus the closed tail — what a row costs is very nearly
   what its body costs, and a seed of short open bodies cannot reach the
   weight the deployed current record actually has. */
const bodyBytes = (i: number) =>
  i === 7
    ? REAL_RECORD.longestBodyBytes
    : i % 20 === 3 || i % 20 === 14
      ? 20_000
      : i % 20 === 0
        ? 12_000
        : Math.round(BODY_SIZES[i % 8]! * (i % 2 === 0 ? 2.2 : 1.2));
/* The tail is the point. The deployed record's median row is about 7KB of
   document and its mean is nearly double that: ten rows carry 45KB to 125KB
   each, because a long-running ticket accumulates dozens of evidence items
   with a note on every one. A seed of evenly-sized rows reaches the same
   total text and renders a document half the weight. The heavy indices are
   deliberately both odd and even: odd rows are the closed ones below, and a
   tail landing only on those would make the whole record look disproportionate
   to the current one for a reason the page is not to blame for. */
const evidenceCount = (i: number) =>
  i === 53
    ? REAL_RECORD.mostEvidenceItems
    : i % 20 === 3 || i % 20 === 14
      ? 110
      : i % 10 === 3 || i % 10 === 6
        ? 70
        : i % 12 === 0
          ? 36
          : i % 9 === 0
            ? 22
            : (i % 9) + 5;

/** Seeds one store at declared capacity and returns what it wrote, so the
 *  caller can assert the fixture is at least as heavy as the real record
 *  before it measures anything against it. */
export function seedCapacityRecord(db: string): { rows: number; storedTextBytes: number } {
  const seed = new Store(db);
  let storedTextBytes = 0;
  const make = (title: string, extra: Record<string, unknown> = {}) => {
    const body = (extra['body'] as string) ?? `${title}.`;
    storedTextBytes += title.length + body.length;
    return seed.createTicket(agent, { title, body, workstream: 'helmo-dev', type: 'build', ...extra });
  };

  // Every row shape the page can draw — a question card, a sitting, work in
  // motion, a blocked row, a closed row with evidence — at the text volume
  // the deployed record carries, which is where the bytes actually come from.
  for (let i = 0; i < CAPACITY.rows; i++) {
    const motion = i % 2 === 0 && i % 5 === 0;
    const t = make(`Seeded row ${i}, recorded under ${LONG_REF} at ${DIGEST(i)}`, {
      body: bodyOf(bodyBytes(i), i),
      ...(motion ? { status: 'in_progress' as const } : {}),
    });
    // The oldest closed rows are shut without evidence on purpose. That
    // raises a grooming finding against a ticket the current record does not
    // draw — it is past the closed tail — which is how the live page came to
    // carry six links to rows that were not on it. Everything after them
    // carries evidence whether it is closed or not, because on the deployed
    // record 170 of 207 rows do and each item is markup the page has to draw.
    const evidence = i < 20 ? [] : evidenceOf(evidenceCount(i), i);
    storedTextBytes += JSON.stringify(evidence).length;
    if (i % 2 === 1) seed.updateTicket(agent, { ticket_id: t.id, status: 'done', note: 'shipped', evidence });
    else if (evidence.length) seed.updateTicket(agent, { ticket_id: t.id, note: 'where this stands', evidence });
  }
  const prereq = make('The unfinished prerequisite');
  make('A sitting behind that prerequisite', {
    needs_human: 'Half an hour reading the proposal and saying yes or no.',
    deps: [{ to: prereq.id, type: 'blocks' as const }],
  });
  make('A sitting he can reach now', { needs_human: 'Two clicks in the Cloudflare dashboard.' });
  const question = make('Which provider account should this use');
  seed.returnToHuman(agent, question.id, {
    situation: 'The Worker needs an account and both would work.',
    question: 'Which account should the Worker use?',
    recommendation: 'Use the company account.',
    options: [
      { label: 'The company account', consequence: 'One bill, one owner, and the personal account stays out of it.' },
      { label: 'The personal account', consequence: 'Nothing to set up today and a migration to do later.' },
    ],
  });
  seed.close();
  return { rows: CAPACITY.rows + 4, storedTextBytes };
}

/** Starts the view over one store and resolves its origin. The operator is
 *  set so the answer control renders: an interactive element that exists only
 *  for the human is exactly the one a floor check must not miss. */
export async function serveRecord(db: string): Promise<{ view: ChildProcess; origin: string }> {
  const view = spawn(process.execPath, ['--import', 'tsx', 'src/view.ts'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, HELMO_DB: db, HELMO_VIEW_PORT: '0', HELMO_VIEW_HOST: '127.0.0.1', HELMO_OPERATOR: human.name },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the view never reported ready')), 20_000);
    view.once('error', reject);
    view.once('exit', (code) => reject(new Error(`the view exited before ready (${code})`)));
    view.on('message', (message) => {
      if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'helmo-view-ready') return;
      clearTimeout(timer);
      resolve((message as { port: number }).port);
    });
  });
  return { view, origin: `http://127.0.0.1:${port}` };
}

/** Fetched twice, timed on the second. The first request to a document pays
 *  for opening the store and warming the module, which is a real cost once per
 *  process and pure noise in a budget — measuring it forced a budget so loose
 *  it no longer failed for a render gone quadratic. */
export async function load(origin: string, path: string) {
  const first = await fetch(`${origin}${path}`, { redirect: 'error' });
  await first.text();
  const started = performance.now();
  const res = await fetch(`${origin}${path}`, { redirect: 'error' });
  const html = await res.text();
  const ms = performance.now() - started;
  if (res.status !== 200) throw new Error(`${path} answered ${res.status}`);
  return { html, bytes: Buffer.byteLength(html), ms, rows: rowsDrawn(html) };
}
