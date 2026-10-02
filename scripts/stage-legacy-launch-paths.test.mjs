// The retired release-directory MCP launch paths, proved against a disposable
// release fixture: a one-component layout staged in a temp directory, started
// through the retired path, and read back on both channels. The fixture's
// "servers" are stubs — what is under test is the forwarding, not the servers,
// and a real server would want a store.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  assertStageable, BANNER, FORWARDS, RETIRES, stageLegacyLaunchPaths,
} from './stage-legacy-launch-paths.mjs';

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A one-component release directory holding stub servers that name themselves. */
function unifiedRelease() {
  const root = mkdtempSync(join(tmpdir(), 'helmo-release-'));
  write(join(root, 'RELEASE.json'), JSON.stringify({ commits: { helmo: 'a'.repeat(40) } }));
  for (const pkg of ['work', 'roadmap']) {
    write(join(root, 'helmo', 'packages', pkg, 'dist', 'server.js'), `console.log('${pkg} server');\n`);
  }
  return root;
}

/** The pre-consolidation layout, where the retired paths are the real builds. */
function legacyRelease() {
  const root = mkdtempSync(join(tmpdir(), 'helmo-legacy-'));
  write(
    join(root, 'RELEASE.json'),
    JSON.stringify({ commits: { rev: 'b'.repeat(40), helmo: 'c'.repeat(40), 'helmo-roadmap': 'd'.repeat(40) } }),
  );
  write(join(root, 'helmo', 'dist', 'server.js'), "console.log('the real work server');\n");
  write(join(root, 'helmo-roadmap', 'dist', 'server.js'), "console.log('the real roadmap server');\n");
  return root;
}

const run = (path, extra = []) =>
  spawnSync(process.execPath, [...extra, path], { encoding: 'utf8' });

test('each retired path starts the server the one-component layout holds', () => {
  const root = unifiedRelease();
  try {
    stageLegacyLaunchPaths(root);
    const work = run(join(root, 'helmo', 'dist', 'server.js'));
    assert.equal(work.status, 0);
    assert.equal(work.stdout.trim(), 'work server');
    const roadmap = run(join(root, 'helmo-roadmap', 'dist', 'server.js'));
    assert.equal(roadmap.status, 0);
    assert.equal(roadmap.stdout.trim(), 'roadmap server');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the deprecation notice goes to stderr and leaves stdout to the protocol', () => {
  const root = unifiedRelease();
  try {
    stageLegacyLaunchPaths(root);
    for (const forward of FORWARDS) {
      const started = run(join(root, forward.from));
      assert.match(started.stderr, /is a retired layout/);
      assert.match(started.stderr, new RegExp(RETIRES));
      assert.doesNotMatch(started.stdout, /retired/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('past the window each retired path refuses and names the replacement', () => {
  const root = unifiedRelease();
  const clock = join(root, 'after-the-window.mjs');
  try {
    stageLegacyLaunchPaths(root);
    const after = Date.parse(`${RETIRES}T23:59:59.999Z`) + 1;
    writeFileSync(clock, `Date.now = () => ${after};\n`);
    for (const forward of FORWARDS) {
      const refused = run(join(root, forward.from), ['--import', `file://${clock}`]);
      assert.equal(refused.status, 2);
      assert.match(refused.stderr, new RegExp(`stopped working after ${RETIRES}`));
      assert.match(refused.stderr, new RegExp(forward.now));
      assert.equal(refused.stdout, '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses the legacy layout, where these paths are the real builds', () => {
  const root = legacyRelease();
  try {
    assert.throws(() => stageLegacyLaunchPaths(root), /refusing to stage into a helmo\/helmo-roadmap\/rev release/);
    assert.equal(run(join(root, 'helmo', 'dist', 'server.js')).stdout.trim(), 'the real work server');
    assert.equal(run(join(root, 'helmo-roadmap', 'dist', 'server.js')).stdout.trim(), 'the real roadmap server');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses an unbuilt release rather than forwarding to nothing', () => {
  const root = unifiedRelease();
  try {
    rmSync(join(root, 'helmo', 'packages', 'roadmap', 'dist', 'server.js'));
    assert.throws(() => stageLegacyLaunchPaths(root), /nothing to forward to/);
    // The work forwarder is checked and refused before the roadmap one is
    // reached, so a half-staged release is never left behind.
    assert.equal(existsSync(join(root, 'helmo', 'dist', 'server.js')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to overwrite a file it did not generate, and re-runs over one it did', () => {
  const root = unifiedRelease();
  try {
    write(join(root, 'helmo', 'dist', 'server.js'), "console.log('somebody else put this here');\n");
    assert.throws(() => assertStageable(root), /is not a generated forwarder/);
    rmSync(join(root, 'helmo', 'dist', 'server.js'));
    stageLegacyLaunchPaths(root);
    assert.doesNotThrow(() => stageLegacyLaunchPaths(root));
    assert.ok(readFileSync(join(root, 'helmo', 'dist', 'server.js'), 'utf8').includes(BANNER));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a directory that is not a release at all', () => {
  const root = mkdtempSync(join(tmpdir(), 'helmo-notarelease-'));
  try {
    assert.throws(() => stageLegacyLaunchPaths(root), /not a release directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
