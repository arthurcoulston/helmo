import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBuilt } from '../../../scripts/build.mjs';
import { launchBrowser } from '../../work/scripts/browser.mjs';
import { env } from '../../cli/test/installation.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
assertBuilt(root);
/* The WCAG audit is a dependency, not an environment variable. It used to run
   only `if (process.env.HELMO_AXE_SOURCE && existsSync(...))`, so the default
   was to audit nothing, print nothing and exit 0 — a clean run a reader took
   for accessibility evidence (H-2982). Resolved here so a missing devDependency
   fails before a browser is launched. */
const required = createRequire(import.meta.url);
const axeSource = required.resolve('axe-core/axe.min.js');
const axeVersion = required('axe-core/package.json').version;
const core = await import('../../core/dist/index.js');
assert.equal(typeof core.uiRequest, 'function', 'The compiled core is stale. Prepare and build this exact ref in a disposable checkout before running verify:ui; never rebuild a shared installation.');
const { Store } = await import('../../work/dist/store.js');
const { Store: RoadmapStore } = await import('../../roadmap/dist/store.js');
const dir = mkdtempSync(join(tmpdir(), 'helmo-ui-proof-'));
for (const name of ['work', 'roadmap', 'runtime', 'shots']) mkdirSync(join(dir, name));
copyFileSync(join(root, 'packages/runtime/examples/roster.toml'), join(dir, 'runtime/roster.toml'));
mkdirSync(join(dir, 'runtime/constitutions'));
writeFileSync(join(dir, 'runtime/constitutions/example-worker.md'), 'A fixture member profile with a clear responsibility.');
mkdirSync(join(dir, 'runtime/state/example-worker'), { recursive: true });
/* A stoppage, not a queue. The wording here used to describe a wait — "needs a
   prerequisite before work can resume" — and a reviewer reading the ochre chip
   beside it took BLOCKED for an ordinary dependency wait and called the colour a
   contract conflict (H-2981). It is not: `loopStateRole` keeps every DELIBERATE
   pause neutral and BLOCKED is a loop that has downed tools, which Arthur
   confirmed should stay amber (H-2987@dev.rev). The fixture says so now. */
writeFileSync(join(dir, 'runtime/state/example-worker/BLOCKED'), 'reason=The fixture worker has downed tools and will not resume without intervention.');
writeFileSync(join(dir, 'runtime/state/example-worker/events.log'), '2026-10-06 fixture event: a complete recent trace.\n');
const actor = { name: 'fixture', kind: 'orchestrator', model: 'fixture', version: 'fixture' };
const store = new Store(join(dir, 'work/helmo.db'));
const create = (title, extra = {}) => store.createTicket(actor, { title, body: `Full record for ${title}`, type: 'build', workstream: 'fixture', labels: ['acct:direction'], ...extra });
const ready = create('Ready work with a complete title');
const blocked = create('Held work must never read ready', { capacity_hold: { reason: 'Waiting for the chosen spending window', provenance: 'Fixture operator', reconsider_when: 'Next fixture cycle' } });
// createTicket takes no capacity hold; set it through the same update path.
store.updateTicket(actor, { ticket_id: blocked.id, capacity_hold: { reason: 'Waiting for the chosen spending window', provenance: 'Fixture operator', reconsider_when: 'Next fixture cycle' }, note: 'Held by the fixture operator.' });
let oldest;
for (let i = 0; i < 24; i++) {
  const t = create(`Completed outcome ${i}`);
  store.updateTicket(actor, { ticket_id: t.id, status: 'done', note: `Finished outcome ${i}`, evidence: [{ kind: 'url', ref: 'https://example.com/result', note: 'The result' }], confidence: 'routine' });
  oldest ??= t;
}
// A result that is a commit, with a file supporting it (R-42 contract §3.5):
// the built bundle has to show the commit as what the work produced. Every row
// of that table is proved from source in `test/work-result.test.mjs`; this one
// case is here because only a real browser on the built app proves the bundle
// carries the change at all.
const operational = create('An operational change states its own result');
store.updateTicket(actor, { ticket_id: operational.id, status: 'done', note: 'Changed the running system.', confidence: 'routine', evidence: [
  { kind: 'commit', ref: 'helmo@76f395d', role: 'result', note: 'What changed' },
  { kind: 'file', ref: '~/.helmo/rev.json', role: 'supporting' },
] });

/* A record far longer than a row can carry, whose opening is filing prose
   rather than the work, and the one fixture with an owner — so the short
   reading and the Who column are proved on what they actually meet. */
const longWork = create('A work record whose opening is not the work', {
  assignee: 'fixture-member',
  body: `${'Filing provenance recorded when this ticket was last reconciled, which is context rather than the work itself. '.repeat(5)}\n\nOutcome: the thing a reader actually wants from this record.`,
});

const decision = create('A decision awaiting the operator');
store.returnToHuman(actor, decision.id, { situation: 'Fixture situation', question: 'Use the standard baseline?', recommendation: 'Use the selected baseline.' });

/* One record per status COLOUR (H-2978), because a palette proved on nothing
   that carries it is an empty set passing. These four put a live role on Work
   in both themes: work in motion, a release review that accepted the work, one
   that refused it, and a closed ticket with nothing to show for itself. */
