/* R-46: read the roadmap vocabulary where a reader sees it, against a LIVE
 * installation rather than a fixture.
 *
 * `verify-ui.mjs` proves every reading on a store it builds itself, which is
 * how the surface is gated. This script is the other half of the same question:
 * a real installation holds initiatives written over months, some hidden and
 * some still carrying pre-R-46 words, and a page that is right about a fixture
 * can still be wrong about those. It takes the running installation as it is —
 * every expectation read from that installation's own API, never written down
 * here, so this file names no installation's rows — and checks that what the
 * page says and what the server serves are the same thing.
 *
 * Usage: node packages/shell/scripts/verify-roadmap.mjs [origin]
 *        (default http://127.0.0.1:4400)
 *
 * Worth knowing before writing another one: the roadmap page is a
 * client-rendered application whose served markup is a few hundred bytes of
 * shell, so `curl` sees no vocabulary at all and a screenshot taken on navigate
 * catches the placeholder. Everything below is read after the render.
 */
import assert from 'node:assert/strict';
import { launchBrowser } from '../../work/scripts/browser.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:4400';

/* The seven statuses in the order the view draws them, and the three that draw
 * whether or not they hold anything. Both are the decision recorded in
 * H-2953@dev.rev, so this list is what the page is checked AGAINST — reading it
 * off the page would check the page against itself. */
const ORDER = ['Active', 'Planned', 'Proposed', 'Paused', 'Monitoring', 'Completed', 'Canceled'];
const ALWAYS = ['Active', 'Planned', 'Proposed'];

/* Every word a pre-R-46 store may still hold, and the two section names the
 * old view drew. None of them is a reading, so none may reach any place on the
 * page where a status is stated.
 *
 * Checked at those places rather than over the whole page text, which is the
 * mistake worth not repeating: "shipping" and "parked" are also ordinary
 * English, and the first run of this check went red on a line of the
 * operator's own charter that used one as a verb. A whole-page search for a
 * status word finds the operator's prose. */
const LEGACY = ['ship_next', 'shipped_watching', 'shipped_stable', 'shipping', 'shipped', 'shaping', 'parked', 'ready', 'archived', 'abandoned', 'Ship next', 'Watching', 'Stable', 'Archived'];

/* The acceptance anchor for R-46 is a set of named cases mapped against the
 * operator's real rows, and it lives in the operator's own definition document
 * rather than here: product source does not name an installation's rows or
 * what their statuses are (H-3341). The section check below covers those cases
 * by construction anyway — it asserts every drawn row against the status its
 * own API serves, which is a stronger statement than a handful of ids. */

