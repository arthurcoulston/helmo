// What the Team page's reads do with a hostile file — family H-3004.
//
// Team inventories every CLAUDE.md and AGENTS.md it finds walking up from a
// seat's working directory: files no roster entry names, in trees any agent on
// this machine can write. So the question is not whether a request can name an
// arbitrary path (it cannot) but what the surface does with a path it accepts.
//
// Each case here is a reported failure, not a hypothesis. A fifo named
// AGENTS.md held every route of the app until a kill; a symlink named CLAUDE.md
// rendered its target's body on the dashboard; `/members/__proto__` answered
// with a phantom member. The app is started for real, because all three were
// found through the listener and a unit test on the projection would have
// missed the one that matters most: that the damage reached routes Team has
// nothing to do with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN, env, fixture } from './installation.mjs';

const SENTINEL = 'OUTSIDE-SENTINEL-H3004';

/** An installation whose one seat's working tree is ours to make hostile.
 *
 *  Each case plants only what it is about. A tree carrying both a fifo and a
 *  link proves nothing about the link: the fifo stalls the route first, so the
 *  symlink test went red for the other defect's reason. */
function hostileInstallation(t, { fifo = false, link = false, stall = false } = {}) {
  const runtime = fixture(t);
  const tree = fixture(t);
  const outside = fixture(t);

  // The repository boundary the walk stops at, so the fixture cannot reach up
  // into the machine running it.
  writeFileSync(join(tree, '.git'), 'a repository boundary');
  mkdirSync(join(runtime, 'constitutions'), { recursive: true });
  writeFileSync(join(runtime, 'constitutions', 'alpha.md'), '---\ncap_tokens: 500\n---\nthe seat itself');

  // A fifo with a discovered name. Opening one for reading blocks until a
  // writer arrives, and nothing here will ever write: this is the shape that
  // froze the app.
  if (fifo) assert.equal(spawnSync('mkfifo', [join(tree, 'AGENTS.md')]).status, 0, 'the fixture could not make a fifo');

  // A file whose every chunk is one the tokenizer pays quadratically for, at a
  // size no byte ceiling would stop. U+3000 alternating with LF is a single
  // chunk to the encoder — the pattern's whitespace branch is `\s`, which the
  // first version of the work guard did not classify as whitespace.
  if (stall) writeFileSync(join(tree, 'AGENTS.md'), '\u3000\n'.repeat(4_000));

  // A symlink with a discovered name, pointing at a file outside the tree.
  if (link) {
    writeFileSync(join(outside, 'secret.txt'), SENTINEL);
    symlinkSync(join(outside, 'secret.txt'), join(tree, 'CLAUDE.md'));
  }

  writeFileSync(join(runtime, 'roster.toml'), `[global]
helmo_cli = "x"
helmo_mcp_server = "y"
[loops.alpha]
workstream = "estate-ui"
cwd = "${tree}"
runtime = "claude"
model = "claude-opus-5"
constitution = "constitutions/alpha.md"
`);
  return { homes: { HELMO_HOME: fixture(t), ROADMAP_HOME: fixture(t), REV_HOME: runtime }, tree };
}

async function startApp(t, homes) {
  const child = spawn(join(BIN, 'helmo'), ['serve'], { env: env({ ...homes, HELMO_APP_PORT: '0' }) });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  return {
    origin: await new Promise((resolve, reject) => {
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
      child.on('exit', (code) => reject(new Error(`the app exited ${code}: ${output}`)));
    }),
  };
}

/** A fetch that fails rather than waits. The reported failure was a route that
 *  never answered, so a test without its own deadline would hang with it. */
