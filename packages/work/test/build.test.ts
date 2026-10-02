import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, digestOf, readStamp, snapshot, Snapshot } from '../src/build.js';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

// H-2490. Every Helmo surface could say WHICH installation it served (H-2474)
// and none could say which BUILD of Helmo was serving it. Reading that off the
// artifact is the H-2432 mistake: on 2026-09-30 dist/store.js had been rebuilt
// at 06:40 under a dashboard that started the evening before, so the commit
// beside the code was the one answer certainly wrong about the process.
//
// Two claims have to hold, and only one of them can be tested by calling a
// function. That the RULE is right — a changed directory is stale, and the
// commit reported is the loaded one — is the first half. That a live surface
// actually reports it, and keeps reporting the build it loaded after the
// directory changes underneath it, is a claim about a process: so a real
// compiled Helmo is started, rebuilt beneath itself, and asked again.

const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '0.1' };
const repo = new URL('..', import.meta.url).pathname;

describe('the identity of what a process can load (H-2490)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'helmo-digest-'));
    writeFileSync(join(dir, 'a.js'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'b.mjs'), 'export const b = 2;\n');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'c.js'), 'export const c = 3;\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('ignores what no process executes: the stamp and the type declarations', () => {
    const before = digestOf(dir);
    writeFileSync(join(dir, 'BUILD.json'), JSON.stringify({ commit: 'a'.repeat(40), dirty: false, built_at: new Date().toISOString() }));
    writeFileSync(join(dir, 'a.d.ts'), 'export declare const a: number;\n');
    expect(digestOf(dir)).toBe(before);
  });

  it('moves when a byte a process would execute moves', () => {
    const before = digestOf(dir);
    appendFileSync(join(dir, 'sub', 'c.js'), '// rebuilt\n');
    expect(digestOf(dir)).not.toBe(before);
  });

  it('is null where there is no javascript to read, rather than an empty answer', () => {
    expect(digestOf(join(dir, 'nowhere'))).toBeNull();
    const empty = mkdtempSync(join(tmpdir(), 'helmo-digest-empty-'));
    expect(digestOf(empty)).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });

  it('reads the stamp beside the code, and refuses a half-written one', () => {
    expect(readStamp(dir)?.commit).toBe('a'.repeat(40));
    writeFileSync(join(dir, 'BUILD.json'), JSON.stringify({ dirty: false }));
    expect(readStamp(dir)).toBeNull();
  });
});

describe('a surface reports what it loaded, never what is on disk now (H-2490)', () => {
  const stamped = (commit: string, dirty = false): Snapshot => ({
    dir: '/p/helmo/dist', digest: 'aaaaaaaaaaaa', stamp: { commit, dirty, built_at: '2026-09-30T06:40:49.000Z' },
  });

  it('calls a match verified and names the commit', () => {
    const r = compare(stamped('c111bf5'), stamped('c111bf5'));
    expect(r.state).toBe('verified');
    expect(r.commit).toBe('c111bf5');
  });

  it('reports the loaded commit on divergence, and the new one only as what is NOT running', () => {
    // The H-2432 shape exactly: the artifact is rebuilt under a live process.
    const rebuilt: Snapshot = { ...stamped('9999999'), digest: 'bbbbbbbbbbbb' };
    const r = compare(stamped('c111bf5'), rebuilt);
    expect(r.state).toBe('stale');
    expect(r.commit).toBe('c111bf5');
    expect(r.detail).toContain('9999999');
    expect(r.detail).toContain('is not running what is there');
  });

  it('says a dirty build does not certify itself', () => {
    expect(compare(stamped('c111bf5', true), stamped('c111bf5', true)).detail).toContain('does not certify');
  });

  it('names no commit for code that carries no stamp', () => {
    const bare: Snapshot = { dir: '/p/helmo/dist', digest: 'aaaaaaaaaaaa', stamp: null };
    const r = compare(bare, bare);
    expect(r.state).toBe('unstamped');
    expect(r.commit).toBeNull();
  });

  it('calls unreadable code unverifiable rather than guessing either way', () => {
    // Two different silences. A process that never took the reading, and a
    // process whose directory holds no javascript at all — which is what
    // running from source under tsx looks like. Neither is "stale": nothing
    // changed, and nothing can be confirmed.
    expect(compare(null, snapshot()).state).toBe('unverifiable');
    const source: Snapshot = { dir: '/p/helmo/src', digest: null, stamp: null };
    const r = compare(source, source);
    expect(r.state).toBe('unverifiable');
    expect(r.detail).toContain('nothing can confirm');
  });

  it('calls a directory that has gone away stale, not verified', () => {
    const gone: Snapshot = { dir: '/p/helmo/dist', digest: null, stamp: null };
    expect(compare(stamped('c111bf5'), gone).state).toBe('stale');
  });
});

