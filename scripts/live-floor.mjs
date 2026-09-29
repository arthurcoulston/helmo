/* The release floor, run against a deployed service instead of a seed (H-202).
 *
 *   npm run live-floor -- http://localhost:4420
 *
 * `npm run floor` proves the page holds up on a record built to capacity.
 * This proves it on the record the operator is actually being served, which
 * is the only reading that can say a budget was appropriate to the thing it
 * protected. It uses the same numbers (`src/floor.ts`), reads the document
 * the same way, and lays it out in the same browser.
 *
 * It only reads: three GETs and a headless page load. Nothing here writes to
 * a store or restarts anything.
 */

import { chromium } from 'playwright-core';
import { FLOOR, elements, markupOf, overBudget, rowsDrawn, styleOf, textOf } from '../src/floor.js';

const origin = (process.argv[2] ?? 'http://localhost:4420').replace(/\/$/, '');
const PATHS = ['/', '/?whole=1', '/?section=awaiting'];
const VIEWPORTS = [360, 390, 480, 700, 1280];
const failures = [];

/** Fetched twice, timed on the second: the first request to a document pays
 *  for warming a process that has usually been idle, and folding that into a
 *  budget is what made the first version of this number meaningless. */
async function load(path) {
  await (await fetch(`${origin}${path}`)).text();
  const started = performance.now();
  const res = await fetch(`${origin}${path}`);
  const html = await res.text();
  const ms = performance.now() - started;
  if (res.status !== 200) throw new Error(`${path} answered ${res.status}`);
  return { html, bytes: Buffer.byteLength(html), ms, rows: rowsDrawn(html) };
}

for (const path of PATHS) {
  const doc = await load(path);
  const markup = markupOf(doc.html);
  const els = elements(markup);
  const ids = els.map((e) => e.attrs['id']).filter(Boolean);
  const idset = new Set(ids);
  const seen = new Set();

  const report = {
    bytes: doc.bytes,
    rows: doc.rows,
    ms: Math.round(doc.ms),
    perRow: doc.rows ? Math.round(doc.bytes / doc.rows) : 0,
    overBudget: overBudget(doc, FLOOR),
    duplicateIds: ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false))).slice(0, 8),
    danglingFragments: [
      ...new Set(
        els
          .flatMap((e) => [e.attrs['href'], e.attrs['xlink:href']])
          .filter((h) => h?.startsWith('#'))
          .filter((h) => !idset.has(h.slice(1))),
      ),
    ].slice(0, 8),
    badHrefs: [
      ...new Set(
        els
          .filter((e) => e.name === 'a')
          .map((e) => e.attrs['href'])
          .filter((h) => {
            if (h === undefined || h === '') return true;
            if (h.startsWith('#')) return false;
            // The view answers every path with the dashboard, so a status
            // code proves nothing: the only route it really has is `/`.
            if (/^[a-z][a-z0-9+.-]*:/i.test(h)) {
              try {
                const url = new URL(h);
                return !['http:', 'https:'].includes(url.protocol) || !url.host;
              } catch {
                return true;
              }
            }
            return new URL(h, `${origin}/`).pathname !== '/';
          }),
      ),
    ].slice(0, 8),
    namelessControls: els
      .filter((e) => ['a', 'button', 'summary'].includes(e.name))
      .filter((e) => !(e.attrs['aria-label'] || e.attrs['title'] || textOf(markup, e)))
      .map((e) => e.name)
      .slice(0, 8),
    subresources: els.filter((e) => e.attrs['src'] || (e.name === 'link' && e.attrs['href'])).map((e) => e.name),
    cssFetches: /@font-face|url\(/.test(styleOf(doc.html)),
    headingSkips: (() => {
      const levels = [...markup.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
      return levels.slice(1).filter((level, i) => level - levels[i] > 1);
    })(),
    marksReadAloud: els.filter((e) => e.name === 'svg' && e.attrs['class'] === 'mark' && e.attrs['aria-hidden'] !== 'true').length,
  };

  for (const [key, value] of Object.entries(report)) {
    const bad = Array.isArray(value) ? value.length > 0 : value === true;
    if (bad) failures.push(`${path} ${key}: ${JSON.stringify(value)}`);
  }
  console.log(path, JSON.stringify(report));
}

// The same widths the browser harness uses, against the deployed document.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
for (const width of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const past = await page.evaluate((limit) => {
    const out = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || box.right <= limit + 1) continue;
      out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} right=${Math.round(box.right)}`);
    }
    return out.slice(0, 5);
  }, width);
  await page.close();
  if (scrollWidth > width + 1) failures.push(`${width}px: the document scrolls sideways (${scrollWidth}px)`);
  if (past.length) failures.push(`${width}px: past the right edge ${JSON.stringify(past)}`);
  console.log(`${width}px`, JSON.stringify({ scrollWidth, pastTheEdge: past }));
}
await browser.close();

if (failures.length) {
  console.error(`\nLIVE FLOOR FAILED on ${origin}:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`\nLIVE FLOOR OK on ${origin}`);
