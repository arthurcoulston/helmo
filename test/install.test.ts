import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installation, InstallationError, requestedInstallation, requireInstallation } from '../src/install.js';
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

// ---- H-2474: the target named, and asserted ----
//
// H-2472 gave the installation a name; what was still missing is the discipline
// of saying it and of checking an operator's assertion against it. The three
// things that have to be true: the name is in what a surface prints, an
// agreeing assertion changes nothing, and a disagreeing one stops the command
// BEFORE the store is opened — which is a claim about a file that must not
// appear, not about an exit code.

describe('the assertion as a service definition passes it (H-2474)', () => {
  it('takes either spelling, and reads a bare flag as an assertion of nothing', () => {
    expect(requestedInstallation([])).toBeUndefined();
    expect(requestedInstallation(['--installation', 'dev.helmo.gp'])).toBe('dev.helmo.gp');
    expect(requestedInstallation(['--installation=dev.helmo.gp'])).toBe('dev.helmo.gp');
    // Not undefined: a flag written with no value must refuse rather than read
    // as never passed (H-1782). The refusal itself is the next block's.
    expect(requestedInstallation(['--installation'])).toBe('');
    expect(requestedInstallation(['--installation', '--other'])).toBe('');
  });
});

describe('--installation asserts the target and cannot move it (H-2474)', () => {
  const home = '/tmp/customer-a/.helmo';
  const resolved = installation(env({ HELMO_HOME: home }));

  /** The message the entry point would have printed, or null if it proceeded. */
  function assertOn(requested?: string): string | null {
    try {
      requireInstallation(env({ HELMO_HOME: home }), (m) => { throw new InstallationError(m); }, requested);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  it('lets through the three spellings an operator has in front of them', () => {
    expect(assertOn(undefined)).toBeNull();
    for (const want of [resolved.label, resolved.home, `${resolved.home}/`, resolved.db]) {
      expect(assertOn(want), `rejected ${want}`).toBeNull();
    }
  });

  it('refuses a value naming another installation, naming both and the knob that moves the target', () => {
    const m = assertOn('dev.helmo.somewhere-else');
    expect(m).toContain("'dev.helmo.somewhere-else'");
    expect(m).toContain(resolved.label);
    expect(m).toContain(resolved.db);
    expect(m).toContain('cannot move it');
    expect(m).toContain('HELMO_HOME');
  });

  it('refuses an assertion of nothing', () => {
    expect(assertOn('')).toContain('given no value');
  });
});

describe('the CLI names the installation it used, in a result and in a refusal (H-2474)', () => {
  let dir: string;
  let home: string;
  let ticket: string;
  const title = 'Name the installation this result came from';

  const cli = (args: string[], vars: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: repo,
      env: spawnEnv(vars),
      encoding: 'utf8',
      timeout: 30_000,
    });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'helmo-target-'));
    home = join(dir, 'customer-a', '.helmo');
    mkdirSync(home, { recursive: true });
    const s = new Store(join(home, 'helmo.db'));
    ticket = s.createTicket(orch, {
      title,
      body: 'Goal: be read back with its installation named. Current state: seeded.',
      workstream: 'rev-dev',
      type: 'build',
    }).id;
    s.close();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('carries the installation in the result without disturbing the payload', () => {
    const r = cli(['get', ticket], { HELMO_HOME: home });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { title: string; installation: { label: string; home: string; db: string } };
    expect(out.title).toBe(title);
    expect(out.installation.label).toBe(installation(env({ HELMO_HOME: home })).label);
    expect(out.installation.home).toBe(home);
    expect(out.installation.db).toBe(join(home, 'helmo.db'));
  });

  it('carries it in a refusal, where a caller most needs to know which store said no', () => {
    const r = cli(['get', 'H-999999'], { HELMO_HOME: home });
    expect(r.status).not.toBe(0);
    const err = JSON.parse(r.stderr) as { error: string; installation: { home: string } };
    expect(err.error).toBeTruthy();
    expect(err.installation.home).toBe(home);
  });

  it('proceeds unchanged when the assertion agrees — including on a write', () => {
    const label = installation(env({ HELMO_HOME: home })).label;
    const r = cli([
      'update', '--ticket', ticket, '--note', 'The assertion agreed, so nothing changed about the write.',
      '--installation', label, '--actor', JSON.stringify(orch),
    ], { HELMO_HOME: home });
    expect(r.status, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { id: string }).id).toBe(ticket);
  });

  it('refuses a write whose assertion disagrees, before the store is opened', () => {
    const fresh = join(dir, 'customer-b', '.helmo');
    mkdirSync(fresh, { recursive: true });
    const r = cli([
      'create', '--title=A write that must never land', '--body=If this store exists, the check ran too late.',
      '--workstream', 'rev-dev', '--type', 'build',
      '--installation', 'dev.helmo.somewhere-else', '--actor', JSON.stringify(orch),
    ], { HELMO_HOME: fresh });
    expect(r.status, `should have refused; stdout: ${r.stdout}`).not.toBe(0);
    const err = JSON.parse(r.stderr) as { error: string };
    expect(err.error).toContain('dev.helmo.somewhere-else');
    expect(err.error).toContain(installation(env({ HELMO_HOME: fresh })).label);
    // The store the command would have written to was never even created.
    expect(existsSync(join(fresh, 'helmo.db')), 'the store was opened before the target was checked').toBe(false);
  });
});

