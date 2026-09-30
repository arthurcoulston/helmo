import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installation, InstallationError } from '../src/install.js';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

// H-2472, the sibling of helmo:test/install.test.ts. Both entry points
// resolved ROADMAP_DB on their own and an installation had no name, so the only
// thing that said which roadmap you were talking to was a database path.
//
// That both entry points resolve the SAME installation is a claim about two
// processes, so each is started for real and asked to reach one seeded store
// through the installation home — something neither could do before — and each
// is started again with conflicting signals and observed to write nothing.

const mason: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1' };

const repo = new URL('..', import.meta.url).pathname;
const account = resolve(userInfo().homedir);
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe('resolving the installation (H-2472)', () => {
  it('leaves the single-install default exactly where it was', () => {
    const i = installation(env({}));
    expect(i.home).toBe(join(homedir(), '.helmo-roadmap'));
    expect(i.db).toBe(join(homedir(), '.helmo-roadmap', 'roadmap.db'));
    expect(i.source).toBe('derived');
  });

  it('lets either of ROADMAP_HOME and ROADMAP_DB determine the other', () => {
    const fromDb = installation(env({ ROADMAP_DB: '/tmp/customer-a/.helmo-roadmap/roadmap.db' }));
    expect(fromDb.home).toBe('/tmp/customer-a/.helmo-roadmap');

    const fromHome = installation(env({ ROADMAP_HOME: '/tmp/customer-a/.helmo-roadmap' }));
    expect(fromHome.home).toBe(fromDb.home);
    expect(fromHome.db).toBe(fromDb.db);
  });

  it('refuses when the two name different installations, naming both and the way out', () => {
    const conflicting = env({
      ROADMAP_HOME: '/tmp/customer-a/.helmo-roadmap',
      ROADMAP_DB: '/tmp/customer-b/.helmo-roadmap/roadmap.db',
    });
    expect(() => installation(conflicting)).toThrow(InstallationError);
    try {
      installation(conflicting);
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('/tmp/customer-a/.helmo-roadmap');
      expect(message).toContain('/tmp/customer-b/.helmo-roadmap/roadmap.db');
      expect(message).toContain('Unset one');
    }
  });

  it('shares the installation name Helmo and Rev already use', () => {
    // The point of the ticket: one installation, one name. ROADMAP_LABEL is the
    // product's own override, HELMO_LABEL is the Helmo-family name this honours
    // for the reason it honours HELMO_ACTOR, and REV_LABEL is the identity the
    // supervisor derives and writes into the service environment (H-2452).
    expect(installation(env({ REV_LABEL: 'dev.rev.gp' })).label).toBe('dev.rev.gp');
    expect(installation(env({ HELMO_LABEL: 'gp', REV_LABEL: 'dev.rev.gp' })).label).toBe('gp');
    expect(installation(env({ ROADMAP_LABEL: 'roadmap-b', HELMO_LABEL: 'gp' })).source).toBe('ROADMAP_LABEL');
    expect(installation(env({ ROADMAP_DB: '', HELMO_LABEL: '  ' })).source).toBe('derived');
  });

  it('keeps the readable name for the conventional homes, and separates same-basename ones', () => {
    expect(installation(env({ ROADMAP_HOME: join(account, '.helmo-roadmap') })).label).toBe('dev.roadmap');
    expect(installation(env({ ROADMAP_HOME: join(account, '.helmo-roadmap-gp') })).label).toBe('dev.roadmap.gp');

    const a = installation(env({ ROADMAP_HOME: '/tmp/customer-a/.helmo-roadmap' }));
    const b = installation(env({ ROADMAP_HOME: '/tmp/customer-b/.helmo-roadmap' }));
    expect(a.label).not.toBe(b.label);
    expect(a.label).toContain('customer-a');

    // A $HOME the install itself could have written must not buy the readable
    // name — the rule keys on the password database.
    expect(installation(env({ HOME: '/tmp/customer-a', ROADMAP_HOME: '/tmp/customer-a/.helmo-roadmap' })).label)
      .not.toBe('dev.roadmap');
  });
});