async function get(origin, path, ms = 10_000) {
  return fetch(`${origin}${path}`, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
}

test('a fifo in a seat\'s working tree is named rather than read, and no route stalls behind it', async (t) => {
  const { homes } = hostileInstallation(t, { fifo: true });
  const { origin } = await startApp(t, homes);

  const started = Date.now();
  const team = await get(origin, '/api/v1/team');
  assert.equal(team.status, 200);
  const document = (await team.json()).data;
  const elapsed = Date.now() - started;

  const files = document.loops[0].context.discovered.files;
  const fifo = files.find((file) => file.name === 'AGENTS.md');
  assert.ok(fifo, 'the fifo left the inventory entirely; it is in the tree and should be reported');
  assert.equal(fifo.state, 'unreadable');
  assert.equal(fifo.tokens, 0);
  assert.match(fifo.error, /fifo/);
  // The whole point: an unreadable file is not a zero folded into a total.
  assert.equal(document.loops[0].context.discovered.tokens, 0);
  assert.ok(document.loops[0].context.startup_tokens > 0, 'the readable profile should still be counted');

  // An unrelated route was the collateral damage: the event loop was blocked,
  // so /overview timed out too.
  assert.equal((await get(origin, '/api/v1/overview')).status, 200);
  assert.ok(elapsed < 10_000, `the Team document took ${elapsed}ms`);
});

test('a file the tokenizer would stall on is named rather than counted, and no route waits for it', async (t) => {
  // The H-3007 FAIL, through the listener: 16KB of U+3000/LF passed the work
  // ceiling, was counted at 4,000 tokens, and held /api/v1/team/members/alpha
  // 38,962ms with /api/v1/overview blocked 38,461ms behind it. Both deadlines
  // below are the real assertions — this case fails by timing out, which is
  // the reported failure itself rather than a proxy for it.
  const { homes } = hostileInstallation(t, { stall: true });
  const { origin } = await startApp(t, homes);

  const started = Date.now();
  const member = await get(origin, '/api/v1/team/members/alpha');
  assert.equal(member.status, 200);
  const elapsed = Date.now() - started;

  const file = (await member.json()).data.context.discovered.files.find((f) => f.name === 'AGENTS.md');
  assert.ok(file, 'the file left the inventory; the CLI would read it, so the page should say it is there');
  assert.equal(file.state, 'unreadable');
  assert.equal(file.tokens, 0);
  assert.equal(file.bytes, 16_000);
  // Reported with its size and reason, never as a token count that would make
  // a planted file look like context the seat carries.
  assert.match(file.error, /chunked too coarsely/);

  assert.equal((await get(origin, '/api/v1/overview')).status, 200);
  assert.ok(elapsed < 10_000, `the member document took ${elapsed}ms`);
});

test('a symlink with a discovered name does not put its target on the dashboard', async (t) => {
  const { homes } = hostileInstallation(t, { link: true });
  const { origin } = await startApp(t, homes);

  const document = (await (await get(origin, '/api/v1/team')).json()).data;
  const link = document.loops[0].context.discovered.files.find((file) => file.name === 'CLAUDE.md');
  assert.ok(link, 'the link left the inventory; the CLI would read it, so the page should say it is there');
  assert.equal(link.state, 'unreadable');
  assert.match(link.error, /symbolic link/);
  assert.ok(!JSON.stringify(document).includes(SENTINEL), 'the target body reached the Team document');

  // And the file route, which is what actually served the target.
  const served = await get(origin, `/api/v1/team/members/alpha/files/${encodeURIComponent(link.path)}`);
  assert.ok(!(await served.text()).includes(SENTINEL), 'the file route served the link target');

  const member = await get(origin, '/api/v1/team/members/alpha');
  assert.equal(member.status, 200);
  assert.ok(!(await member.text()).includes(SENTINEL), 'the member document served the link target');
});

test('a prototype name is not a seat, and is not a period', async (t) => {
  const { homes } = hostileInstallation(t);
  const { origin } = await startApp(t, homes);

  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const response = await get(origin, `/api/v1/team/members/${encodeURIComponent(name)}`);
    assert.equal(response.status, 404, `${name} answered as a member`);
  }
  // `'__proto__' in PERIODS` was true, so the window dated to NaN and the route
  // answered an error instead of falling back.
  const fallback = await get(origin, '/api/v1/team?period=__proto__');
  assert.equal(fallback.status, 200);
  assert.equal((await fallback.json()).data.period, '7d');
});
