import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBuilt } from '../../../scripts/build.mjs';
import { launchBrowser } from '../../work/scripts/browser.mjs';
import { env } from '../../cli/test/installation.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
assertBuilt(root);
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
writeFileSync(join(dir, 'runtime/state/example-worker/BLOCKED'), 'reason=The fixture needs a prerequisite before work can resume.');
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

const decision = create('A decision awaiting the operator');
store.returnToHuman(actor, decision.id, { situation: 'Fixture situation', question: 'Use the standard baseline?', recommendation: 'Use the selected baseline.' });

const roadmap = new RoadmapStore(join(dir, 'roadmap/roadmap.db'));
const project = roadmap.createProject(actor, { title: 'The complete standard UI foundation', status: 'ready', body: 'Preserve the full project record while using standard components.' });
const objective = roadmap.setCharterItem(actor, { shape: 'objective', statement: 'A clear foundation', source: 'Fixture charter', horizon: 'near', rank: 1 });
roadmap.cite(actor, { project_id: project.id, objective_id: objective.id, claim: 'A consistent interface makes the work legible.' });
roadmap.recordClaim(actor, { project_id: project.id, kind: 'value', level: 'high', reason: 'Every operator reading benefits.' });
roadmap.recordClaim(actor, { project_id: project.id, kind: 'effort', size: 'M', predicted_usd: 20, reason: 'A finite set of existing screens.' });
roadmap.setShipNext(actor, { project_id: project.id, decided_by: 'Fixture operator', reason: 'The foundation is the next work.' });

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
  await page.goto(`${origin}/work`);
  await page.getByRole('heading', { name: 'Ready · 1', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Ready', exact: true }).getByText(ready.title, { exact: true }).count(), 1);
  assert.equal(await page.getByRole('region', { name: 'Blocked', exact: true }).getByText(blocked.title, { exact: true }).count(), 1);
  assert.equal(await page.locator(`#${oldest.id}`).count(), 0, 'default reading must bound terminal history');
  await page.locator(`#${ready.id}`).getByRole('button', { name: /Ready work with a complete title/ }).click();
  await page.getByText(`Full record for ${ready.title}`, { exact: true }).waitFor();
  await page.getByRole('button', { name: `Copy ${ready.id}`, exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), ready.id);
  await page.waitForTimeout(15500);
  assert.equal(await page.getByText(`Full record for ${ready.title}`, { exact: true }).count(), 1, 'refresh must keep the disclosure open');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), `Copy ${ready.id}`, 'refresh must retain focus');
  await page.goto(`${origin}/#${oldest.id}`);
  await page.getByText(`Full record for ${oldest.title}`, { exact: true }).waitFor();
  await page.getByRole('link', { name: 'View result', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'View result', exact: true }).getAttribute('href'), 'https://example.com/result');
  await page.goto(`${origin}/work?whole=1#${operational.id}`);
  const operationalRow = page.locator(`#${operational.id}`);
  await operationalRow.getByText('commit helmo@76f395d', { exact: true }).waitFor();
  assert.equal(await operationalRow.getByText('No result recorded').count(), 0, 'a commit result must not read as no result');
  assert.equal(await operationalRow.getByRole('link', { name: 'View result', exact: true }).count(), 0, 'a commit is not something a browser opens');
  assert.equal(await operationalRow.getByText('~/.helmo/rev.json', { exact: true }).count(), 1);
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
  await page.goto(`${origin}/roadmap#${project.id}`);
  await page.getByText(project.body, { exact: true }).waitFor();
  await page.getByText(/decided by Fixture operator/).waitFor();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByText(/ship next set/).waitFor();
  await page.getByRole('button', { name: `Copy ${project.id}`, exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), project.id);
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
  for (const area of ['overview', 'work', 'roadmap', 'team', 'run']) for (const theme of ['light', 'dark']) for (const width of [390, 640, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/${area}`);
    await page.getByText(/Refreshed .*updates every/).waitFor();
    await page.evaluate((value) => document.documentElement.className = value, theme);
    await page.waitForTimeout(250);
    const measure = await page.evaluate(() => ({ font: getComputedStyle(document.body).fontFamily, overflow: document.documentElement.scrollWidth - innerWidth }));
    assert.match(measure.font, /Inter/);
    assert.ok(measure.overflow <= 1, `${theme} ${width}: ${measure.overflow}px overflow`);
    if (process.env.HELMO_AXE_SOURCE && existsSync(process.env.HELMO_AXE_SOURCE)) {
      await page.addScriptTag({ path: process.env.HELMO_AXE_SOURCE });
      const audit = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => ({ target: n.target, failureSummary: n.failureSummary })) })));
      assert.deepEqual(audit, [], `${area} ${theme} ${width} accessibility violations: ${JSON.stringify(audit)}`);
    }
    await page.screenshot({ path: join(dir, `shots/${area}-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
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
  await page.getByText(project.body, { exact: true }).waitFor();
  await page.route('**/api/v1/roadmap', (route) => route.fulfill({ status: 503, body: 'fixture unavailable' }));
  await page.getByText('Refresh failed', { exact: true }).waitFor({ timeout: 20000 });
  assert.equal(await page.getByText(project.body, { exact: true }).count(), 1);
  await page.reload();
  await page.getByText('Could not read roadmap', { exact: true }).waitFor();
  await page.unroute('**/api/v1/roadmap');
  // Keyboard scrolling keeps the table, not the entire document, moving.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${origin}/run`);
  await page.getByRole('table', { name: 'Loop status', exact: true }).focus();
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250);
  assert.ok(await page.locator('[data-slot="table-container"]').evaluate((el) => el.scrollLeft > 0));
  assert.deepEqual(errors, []);
  console.log(`All five areas, record history, held state, copy, focused refresh, embedded answer, runtime trace, team profiles, Inter and all 30 layouts verified. Evidence: ${dir}`);
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ origin, artifacts: dir, errors, verified: new Date().toISOString() }, null, 2));
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  store.close();
  roadmap.close();
}
