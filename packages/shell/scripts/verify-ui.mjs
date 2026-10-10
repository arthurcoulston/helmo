import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
/* Team's readings exist only where the configuration puts them. A live
   installation today has no roster skill on most seats, no file over its cap
   and no unreadable one, so without these three the skills segment, the amber
   over-cap alert and the red unreadable alert render nowhere and pass every
   assertion below by being absent (H-3001). The shipped example roster stays
   documentation; these seats are appended to the copy. */
const seatTree = join(dir, 'runtime/seat');
mkdirSync(join(seatTree, 'memory'), { recursive: true });
writeFileSync(join(seatTree, '.git'), 'a fixture repository boundary the instruction walk stops at');
writeFileSync(join(seatTree, 'CLAUDE.md'), '---\ncap_tokens: 400\n---\nWhat the CLI finds for itself in the working tree.');
writeFileSync(join(seatTree, 'memory/MEMORY.md'), '---\ncap_tokens: 1200\n---\nThe fixture memory index.');
/* Large enough that counting the corpus as startup context would be obvious on
   the page — which is the distinction the view exists to keep. */
for (let i = 0; i < 12; i += 1) writeFileSync(join(seatTree, `memory/lesson-${i}.md`), `A fixture lesson about ${i}.\n`.repeat(60));
writeFileSync(join(dir, 'runtime/constitutions/well-found.md'), '---\ncap_tokens: 400\n---\nA fixture seat whose configuration is in good order.');
writeFileSync(join(dir, 'runtime/constitutions/fixture-skill.md'), 'A fixture roster skill, appended to the constitution at spawn.');
writeFileSync(join(dir, 'runtime/constitutions/over-cap.md'), `---\ncap_tokens: 5\n---\n${'A fixture profile written past its ratified cap. '.repeat(30)}`);
appendFileSync(join(dir, 'runtime/roster.toml'), [
  '',
  '[loops.well-found]',
  'workstream = "fixture"',
  `cwd = ${JSON.stringify(seatTree)}`,
  'runtime = "claude"',
  'model = "fixture-model"',
  'constitution = "constitutions/well-found.md"',
  'skills = ["constitutions/fixture-skill.md"]',
  `memory_dir = ${JSON.stringify(join(seatTree, 'memory'))}`,
  '',
  /* This one carries the widest workstream and model the live roster holds, so
     the two columns Runtime deliberately sizes UNDER their widest row are
     exercised here rather than only in a live probe (H-3048). Both are real
     values: "knowledge-base" is a live workstream, and a parked loop still runs
     the dated model id from before the names were short. Each is wider than its
     column and so must wrap — and the fixture is where that stays true, because
     with three loops named "fixture" nothing in this run reached a column's
     declared width at all and leaving them nowrap was green. */
  '[loops.over-its-cap]',
  'workstream = "knowledge-base"',
  `cwd = ${JSON.stringify(seatTree)}`,
  'runtime = "claude"',
  'model = "claude-haiku-4-5-20251001"',
  'constitution = "constitutions/over-cap.md"',
  '',
  '[loops.cannot-be-read]',
  'workstream = "fixture"',
  `cwd = ${JSON.stringify(seatTree)}`,
  'runtime = "claude"',
  'model = "fixture-model"',
  'constitution = "constitutions/no-such-profile.md"',
  '',
  /* Overview's condensed roster needs every state it can draw to be really
     drawn somewhere, and the two below are the ones the existing fixture
     cannot produce: an unexpected failure, and a seat served by more than one
     session. Without them the card's red chip and its roll-up render nowhere
     in this run and pass every assertion by being absent — the same trap the
     three seats above were added for (H-3091). */
  '[loops.wedged-worker]',
  'workstream = "fixture"',
  `cwd = ${JSON.stringify(seatTree)}`,
  'runtime = "claude"',
  'model = "fixture-model"',
  'constitution = "constitutions/well-found.md"',
  '',
  '[loops.pair]',
  'workstream = "fixture"',
  `cwd = ${JSON.stringify(seatTree)}`,
  'runtime = "claude"',
  'model = "fixture-model"',
  'constitution = "constitutions/well-found.md"',
  '',
  // A second session in one seat. Its own writable checkout, because the
  // roster refuses to load two same-seat workers sharing one.
  '[loops.pair-2]',
  'seat = "pair"',
  'lane = "fixture"',
  'workstream = "fixture"',
  `cwd = ${JSON.stringify(join(dir, 'runtime/seat-2'))}`,
  'runtime = "claude"',
  'model = "fixture-model"',
  'constitution = "constitutions/well-found.md"',
  '',
].join('\n'));
/* The live states. A marker naming a pid that is really alive — this process —
   is what Rev reads as a running session; without one every seat in the
   fixture is `halted`, which is one of the four states and tells a reader
   nothing about the other three. */
