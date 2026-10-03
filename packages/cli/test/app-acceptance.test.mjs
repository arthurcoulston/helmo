// Acceptance for the one app's compatibility surface — family T1.c of the
// consolidation plan: `:4400` answers 200 directly, and every retired port
// answers 301 to a location that itself answers 200 and renders the named
// record. A connection refused on a retired port is a failure here, not a
// tidy-up: a hash fragment is never sent to a server, so nothing downstream
// can rescue `localhost:4410/#R-39` once nothing is listening on 4410.
//
// Every port below is disposable. The estate's own numbers are the ROWS of
// the retired set, which this fixture rebases onto ephemeral ports — a test
// that bound 4410 would be fighting the installation it is meant to be
// proving, and would pass or fail on whether a dashboard happened to be up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../roadmap/dist/store.js';
import { BIN, env, fixture, freePort, revHome, sentinel } from './installation.mjs';

const FILER = JSON.stringify({ name: 'helmo-orchestrator', kind: 'orchestrator', model: 'test', version: 'test' });
const SEED = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'test', version: 'test' };

// The estate's retired listener set, from the consolidation plan's records
// table: the port each surface was reached at, and the route on the one app
// that now answers for it. `was` is documentation; `route` is behavior.
const RETIRED = [
  { was: 4410, route: '/roadmap', title: '<title>Roadmap</title>' },
  { was: 4500, route: '/run', title: '<title>Rev</title>' },
  { was: 4300, route: '/', title: '<title>Helmo</title>' },
];

/** One disposable installation: its own work, roadmap and runtime homes. */
function installation(t) {
  return { HELMO_HOME: fixture(t), ROADMAP_HOME: fixture(t), REV_HOME: revHome(t) };
}

function seedTicket(homes, title) {
  const r = spawnSync(join(BIN, 'helmo'), [
    'work', 'create', '--title', title, '--body', 'seeded by the app acceptance fixture',
    '--workstream', 'estate-ui', '--type', 'build',
  ], { encoding: 'utf8', env: env({ ...homes, HELMO_ACTOR: FILER }) });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).id;
}

function seedProject(homes, title) {
  const store = new Store(join(homes.ROADMAP_HOME, 'roadmap.db'));
  try {
    return store.createProject(SEED, { title }).id;
  } finally {
    store.close();
  }
}

/** Start the real `helmo serve` process and wait for the origin it announces.
 *  Returns the child so a test can signal it; `legacy` is the configured
 *  retired set, already rebased onto live ports. */
async function startApp(t, homes, legacy = [], extra = {}) {
  const child = spawn(join(BIN, 'helmo'), ['serve'], {
    env: env({
      ...homes,
      HELMO_APP_PORT: '0',
      HELMO_LEGACY_LISTENERS: JSON.stringify(legacy.map(({ port, route }) => ({ port, route }))),
      ...extra,
    }),
  });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the app never started: ${output}`)), 15_000);
    const read = (chunk) => {
      output += chunk;
      const match = output.match(/Helmo app: (http:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`the app exited ${code} before announcing itself: ${output}`)));
  });
  return { child, origin, output: () => output };
}

/** Rebase the documented retired set onto ports nothing holds. */
async function rebase() {
  const ports = await Promise.all(RETIRED.map(() => freePort()));
  return RETIRED.map((row, index) => ({ ...row, port: ports[index] }));
}

/** Every TCP port one process is listening on, read from the operating system
 *  rather than from the process's own account of itself. `lsof` is not
 *  portable, so a platform without it reports null and the caller says so
 *  instead of passing quietly. */
function listeningPorts(pid) {
  const r = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return new Set(
    [...r.stdout.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map((match) => Number(match[1])),
  );
}

/** Wait for the process to exit, bounded. A listener the app failed to close
 *  keeps the event loop alive, so an unbounded wait turns that defect into a
 *  hung test run instead of a failure anyone can read. */
function exited(child, ms = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the app did not exit within ${ms}ms of SIGTERM — something it opened is still holding the loop up`)),
      ms,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function free(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

test('the app answers its own port directly and renders the record a recorded URL names', async (t) => {
  const homes = installation(t);
  const ticket = seedTicket(homes, 'the record a bookmark names');
  const { origin } = await startApp(t, homes);

  // `:4400/#H-n` reaches the server as `/`: the fragment is resolved in the
  // page. So "the recorded URL still works" is two readings — the document
  // answers 200, and the record it names is in it.
  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, new RegExp(ticket), `${ticket} is not in the page a #${ticket} bookmark lands on`);
});

