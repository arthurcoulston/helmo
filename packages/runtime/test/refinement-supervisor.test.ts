// Real supervisor/roster/protocol entry with disposable state and intercepted access.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const root = resolve(import.meta.dirname, '..');
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 8000) throw new Error('supervisor fixture deadline'); await pause(25); }
}
function fixture(enabled: boolean, empty = false, delay = 0) {
  const home = mkdtempSync(join(tmpdir(), 'rev-refinement-supervisor-'));
  const journal = join(home, 'requests.jsonl'), dir = join(home, 'state', 'supervisor');
  mkdirSync(dir, { recursive: true }); mkdirSync(join(home, 'state', 'stopped'), { recursive: true });
  writeFileSync(join(home, 'state', 'stopped', 'STOP'), 'fixture');
  const preload = join(home, 'access.mjs');
  writeFileSync(preload, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const original = cp.execFileSync;
cp.execFileSync = (file, args, options) => {
  if (file === 'ps' && args[0] === '-o' && args[1] === 'ppid=') return original(file, args, options);
  if (file === '/usr/bin/security' && args.join(' ') === 'find-generic-password -s plumb-intake-executor-secret -w') return 'NOT_A_REAL_SECRET';
  throw new Error('fixture refused command');
};
syncBuiltinESMExports();
globalThis.fetch = async (input, init) => {
  const u = new URL(String(input));
  if (u.origin !== 'http://localhost:9876' || !/^\\/api\\/(intake-preparation|refinement-commit|refinement-preparation)\\/(claim|result)$/.test(u.pathname)) throw new Error('fixture refused request');
  appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ path: u.pathname, body: JSON.parse(init.body) }) + '\\n');
  if (u.pathname.endsWith('/result')) { await new Promise(r => setTimeout(r, ${delay})); return new Response('{}', {status:200}); }
  return new Response(null, {status:204});
};`);
  const runner = join(home, 'run.ts');
  writeFileSync(runner, `import { loadRoster } from ${JSON.stringify(join(root, 'src/config.ts'))};
import { runFleet } from ${JSON.stringify(join(root, 'src/supervisor.ts'))};
const r = loadRoster(); runFleet(r.global, r.loops).then(code => process.exit(code));`);
  writeFileSync(join(home, 'roster.toml'), `[global]
