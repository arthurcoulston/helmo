import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installation, InstallationError } from '../src/install.js';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

// H-2472. Four entry points each resolved HELMO_DB on their own, and an
// installation had no name: the only thing that said which Helmo you were
// talking to was a database path, and nothing printed it back.
//
// Two things have to be true of the fix, and only one of them can be tested by
// calling the resolver. That all four entry points resolve the SAME
// installation is a claim about four processes, so each of them is started for
// real and asked to reach one seeded store through the installation home —
// something none of them could do before — and each is started again with
// conflicting signals and observed to write nothing.

const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '0.1' };

const repo = new URL('..', import.meta.url).pathname;
const account = resolve(userInfo().homedir);
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe('resolving the installation (H-2472)', () => {
  it('leaves the single-install default exactly where it was', () => {
    const i = installation(env({}));
    expect(i.home).toBe(join(homedir(), '.helmo'));
    expect(i.db).toBe(join(homedir(), '.helmo', 'helmo.db'));
    expect(i.source).toBe('derived');
  });

  it('lets either of HELMO_HOME and HELMO_DB determine the other', () => {
    // A bare HELMO_DB is how Rev's roster has always pointed a fleet at its
    // store; nothing already deployed has anything new to set.
    const fromDb = installation(env({ HELMO_DB: '/tmp/customer-a/.helmo/helmo.db' }));
    expect(fromDb.home).toBe('/tmp/customer-a/.helmo');
    expect(fromDb.db).toBe('/tmp/customer-a/.helmo/helmo.db');

    const fromHome = installation(env({ HELMO_HOME: '/tmp/customer-a/.helmo' }));
    expect(fromHome.home).toBe(fromDb.home);
    expect(fromHome.db).toBe(fromDb.db);

    // Both, agreeing, is fine — including a store in a subdirectory of the home.
    expect(installation(env({ HELMO_HOME: '/tmp/customer-a/.helmo', HELMO_DB: '/tmp/customer-a/.helmo/db/helmo.db' })).home)
      .toBe('/tmp/customer-a/.helmo');
  });

  it('refuses when the two name different installations, naming both and the way out', () => {
    const conflicting = env({ HELMO_HOME: '/tmp/customer-a/.helmo', HELMO_DB: '/tmp/customer-b/.helmo/helmo.db' });
    expect(() => installation(conflicting)).toThrow(InstallationError);
    try {
      installation(conflicting);
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('/tmp/customer-a/.helmo');
      expect(message).toContain('/tmp/customer-b/.helmo/helmo.db');
      expect(message).toContain('Unset one');
    }
  });

  it('treats an empty variable as unset rather than as a path', () => {
    expect(installation(env({ HELMO_DB: '', HELMO_HOME: '  ' })).db).toBe(join(homedir(), '.helmo', 'helmo.db'));
    expect(installation(env({ HELMO_LABEL: '', REV_LABEL: '' })).source).toBe('derived');
  });

  it('takes the supervisor\'s name for the installation when Rev started the process', () => {
    // Not a new registry: REV_LABEL is the identity rev:src/service.ts derives
    // and writes into the service environment (H-2452), which everything Rev
    // spawns inherits.
    const supervised = installation(env({ HELMO_DB: '/tmp/customer-a/.helmo/helmo.db', REV_LABEL: 'dev.rev.gp' }));
    expect(supervised.label).toBe('dev.rev.gp');
    expect(supervised.source).toBe('REV_LABEL');

    const overridden = installation(env({ HELMO_LABEL: 'helmo-b', REV_LABEL: 'dev.rev.gp' }));
    expect(overridden.label).toBe('helmo-b');
    expect(overridden.source).toBe('HELMO_LABEL');
  });

  it('keeps the readable name for the conventional homes', () => {
    expect(installation(env({ HELMO_HOME: join(account, '.helmo') })).label).toBe('dev.helmo');
    expect(installation(env({ HELMO_HOME: join(account, '.helmo-gp') })).label).toBe('dev.helmo.gp');
  });

  it('gives two same-basename homes distinct names', () => {
    // The H-2452 defect one level up: deriving an identity from the home's
    // BASENAME is still one identity for many installs.
    const a = installation(env({ HELMO_HOME: '/tmp/customer-a/.helmo' }));
    const b = installation(env({ HELMO_HOME: '/tmp/customer-b/.helmo' }));
    expect(a.label).not.toBe(b.label);
    expect(a.label).toContain('customer-a');
    expect(b.label).toContain('customer-b');
    // Stable across calls — it is a function of the path, not of the run.
    expect(installation(env({ HELMO_HOME: '/tmp/customer-a/.helmo' })).label).toBe(a.label);
  });

  it('is not fooled by a $HOME the software under test could have written', () => {
    // A service manager hands a daemon an environment the install itself wrote,
    // so the conventional-home rule keys on the password database. Claiming a
    // home is "~/.helmo" by setting HOME must not buy the readable name.
    const claimed = installation(env({ HOME: '/tmp/customer-a', HELMO_HOME: '/tmp/customer-a/.helmo' }));
    expect(claimed.label).not.toBe('dev.helmo');
  });
});

// ---- The four entry points, as four processes ----

