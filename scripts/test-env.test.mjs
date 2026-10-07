import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scrubInPlace, testEnv } from './test-env.mjs';

const SELF = fileURLToPath(new URL('./test-env.mjs', import.meta.url));
const ROOT = dirname(dirname(SELF));
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