helmo_cli = "fixture-unused"
helmo_mcp_server = "fixture-unused"
poll_seconds = 0.1
usage_poll_seconds = 0
intake_preparation_origin = "http://localhost:9876"
intake_preparation_checkout = "${home}"
refinement_preparation_enabled = ${enabled}
refinement_preparation_source = "${join(home, 'source')}"
refinement_preparation_base_ref = "${'a'.repeat(40)}"
refinement_preparation_work_root = "${join(home, 'artifacts')}"
refinement_preparation_sync_script = "${join(home, 'sync.mjs')}"
refinement_preparation_scan_script = "${join(home, 'scan.mjs')}"
${empty ? '' : `[loops.stopped]\nworkstream = "fixture"\ncwd = "${home}"\nruntime = "mock"\nmock_cmd = "false"`}`);
  const start = () => {
    let out = '';
    const child = spawn(process.execPath, ['--import', preload, '--import', 'tsx', runner], { cwd: root, env: { ...process.env, REV_HOME: home, REV_RELEASE_SELECTION: '' } });
    child.stdout.on('data', b => out += b); child.stderr.on('data', b => out += b);
    const exit = new Promise<number | null>(r => child.on('exit', r));
    return { child, exit, out: () => out };
  };
  const requests = () => existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  return { home, dir, start, requests };
}
describe('supervisor refinement opt-in lifecycle', () => {
  it('opt-out runs existing pulls without provider preparation or resuming STOP', async () => {
    const f = fixture(false), p = f.start();
    try {
      await until(() => f.requests().length >= 4);
      expect(f.requests().some(r => r.path.includes('refinement-preparation'))).toBe(false);
      expect(existsSync(join(f.home, 'state/stopped/RUNNING'))).toBe(false);
      p.child.kill('SIGTERM'); expect(await p.exit).toBe(0);
    } finally { p.child.kill('SIGKILL'); }
  });
  it('opt-in polls idle state with closed observation and stops on drain', async () => {
    const f = fixture(true), p = f.start();
    try {
      const last = join(f.dir, 'refinement-preparation-last.json'); await until(() => existsSync(last));
      expect(JSON.parse(readFileSync(last, 'utf8'))).toMatchObject({ result: 'idle', claim: 204, owner: 'builder' });
      expect(f.requests().some(r => r.path.includes('refinement-preparation'))).toBe(true);
      p.child.kill('SIGTERM'); expect(await p.exit).toBe(0);
      const count = f.requests().length; await pause(250); expect(f.requests().length).toBe(count);
      expect(existsSync(join(f.home, 'state/stopped/RUNNING'))).toBe(false);
    } finally { p.child.kill('SIGKILL'); }
  });
  it('restart reconciles verified receipt; drain waits for delivery without new claims', async () => {
    const f = fixture(true, false, 500), state = join(f.dir, 'refinement-preparation.json');
    const a = { gitRef: 'c'.repeat(40), promptHash: 'd'.repeat(64) };
    writeFileSync(state, JSON.stringify({ target: { origin: 'http://localhost:9876', executorId: 'goodplumb-rev', executorVersion: '1', baseRef: 'a'.repeat(40) },
      envelope: { identity: 'job-1', orgId: 'org_a', projectId: 'project_a', orgSlug: 'test-org', projectSlug: 'test-project', meetingId: 'booking:2026-10-13T20:00:00.000Z', directiveVersionId: 'version_a', contentHash: 'a'.repeat(64), feedbackSha256: 'b'.repeat(64), attemptId: 'attempt-1', attemptCount: 1, leaseExpiresAt: '2026-10-13T21:00:00.000Z', providerPublicationDecisionRef: 'H-1523@dev.helmo.gp' },
      artifact: a, receipt: { ...a, agentId: 'agent_refinement_000000001' }, verified: true, refusals: 0 }));
    // A changed configured artifact base must not deliver a previously verified receipt.
    const saved = readFileSync(state, 'utf8');
    writeFileSync(state, saved.replace('"baseRef":"' + 'a'.repeat(40), '"baseRef":"' + 'b'.repeat(40)));
    const changed = f.start();
    try {
      await until(() => existsSync(join(f.dir, 'events.log')) && readFileSync(join(f.dir, 'events.log'), 'utf8').includes('refinement-preparation-error'));
      changed.child.kill('SIGTERM'); expect(await changed.exit).toBe(0);
      expect(f.requests().some(r => r.path.includes('refinement-preparation'))).toBe(false);
      expect(readFileSync(state, 'utf8')).not.toBe(saved);
    } finally { changed.child.kill('SIGKILL'); }
    writeFileSync(state, saved);
    const p = f.start();
    try {
      await until(() => f.requests().some(r => r.path.endsWith('/refinement-preparation/result')));
      p.child.kill('SIGTERM'); await pause(100); expect(p.child.exitCode).toBeNull();
      expect(await p.exit).toBe(0); expect(existsSync(state)).toBe(false);
      expect(f.requests().filter(r => r.path.includes('refinement-preparation')).map(r => r.path)).toEqual(['/api/refinement-preparation/result']);
      expect(readFileSync(join(f.dir, 'events.log'), 'utf8')).toContain('result=bound');
    } finally { p.child.kill('SIGKILL'); }
  });
  it('corrupt retained state logs a closed owned error without leaking contents', async () => {
    const f = fixture(true), pState = join(f.dir, 'refinement-preparation.json');
    writeFileSync(pState, 'PRIVATE_SENTINEL malformed');
    const p = f.start();
    try {
      const log = join(f.dir, 'events.log');
      await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('refinement-preparation-error'));
      expect(readFileSync(log, 'utf8')).not.toContain('PRIVATE_SENTINEL');
      expect(p.out()).not.toContain('PRIVATE_SENTINEL');
      expect(readFileSync(pState, 'utf8')).toBe('PRIVATE_SENTINEL malformed');
      p.child.kill('SIGTERM'); expect(await p.exit).toBe(0);
    } finally { p.child.kill('SIGKILL'); }
  });
  it('invalid enabled config refuses before RUNNING or any access', async () => {
    const f = fixture(true), roster = join(f.home, 'roster.toml');
    writeFileSync(roster, readFileSync(roster, 'utf8').replace('a'.repeat(40), 'moving-main'));
    const p = f.start();
    try {
      expect(await p.exit).toBe(1); expect(f.requests()).toEqual([]);
      expect(existsSync(join(f.dir, 'RUNNING'))).toBe(false);
      expect(p.out()).toContain('Invalid refinement preparation configuration');
      expect(p.out()).not.toContain('moving-main');
    } finally { p.child.kill('SIGKILL'); }
  });
  it('empty roster exits without polls or timers even opted in', async () => {
    const f = fixture(true, true), p = f.start();
    try { expect(await p.exit).toBe(0); expect(f.requests()).toEqual([]); }
    finally { p.child.kill('SIGKILL'); }
  });
});
