// Disposable installations for the CLI tests, and the one environment scrubber
// they all go through.
//
// A loop runs these tests with its own installation in the environment, and an
// inherited REV_HOME, HELMO_HOME or INSTALLATION_RELEASE would aim a test at
// the live estate (H-2644). That is why `env` lives here rather than once per
// test file: a second, slightly different scrubber is how one file quietly
// stops being isolated.
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const BIN = join(ROOT, 'node_modules', '.bin');

export function env(extra = {}) {
  const base = { ...process.env };
  for (const key of Object.keys(base)) {
    if (/^(HELMO|ROADMAP|REV|INSTALLATION)_/.test(key)) delete base[key];
  }
  delete base['REV_CLI'];
  return { ...base, ...extra };
}

export function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'helmo-front-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// Every runtime command loads the roster at module level, so a runtime
// fixture is a home with one in it — the repository's own example, which is
// what its refusal tells an operator to copy.
export function revHome(t) {
  const home = fixture(t);
  copyFileSync(join(ROOT, 'packages', 'runtime', 'examples', 'roster.toml'), join(home, 'roster.toml'));
  return home;
}

export function boundInstallation(t, label = 'fixture-bound') {
  const root = fixture(t);
  const work = join(root, 'work');
  const roadmap = join(root, 'roadmap');
  const runtime = join(root, 'runtime');
  const binding = join(root, 'installation.json');
  // The Runtime fixture needs its roster in the control home, not the shared
  // parent used to make all owned paths visible in one test failure.
  mkdirSync(work); mkdirSync(roadmap); mkdirSync(runtime);
  copyFileSync(join(ROOT, 'packages', 'runtime', 'examples', 'roster.toml'), join(runtime, 'roster.toml'));
  writeFileSync(binding, JSON.stringify({ version: 1, id: label, installation: label, release: null,
    work: { home: work, store: join(work, 'helmo.db') },
    roadmap: { home: roadmap, store: join(roadmap, 'roadmap.db') },
    control: { home: runtime, service: label } }));
  return { root, work, roadmap, runtime, binding, label, env: {
    HELMO_BINDING: binding, HELMO_REQUIRE_BINDING: '1', HELMO_INSTALLATION: label,
    HELMO_HOME: work, ROADMAP_HOME: roadmap, REV_HOME: runtime,
  } };
}

/** A port nothing holds, found by binding and releasing it. Good enough for a
 *  fixture and never for a service: the window between release and reuse is
 *  what makes it unsafe in anything long-lived. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/** A listener standing in for something else that already holds a port — the
 *  other installation, Good Plumb, a meeting surface. It answers its own name,
 *  so a test can tell "still mine" from "still something". */
export async function sentinel(t, name, port) {
  const server = createServer((_request, response) => response.end(name));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const { port: bound } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { name, port: bound, server };
}