const moving = create('Work in motion reads as in motion');
store.updateTicket(actor, { ticket_id: moving.id, status: 'in_progress', note: 'Claimed by the fixture worker.' });
const reviewer = { name: 'fixture-reviewer', kind: 'agent', model: 'fixture', version: 'fixture' };
const reviewed = (title, verdict) => {
  const t = create(title);
  /* An immutable ref: the store refuses anything short of a full sha, which
     is the point of the completion record. */
  const ref = `helmo@${createHash('sha1').update(t.id).digest('hex')}`;
  store.updateTicket(actor, { ticket_id: t.id, status: 'done', note: `Finished ${t.id}.`, confidence: 'routine', evidence: [{ kind: 'commit', ref, role: 'result' }] });
  store.recordProductCompletion(actor, { ticket_id: t.id, artifacts: [{ ref, author: 'fixture' }], note: 'Ready for an independent reading.' });
  store.recordAcceptanceVerdict(reviewer, { ticket_id: t.id, refs: [ref], verdict, note: `The review ${verdict === 'pass' ? 'confirmed' : 'refused'} this exact ref.` });
  return t;
};
const accepted = reviewed('An accepted release review says so', 'pass');
const refused = reviewed('A refused release review says so', 'fail');
const unproved = create('A closed ticket with nothing to show');
store.updateTicket(actor, { ticket_id: unproved.id, status: 'done', note: 'Closed without recording what it produced.', confidence: 'needs_review' });

const roadmap = new RoadmapStore(join(dir, 'roadmap/roadmap.db'));
const project = roadmap.createProject(actor, { title: 'The complete standard UI foundation', status: 'ready', body: 'Preserve the full project record while using standard components.' });
const objective = roadmap.setCharterItem(actor, { shape: 'objective', statement: 'A clear foundation', source: 'Fixture charter', horizon: 'near', rank: 1 });
roadmap.cite(actor, { project_id: project.id, objective_id: objective.id, claim: 'A consistent interface makes the work legible.' });
roadmap.recordClaim(actor, { project_id: project.id, kind: 'value', level: 'high', reason: 'Every operator reading benefits.' });
roadmap.recordClaim(actor, { project_id: project.id, kind: 'effort', size: 'M', predicted_usd: 20, reason: 'A finite set of existing screens.' });
roadmap.setShipNext(actor, { project_id: project.id, decided_by: 'Fixture operator', reason: 'The foundation is the next work.' });
/* Three more projects, so the compact reading is proved on what it has to
   survive: a record far longer than a row can carry whose opening is filing
   prose rather than meaning, a second ranked row to compare the order
   against, and an unranked shipped one. */
const unruly = roadmap.createProject(actor, { title: 'An unruly record whose opening is not the project', status: 'shaping', body: `${'Filing provenance recorded when this project was last reconciled, which is context rather than the project itself. '.repeat(5)}\n\nOutcome: the thing a reader actually wants from this record.` });
roadmap.updateProject(actor, { project_id: unruly.id, status: 'parked', parked_reason: 'Another project is the current focus.', unpark_condition: 'The current focus ships.', note: 'Parked by the fixture operator.' });
const shaping = roadmap.createProject(actor, { title: 'A shaping project with no stated objective', status: 'shaping', body: 'Still being shaped.' });
const watching = roadmap.createProject(actor, { title: 'A shipped project under observation', status: 'shipped_watching', body: 'Shipped and watched.' });
/* And one that came through observation, so Roadmap carries the healthy role
   as well as the in-motion one. */
roadmap.createProject(actor, { title: 'A shipped project that settled', status: 'shipped_stable', body: 'Shipped and stable.' });

const choice = create('Choose between the stored options');
store.returnToHuman(actor, choice.id, { situation: 'Both options are valid.', question: 'Which option should be used?', recommendation: 'First', options: [{ label: 'First', consequence: 'Use the first path.' }, { label: 'Second', consequence: 'Use the second path.' }] });
const action = create('Report the completed action');
store.requestAction(actor, action.id, { situation: 'A fixture action is due.', action: 'Complete the fixture action.', why_human: 'The fixture operator performs it.' });
const sitting = create('A sitting is a conversation', { needs_human: 'Discuss this with the fixture member.', sitting_with: 'fixture' });

