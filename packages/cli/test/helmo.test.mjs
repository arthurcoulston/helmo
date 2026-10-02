// The front command and the adapters behind it — compatibility family T3.a:
// every old binary name still works, and says it is leaving.
//
// These tests drive the real linked binaries in node_modules/.bin, because
// what is under test is what a caller's shell reaches: a bin entry that still
// points at the old target, or a notice written to stdout, are both invisible
// to a test that imports a function instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'node_modules', '.bin');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
// Two actors, because Helmo refuses a seat the claim of a ticket it filed
// itself and nobody else has touched: the fixture files as the orchestrator
// and writes as the seat.
const FILER = JSON.stringify({ name: 'helmo-orchestrator', kind: 'orchestrator', model: 'test', version: 'test' });
// The seat carries a session stamp: an agent claiming without one is a desk
// claim, which Helmo refuses (refuseUnmarkedDeskClaim).
const ACTOR = JSON.stringify({ name: 'mason', kind: 'agent', model: 'test', version: 'test', session: 'test' });
const NOTICE = /COMPATIBILITY\.md/;

// A loop runs these with its own installation in the environment, and an
// inherited REV_HOME, HELMO_HOME or INSTALLATION_RELEASE would aim a test at
// the live estate (H-2644). Every variable the products read is cleared here
// and only the fixture's own values are put back.
function env(extra = {}) {
  const base = { ...process.env };
  for (const key of Object.keys(base)) {
    if (/^(HELMO|ROADMAP|REV|INSTALLATION)_/.test(key)) delete base[key];
  }
  delete base['REV_CLI'];
  return { ...base, ...extra };
}

function run(bin, args, extra = {}) {
  const r = spawnSync(join(BIN, bin), args, { encoding: 'utf8', env: env(extra) });
  if (r.error) throw r.error;
  return r;
}

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'helmo-front-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// Every runtime command loads the roster at module level, so a runtime
// fixture is a home with one in it — the repository's own example, which is
// what its refusal tells an operator to copy.
function revHome(t) {
  const home = fixture(t);
  copyFileSync(join(ROOT, 'packages', 'runtime', 'examples', 'roster.toml'), join(home, 'roster.toml'));
  return home;
}

function deprecationLines(stderr) {
  return stderr.split('\n').filter((line) => NOTICE.test(line));
}

test('helmo with no arguments names every group it fronts', () => {
  const r = run('helmo', []);
  assert.equal(r.status, 0);
  for (const group of ['work', 'roadmap', 'run', 'team', 'release', 'service', 'serve', 'mcp']) {
    assert.match(r.stdout, new RegExp(`^  ${group} `, 'm'), `${group} is missing from the usage`);
  }
  assert.equal(r.stderr, '');
});

test('helmo --version is the one product version', () => {
  assert.equal(run('helmo', ['--version']).stdout.trim(), VERSION);
});

test('an unknown group refuses on stderr, names the groups, and prints nothing on stdout', () => {
  const r = run('helmo', ['wrok', 'list']);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /unknown group 'wrok'/);
  assert.match(r.stderr, /work roadmap run team release service serve mcp/);
});

test('a group that serves several products refuses without one, and names them', () => {
  const missing = run('helmo', ['mcp']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /needs a product: work or roadmap/);

  const wrong = run('helmo', ['serve', 'runtime']);
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /no product 'runtime'.*work, roadmap, run/);
});

test('helmo work and helmo-cli are the same entry point: each sees the other’s writes', (t) => {
  const home = fixture(t);
  const made = run('helmo', ['work', 'create', '--title', 'front door', '--body', 'b', '--workstream', 'estate-ui', '--type', 'build'], { HELMO_HOME: home, HELMO_ACTOR: FILER });
  assert.equal(made.status, 0);
  const id = JSON.parse(made.stdout).id;

  // The old name reads the record the new name wrote.
  const read = run('helmo-cli', ['get', '--ticket', id], { HELMO_HOME: home, HELMO_ACTOR: ACTOR });
  assert.equal(read.status, 0);
  assert.equal(JSON.parse(read.stdout).title, 'front door');

  // And the effect of a write through the old name is visible through the new.
  const wrote = run('helmo-cli', ['update', '--ticket', id, '--note', 'claimed', '--status', 'in_progress'], { HELMO_HOME: home, HELMO_ACTOR: ACTOR });
  assert.equal(wrote.status, 0, wrote.stdout);
  const after = run('helmo', ['work', 'get', '--ticket', id], { HELMO_HOME: home, HELMO_ACTOR: ACTOR });
  assert.equal(JSON.parse(after.stdout).status, 'in_progress');
});

test('helmo-cli says it is leaving: one line on stderr, and stdout is still one JSON object', (t) => {
  const home = fixture(t);
  const r = run('helmo-cli', ['list'], { HELMO_HOME: home, HELMO_ACTOR: ACTOR });
  assert.equal(r.status, 0);

  const notices = deprecationLines(r.stderr);
  assert.equal(notices.length, 1, `expected one deprecation line, got ${JSON.stringify(r.stderr)}`);
  assert.match(notices[0], /helmo-cli is now 'helmo work'/);
  assert.match(notices[0], /2027-04-01/);

  // The regression a warning on the wrong stream would cause.
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});