// ---- Both entry points, as processes ----

const ENTRIES = ['src/server.ts', 'src/view.ts'] as const;

/** The inherited environment carries this fleet's own ROADMAP_DB and labels; a
 *  case that did not strip them would be testing the estate's installation. */
function spawnEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  const base = { ...process.env };
  for (const k of ['ROADMAP_DB', 'ROADMAP_HOME', 'ROADMAP_LABEL', 'HELMO_LABEL', 'REV_LABEL']) delete base[k];
  return { ...base, ...vars };
}

/** A port nobody is on. The view prints its configured port, not its assigned
 *  one, so it cannot be asked for an ephemeral one after the fact. */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const probe = createServer();
    probe.once('error', rej);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => res(port));
    });
  });
}

describe('both entry points reach one installation through its home (H-2472)', () => {
  let dir: string;
  let home: string;
  let project: string;
  const title = 'Prove the installation home reaches this store';
  let view: ChildProcess | null = null;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'roadmap-install-'));
    home = join(dir, 'customer-a', '.helmo-roadmap');
    mkdirSync(home, { recursive: true });
    const seed = new Store(join(home, 'roadmap.db'));
    project = seed.createProject(mason, { title }).id;
    seed.close();
  });
  afterAll(() => {
    view?.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('the MCP server serves the seeded project', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/server.ts'],
      cwd: repo,
      env: spawnEnv({ ROADMAP_HOME: home }) as Record<string, string>,
    });
    const client = new Client({ name: 'install-test', version: '0' });
    await client.connect(transport);
    const res = await client.callTool({ name: 'roadmap_get_project', arguments: { project_id: project } });
    expect((res.content as { text: string }[])[0]!.text).toContain(title);
    await client.close();
  });

  it('the view serves the seeded project and says which installation it read', async () => {
    const port = await freePort();
    view = spawn(process.execPath, ['--import', 'tsx', 'src/view.ts'], {
      cwd: repo,
      env: spawnEnv({ ROADMAP_HOME: home, ROADMAP_VIEW_PORT: String(port), ROADMAP_VIEW_HOST: '127.0.0.1' }),
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const line = await new Promise<string>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('the view never reported ready')), 15_000);
      view!.once('error', rej);
      view!.once('exit', (code) => rej(new Error(`the view exited before ready (${code})`)));
      view!.stdout!.on('data', (d: Buffer) => {
        const text = d.toString();
        if (!text.includes('Roadmap view:')) return;
        clearTimeout(timer);
        res(text);
      });
    });

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain(title);
    expect(line).toContain(`install: ${installation(env({ ROADMAP_HOME: home })).label}`);
  });
});

describe('neither entry point opens a store when the environment names two installations (H-2472)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'roadmap-conflict-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(ENTRIES)('%s refuses before writing anything', (file) => {
    const scope = join(dir, file.replace(/\W/g, '_'));
    const home = join(scope, 'customer-a', '.helmo-roadmap');
    const db = join(scope, 'customer-b', '.helmo-roadmap', 'roadmap.db');
    const r = spawnSync(process.execPath, ['--import', 'tsx', file], {
      cwd: repo,
      env: spawnEnv({ ROADMAP_HOME: home, ROADMAP_DB: db, ROADMAP_VIEW_PORT: '0' }),
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(r.status, `${file} should have refused; stdout: ${r.stdout}`).not.toBe(0);
    expect(r.stderr).toContain(home);
    expect(r.stderr).toContain(db);
    // The refusal is the point only if nothing was created on the way to it:
    // an entry point that opened the store first would leave one of these.
    expect(existsSync(db), `${file} created ${db}`).toBe(false);
    expect(existsSync(home), `${file} created ${home}`).toBe(false);
  });
});