const ENTRIES = ['src/cli.ts', 'src/server.ts', 'src/view.ts', 'src/remote.ts'] as const;
// Generated, not written: remote.ts demands 24 characters, and a literal long
// enough to satisfy it reads to the publisher's object scan as a credential
// assignment — which refuses the push for the whole repository.
const TOKEN = randomBytes(16).toString('hex');

/** The inherited environment carries this fleet's own HELMO_DB and HELMO_ACTOR;
 *  a case that did not strip them would be testing the estate's installation. */
function spawnEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  const base = { ...process.env };
  for (const k of ['HELMO_DB', 'HELMO_HOME', 'HELMO_LABEL', 'REV_LABEL', 'HELMO_OPERATOR']) delete base[k];
  return { ...base, HELMO_REMOTE_TOKEN: TOKEN, ...vars };
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Spawn an entry point and resolve once its first stdout line arrives. */
function started(file: string, vars: Record<string, string>, extra: string[] = []): Promise<{ child: ChildProcess; line: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', file, ...extra], {
    cwd: repo,
    env: spawnEnv(vars),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${file} printed nothing in 20s`)), 20_000);
    let out = '';
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const nl = out.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      res({ child, line: out.slice(0, nl) });
    });
    child.once('error', rej);
    child.once('exit', (code) => rej(new Error(`${file} exited before printing (${code})`)));
  });
}

describe('every entry point reaches one installation through its home (H-2472)', () => {
  let dir: string;
  let home: string;
  let ticket: string;
  const title = 'Prove the installation home reaches this store';
  const running: ChildProcess[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'helmo-install-'));
    home = join(dir, 'customer-a', '.helmo');
    mkdirSync(home, { recursive: true });
    const s = new Store(join(home, 'helmo.db'));
    ticket = s.createTicket(orch, {
      title,
      body: 'Goal: be found by every entry point given only HELMO_HOME. Current state: seeded.',
      workstream: 'rev-dev',
      type: 'build',
    }).id;
    s.close();
  });
  afterAll(() => {
    for (const c of running) c.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('the CLI reads the seeded ticket, from HELMO_HOME and from HELMO_DB alike', () => {
    for (const vars of [{ HELMO_HOME: home }, { HELMO_DB: join(home, 'helmo.db') }]) {
      const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'get', ticket], {
        cwd: repo,
        env: spawnEnv(vars),
        encoding: 'utf8',
      });
      expect(r.status, `${JSON.stringify(vars)}: ${r.stderr}`).toBe(0);
      expect(JSON.parse(r.stdout).title).toBe(title);
    }
  });

  it('the MCP server serves the seeded ticket', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/server.ts'],
      cwd: repo,
      env: spawnEnv({ HELMO_HOME: home }) as Record<string, string>,
    });
    const client = new Client({ name: 'install-test', version: '0' });
    await client.connect(transport);
    const res = await client.callTool({ name: 'helmo_get_ticket', arguments: { ticket_id: ticket } });
    expect((res.content as { text: string }[])[0]!.text).toContain(title);
    await client.close();
  });

  it('the view serves the seeded ticket and says which installation it read', async () => {
    const { child, line } = await started('src/view.ts', { HELMO_HOME: home, HELMO_VIEW_PORT: '0' });
    running.push(child);
    const port = await new Promise<number>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('the view never reported ready')), 20_000);
      child.on('message', (m) => {
        if (!m || typeof m !== 'object' || (m as { type?: string }).type !== 'helmo-view-ready') return;
        clearTimeout(timer);
        res((m as { port: number }).port);
      });
    });
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain(title);
    expect(line).toContain(`install: ${installation(env({ HELMO_HOME: home })).label}`);
  });

  it('the remote surface serves the seeded ticket and says which installation it read', async () => {
    const port = await freePort();
    const { child, line } = await started('src/remote.ts', { HELMO_HOME: home, HELMO_REMOTE_PORT: String(port) });
    running.push(child);
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'helmo_get_ticket', arguments: { ticket_id: ticket } },
      }),
    });
    expect(await res.text()).toContain(title);
    expect(line).toContain(`install: ${installation(env({ HELMO_HOME: home })).label}`);
  });
});

describe('no entry point opens a store when the environment names two installations (H-2472)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'helmo-conflict-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(ENTRIES)('%s refuses before writing anything', (file) => {
    const home = join(dir, file.replace(/\W/g, '_'), 'customer-a', '.helmo');
    const db = join(dir, file.replace(/\W/g, '_'), 'customer-b', '.helmo', 'helmo.db');
    const r = spawnSync(process.execPath, ['--import', 'tsx', file, 'get', 'H-1'], {
      cwd: repo,
      env: spawnEnv({ HELMO_HOME: home, HELMO_DB: db, HELMO_VIEW_PORT: '0', HELMO_REMOTE_PORT: '0' }),
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(r.status, `${file} should have refused; stdout: ${r.stdout}`).not.toBe(0);
    expect(r.stderr).toContain(home);
    expect(r.stderr).toContain(db);
    // The refusal is the point only if nothing was created on the way to it:
    // an entry point that opened the store first would leave one of these.
    expect(existsSync(db), `${file} created ${db}`).toBe(false);
    expect(existsSync(join(home, 'helmo.db')), `${file} created a store under ${home}`).toBe(false);
    expect(existsSync(home), `${file} created ${home}`).toBe(false);
  });
});