const failures = [];
const check = (ok, line) => { if (!ok) failures.push(line); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${line}`); };

const document_ = await (await fetch(`${origin}/api/v1/roadmap`)).json();
const served = document_.data;
assert.ok(served?.projects?.length, `${origin} served no roadmap projects`);
const reading = (project) => project.status;
const expected = new Map(ORDER.map((status) => [status, served.projects.filter((p) => !p.archived && reading(p) === status).map((p) => p.id)]));
const hidden = served.projects.filter((p) => p.archived);

const browser = await launchBrowser();
try {
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(20000);
  await page.goto(`${origin}/roadmap`);
  await page.getByRole('table').first().waitFor();
  const sections = await page.locator('section[aria-label]').evaluateAll((nodes) => nodes.map((node) => ({
    label: node.getAttribute('aria-label'),
    heading: node.querySelector('h2')?.textContent ?? '',
    ids: [...node.querySelectorAll('tbody tr[id]')].map((row) => row.id),
  })));
  const text = await page.locator('#root').innerText();

  console.log(`--- the sections are the seven statuses, in order, as the server groups them (${origin}) ---`);
  const drawn = sections.map((s) => s.label);
  check(
    drawn.every((label, i) => drawn.slice(0, i).every((earlier) => ORDER.indexOf(earlier) < ORDER.indexOf(label))),
    `sections in status order: ${JSON.stringify(drawn)}`,
  );
  for (const status of ALWAYS) check(drawn.includes(status), `${status} is drawn whether or not it holds anything`);
  for (const section of sections) {
    check(ORDER.includes(section.label), `${section.label} is one of the seven statuses`);
    check(
      section.heading === `${section.label} · ${section.ids.length}`,
      `${section.label} heading states its own count: ${JSON.stringify(section.heading)} over ${section.ids.length} rows`,
    );
    const want = expected.get(section.label) ?? [];
    check(
      section.ids.length === want.length && section.ids.every((id) => want.includes(id)),
      `${section.label} holds exactly the rows the server reads as ${section.label}: ${section.ids.length} drawn, ${want.length} served`,
    );
  }
  for (const [status, ids] of expected) {
    if (!ids.length || drawn.includes(status)) continue;
    check(false, `${ids.length} rows read as ${status} and no section draws them: ${ids.join(', ')}`);
  }

  console.log('\n--- a hidden record is absent from the list and reachable from it ---');
  for (const project of hidden) {
    check(!sections.some((s) => s.ids.includes(project.id)), `${project.id} is in no section`);
    check(new RegExp(`\\b${project.id}\\b`).test(text), `${project.id} is named in the footnote with the status it kept`);
  }
  if (hidden.length) {
    const footnote = page.getByText(/hidden record/);
    await footnote.waitFor();
    check(
      new RegExp(`^${hidden.length} hidden records? (is|are) not listed above\\.`).test(await footnote.innerText()),
      `the footnote counts the ${hidden.length} hidden records: ${JSON.stringify((await footnote.innerText()).slice(0, 60))}`,
    );
    await footnote.getByRole('link', { name: hidden[0].id, exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.waitFor();
    check((await sheet.innerText()).includes(hidden[0].id), `${hidden[0].id} opens its record from the footnote`);
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
  }

  console.log('\n--- no pre-R-46 word reaches anywhere a status is stated ---');
  /* `data-column` is how a column is addressed here, as it is in verify-ui. */
  const stated = [
    ...sections.map((section) => section.label),
    ...sections.map((section) => section.heading),
    ...(await page.locator('[data-column="state"]').allInnerTexts()),
    ...(await page.getByText(/hidden record/).count() ? [await page.getByText(/hidden record/).innerText()] : []),
  ].join('\n');
  for (const word of LEGACY) {
    const n = stated.split(word).length - 1;
    check(n === 0, `"${word}" stated as a status ${n}x`);
  }
  /* And the record's own badge and held-initiative alert, on a row that has
     both — the alert read "Parked · Unparks when" until this packet, which is
     the status word the list no longer draws surviving one layer in. */
  const held = served.projects.find((p) => !p.archived && p.parked_reason);
  if (held) {
    await page.goto(`${origin}/roadmap#${held.id}`);
    const sheet = page.getByRole('dialog');
    await sheet.waitFor();
    const record = await sheet.innerText();
    check(record.includes(`\n${held.status}\n`) || record.includes(held.status), `${held.id}'s record states ${held.status}`);
    for (const word of ['Parked', 'Unparks when']) check(!record.includes(word), `${held.id}'s record does not say "${word}"`);
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
  }

  console.log('\n--- health is the owner\'s judgment: drawn where it is set, silent where it is not ---');
  const judged = served.projects.filter((p) => p.health && !p.archived);
  /* Scoped to the column health draws in, for the same reason the legacy words
     are: a count taken over the whole page would be a count of somebody's
     prose. */
  const rows = (await page.locator('[data-column="project"]').allInnerTexts()).join('\n');
  for (const word of ['On track', 'At risk', 'Off track']) {
    const n = rows.split(word).length - 1;
    const want = judged.filter((p) => p.health === word).length;
    check(n === want, `"${word}" is served on ${want} rows and drawn ${n}x`);
  }
  if (!judged.length) console.log('  note  no row in this installation carries a health yet, so the drawn case is proved by verify-ui.mjs and not here');

  console.log('\n--- the record says what remains and what shipped, with its denominator ---');
  const counted = served.projects.filter((p) => p.remaining_work && !p.archived);
  check(counted.length === served.projects.filter((p) => !p.archived).length, `the work join reaches every drawn row: ${counted.length}`);
  const subject = counted.find((p) => p.remaining_work.open.length) ?? counted[0];
  await page.goto(`${origin}/roadmap#${subject.id}`);
  const record = page.getByRole('dialog');
  await record.waitFor();
  const shown = await record.innerText();
  check(shown.includes(`What remains · ${subject.remaining_work.reading}`), `${subject.id} states what remains with its denominator: ${subject.remaining_work.reading}`);
  check(shown.includes(subject.remaining_work.coverage), `${subject.id} prints the server's coverage sentence verbatim`);
  check(shown.includes(`What has shipped · ${subject.shipped.reading}`), `${subject.id} states what shipped: ${subject.shipped.reading}`);
  for (const ticket of subject.remaining_work.open) check(shown.includes(ticket.id), `${ticket.id} is named as outstanding`);
  check(!/\d+%/.test(shown), 'no percentage is derived anywhere in the record');

  /* A recurring TEMPLATE is standing work — never ready, never claimed — and is
     listed apart from the open count as what WATCHES the initiative. This is the
     reading the fixture cannot carry: seeding a template there spawns a due
     instance on the next queue read and moves the Work counts that same run
     asserts. Here it is read off whichever initiative the installation has
     one on: its open count must exclude the template, with the template shown
     beside it as what watches the row (R-46 case 5). */
  const watched = counted.find((p) => p.remaining_work.standing.length);
  if (!watched) console.log('  note  no initiative in this installation is watched by a recurring template, so that reading is not exercised here');
  if (watched) {
    await page.goto(`${origin}/roadmap#${watched.id}`);
    await page.getByRole('dialog').waitFor();
    const held = await page.getByRole('dialog').innerText();
    check(held.includes(`What remains \u00b7 ${watched.remaining_work.reading}`), `${watched.id} counts ${watched.remaining_work.reading}, excluding its template`);
    for (const ticket of watched.remaining_work.standing) check(held.includes(ticket.id), `${ticket.id} is named as what watches ${watched.id}`);
    check(/standing work, never ready and never claimed, so it is not in the open count/.test(held), 'standing work says why it is not in the open count');
  }
} finally {
  await browser.close();
}

console.log(failures.length ? `\nFAILED\n- ${failures.join('\n- ')}` : `\nPASS — ${origin} reads the R-46 vocabulary`);
process.exit(failures.length ? 1 : 0);