mkdirSync(join(dir, 'runtime/seat-2'), { recursive: true });
const livePid = `${process.pid}\n`;
for (const [loop, files] of Object.entries({
  'well-found': { RUNNING: livePid },
  'over-its-cap': { RUNNING: livePid, IDLE: '4201\nno executable work is owned by this seat or ready in its watched scope\n' },
  'wedged-worker': { WEDGED: 'The fixture worker cannot reach Helm.\nat=2026-10-10T17:00:00.000Z\n' },
  pair: { RUNNING: livePid },
  'pair-2': { RUNNING: livePid, IDLE: '4201\nno executable work is owned by this seat or ready in its watched scope\n' },
})) {
  mkdirSync(join(dir, 'runtime/state', loop), { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, 'runtime/state', loop, file), content);
}
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
  /* The categories cycle so the Overview results card is measured on several
     of its badges rather than on one repeated ten times (R-44). */
  const category = ['feature', 'improvement', 'bug_fix', 'maintenance', 'operations'][i % 5];
  store.updateTicket(actor, { ticket_id: t.id, status: 'done', note: `Finished outcome ${i}`, completion_account: { category, summary: `Outcome ${i} is in place: a reader can see what this fixture ticket produced without opening it.` }, evidence: [{ kind: 'url', ref: 'https://example.com/result', note: 'The result' }], confidence: 'routine' });
  oldest ??= t;
}
// A result that is a commit, with a file supporting it (R-42 contract §3.5):
// the built bundle has to show the commit as what the work produced. Every row
// of that table is proved from source in `test/work-result.test.mjs`; this one
// case is here because only a real browser on the built app proves the bundle
// carries the change at all.
const operational = create('An operational change states its own result');
store.updateTicket(actor, { ticket_id: operational.id, status: 'done', note: 'Changed the running system.', completion_account: { category: 'operations', summary: 'The running system now resizes on upload; verified by reading the worker log after a real upload.' }, confidence: 'routine', evidence: [
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
/* And a progress note longer than the 280 characters the store sends, so the
   bound is proved where a reader meets it. Until H-2988 the cut was a hard
   slice at exactly 280: it landed mid-word on 1,787 of the 2,066 notes in the
   live store and said nothing about having cut, which is the one failure a
   reader cannot see — a half-word reads as a finished sentence. */
const LONG_NOTE = 'Reconciled the fixture record against the real one and found the same drift again. '.repeat(5).trim();
store.updateTicket(actor, { ticket_id: longWork.id, note: LONG_NOTE });

const decision = create('A decision awaiting the operator');
store.returnToHuman(actor, decision.id, { situation: 'Fixture situation', question: 'Use the standard baseline?', recommendation: 'Use the selected baseline.' });

/* One record per status COLOUR (H-2978), because a palette proved on nothing
   that carries it is an empty set passing. These four put a live role on Work
   in both themes: work in motion, a release review that accepted the work, one
   that refused it, and a closed ticket with nothing to show for itself. */
const moving = create('Work in motion reads as in motion');
store.updateTicket(actor, { ticket_id: moving.id, status: 'in_progress', note: 'Claimed by the fixture worker.' });
/* A claim by a seat the ROSTER configures, which is what puts a ticket link on
   Overview's condensed roster. Every other claim in this fixture is the
   orchestrator's, and a seat holding nothing draws no link at all (H-3091). */
const seatHolds = create('The work a configured seat is holding');
store.updateTicket({ name: 'well-found', kind: 'agent', model: 'fixture', version: 'fixture' }, { ticket_id: seatHolds.id, status: 'in_progress', note: 'Claimed by the configured seat.' });
const reviewer = { name: 'fixture-reviewer', kind: 'agent', model: 'fixture', version: 'fixture' };
const reviewed = (title, verdict) => {
  const t = create(title);
  /* An immutable ref: the store refuses anything short of a full sha, which
     is the point of the completion record. */
  const ref = `helmo@${createHash('sha1').update(t.id).digest('hex')}`;
  store.updateTicket(actor, { ticket_id: t.id, status: 'done', note: `Finished ${t.id}.`, completion_account: { category: 'feature', summary: `${t.id} delivers the reviewed change, offered for an independent reading at one exact ref.` }, confidence: 'routine', evidence: [{ kind: 'commit', ref, role: 'result' }] });
  store.recordProductCompletion(actor, { ticket_id: t.id, artifacts: [{ ref, author: 'fixture' }], note: 'Ready for an independent reading.' });
  store.recordAcceptanceVerdict(reviewer, { ticket_id: t.id, refs: [ref], verdict, note: `The review ${verdict === 'pass' ? 'confirmed' : 'refused'} this exact ref.` });
  return t;
};
const accepted = reviewed('An accepted release review says so', 'pass');
const refused = reviewed('A refused release review says so', 'fail');
const unproved = create('A closed ticket with nothing to show');
store.updateTicket(actor, { ticket_id: unproved.id, status: 'done', note: 'Closed without recording what it produced.', completion_account: { category: 'maintenance', summary: 'The fixture obligation is discharged; nothing was produced that can be linked.' }, confidence: 'needs_review' });

/* A done record with NO completion account, reached the one way that is still
   legitimate: the human answered the question and that resolved the work
   (R-44 contract §2). No agent close can produce this any more, so without
   this fixture the "Completion account missing" reading on the results card
   is proved nowhere in the browser — and it is the reading every legacy row
   in the live store takes. */
const humanClosed = create('Work the human closed by answering it');
store.returnToHuman(actor, humanClosed.id, { situation: 'The fixture needs a decision before it can go further.', question: 'Is this already covered?', recommendation: 'Close it as covered.' });
store.answerTicket({ name: 'Fixture Operator', kind: 'human' }, humanClosed.id, { answer: 'Already covered elsewhere; nothing more to do.', resolution: 'done' });

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
  assert.equal(await page.getByRole('heading', { name: 'Work', exact: true }).count(), 1, 'the header is the page title; content must not repeat it');
  assert.equal(await page.getByText(/Current record ·/).count(), 0, 'the retired current-record line must stay absent');
  await page.getByText('2 ready', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Archived', exact: true }).getAttribute('href'), '?whole=1');
  assert.equal(await page.getByRole('link', { name: 'See all completed tickets.', exact: true }).getAttribute('href'), '?whole=1');
  const sidebar = page.locator('[data-slot="sidebar"]');
  assert.equal(await sidebar.getAttribute('data-state'), 'collapsed', 'a fresh desktop window starts with the icon rail collapsed');
  await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click();
  assert.equal(await sidebar.getAttribute('data-state'), 'expanded');
  await page.reload();
  assert.equal(await sidebar.getAttribute('data-state'), 'expanded', 'this window keeps its explicit sidebar choice across reload');
  const theme = page.getByRole('button', { name: /Use (dark|light) theme/ });
  await theme.click();
  const storedTheme = await page.evaluate(() => localStorage.getItem('theme'));
  assert.ok(storedTheme === 'light' || storedTheme === 'dark', 'the visible theme control stores through the generated provider');
  assert.equal(await page.getByRole('table', { name: 'Ready', exact: true }).getByText(ready.title, { exact: true }).count(), 1);
  assert.equal(await page.getByRole('table', { name: 'Blocked', exact: true }).getByText(blocked.title, { exact: true }).count(), 1);
  assert.equal(await page.locator(`#${oldest.id}`).count(), 0, 'default reading must bound terminal history');
  assert.equal(await page.getByText(`Full record for ${ready.title}`, { exact: true }).count(), 0, 'a collapsed row must not carry the record body');
  await page.locator(`tr#${blocked.id}`).getByText('On hold', { exact: true }).waitFor();
  assert.equal(await page.locator(`tr#${blocked.id}`).getByText('Waiting for the chosen spending window').count(), 0, "a hold's reason belongs in the record");
  await page.locator(`tr#${longWork.id}`).getByText('fixture-member', { exact: true }).waitFor();
  /* An expanded row offers two readings and labels each for what it IS: where
     the record stands, from its latest progress note, and how it opens,
     verbatim. Neither is a summary, because no stored field is one (H-2988). */
  await page.locator(`tr#${longWork.id}`).getByRole('button', { name: `Summary of ${longWork.id}`, exact: true }).click();
  const opening = page.locator(`[data-expanded-for="${longWork.id}"]`);
  await opening.getByText('Where it stands', { exact: true }).waitFor();
  await opening.getByText('The record opens', { exact: true }).waitFor();
  const stands = await opening.locator('p').first().innerText();
  // The author's own words, cut at a word boundary, the cut admitted, attributed.
  const visible = stands.split('…')[0];
  assert.ok(stands.includes('…'), `the bounded note must admit its cut: ${stands}`);
  assert.ok(LONG_NOTE.startsWith(visible), `the note shown is not the author's own words: ${visible.slice(0, 40)}`);
  assert.equal(LONG_NOTE[visible.length], ' ', `the note must be cut at a word boundary, not mid-word: "${visible.slice(-20)}"`);
  assert.match(stands, /— fixture, /, 'a progress note must say who recorded it and when');
  const shown = await opening.locator('p').nth(1).innerText();
  assert.ok(shown.startsWith('Filing provenance recorded when'), `the second reading is not the record's opening: ${shown.slice(0, 40)}`);
  assert.ok(shown.length <= 321 && shown.endsWith('…'), `the opening is not bounded: ${shown.length} characters`);
  assert.equal(await opening.getByRole('button', { name: 'History', exact: true }).count(), 0, 'an expanded row carries no history');
  /* And the control names the record it opens, for a reader who meets it out of
     context: a page with one "Open full view" per expanded row says nothing.
     Read as text rather than as an accessible name, so the assertion is about
     the words rather than about how a name is composed from them. */
  const fullView = opening.getByRole('button', { name: /^Open full view/ });
  await fullView.waitFor();
  const fullViewLabel = (await fullView.textContent()).trim();
  assert.match(fullViewLabel, /^Open full view — this is the record's opening only/);
  assert.ok(fullViewLabel.includes(longWork.id), `the full-view control must name its record: ${fullViewLabel}`);
  /* And a record nobody has recorded progress on says so, rather than drawing a
     blank line where a reader expects words. Twelve parked projects are in this
     state on the live record. */
  const unnotedToggle = page.locator(`tr#${ready.id}`).getByRole('button', { name: `Summary of ${ready.id}`, exact: true });
  await unnotedToggle.click();
  const unnoted = page.locator(`[data-expanded-for="${ready.id}"]`);
  await unnoted.getByText('No progress has been recorded on this record yet.', { exact: true }).waitFor();
  // A record short enough to be shown whole does not claim to be an excerpt.
  const wholeView = unnoted.getByRole('button', { name: /^Open full view/ });
  await wholeView.waitFor();
  assert.equal((await wholeView.textContent()).trim(), `Open full view: ${ready.id} ${ready.title}`);
  await unnotedToggle.click();
  await unnoted.waitFor({ state: 'detached' });
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
  await record.getByText(/Last recorded progress .* by fixture: Held by the fixture operator\./).waitFor();
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
  const parentSidebarState = await page.locator('[data-slot="sidebar"]').getAttribute('data-state');
  await popup.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click();
  assert.equal(await page.locator('[data-slot="sidebar"]').getAttribute('data-state'), parentSidebarState, 'one window cannot change another window\'s sidebar');
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
  /* The same two labelled readings as Work, from the same component, over
     Roadmap's own progress note — which is the project's latest 'updated' note
     and never its cost rollup. */
  await page.locator(`tr#${unruly.id}`).getByRole('button', { name: `Summary of ${unruly.id}`, exact: true }).click();
  const summary = page.locator(`[data-expanded-for="${unruly.id}"]`);
  await summary.getByText('Where it stands', { exact: true }).waitFor();
  await summary.getByText('The record opens', { exact: true }).waitFor();
  assert.match(await summary.locator('p').first().innerText(), /^Parked by the fixture operator\. — fixture, /);
  const preview = await summary.locator('p').nth(1).innerText();
  assert.ok(preview.startsWith('Filing provenance recorded when'), `the second reading is not the record's opening: ${preview.slice(0, 40)}`);
  assert.ok(preview.length <= 321 && preview.endsWith('…'), `the opening is not bounded: ${preview.length} characters`);
  assert.equal(await summary.getByRole('button', { name: 'History', exact: true }).count(), 0, 'an expanded row carries no history');
  const projectView = summary.getByRole('button', { name: /^Open full view/ });
  await projectView.waitFor();
  const projectViewLabel = (await projectView.textContent()).trim();
  assert.match(projectViewLabel, /^Open full view — this is the record's opening only/);
  assert.ok(projectViewLabel.includes(unruly.id), `the full-view control must name its record: ${projectViewLabel}`);
  const unshaped = page.locator(`tr#${shaping.id}`).getByRole('button', { name: `Summary of ${shaping.id}`, exact: true });
  await unshaped.click();
  await page.locator(`[data-expanded-for="${shaping.id}"]`).getByText('No progress has been recorded on this record yet.', { exact: true }).waitFor();
  await unshaped.click();
  await page.locator(`[data-expanded-for="${shaping.id}"]`).waitFor({ state: 'detached' });
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
  /* Team. The three readings this view exists to keep apart are each asserted
     on the rendered page, because each of them is a way to mislead and none of
     them is visible in a JSON test (H-3001). */
  await page.goto(`${origin}/team`);
  await page.getByRole('table', { name: 'Team', exact: true }).waitFor();
  /* A configured file past its ratified cap, and one the shim could not read at
     all, both reach the top of the page — red for the one that stops a launch. */
  const attention = page.getByRole('alert').filter({ hasText: 'need your attention' });
  await attention.getByText(/over-cap\.md/).waitFor();
  await attention.getByText(/no-such-profile\.md \(cannot be read\)/).waitFor();
  assert.equal(await attention.getAttribute('data-status-role'), 'failure', 'an unreadable profile outranks an over-cap one');
  /* And the chip on the file itself, which is what `contextFileRole` decides.
     The alert above reads its role from that same function, so asserting only
     the alert would pass on a mapping flipped underneath it. */
  await page.getByRole('button', { name: 'cannot-be-read', exact: true }).click();
  assert.equal(
    await page.getByRole('dialog').locator('[data-status-role]').filter({ hasText: 'unreadable' }).getAttribute('data-status-role'),
    'failure', 'an unreadable configured file is red on the file itself, not only in the summary',
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: "well-found", exact: true }).click();
  /* Composed, discovered and available, each in its own words. The memory
     corpus is reported beside the startup total and never inside it: the
     fixture seat's twelve lessons are an order of magnitude larger than
     everything it actually loads, so a view that added them in would say so. */
  const teamSheet = page.getByRole('dialog');
  await teamSheet.getByText(/Profile \d/).waitFor();
  await teamSheet.getByText(/Skills \d/).waitFor();
  await teamSheet.getByText(/Working tree \d/).waitFor();
  await teamSheet.getByText(/Rev does not compose these/).waitFor();
  await teamSheet.getByText(/13 files · roughly [\d,]+ tokens if every one were read/).waitFor();
  await teamSheet.getByText(/No whole-session cap is configured anywhere/).waitFor();
  await teamSheet.getByText(/the tool and MCP schemas the session is given/).waitFor();
  const startup = Number((await teamSheet.getByText(/^[\d,]+ tok$/).first().innerText()).replace(/[^\d]/g, ''));
  const corpus = Number((await teamSheet.getByText(/roughly [\d,]+ tokens/).innerText()).match(/roughly ([\d,]+)/)[1].replace(/,/g, ''));
  assert.ok(corpus > startup * 10, `the fixture corpus (${corpus}) must dwarf the startup reading (${startup}), or this distinction is untested`);
  /* The `--- Skill: … ---` header Rev writes before each appended skill is real
     prompt bytes belonging to no file. The page states it instead of letting
     the skill rows quietly fall short of the segment above them, and the
     segment counts it — `parts()` does that sum itself, so nothing but the
     rendered page proves this half of H-3009. */
  const framing = Number((await teamSheet.getByText(/^Plus [\d,]+ tokens that belong to no file/).innerText()).match(/Plus ([\d,]+)/)[1].replace(/,/g, ''));
  const skillFile = Number((await teamSheet.locator('[data-context-file="fixture-skill.md"]').getByText(/^[\d,]+ tok/).innerText()).replace(/[^\d]/g, ''));
  const skillsSegment = Number((await teamSheet.getByText(/^Skills [\d,]+$/).innerText()).match(/([\d,]+)/)[1].replace(/,/g, ''));
  assert.ok(framing > 0, 'the skill headers must be counted, not reported as a zero');
  assert.equal(skillsSegment, skillFile + framing, `the Skills segment (${skillsSegment}) must be the one fixture skill (${skillFile}) plus its header (${framing})`);

  /* The bounded file route, through the page: a file the inventory names reads,
     and the reading is the file rather than a summary of it. */
  await teamSheet.getByRole('button', { name: 'Read fixture-skill.md' }).click();
  await teamSheet.getByText('A fixture roster skill, appended to the constitution at spawn.').waitFor();
  await page.keyboard.press('Escape');
  /* The period really re-reads the server rather than re-labelling the page. */
  await page.getByRole('button', { name: '24 hours' }).click();
  await page.getByRole('button', { name: '24 hours' }).and(page.locator('[aria-pressed="true"]')).waitFor();
  await page.getByRole('button', { name: "well-found", exact: true }).click();
  await page.getByRole('dialog').getByText(/USAGE · 24 HOURS|Usage · 24 hours/i).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '7 days' }).click();
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
  /* Overview's condensed roster (H-3091). Read here rather than left to the
     layout walk below, because an empty widget draws its own "no agents" copy,
     audits clean, and reports 30 layouts verified: the seed is the only part
     that makes this card's pass a statement about the product. */
  await page.goto(`${origin}/overview`);
  const teamNow = page.locator('[aria-label="Team now"]');
  await teamNow.getByText('Team now', { exact: true }).waitFor();
  /* Element by element rather than `textContent`: nothing in this card puts a
     space between the name, the chip and the reason, so one string would read
     as "example-workerBlockedThe fixture worker…" and a per-field assertion
     would be matching an artifact of the markup. */
  const roster = await teamNow.evaluate((el) => [...el.querySelectorAll('li')]
    .map((li) => [...li.children].map((child) => child.textContent.replace(/\s+/g, ' ').trim()).join(' ')));
  /* Every seat the roster configures, each one exactly once: a seat served by
     two sessions is one agent, which is the whole reason this document rolls
     up rather than listing loops. */
  assert.deepEqual(
    roster.map((row) => row.split(' ')[0]),
    ['example-worker', 'well-found', 'over-its-cap', 'cannot-be-read', 'wedged-worker', 'pair'],
    `the condensed roster is not the fixture's own seats: ${JSON.stringify(roster)}`,
  );
  for (const [seat, reading] of Object.entries({
    'well-found': new RegExp(`^well-found Working ${seatHolds.id}$`),
    'over-its-cap': /^over-its-cap Awaiting work$/,
    // The reason is in the glance view for the two states that need Arthur,
    // and this is the one that proves it is rendered rather than merely sent.
    'example-worker': /^example-worker Blocked The fixture worker has downed tools/,
    'cannot-be-read': /^cannot-be-read Stopped$/,
    'wedged-worker': /^wedged-worker Failed The fixture worker cannot reach Helm\.$/,
    // Two sessions, one chip, and the count that says so.
    pair: /^pair Working 2 sessions$/,
  })) {
    const row = roster.find((text) => text.startsWith(`${seat} `)) ?? '';
    assert.match(row, reading, `${seat}'s reading on the condensed roster`);
  }
  /* The disclosure, which no server-rendered proof can see: a closed
     Collapsible renders none of its content. Both of the pooled seat's
     sessions are named under it, with their own state words, so the roll-up is
     checkable rather than taken on trust. */
  await teamNow.getByRole('button', { name: 'Session detail', exact: true }).click();
  await teamNow.getByText(/pair · session pair-2 · IDLE/).waitFor();
  await teamNow.getByText(/^pair · RUNNING · fixture$/).waitFor();
  /* And the fifteen-second refresh does not take it away again. The card is
     redrawn from a new reading every poll, so a disclosure a reader opened to
     understand a blockage has to survive one — closing under them is how a
     page that updates itself becomes one nobody can read. */
  const refreshed = await page.getByText(/^Refreshed /).innerText();
  await page.waitForFunction(
    (was) => [...document.querySelectorAll('p')].some((p) => p.textContent.startsWith('Refreshed ') && p.textContent !== was),
    refreshed,
    { timeout: 30_000 },
  );
  await teamNow.getByText(/pair · session pair-2 · IDLE/).waitFor({ timeout: 1_000 });
  const areas = ['overview', 'work', 'roadmap', 'team', 'run'], themes = ['light', 'dark'], widths = [390, 640, 1280];
  const audited = [];
  /* Where the horizontal fold falls on a phone. Nothing above can see this:
     the page itself never overflows — the table scrolls inside its own
     container — so `measure.overflow` is 0 on a row whose state is cut in
     half, which is what shipped (H-2981: "In moti" on Work at 390, and
     Roadmap's "Ship next" cut harder). Which columns have to be readable
     without scrolling is each view's own call, declared on its table rather
     than known here; everything after them is what the region's label offers
     to scroll for. */
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
  /* Every expanded preview measured at 390 — see where they are pushed. */
  const previews = [];
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
         tomorrow must still be measured rather than silently skipped.

         And by the columns the TABLE declares above its fold, never by a column
         id this check happens to know. Keyed on "state" it measured Work and
         Roadmap — the two views with a column of that name — and silently
         skipped Team, whose state badge lives inside its member cell, so the
         one view added since could have put its subject beyond the fold under a
         green run (H-3001). A table that declares nothing is itself a failure
         below: the skip is what has to be impossible, not merely unlikely. */
      const measured = await page.evaluate(() => [...document.querySelectorAll('[data-slot="table-container"]')].flatMap((container) => {
        const table = container.querySelector('table');
        const edge = container.getBoundingClientRect().left + container.clientWidth;
        const label = table?.getAttribute('aria-label');
        const declared = (table?.dataset.aboveFold ?? '').split(' ').filter(Boolean);
        if (!declared.length) return [{ table: label, column: null, text: '', over: 0 }];
        return declared.map((column) => {
          /* The header's box is the column's geometry under fixed layout, and
             the body cell is what a reader actually reads — measure the box,
             report the words. */
          const th = container.querySelector(`thead th[data-column="${column}"]`);
          const cell = container.querySelector(`tbody [data-column="${column}"]`);
          return {
            table: label,
            column,
            text: (cell ?? th)?.textContent.trim() ?? '',
            over: th ? Math.round(th.getBoundingClientRect().right - edge) : NaN,
          };
        });
      }));
      for (const row of measured) {
        if (row.column === null) cut.push(`${area} ${theme}: ${row.table} declares no above-fold columns, so its fold is unmeasured`);
        else if (Number.isNaN(row.over)) cut.push(`${area} ${theme}: ${row.table} declares "${row.column}" above the fold and has no such column`);
        else if (row.over > 0) cut.push(`${area} ${theme}: ${row.table} cuts ${row.column} ("${row.text}") by ${row.over}px`);
      }
      folds.push(...measured.filter((row) => row.column !== null));
      /* And an expanded row's preview, which is a different measurement from
         the columns above it. A disclosure cell spans every column, so it
         inherited the table's min-width and wrapped its words at 588 inside a
         390 window: a third of every line of Work's preview was past the fold,
         to be scrolled to line by line. A short reading you cannot read in one
         pass is not one, and nothing here could see it — the fold check reads
         declared columns, and a disclosure cell has none. */
      // Nothing is expanded on a freshly loaded page; open the first row of
      // every table so there is a preview to measure at all.
      for (const toggle of await page.locator('tbody tr[id] button[aria-expanded="false"]').all()) {
        if (await toggle.isVisible()) await toggle.click();
      }
      await page.waitForTimeout(250);
      previews.push(...(await page.evaluate(() => [...document.querySelectorAll('[data-expanded-for]')].map((cell) => {
        const scroller = cell.closest('[data-slot="table-container"]');
        const content = cell.firstElementChild;
        return { id: cell.dataset.expandedFor, over: Math.round(content.getBoundingClientRect().width - scroller.clientWidth) };
      }))).map((item) => ({ ...item, where: `${area} ${theme}` })));
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
      const box = cell.getBoundingClientRect();
      const right = box.right - parseFloat(style.paddingRight);
      const room = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      /* Every descendant's right edge against the cell's content box — geometry
         rather than structure. This read the direct children's widths until
         H-3048, which is a narrower question than it looks and left two whole
         classes of spill invisible:

         - A control behind a BLOCK child. Runtime's trace column holds its
           button inside a Collapsible's own div, and a block stretches to the
           cell — so it reports the cell's width however far the button inside
           it reaches. Measured on this run's own fixture: a trace column
           holding a button 105px wider than it was green on the structural
           reading and is red on this one.
         - The cell's own text, excluded deliberately on the argument that a
           wrapping cell's box holds its text by definition — true, and silent
           about the cells that do NOT wrap. Upstream's TableCell is
           `whitespace-nowrap`, so that was most of them.

         Both are the same failure the check exists for: fixed layout gives up
         the browser's guarantee that content fits, and a column declared at
         half what it holds reaches into its neighbour with nothing in the
         page's own overflow to show for it. */
      const found = [];
      for (const el of cell.querySelectorAll('*')) {
        if (getComputedStyle(el).display === 'none') continue;
        const over = Math.round(el.getBoundingClientRect().right - right);
        if (over > 1) found.push({ column: cell.dataset.column, over, text: el.textContent.trim().slice(0, 30) });
      }
      /* Text has no box of its own, so it is measured with a range. Only where
         the cell cannot wrap: where it can, the box holds the text by
         definition and this would report every wrapped line. */
      if (style.whiteSpace !== 'normal') for (const node of cell.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const over = Math.round(range.getBoundingClientRect().width - room);
        if (over > 1) found.push({ column: cell.dataset.column, over, text: node.textContent.trim().slice(0, 30) });
      }
      /* One line per column and content, not one per row: a hundred records
         holding the same oversized control is one defect, and a failure a
         reader scrolls past is one they do not read. */
      return [...new Map(found.map((item) => [`${item.column}/${item.text}`, item])).values()];
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
  assert.deepEqual(cut, [], 'a 390 window must read every column a view declares above its fold');
  assert.deepEqual(
    [...shapes].filter(([, distinct]) => distinct.length > 1).map(([where, distinct]) => `${where}: ${distinct.length} shapes — ${distinct.join(' | ')}`),
    [],
    "a view's groups must put their equivalent columns in the same place",
  );
  /* Both record views, both themes, all three widths — so the pass above is
     not one view that happens to have a single group. */
  assert.ok(shapes.size >= 12, `only ${shapes.size} multi-group views were measured for alignment: ${[...shapes.keys()].join(', ')}`);
  assert.deepEqual([...new Set(spill)], [], 'a column must be wide enough for what it holds');
  assert.ok(previews.length, 'no expanded preview was measured at 390, so its fold is unproved');
  assert.deepEqual(
    previews.filter((p) => p.over > 1).map((p) => `${p.where}: ${p.id}'s preview is ${p.over}px wider than the window`),
    [],
    'an expanded preview must read without scrolling sideways',
  );
  /* The assertion the old `state` key could not make. Counting cells says the
     loop ran; naming the columns says WHICH views it ran on, and Team's two
     and Runtime's loop are only in this set because those tables declare them
     — keyed on "state" this list came back without them and the check was green
     regardless. */
  assert.deepEqual(
    [...new Set(folds.map((fold) => fold.column))].sort(),
    ['context', 'loop', 'member', 'project', 'state', 'work'],
    'every above-fold column every view declares must be measured at 390',
  );
  assert.ok(folds.length >= 24, `only ${folds.length} above-fold columns were measured at 390, so the fold was not really read`);
  /* Reported, not asserted: how much room the tightest column had to spare. A
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
  console.log(`All five areas, Work's and Roadmap's compact tables, bounded summaries and full records, held state, copy, focused refresh, embedded answer, runtime trace, Team's composed/discovered/available context with its bounded file reads, Inter, the four status roles measured at rest and on hovered and expanded rows in both themes, all ${audited.length} layouts verified and audited against WCAG 2 A/AA with axe-core ${axeVersion}, ${shapes.size} multi-group views aligned column for column, and nothing wider than the column holding it. Red outranks amber by at least ${LOUDER_BY} on every ground both were found on: ${redVsAmber.join('; ')}. At 390 the tightest of ${folds.length} declared above-fold columns, ${tightest.column} ("${tightest.text}") in ${tightest.table}, cleared the fold by ${-tightest.over}px, and all ${previews.length} expanded previews read inside the window, the tightest with ${-Math.max(...previews.map((p) => p.over))}px to spare. Evidence: ${dir}`);
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ origin, artifacts: dir, errors, verified: new Date().toISOString() }, null, 2));
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  store.close();
  roadmap.close();
}