describe('no entry point opens a store when the assertion names another installation (H-2474)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'helmo-assert-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(ENTRIES)('%s refuses before writing anything', (file) => {
    const home = join(dir, file.replace(/\W/g, '_'), 'customer-a', '.helmo');
    const r = spawnSync(process.execPath, ['--import', 'tsx', file, 'get', 'H-1', '--installation', 'dev.helmo.somewhere-else'], {
      cwd: repo,
      env: spawnEnv({ HELMO_HOME: home, HELMO_VIEW_PORT: '0', HELMO_REMOTE_PORT: '0' }),
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(r.status, `${file} should have refused; stdout: ${r.stdout}`).not.toBe(0);
    expect(r.stderr).toContain('dev.helmo.somewhere-else');
    expect(existsSync(join(home, 'helmo.db')), `${file} created a store under ${home}`).toBe(false);
    expect(existsSync(home), `${file} created ${home}`).toBe(false);
  });
});

describe('the store owns its explicitly named installation (H-2487)', () => {
  it('claims atomically on the first mutation and refuses another inherited name without changing records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helmo-store-identity-'));
    const path = join(dir, 'helmo.db');
    const first = new Store(path, { label: 'dev.rev.personal', source: 'REV_LABEL' });
    expect(first.installationIdentity()).toEqual({ process: 'dev.rev.personal', stored: null, clear: true });
    const ticket = first.createTicket(orch, { title: 'Named store', body: 'The first mutation owns the name.', workstream: 'rev-dev', type: 'build' });
    expect(first.installationIdentity()).toEqual({ process: 'dev.rev.personal', stored: 'dev.rev.personal', clear: true });
    first.close();

    const wrong = new Store(path, { label: 'dev.rev.gp', source: 'REV_LABEL' });
    expect(wrong.getTicket(ticket.id).title).toBe('Named store');
    expect(wrong.installationIdentity()).toEqual({ process: 'dev.rev.gp', stored: 'dev.rev.personal', clear: false });
    expect(() => wrong.updateTicket(orch, { ticket_id: ticket.id, note: 'must not land' })).toThrow(/UNCLEAR.*dev\.rev\.gp.*dev\.rev\.personal/);
    expect(wrong.getTicket(ticket.id).updated_at).toBe(ticket.updated_at);
    wrong.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not give a derived-only store a durable name', () => {
    const store = new Store(':memory:', { label: 'dev.helmo', source: 'derived' });
    store.createTicket(orch, { title: 'Old single install', body: 'Derived use stays unnamed.', workstream: 'rev-dev', type: 'build' });
    expect(store.installationIdentity()).toEqual({ process: 'dev.helmo', stored: null, clear: true });
    store.close();
  });
});