test('a missing or invalid runtime roster returns 500 without killing the app', async (t) => {
  const cases = [
    ['missing', fixture(t), /roster\.toml/],
    ['invalid', fixture(t), /share seat 'builder' and cwd/],
  ];
  writeFileSync(join(cases[1][1], 'roster.toml'), `[global]
helmo_cli = "x"
helmo_mcp_server = "y"
[loops.builder]
workstream = "w"
cwd = "/tmp/shared"
runtime = "mock"
model = "m"
constitution = "/tmp/PROFILE.md"
[loops.builder-2]
seat = "builder"
workstream = "w"
cwd = "/tmp/shared"
runtime = "mock"
model = "m"
constitution = "/tmp/PROFILE.md"
`);

  for (const [name, REV_HOME, message] of cases) {
    await t.test(name, async (t) => {
      const homes = { HELMO_HOME: fixture(t), ROADMAP_HOME: fixture(t), REV_HOME };
      const app = await startApp(t, homes);
      for (const path of ['/run', '/', '/team', '/api/v1/team', '/api/v1/overview']) {
        const failed = await fetch(`${app.origin}${path}`);
        assert.equal(failed.status, 500, path);
        assert.match(await failed.text(), message, path);
      }
      assert.equal((await fetch(`${app.origin}/work`)).status, 200, 'the app process did not remain available');
    });
  }
});

test('every retired port answers 301 to a location that answers 200 and renders its surface', async (t) => {
  const homes = installation(t);
  const project = seedProject(homes, 'the initiative a 4410 bookmark names');
  const legacy = await rebase();
  const { origin } = await startApp(t, homes, legacy);

  for (const row of legacy) {
    const redirect = await fetch(`http://127.0.0.1:${row.port}/`, { redirect: 'manual' });
    assert.equal(redirect.status, 301, `:${row.was} (rebased to :${row.port}) did not redirect`);
    const location = redirect.headers.get('location');
    // The route normalizes `/` to nothing, so the incoming path supplies it.
    assert.equal(location, `${origin}${row.route === '/' ? '' : row.route}/`, `:${row.was} redirected to the wrong route`);
    // A fragment is client-side. The browser reattaches `#R-39` to whatever
    // Location names, and only if Location does not carry one of its own.
    assert.ok(!location.includes('#'), `:${row.was} put a fragment in Location, which would replace the caller's`);

    const landed = await fetch(location);
    assert.equal(landed.status, 200, `the destination of :${row.was} did not answer`);
    assert.match(await landed.text(), new RegExp(row.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `:${row.was} landed on the wrong surface`);
  }

  // The 21 `:4410/#R-n` refs are roadmap evidence, so the roadmap
  // destination must resolve the name, not merely render a page.
  const roadmap = legacy.find((row) => row.route === '/roadmap');
  const landed = await fetch(`${origin}${roadmap.route}/`);
  assert.match(await landed.text(), new RegExp(project), `${project} is not in the page a :4410/#${project} bookmark lands on`);
});

test('a retired port preserves the path and query it was given', async (t) => {
  const homes = installation(t);
  const legacy = await rebase();
  const { origin } = await startApp(t, homes, legacy);

  const row = legacy.find((item) => item.route === '/run');
  const redirect = await fetch(`http://127.0.0.1:${row.port}/loops?whole=1`, {
    redirect: 'manual',
    headers: { host: 'poison.example:9999' },
  });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), `${origin}/run/loops?whole=1`);
});

test('the app binds exactly the ports it was configured with and leaves every other listener alone', async (t) => {
  const homes = installation(t);
  const legacy = await rebase();
  // The ports this installation must never touch: another installation's
  // dashboard, Good Plumb's, a meeting surface. Each is held by something
  // that answers its own name, so "untouched" is a reading rather than a hope.
  const excluded = await Promise.all([
    sentinel(t, 'other-installation', 0),
    sentinel(t, 'good-plumb', 0),
    sentinel(t, 'meeting', 0),
  ]);
  const unconfigured = await freePort();

  const app = await startApp(t, homes, legacy);
  assert.equal((await fetch(`${app.origin}/health.json`)).status, 200);

  for (const held of excluded) {
    const response = await fetch(`http://127.0.0.1:${held.port}/`);
    assert.equal(await response.text(), held.name, `:${held.port} is no longer answering for ${held.name}`);
  }
  assert.equal(await free(unconfigured), true, 'the app bound a port nothing configured');

  // The sentinels prove nothing was taken from an owner that was already
  // there; this proves nothing was taken at all. Without it the test passes
  // for an app that binds a port no one asked for and no one happened to hold.
  const bound = listeningPorts(app.child.pid);
  assert.ok(bound, 'lsof is unavailable, so the bound port set was not measured on this platform');
  assert.deepEqual(
    [...bound].sort((a, b) => a - b),
    [Number(new URL(app.origin).port), ...legacy.map((row) => row.port)].sort((a, b) => a - b),
    'the app is listening on something other than exactly what it was configured with',
  );
});

