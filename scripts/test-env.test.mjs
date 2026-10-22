import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scrubInPlace, testEnv } from './test-env.mjs';

const SELF = fileURLToPath(new URL('./test-env.mjs', import.meta.url));
const ROOT = dirname(dirname(SELF));

// How a vitest case declares its own budget. `test` is vitest's own alias for
// `it` and the keyword most of this repo's cases are written with, so reading
// only `it` left the floor open to the dominant form (H-3359); and nothing
// formats this tree, so the padding inside the braces is a convention rather
// than a guarantee. An options bag handed to a child process is not a case's
// own budget, which is what the leading keyword tells the two apart.
const DECLARED_TIMEOUT = /^\s*(?:it|test|describe)(?:\.\w+(?:\([^)]*\))?)*\(.*\{\s*timeout:\s*([0-9_]+)\s*\}/;
const declaredTimeout = (line) => {
  const found = DECLARED_TIMEOUT.exec(line);
  return found ? Number(found[1].replaceAll('_', '')) : null;
};
const LEAKED = {
  PATH: '/usr/bin:/bin',
  HOME: homedir(),
  INSTALLATION_RELEASE: join(homedir(), '.rev', 'release.json'),
  REV_HOME: join(homedir(), '.rev'),
  REV_LABEL: 'dev.rev',
  REV_LOOP: 'mason',
  REV_CLI: '/tmp/release/rev/dist/cli.js',
  HELMO_HOME: join(homedir(), '.helmo'),
  ROADMAP_HOME: join(homedir(), '.roadmap'),
  HELMO_A_KEY_ADDED_LATER: 'covered by the prefix',
};

test('clears inherited product state and redirects REV_HOME away from the live installation', () => {
  const env = testEnv(LEAKED, { home: '/tmp/helmo-test-home' });
  for (const key of [
    'INSTALLATION_RELEASE', 'REV_LABEL', 'REV_LOOP', 'REV_CLI',
    'HELMO_HOME', 'ROADMAP_HOME', 'HELMO_A_KEY_ADDED_LATER',
  ]) assert.equal(env[key], undefined, `${key} survived the scrub`);
  assert.equal(env.REV_HOME, '/tmp/helmo-test-home');
  assert.equal(env.PATH, LEAKED.PATH);
  assert.equal(env.HOME, LEAKED.HOME);
});

test('refuses to run without a scratch REV_HOME', () => {
  assert.throws(() => testEnv(LEAKED), /live ~\/\.rev installation/);
});

test('the command wrapper scrubs its child and preserves a red exit', () => {
  const read = 'console.log(JSON.stringify({home: process.env.REV_HOME, release: process.env.INSTALLATION_RELEASE ?? null, label: process.env.REV_LABEL ?? null}))';
  const out = execFileSync(process.execPath, [SELF, '--', process.execPath, '-e', read], {
    encoding: 'utf8', env: { ...process.env, ...LEAKED }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const seen = JSON.parse(out);
  assert.equal(seen.release, null);
  assert.equal(seen.label, null);
  assert.ok(seen.home && seen.home !== join(homedir(), '.rev'));

  const probe = `const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, [${JSON.stringify(SELF)}, '--', process.execPath, '-e', 'process.exit(7)'], { stdio: 'ignore' });
    process.stdout.write(String(result.status));`;
  assert.equal(execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }), '7');
});

test('the same scrub applies in place, so a suite is isolated by where it runs', () => {
  const env = { ...LEAKED };
  const home = scrubInPlace(env);
  try {
    for (const key of ['INSTALLATION_RELEASE', 'REV_LABEL', 'REV_LOOP', 'REV_CLI', 'HELMO_HOME']) {
      assert.equal(env[key], undefined, `${key} survived the scrub`);
    }
    assert.equal(env.REV_HOME, home);
    assert.notEqual(home, join(homedir(), '.rev'));
    assert.equal(env.PATH, LEAKED.PATH);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('every workspace whose suite runs vitest loads the one shared config', async () => {
  const shared = (await import('./vitest.shared.mjs')).default;
  const setup = shared.test.setupFiles[0];
  assert.ok(existsSync(setup), `the shared config names ${setup}, which does not exist`);

  const script = (dir) => JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')).scripts?.test ?? '';
  const workspaces = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).workspaces
    .filter((dir) => /\bvitest\b/.test(script(dir)));
  assert.ok(workspaces.length >= 4, `expected the vitest workspaces, found ${workspaces.join(', ') || 'none'}`);

  // The root too: `npx vitest run <file>` from the root is its own door.
  for (const dir of ['.', ...workspaces]) {
    const config = join(ROOT, dir, 'vitest.config.mjs');
    assert.ok(existsSync(config), `${dir} runs vitest with no vitest.config.mjs, so its suite inherits the live installation`);
    assert.equal((await import(pathToFileURL(config))).default, shared, `${dir}'s config is not the shared one`);
  }
});

test('the per-test budget is chosen here, and no case declares less room than it', async () => {
  const floor = (await import('./vitest.shared.mjs')).default.test.testTimeout;
  assert.ok(floor >= 15_000, `the shared testTimeout is ${floor ?? 'unset'}; dropping to vitest's 5000ms default reds the CLI-spawning cases on a loaded box (H-3354)`);

  // A per-case `{ timeout: … }` is written to buy MORE room than the default.
  // Raising the floor past one turns it into a tightening nobody intended.
  let scanned = 0;
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    const dir = join(ROOT, 'packages', pkg, 'test');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.ts'))) {
      scanned++;
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
        const ms = declaredTimeout(line);
        if (ms === null) continue;
        assert.ok(ms >= floor, `packages/${pkg}/test/${file} declares ${ms}ms, below the shared ${floor}ms floor, so it reads as extra room while granting less`);
      }
    }
  }
  assert.ok(scanned >= 20, `found only ${scanned} test files to scan, so this check is reading the wrong tree`);
});

test('the floor scanner reads every form a case declares a budget in', () => {
  // The hole this closes was invisible because nothing read the matcher back:
  // the scan stayed green over a sub-floor case it simply could not see.
  for (const line of [
    "  it('x', { timeout: 1_000 }, async () => {",
    "  test('x', { timeout: 1_000 }, async () => {",
    "describe('x', { timeout: 1_000 }, () => {",
    "  test.each(CASES)('x', { timeout: 1_000 }, () => {",
    "  it.skipIf(false)('x', { timeout: 1_000 }, () => {",
    "  test('x', {timeout:1_000}, () => {",
  ]) assert.equal(declaredTimeout(line), 1000, `the scanner cannot see: ${line.trim()}`);

  for (const line of [
    '      timeout: 30_000,',
    "    expect(connect.mock.calls).toEqual([[endpoint, { timeout: 10000 }]]);",
  ]) assert.equal(declaredTimeout(line), null, `the scanner wrongly budgets: ${line.trim()}`);
});