test('the new name says nothing about deprecation', (t) => {
  const home = fixture(t);
  const r = run('helmo', ['work', 'list'], { HELMO_HOME: home, HELMO_ACTOR: ACTOR });
  assert.equal(r.status, 0);
  assert.deepEqual(deprecationLines(r.stderr), []);
});

test('helmo-view names its replacement and its own shorter window', (t) => {
  const home = fixture(t);
  // The view would hold the port open, so this run is only about the notice:
  // an unusable port makes it exit on its own after the line is written.
  const r = run('helmo-view', [], { HELMO_HOME: home, HELMO_VIEW_PORT: '1' });
  const notices = deprecationLines(r.stderr);
  assert.equal(notices.length, 1, r.stderr);
  assert.match(notices[0], /helmo-view is now 'helmo serve work'/);
  assert.match(notices[0], /2027-01-01/);
});

test('usage under the front command names the front command, and rev stays rev', (t) => {
  // Runtime writes the usage it prints for a missing command on stderr.
  const underHelmo = run('helmo', ['run'], { REV_HOME: revHome(t) });
  assert.match(underHelmo.stderr, /^usage: helmo run <command>/m);

  // Row 14: rev is a permanent alias, not an adapter. It keeps its own name in
  // its own usage, because it is named in loop prompts that regenerate.
  //
  // Invoked at its own path rather than through node_modules/.bin: npm skips
  // linking a bin whose target does not exist yet, so after the documented
  // cold install (npm ci, then build) `rev` is linked only by a second
  // install. The adapters above are committed source files and link on the
  // first one.
  const underRev = spawnSync(process.execPath, [join(ROOT, 'packages', 'runtime', 'dist', 'cli.js')], {
    encoding: 'utf8',
    env: env({ REV_HOME: revHome(t) }),
  });
  assert.match(underRev.stderr, /^usage: rev <command>/m);
  assert.deepEqual(deprecationLines(underRev.stderr), []);
});

test('a runtime group stands in for its verb, and the verb it stands for is reached', (t) => {
  const home = revHome(t);

  // The effect: bare `release` is runtime's own default, so this reaches the
  // real release surface and reports this installation's selection.
  const status = run('helmo', ['release'], { REV_HOME: home });
  assert.equal(status.status, 0);
  assert.match(status.stdout, /^installation: /m);
  assert.match(status.stdout, /^release: /m);

  // And the refusal it prints for an unknown subcommand names the group the
  // caller actually typed, not rev.
  const wrong = run('helmo', ['release', 'bogus'], { REV_HOME: home });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /^usage: helmo release <status \| upgrade/m);
});

// The two long-lived surfaces: assert they actually start under the new
// spelling, rather than that a path resolved.
function started(bin, args, extra, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(BIN, bin), args, { env: env(extra) });
    let stdout = '';
    let stderr = '';
    const done = (matched) => {
      child.kill('SIGKILL');
      resolve({ stdout, stderr, matched });
    };
    const timer = setTimeout(() => done(false), 10_000);
    // The MCP servers announce themselves on stderr because stdout is the
    // protocol channel; the views announce on stdout. Watch both, and let the
    // marker say which surface started.
    const watch = (chunk) => {
      if (marker.test(stdout) || marker.test(stderr)) {
        clearTimeout(timer);
        done(true);
      }
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      watch();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      watch();
    });
    child.on('error', reject);
  });
}

test('helmo mcp work starts the Helmo MCP server', async (t) => {
  const home = fixture(t);
  const { stderr, matched } = await started('helmo', ['mcp', 'work'], { HELMO_HOME: home }, /Helmo MCP \(stdio\)/);
  assert.ok(matched, `the server never announced itself: ${stderr}`);
  assert.deepEqual(deprecationLines(stderr), []);
});

test('helmo-mcp still starts the Helmo MCP server without polluting its protocol', async (t) => {
  const home = fixture(t);
  const { stdout, stderr, matched } = await started('helmo-mcp', [], { HELMO_HOME: home }, /Helmo MCP \(stdio\)/);
  assert.ok(matched, `the server never announced itself: ${stderr}`);
  const notices = deprecationLines(stderr);
  assert.equal(notices.length, 1, stderr);
  assert.match(notices[0], /helmo-mcp is now 'helmo mcp work'/);
  assert.match(notices[0], /2027-04-01/);
  assert.equal(stdout, '', 'the deprecation notice must not pollute the MCP protocol channel');
});

test('roadmap-mcp still starts the roadmap MCP server, and says it is leaving', async (t) => {
  const home = fixture(t);
  const { stderr, matched } = await started('roadmap-mcp', [], { ROADMAP_HOME: home }, /MCP \(stdio\)/);
  assert.ok(matched, `the server never announced itself: ${stderr}`);
  const notices = deprecationLines(stderr);
  assert.equal(notices.length, 1, stderr);
  assert.match(notices[0], /roadmap-mcp is now 'helmo mcp roadmap'/);
});

test('helmo serve work serves the Helmo view', async (t) => {
  const home = fixture(t);
  const { stdout, stderr, matched } = await started('helmo', ['serve', 'work'], { HELMO_HOME: home, HELMO_VIEW_PORT: '0' }, /Helmo view:/);
  assert.ok(matched, `the view never announced itself: ${stdout}${stderr}`);
  assert.deepEqual(deprecationLines(stdout), [], 'the new name must not print a notice on stdout');
});