// ---- The live half: a real compiled Helmo, rebuilt underneath itself ----
//
// Compiled INTO THE REPO (.build-test/, gitignored) rather than a temp
// directory, because an ESM import of better-sqlite3 resolves by walking up
// from the file, and because dist/ is loaded by consumers this session must
// not touch (H-2435). Never `npm run build` here.

describe('a live surface asked after a rebuild says STALE (H-2490)', () => {
  let out: string;
  let home: string;
  let ticket: string;
  const title = 'Prove the dashboard says what it is running';
  const LOADED_COMMIT = '1111111111111111111111111111111111111111';
  const REBUILT_COMMIT = '9999999999999999999999999999999999999999';
  const running: ChildProcess[] = [];
  let port = 0;

  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => {
    const base = { ...process.env };
    for (const k of ['HELMO_DB', 'HELMO_HOME', 'HELMO_INSTALLATION', 'HELMO_LABEL', 'REV_LABEL', 'HELMO_OPERATOR']) delete base[k];
    return { ...base, ...vars };
  };
  const stamp = (commit: string) =>
    writeFileSync(join(out, 'BUILD.json'), JSON.stringify({ repo, commit, dirty: false, built_at: new Date().toISOString() }));

  beforeAll(async () => {
    mkdirSync(join(repo, '.build-test'), { recursive: true });
    out = mkdtempSync(join(repo, '.build-test', 'run-'));
    const tsc = spawnSync('npx', ['tsc', '--outDir', out], { cwd: repo, encoding: 'utf8' });
    expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0);
    stamp(LOADED_COMMIT);

    home = mkdtempSync(join(tmpdir(), 'helmo-running-'));
    const s = new Store(join(home, 'helmo.db'));
    ticket = s.createTicket(orch, { title, body: 'Goal: be served by a process that can say what it loaded.', workstream: 'helmo-dev', type: 'build' }).id;
    s.close();

    const child = spawn(process.execPath, [join(out, 'view.js')], {
      cwd: repo,
      env: env({ HELMO_HOME: home, HELMO_VIEW_PORT: '0' }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    running.push(child);
    port = await new Promise<number>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('the view never reported ready')), 20_000);
      child.on('message', (m) => {
        if (!m || typeof m !== 'object' || (m as { type?: string }).type !== 'helmo-view-ready') return;
        clearTimeout(timer);
        res((m as { port: number }).port);
      });
      child.once('exit', (code) => rej(new Error(`the view exited before serving (${code})`)));
    });
  }, 60_000);

  afterAll(() => {
    for (const c of running) c.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
    rmSync(join(repo, '.build-test'), { recursive: true, force: true });
  });

  it('names the installation and the build it loaded while that is still true', async () => {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain(title);
    expect(html).toContain('build 1111111');
    expect(html).not.toContain('STALE');
  });

  it('keeps reporting the build it loaded after the directory is rebuilt under it', async () => {
    // The rebuild H-2432 was: the artifact moves, the process does not.
    appendFileSync(join(out, 'presentation.js'), '\n// rebuilt underneath the running view\n');
    stamp(REBUILT_COMMIT);

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain('STALE');
    // The loaded commit stays on the line: it is the only one that describes
    // this process, and a reader needs to know WHICH build went stale.
    expect(html).toContain('build 1111111 STALE');
    // The commit beside the code is the one answer that is certainly wrong
    // about this process, so it may not appear as what it is running.
    expect(html).not.toContain('build 9999999');
    expect(html).toContain(title); // and the dashboard still serves
  });

  it('a CLI started after the rebuild reports the build IT loaded, which is the new one', () => {
    const r = spawnSync(process.execPath, [join(out, 'cli.js'), 'get', ticket], { cwd: repo, env: env({ HELMO_HOME: home }), encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as { installation: { label: string; running: { state: string; commit?: string } } };
    expect(parsed.installation.label).toBeTruthy();
    expect(parsed.installation.running.state).toBe('verified');
    expect(parsed.installation.running.commit).toBe(REBUILT_COMMIT);
  });

  it('the MCP server names its installation and its build on stderr, leaving stdout to the protocol', async () => {
    const child = spawn(process.execPath, [join(out, 'server.js')], { cwd: repo, env: env({ HELMO_HOME: home }), stdio: ['pipe', 'pipe', 'pipe'] });
    running.push(child);
    const line = await new Promise<string>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('the MCP server printed nothing in 20s')), 20_000);
      let buf = '';
      child.stderr!.on('data', (d: Buffer) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        res(buf.slice(0, nl));
      });
    });
    expect(line).toContain('install: ');
    expect(line).toContain('running: 9999999');
  }, 30_000);
});