const child = spawn(process.execPath, [join(root, 'packages/cli/bin/serve.js')], {
  env: env({ HELMO_HOME: join(dir, 'work'), ROADMAP_HOME: join(dir, 'roadmap'), REV_HOME: join(dir, 'runtime'), HELMO_APP_PORT: '0', HELMO_OPERATOR: 'fixture-operator' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
const origin = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(output || 'The preview did not start')), 20000);
  const read = (chunk) => {
    output += chunk;
    const match = /Helmo app: (http:\/\/\S+)/.exec(output);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  };
  child.stdout.on('data', read); child.stderr.on('data', read);
  child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Preview exited ${code}: ${output}`)); });
});
let browser;
try {
  browser = await launchBrowser();
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  /* ---------- the status palette, measured where it is painted (H-2978) ----------

     Arthur's approved colours, as the browser must compute them. A role is
     found by the token it NAMES in its class attribute rather than by the
     selectors this change happened to touch, so a role added later to any
     surface is measured without anyone remembering to widen this. */
  const PALETTE = {
    info: { light: ['rgb(73, 106, 138)', 'rgb(237, 242, 247)'], dark: ['rgb(169, 195, 219)', 'rgb(38, 51, 63)'] },
    success: { light: ['rgb(73, 107, 85)', 'rgb(237, 244, 239)'], dark: ['rgb(174, 203, 183)', 'rgb(41, 55, 46)'] },
    attention: { light: ['rgb(136, 101, 40)', 'rgb(250, 243, 229)'], dark: ['rgb(217, 189, 135)', 'rgb(61, 52, 36)'] },
    failure: { light: ['rgb(138, 65, 69)', 'rgb(243, 214, 214)'], dark: ['rgb(233, 176, 176)', 'rgb(86, 54, 54)'] },
  };
  const luminance = (css) => {
    const [r, g, b] = css.match(/[\d.]+/g).slice(0, 3)
      .map((v) => Number(v) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const seen = new Set();
  /* How far each role's fill stands off the ground it is on, grouped by that
     exact ground so the comparison is between chips on the same page and never
     between a chip on a card and one on a hovered row. Arthur's H-2987 decision
     is an ordering — red louder than amber — so what is asserted is the
     ordering, measured on what the renderer actually produced rather than on
     the hexes. `test/status-palette.test.mjs` is where the 0.2 floor under the
     margin is decided and explained; this is the same floor on real pixels. */
  const LOUDER_BY = 0.2;
  const standoff = new Map();
  /** Measure every rendered role on the current page, in the current theme. */
  async function measurePalette(where, theme) {
    /* A theme class put on from script cross-fades every `transition-all`
       element, and a badge read mid-fade is sitting at the OTHER theme's colour
       on this theme's ground — a real contrast failure, and a flaky one.
       Settle on CSS transitions only: a skeleton's pulse never finishes. */
    await page.waitForFunction(() => !document.getAnimations().some((a) => a.constructor.name === 'CSSTransition'));
    /* Both ways in: the marker, and a class naming a token. An element that
       lost its class entirely still has the marker and still gets measured. */
    const found = await page.evaluate(() => {
      /* The browser is the authority on what a colour IS. The preset's own
         surfaces are declared in oklch and `getComputedStyle` hands them back
         that way, so reading a colour's three components as if they were sRGB
         bytes turns every ratio against a real surface into fiction — 0.96 is
         not one red. Painting the value and reading the pixel back asks the
         renderer to convert, whatever space it was written in. */
      const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 })
        .getContext('2d', { willReadFrequently: true });
      ctx.globalCompositeOperation = 'copy';
      const srgb = (css) => {
        ctx.fillStyle = '#000';
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
      };
      return [...document.querySelectorAll('[data-status-role], [class*="--helmo-"]')]
      .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
      .map((el) => {
        const classes = String(el.className);
        /* The colour behind this element: its own if it paints one, else what
           shows through to the nearest ancestor that does. Text given only an
           ink sits on the page.

           Every layer is composited rather than read as if it were opaque,
           because upstream's TableRow tints a hovered and an expanded row with
           `bg-muted/50` — half-transparent — and the reader sees the blend. The
           declared colour of a translucent layer is a ratio nobody is looking
           at, and reading it as solid can report a pass the screen never gave. */
        const composite = (from) => {
          const layers = [];
          for (let node = from; node; node = node.parentElement) {
            const [r, g, b, a] = srgb(getComputedStyle(node).backgroundColor);
            if (a > 0) layers.push([r, g, b, a]);
            if (a === 1) break;
          }
          /* Bottom layer first, each one painted onto what is already under it. */
          const [br, bg, bb] = layers.reduceRight(
            (under, [r, g, b, a]) => [r, g, b].map((channel, i) => Math.round(channel * a + under[i] * (1 - a))),
            [255, 255, 255],
          );
          return `rgb(${br}, ${bg}, ${bb})`;
        };
        const background = composite(el);
        /* And the ground the element sits ON, which is a different question from
           the surface its own text sits on, and the one "stands out" is asked
           against. Started from the parent, so a tinted chip's own fill is not
           mistaken for the page it is standing off. */
        const ground = composite(el.parentElement);
        return {
          /* The marker first: StatusBadge and StatusAlert set it from the role
             PROP, so an element carrying it must be fully painted whatever its
             class attribute ended up saying — which is what catches a utility
             Tailwind never generated or a merge that kept the stock colour.
             The class is only the fallback, for ink applied to plain text. */
          role: el.dataset.statusRole ?? (/--helmo-(\w+)-/.exec(classes) ?? [])[1],
          tinted: Boolean(el.dataset.statusRole) || classes.includes('bg-[var(--helmo-'),
          text: el.textContent.trim(),
          color: `rgb(${srgb(getComputedStyle(el).color).slice(0, 3).join(', ')})`,
          background,
          ground,
        };
      });
    });
    for (const item of found) {
      const expected = PALETTE[item.role];
      assert.ok(expected, `${where} ${theme}: an element names an unknown role "${item.role}"`);
      const [ink, tint] = expected[theme];
      assert.equal(item.color, ink, `${where} ${theme}: a ${item.role} element is not painted the approved ink — a class that never reached the stylesheet paints nothing and logs nothing`);
      if (item.tinted) assert.equal(item.background, tint, `${where} ${theme}: a ${item.role} element asks for its tint and sits on ${item.background}`);
      /* The reading that matters: the ratio the browser actually produces on
         the surface this element actually landed on. */
      const ratio = contrast(item.color, item.background);
      assert.ok(ratio >= 4.5, `${where} ${theme}: ${item.role} "${item.text.slice(0, 40)}" reads ${ratio.toFixed(2)}:1 on ${item.background}`);
      /* The tint is 1.1–1.45:1 against its surface by design, so colour can
         never be the carrier: every role has to say what it means in words. */
      assert.ok(item.text, `${where} ${theme}: a ${item.role} element carries colour and no text`);
      seen.add(`${item.role}/${theme}`);
      if (item.tinted) {
        const key = `${theme} on ${item.ground}`;
        const group = standoff.get(key) ?? standoff.set(key, new Map()).get(key);
        group.set(item.role, contrast(item.background, item.ground));
      }
    }
    return found.length;
  }
  // Work is a compact reading: the groups are tables, a collapsed row carries
  // no record body, and a sentence-length reason is in the record not the row.
  await page.goto(`${origin}/work`);
  await page.getByRole('heading', { name: 'Ready · 2', exact: true }).waitFor();
  assert.equal(await page.getByRole('table', { name: 'Ready', exact: true }).getByText(ready.title, { exact: true }).count(), 1);
  assert.equal(await page.getByRole('table', { name: 'Blocked', exact: true }).getByText(blocked.title, { exact: true }).count(), 1);
  assert.equal(await page.locator(`#${oldest.id}`).count(), 0, 'default reading must bound terminal history');
  assert.equal(await page.getByText(`Full record for ${ready.title}`, { exact: true }).count(), 0, 'a collapsed row must not carry the record body');
  await page.locator(`tr#${blocked.id}`).getByText('On hold', { exact: true }).waitFor();
  assert.equal(await page.locator(`tr#${blocked.id}`).getByText('Waiting for the chosen spending window').count(), 0, "a hold's reason belongs in the record");
  await page.locator(`tr#${longWork.id}`).getByText('fixture-member', { exact: true }).waitFor();
  // The one short reading a row offers is the record's own opening, bounded.
  await page.locator(`tr#${longWork.id}`).getByRole('button', { name: `Summary of ${longWork.id}`, exact: true }).click();
  const opening = page.locator(`[data-expanded-for="${longWork.id}"]`);
  const shown = await opening.locator('p').innerText();
  assert.ok(shown.startsWith('Filing provenance recorded when'), `the preview is not the record's opening: ${shown.slice(0, 40)}`);
  assert.ok(shown.length <= 321 && shown.endsWith('…'), `the preview is not bounded: ${shown.length} characters`);
  assert.equal(await opening.getByRole('button', { name: 'History', exact: true }).count(), 0, 'an expanded row carries no history');
  await opening.getByRole('button', { name: /^Open full view/ }).waitFor();
  // Expansion and focus are the reader's state, and a poll may move neither.
  await page.getByRole('button', { name: `Copy ${ready.id}`, exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), ready.id);
  await page.waitForTimeout(15500);
  assert.equal(await page.locator(`[data-expanded-for="${longWork.id}"]`).count(), 1, 'refresh must keep the row expanded');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), `Copy ${ready.id}`, 'refresh must retain focus');
  // The complete record is a Sheet, reached from the row by keyboard without
  // expanding first, carrying what the row deliberately leaves out.
  await page.locator(`tr#${blocked.id}`).getByRole('button', { name: blocked.title, exact: true }).focus();
  await page.keyboard.press('Enter');
  const record = page.getByRole('dialog');
  await record.getByText(`Full record for ${blocked.title}`, { exact: true }).waitFor();
  await record.getByText('On hold · Waiting for the chosen spending window', { exact: true }).waitFor();
  // Work's history is written out under its own heading, not behind a toggle.
  await record.getByRole('heading', { name: 'History', exact: true }).waitFor();
  await record.getByText(/Last recorded update .* by fixture: Held by the fixture operator\./).waitFor();
  await record.locator(`[aria-label="${blocked.id} history"]`).getByText('Held by the fixture operator.', { exact: true }).waitFor();
  await record.getByRole('button', { name: `Copy ${blocked.id}`, exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), blocked.id);
  await page.keyboard.press('Escape');
  await record.waitFor({ state: 'detached' });
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent?.trim()),
    blocked.title,
    'closing the record must return focus to the control that opened it',
  );
  // A bookmarked reference opens that record, and the result is in it.
  await page.goto(`${origin}/#${oldest.id}`);
  const closed = page.getByRole('dialog');
  await closed.getByText(`Full record for ${oldest.title}`, { exact: true }).waitFor();
  assert.equal(await closed.getByRole('link', { name: 'View result', exact: true }).getAttribute('href'), 'https://example.com/result');
  await page.goto(`${origin}/work?whole=1#${operational.id}`);
  const operationalRecord = page.getByRole('dialog');
  await operationalRecord.getByText('commit helmo@76f395d', { exact: true }).waitFor();
  assert.equal(await operationalRecord.getByText('No result recorded').count(), 0, 'a commit result must not read as no result');
  assert.equal(await operationalRecord.getByRole('link', { name: 'View result', exact: true }).count(), 0, 'a commit is not something a browser opens');
  assert.equal(await operationalRecord.getByText('~/.helmo/rev.json', { exact: true }).count(), 1);
  for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((value) => document.documentElement.className = value, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(dir, `shots/work-record-${theme}-${width}.png`), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => document.documentElement.className = 'light');
  await page.goto(`${origin}/?section=awaiting`);
  await page.getByText(decision.title, { exact: true }).waitFor();
  assert.equal(await page.locator('[data-sidebar="sidebar"]').count(), 0, 'embedded reading carries no full navigation');
  await page.locator(`#${decision.id}`).getByRole('button', { name: 'Ratify recommendation', exact: true }).click();
  await page.locator(`#${decision.id}`).waitFor({ state: 'detached' });
  assert.equal(store.getTicket(decision.id).status, 'open');
  await page.goto(`${origin}/work`);
  await page.locator(`#${sitting.id}`).waitFor();
  assert.equal(await page.locator(`#${sitting.id}`).getByRole('button').count(), 1, 'a sitting offers only copying, no answer control');
  const option = page.locator(`#${choice.id}`).getByRole('button', { name: /Second/ });
  await option.focus(); await page.keyboard.press('Enter');
  await page.locator(`#${choice.id}`).getByRole('button', { name: 'Ratify recommendation' }).waitFor({ state: 'detached' });
  assert.equal(store.lastAnswer(choice.id).chosen_option, 'Second');
  await page.locator(`#${action.id}`).getByRole('button', { name: 'I’ve done it' }).click();
  await page.locator(`#${action.id}`).getByRole('button', { name: 'I’ve done it' }).waitFor({ state: 'detached' });
  assert.equal(store.getTicket(action.id).action, null);
  const stale = create('Two windows see the same pending decision');
  store.returnToHuman(actor, stale.id, { situation: 'One answer is allowed.', question: 'Use this result?', recommendation: 'Use it.' });
  await page.goto(`${origin}/work?whole=1#${stale.id}`);
  await page.locator(`#${stale.id}`).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'a fragment naming a request must not put a modal over its card');
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open in new window' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.equal(popup.url(), page.url());
  await popup.locator(`#${stale.id}`).getByRole('button', { name: 'Ratify recommendation' }).click();
  await popup.locator(`#${stale.id}`).getByRole('button', { name: 'Ratify recommendation' }).waitFor({ state: 'detached' });
  const refused = page.waitForResponse((response) => response.url().endsWith('/answer') && response.request().method() === 'POST');
  await page.locator(`#${stale.id}`).getByRole('button', { name: 'Ratify recommendation' }).click();
  const refusal = await refused;
  assert.equal(refusal.status(), 400, 'a resolved question cannot be answered again');
  await page.getByRole('status').filter({ hasText: (await refusal.json()).error }).waitFor();
  assert.equal(store.getEvents(stale.id).filter((e) => e.event_type === 'answered').length, 1);
  await popup.close();
  await page.evaluate(() => window.open = () => null);
  await page.getByRole('button', { name: 'Open in new window' }).click();
  await page.getByRole('link', { name: /Your browser blocked the window/ }).waitFor();
  await page.goto(`${origin}/work`);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
  await page.getByRole('button', { name: `Copy ${ready.id}`, exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('status').filter({ hasText: `${ready.id} copied` }).waitFor();
  // Roadmap is a compact table: a collapsed row carries no record body, and
  // the groups and the server's ranked order are what the rows are.
  await page.goto(`${origin}/roadmap`);
  const list = page.getByRole('table', { name: 'The list', exact: true });
  await list.locator(`tr#${unruly.id}`).waitFor();
  assert.equal(await page.getByText(project.body, { exact: true }).count(), 0, 'a collapsed row must not carry the record body');
  const ranking = (await (await page.request.get(`${origin}/api/v1/roadmap`)).json()).data.ranked;
  assert.deepEqual(
    await list.locator('tbody tr[id]').evaluateAll((rows) => rows.map((row) => row.id)),
    ranking.filter((r) => r.project.status !== 'ship_next').map((r) => r.project.id),
    'the table must keep the order the server ranked',
  );
  assert.deepEqual(
    await page.getByRole('table', { name: 'Ship next', exact: true }).locator('tbody tr[id]').evaluateAll((rows) => rows.map((row) => row.id)),
    [project.id],
  );
  await page.getByRole('table', { name: 'Shipped — watching', exact: true }).locator(`tr#${watching.id}`).getByText('—', { exact: true }).waitFor();
  // The server's own explanation is the only place a row says these things.
  await page.locator(`tr#${shaping.id}`).getByText('shaping, advances nothing stated', { exact: true }).waitFor();
  assert.equal(
    (await page.locator(`tr#${shaping.id}`).innerText()).match(/advances nothing stated/g).length,
    1,
    'the row must not render the same ranking fact twice',
  );
  // An expanded row is the record's opening, bounded, and nothing else.
  await page.locator(`tr#${unruly.id}`).getByRole('button', { name: `Summary of ${unruly.id}`, exact: true }).click();
  const summary = page.locator(`[data-expanded-for="${unruly.id}"]`);
  const preview = await summary.locator('p').innerText();
  assert.ok(preview.startsWith('Filing provenance recorded when'), `the preview is not the record's opening: ${preview.slice(0, 40)}`);
  assert.ok(preview.length <= 321 && preview.endsWith('…'), `the preview is not bounded: ${preview.length} characters`);
  assert.equal(await summary.getByRole('button', { name: 'History', exact: true }).count(), 0, 'an expanded row carries no history');
  await summary.getByRole('button', { name: /^Open full view/ }).waitFor();
  // Expansion is keyed by the record, so a refresh cannot close it.
  await page.waitForTimeout(15500);
  assert.equal(await page.locator(`[data-expanded-for="${unruly.id}"]`).count(), 1, 'refresh must keep the row expanded');
  // The complete project is a Sheet, reachable without expanding first, and
  // closing it returns to the control that opened it.
  await page.locator(`tr#${project.id}`).getByRole('button', { name: project.title, exact: true }).focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog');
  await sheet.getByText(project.body, { exact: true }).waitFor();
  await sheet.getByText(/decided by Fixture operator/).waitFor();
  await sheet.getByText(/A consistent interface makes the work legible/).waitFor();
  await sheet.getByText(/Every operator reading benefits/).waitFor();
  await sheet.getByRole('button', { name: 'History', exact: true }).click();
  await sheet.getByText(/ship next set/).waitFor();
  await sheet.getByRole('button', { name: `Copy ${project.id}`, exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), project.id);
  for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((value) => document.documentElement.className = value, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(dir, `shots/roadmap-record-${theme}-${width}.png`), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => document.documentElement.className = 'light');
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent?.trim()),
    project.title,
    'closing the record must return focus to the control that opened it',
  );
  // The parked reason and its exit are in the record, not in the row.
  assert.equal(await page.locator(`tr#${unruly.id}`).getByText('Another project is the current focus.').count(), 0);
  await page.goto(`${origin}/roadmap#${unruly.id}`);
  await page.getByRole('dialog').getByText('Another project is the current focus. · Unparks when: The current focus ships.', { exact: true }).waitFor();
  await page.goto(`${origin}/run`);
  await page.getByRole('table', { name: 'Loop status', exact: true }).waitFor();
  await page.getByText('BLOCKED', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Recent events for example-worker' }).click();
  await page.getByText(/a complete recent trace/).waitFor();
  await page.getByRole('button', { name: 'Build and installation details' }).click();
  await page.getByText(/supervisor: not running/).waitFor();
  await page.goto(`${origin}/team`);
  await page.getByRole('button', { name: 'Profile for example-worker' }).click();
  await page.getByText('A fixture member profile with a clear responsibility.', { exact: true }).waitFor();
  /* A row's surface is not fixed, and the layouts above only ever measured it
     at rest. Upstream's TableRow tints on hover and for as long as a row stays
     expanded (`hover:bg-muted/50`, `has-aria-expanded:bg-muted/50`), and both
     tints are translucent — the case the compositing above exists for.

     Each state is proved to have actually moved the surface before a role on it
     is measured: a hover that silently did nothing would otherwise re-measure
     the resting row and pass. */
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/work`);
  const movingRow = page.locator(`tr#${moving.id}`);
  await movingRow.getByText('In motion', { exact: true }).waitFor();
  const movedFrom = ([id, was]) => getComputedStyle(document.getElementById(id)).backgroundColor !== was;
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.className = value, theme);
    const resting = await movingRow.evaluate((el) => getComputedStyle(el).backgroundColor);
    await movingRow.hover();
    await page.waitForFunction(movedFrom, [moving.id, resting]);
    assert.ok(await measurePalette('a hovered row', theme) > 0, `${theme}: a hovered row carried no role to measure`);
    /* Expanded is the same tint but it outlives the pointer, so it is the one a
       reader actually sits in front of. Measured with the mouse taken away, or
       it would just be the hover case again. */
    const summary = movingRow.getByRole('button', { name: `Summary of ${moving.id}`, exact: true });
    await summary.click();
    await page.locator(`[data-expanded-for="${moving.id}"]`).waitFor();
    await page.mouse.move(0, 0);
    await page.waitForFunction(movedFrom, [moving.id, resting]);
    assert.ok(await measurePalette('an expanded row', theme) > 0, `${theme}: an expanded row carried no role to measure`);
    await summary.click();
    await page.locator(`[data-expanded-for="${moving.id}"]`).waitFor({ state: 'detached' });
  }
  /* Why those two measurements stay true as the product grows: every role in a
     row paints its own opaque tint, so whatever the row does behind it cannot
     change the ratio. `inkRole` is the exception that would break that — ink on
     whatever happens to be underneath — and this is what fails on the day one
     is put in a row, naming the reason rather than a colour. */
  assert.deepEqual(
    await page.evaluate(() => [...document.querySelectorAll('tr [data-status-role], tr [class*="--helmo-"]')]
      .filter((el) => !el.dataset.statusRole && !String(el.className).includes('bg-[var(--helmo-'))
      .map((el) => el.textContent.trim().slice(0, 40))),
    [],
    'a role inside a table row carries ink with no tint of its own, so a hovered or expanded row changes the surface under it',
  );
  await page.evaluate(() => document.documentElement.className = 'light');
  const areas = ['overview', 'work', 'roadmap', 'team', 'run'], themes = ['light', 'dark'], widths = [390, 640, 1280];
  const audited = [];
  /* Where the horizontal fold falls on a phone. Nothing above can see this:
     the page itself never overflows — the table scrolls inside its own
     container — so `measure.overflow` is 0 on a row whose state is cut in
     half, which is what shipped (H-2981: "In moti" on Work at 390, and
     Roadmap's "Ship next" cut harder). A row's work and its state are the two
     columns that have to be readable without scrolling; everything after them
     is what the region's label offers to scroll for. */
  const cut = [], folds = [];
  /* And whether the groups of one view line up. Each group is its own table, so
     under auto layout each sized its columns from its own content and Work's
     State column started at x317 in two groups and x340 in the third — a view
     with no straight edge to run an eye down (H-2988). `table-fixed` and a
     declared width per column make the geometry a property of the view rather
     than of which records happen to be in a group, which is also what makes
     this measurable on a fixture at all. */
  const shapes = new Map();
  /* And whether anything is wider than the column holding it. Fixed layout is
     what makes a column's width a decision rather than a consequence, and the
     thing it gives up is the browser's own guarantee that content fits: a cell
     that cannot wrap simply reaches across its neighbour, with nothing in the
     page's own overflow to show for it. Each width is sized to the widest thing
     the real record asks it to carry, so this is the measurement that keeps
     that true as the words change. */
  const spill = [];
  for (const area of areas) for (const theme of themes) for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/${area}`);
    await page.getByText(/Refreshed .*updates every/).waitFor();
    await page.evaluate((value) => document.documentElement.className = value, theme);
    await page.waitForTimeout(250);
    const measure = await page.evaluate(() => ({ font: getComputedStyle(document.body).fontFamily, overflow: document.documentElement.scrollWidth - innerWidth }));
    assert.match(measure.font, /Inter/);
    assert.ok(measure.overflow <= 1, `${theme} ${width}: ${measure.overflow}px overflow`);
    await measurePalette(`${area} ${width}`, theme);
    await page.addScriptTag({ path: axeSource });
    const audit = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => ({ target: n.target, failureSummary: n.failureSummary })) })));
    assert.deepEqual(audit, [], `${area} ${theme} ${width} accessibility violations: ${JSON.stringify(audit)}`);
    audited.push(`${area}/${theme}/${width}`);
    await page.screenshot({ path: join(dir, `shots/${area}-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
    if (width === 390) {
      /* By `data-column`, never by the words in the cell: a state renamed
         tomorrow must still be measured rather than silently skipped. */
      const states = await page.evaluate(() => [...document.querySelectorAll('[data-slot="table-container"]')].flatMap((container) => {
        const edge = container.getBoundingClientRect().left + container.clientWidth;
        return [...container.querySelectorAll('tbody [data-column="state"]')].map((cell) => ({
          table: container.querySelector('table')?.getAttribute('aria-label'),
          text: cell.textContent.trim(),
          over: Math.round(cell.getBoundingClientRect().right - edge),
        }));
      }));
      folds.push(...states);
      cut.push(...states.filter((state) => state.over > 0).map((state) => `${area} ${theme}: ${state.table} cuts "${state.text}" by ${state.over}px`));
    }
    /* By offset and width from the table's own left edge, never from the
       viewport: a view whose groups agree is one shape however the page around
       them is laid out. */
    const geometry = await page.evaluate(() => [...document.querySelectorAll('[data-slot="table-container"]')].map((container) => {
      const table = container.querySelector('table');
      const left = table.getBoundingClientRect().left;
      return [...container.querySelectorAll('thead th[data-column]')]
        .map((th) => `${th.dataset.column}@${Math.round(th.getBoundingClientRect().left - left)}+${Math.round(th.getBoundingClientRect().width)}`)
        .join(' ');
    }));
    if (geometry.length > 1) shapes.set(`${area} ${theme} ${width}`, [...new Set(geometry)]);
    spill.push(...(await page.evaluate(() => [...document.querySelectorAll('tbody td[data-column]')].flatMap((cell) => {
      const style = getComputedStyle(cell);
      const room = cell.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      /* The cell's own children, not its text: a wrapping cell's box already
         holds its text by definition, and what overflows is an element that
         will not wrap — a badge, a date, a name. */
      return [...cell.children]
        .map((el) => ({ column: cell.dataset.column, over: Math.round(el.getBoundingClientRect().width - room), text: el.textContent.trim().slice(0, 30) }))
        .filter((item) => item.over > 1);
    }))).map((item) => `${area} ${theme} ${width}: ${item.column} holds "${item.text}", ${item.over}px wider than its column`));
  }
  // A real iframe receives both its count and size without a second renderer.
  await page.goto(`${origin}/work`);
  await page.evaluate(() => {
    window.sectionReports = [];
    window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data?.type === 'helmo:section-size') window.sectionReports.push(e.data); });
    const iframe = document.createElement('iframe'); iframe.src = '/?section=awaiting'; document.body.appendChild(iframe);
  });
  await page.waitForFunction(() => window.sectionReports?.some((r) => r.count === 1 && r.height > 100));
  // Failed polling keeps actual content and announces the last good reading.
  await page.goto(`${origin}/roadmap`);
  await page.getByText(project.title, { exact: true }).waitFor();
  await page.route('**/api/v1/roadmap', (route) => route.fulfill({ status: 503, body: 'fixture unavailable' }));
  await page.getByText('Refresh failed', { exact: true }).waitFor({ timeout: 20000 });
  assert.equal(await page.getByText(project.title, { exact: true }).count(), 1);
  await page.reload();
  await page.getByText('Could not read roadmap', { exact: true }).waitFor();
  /* A page that cannot be read at all is the one failure alert a reader meets,
     and it only exists on this path — so it is measured here, in both themes,
     rather than left to the layouts above where nothing is broken. */
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.className = value, theme);
    assert.ok(await measurePalette('an unreadable area', theme) > 0, 'the unreadable area carries no role at all');
  }
  await page.evaluate(() => document.documentElement.className = 'light');
  await page.unroute('**/api/v1/roadmap');
  // Keyboard scrolling keeps the table, not the entire document, moving.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${origin}/run`);
  await page.getByRole('table', { name: 'Loop status', exact: true }).focus();
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250);
  assert.ok(await page.locator('[data-slot="table-container"]').evaluate((el) => el.scrollLeft > 0));
  /* Every assertion above this line would pass on a page that painted no role
     at all, which is how a palette ships as monochrome under a green run. */
  assert.deepEqual(
    [...seen].sort(),
    ['attention/dark', 'attention/light', 'failure/dark', 'failure/light', 'info/dark', 'info/light', 'success/dark', 'success/light'],
    'a role was never rendered anywhere, so nothing measured it',
  );
  /* Red outranks amber, as Arthur decided in H-2987@dev.rev — on the rendered
     fills, on each ground a chip was actually found on. Only grounds carrying
     failure AND something else can say anything, and the pair that has to be
     compared is named explicitly below, because an ordering asserted over an
     empty set of comparisons is the failure mode this whole file exists for. */
  const quieter = [];
  let comparedWithAttention = new Set();
  for (const [where, group] of standoff) {
    const failure = group.get('failure');
    if (failure === undefined) continue;
    for (const [role, ratio] of group) {
      if (role === 'failure') continue;
      if (failure < ratio + LOUDER_BY) quieter.push(`${where}: failure stands off at ${failure.toFixed(3)}:1 and ${role} at ${ratio.toFixed(3)}:1`);
      if (role === 'attention') comparedWithAttention.add(where.split(' ')[0]);
    }
  }
  assert.deepEqual(quieter, [], `failure must stand off its ground at least ${LOUDER_BY} further than every other role`);
  assert.deepEqual([...comparedWithAttention].sort(), ['dark', 'light'], 'failure and attention were never measured on one ground in both themes, so nothing compared red against amber');
  /* Reported, not asserted: by how much. A pass says red outranks amber; this
     says whether it does so by a hair or by a margin a reader can see. */
  const redVsAmber = [...standoff].flatMap(([where, group]) => {
    const [failure, attention] = [group.get('failure'), group.get('attention')];
    return failure !== undefined && attention !== undefined ? [`${where} failure ${failure.toFixed(2)}:1 vs attention ${attention.toFixed(2)}:1`] : [];
  });
  /* An area with no record table measures no fold, so the pass above is the
     empty set unless Work's and Roadmap's tables were really read. */
  assert.deepEqual(cut, [], 'a 390 window must read a row down to its state without scrolling');
  assert.deepEqual(
    [...shapes].filter(([, distinct]) => distinct.length > 1).map(([where, distinct]) => `${where}: ${distinct.length} shapes — ${distinct.join(' | ')}`),
    [],
    "a view's groups must put their equivalent columns in the same place",
  );
  /* Both record views, both themes, all three widths — so the pass above is
     not one view that happens to have a single group. */
  assert.ok(shapes.size >= 12, `only ${shapes.size} multi-group views were measured for alignment: ${[...shapes.keys()].join(', ')}`);
  assert.deepEqual([...new Set(spill)], [], 'a column must be wide enough for what it holds');
  assert.ok(folds.length >= 8, `only ${folds.length} state cells were measured at 390, so the fold was not really read`);
  /* Reported, not asserted: how much room the tightest state had to spare. A
     pass says nothing was cut; this says how close the next longer word is. */
  const tightest = folds.reduce((worst, fold) => (fold.over > worst.over ? fold : worst));
  /* And every layout would pass with the audit skipped, which is exactly how it
     shipped: the count is what turns a skipped audit red instead of silent. */
  assert.equal(
    audited.length,
    areas.length * themes.length * widths.length,
    `the WCAG audit ran on ${audited.length} layouts, not all ${areas.length * themes.length * widths.length}: ${audited.join(', ')}`,
  );
  assert.deepEqual(errors, []);
  console.log(`All five areas, Work's and Roadmap's compact tables, bounded summaries and full records, held state, copy, focused refresh, embedded answer, runtime trace, team profiles, Inter, the four status roles measured at rest and on hovered and expanded rows in both themes, all ${audited.length} layouts verified and audited against WCAG 2 A/AA with axe-core ${axeVersion}, ${shapes.size} multi-group views aligned column for column, and nothing wider than the column holding it. Red outranks amber by at least ${LOUDER_BY} on every ground both were found on: ${redVsAmber.join('; ')}. At 390 the tightest of ${folds.length} state cells, "${tightest.text}" in ${tightest.table}, cleared the fold by ${-tightest.over}px. Evidence: ${dir}`);
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ origin, artifacts: dir, errors, verified: new Date().toISOString() }, null, 2));
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  store.close();
  roadmap.close();
}
