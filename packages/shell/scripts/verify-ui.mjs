import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../work/dist/store.js';
import { launchBrowser } from '../../work/scripts/browser.mjs';
import { env } from '../../cli/test/installation.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'helmo-ui-proof-'));
for (const name of ['work', 'roadmap', 'runtime', 'shots']) mkdirSync(join(dir, name));
copyFileSync(join(root, 'packages/runtime/examples/roster.toml'), join(dir, 'runtime/roster.toml'));
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
const decision = create('A decision awaiting the operator');
store.returnToHuman(actor, decision.id, { situation: 'Fixture situation', question: 'Use the standard baseline?', recommendation: 'Use the selected baseline.' });

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
  await page.goto(`${origin}/?section=awaiting`);
  await page.getByText(decision.title, { exact: true }).waitFor();
  assert.equal(await page.locator('[data-sidebar="sidebar"]').count(), 0, 'embedded reading carries no full navigation');
  await page.getByRole('button', { name: 'Ratify recommendation', exact: true }).click();
  await page.getByText('Queue is empty.', { exact: false }).waitFor();
  assert.equal(store.getTicket(decision.id).status, 'open');
  for (const theme of ['light', 'dark']) for (const width of [390, 640, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/work`);
    await page.getByRole('heading', { name: /Ready ·/ }).waitFor();
    await page.evaluate((value) => document.documentElement.className = value, theme);
    await page.waitForTimeout(250);
    const measure = await page.evaluate(() => ({ font: getComputedStyle(document.body).fontFamily, overflow: document.documentElement.scrollWidth - innerWidth }));
    assert.match(measure.font, /Inter/);
    assert.ok(measure.overflow <= 1, `${theme} ${width}: ${measure.overflow}px overflow`);
    await page.screenshot({ path: join(dir, `shots/work-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  assert.deepEqual(errors, []);
  console.log(`Work records, hash bookmarks, history, held state, copy, focused refresh, embedded answer, Inter and all six layouts verified. Evidence: ${dir}`);
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ origin, artifacts: dir, errors, verified: new Date().toISOString() }, null, 2));
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  store.close();
}