test('a configured port something else already holds refuses the whole start', async (t) => {
  const homes = installation(t);
  const legacy = await rebase();
  const held = await sentinel(t, 'good-plumb', legacy[1].port);
  legacy[1] = { ...legacy[1], port: held.port };

  const child = spawn(join(BIN, 'helmo'), ['serve'], {
    env: env({
      ...homes,
      HELMO_APP_PORT: '0',
      HELMO_LEGACY_LISTENERS: JSON.stringify(legacy.map(({ port, route }) => ({ port, route }))),
    }),
  });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.on('exit', resolve));

  assert.notEqual(code, 0, `the app started anyway: ${output}`);
  assert.match(output, /EADDRINUSE/);
  // The point of refusing the whole start: the listener it could not have is
  // still the other owner's, and the ones it did open are closed again.
  assert.equal(await (await fetch(`http://127.0.0.1:${held.port}/`)).text(), held.name);
  assert.equal(await free(legacy[0].port), true, 'a listener from the failed attempt is still open');
  assert.equal(await free(legacy[2].port), true, 'a listener from the failed attempt is still open');
});

test('health is a reading of this installation, and does not speak for the remote write surface', async (t) => {
  const homes = installation(t);
  const { origin } = await startApp(t, homes);

  const response = await fetch(`${origin}/health.json`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  // Exactly the four surfaces this process actually serves. The remote write
  // service on :4401 is separately authenticated and is not in this process,
  // so health must not imply it was checked (H-2627).
  assert.deepEqual(body.checks.map((item) => item.name), ['app', 'work', 'roadmap', 'runtime']);
  assert.equal(body.checks.find((item) => item.name === 'app').detail.origin, origin);
  assert.equal(body.checks.find((item) => item.name === 'work').detail.store, join(homes.HELMO_HOME, 'helmo.db'));
});

test('two installations each serve their own records, and one shutting down leaves the other serving', async (t) => {
  const alpha = installation(t);
  const beta = installation(t);
  const alphaTicket = seedTicket(alpha, 'alpha only');
  const betaTicket = seedTicket(beta, 'beta only');
  const alphaLegacy = await rebase();
  const betaLegacy = await rebase();

  const alphaApp = await startApp(t, alpha, alphaLegacy);
  const betaApp = await startApp(t, beta, betaLegacy);
  assert.notEqual(alphaApp.origin, betaApp.origin);

  // Both installations minted H-1, so the ids cannot tell them apart. The
  // titles can: each page must carry its own and not the other's.
  const alphaHtml = await (await fetch(`${alphaApp.origin}/`)).text();
  const betaHtml = await (await fetch(`${betaApp.origin}/`)).text();
  assert.equal(alphaTicket, betaTicket, 'the fixture is only interesting while both ids collide');
  assert.match(alphaHtml, /alpha only/);
  assert.ok(!alphaHtml.includes('beta only'), 'alpha rendered the other installation’s record');
  assert.match(betaHtml, /beta only/);
  assert.ok(!betaHtml.includes('alpha only'), 'beta rendered the other installation’s record');

  const alphaStore = (await (await fetch(`${alphaApp.origin}/health.json`)).json()).checks.find((i) => i.name === 'work').detail.store;
  const betaStore = (await (await fetch(`${betaApp.origin}/health.json`)).json()).checks.find((i) => i.name === 'work').detail.store;
  assert.notEqual(alphaStore, betaStore);

  // Clean shutdown, and only of the installation that was signalled.
  const exit = exited(alphaApp.child);
  alphaApp.child.kill('SIGTERM');
  assert.equal(await exit, 0, 'SIGTERM was not a clean shutdown');
  for (const row of alphaLegacy) {
    assert.equal(await free(row.port), true, `:${row.was} is still bound after shutdown`);
  }
  assert.equal(await free(Number(new URL(alphaApp.origin).port)), true, 'the app port is still bound after shutdown');

  assert.equal((await fetch(`${betaApp.origin}/health.json`)).status, 200, 'beta stopped answering when alpha shut down');
  const stillThere = await fetch(`http://127.0.0.1:${betaLegacy[0].port}/`, { redirect: 'manual' });
  assert.equal(stillThere.status, 301, 'beta’s retired listener went down with alpha');
});
