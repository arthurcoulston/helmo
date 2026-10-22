import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { missingClaimEvidence } from '../src/missing-claim.js';
import { recordLaunchIntent, recordLaunchClaim, recordLaunchDispatch, settleLaunch, launchGroupFile } from '../src/launch-journal.js';
import { stateDir } from '../src/config.js';
import { HELMO_STORE, HELMO_ROOT } from './helmo.js';
import { testEnv } from '../../../scripts/test-env.mjs';

describe('missing-claim ended-session evidence', () => {
  it('runs inspection, repair, external read and fresh claim through the compiled CLIs in a disposable installation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'missing-cli-')), prior = process.env.REV_HOME;
    process.env.REV_HOME = home;
    const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
    try {
      const exited = once(child, 'exit'); await once(child, 'spawn'); await exited;
      const generation = `rev:fixture:${child.pid}:17:123`, worker = 'fixture';
      const actor = { name: 'builder', kind: 'agent', model: 'fixture', version: '1', session: 'rev:fixture', generation };
      const db = join(home, 'synthetic.db'), work = join(HELMO_ROOT, 'dist/cli.js'), runtime = join(import.meta.dirname, '../dist/cli.js');
      const { Store } = await import(HELMO_STORE);
      const store = new Store(db);
      const ticket = store.createTicket({ name: 'planner', kind: 'orchestrator', model: 'fixture', version: '1' }, { title: 'Stranded fixture', body: 'Frozen source retained', workstream: 'fixture', type: 'build', assignee: 'builder', lane: 'copy' });
      store.launchClaim(actor, 'fixture', 'builder', generation, undefined, undefined, undefined, 'copy');
      store.updateTicket(actor, { ticket_id: ticket.id, status: 'in_progress', note: 'Legacy checkpoint' });
      store['endExecution'](ticket.id, 'status:in_progress', new Date().toISOString()); store.close();
      writeFileSync(join(home, 'roster.toml'), `[global]\nhelmo_cli=${JSON.stringify(work)}\nhelmo_mcp_server="/unused"\nhelmo_db=${JSON.stringify(db)}\n[loops.fixture]\nseat="builder"\nworkstream="fixture"\nlane="copy"\ncwd=${JSON.stringify(home + '/one')}\nruntime="mock"\n[loops.sibling]\nseat="builder"\nworkstream="fixture"\nlane="sibling"\ncwd=${JSON.stringify(home + '/two')}\nruntime="mock"\n`);
      const cmd = execFileSync('ps', ['-ww', '-p', String(process.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
      writeFileSync(join(stateDir(worker), 'RUNNING'), `${process.pid}\ncmd ${cmd}\n`);
      writeFileSync(join(stateDir(worker), 'IDLE'), '1\nNo executable work\n');
      const start = `${new Date().toISOString()} run-start iter=17\n`;
      recordLaunchIntent(worker, generation, { claim: true }); recordLaunchClaim(worker, generation, ticket.id); recordLaunchDispatch(worker, generation);
      writeFileSync(launchGroupFile(worker, generation), String(child.pid)); settleLaunch(worker, generation, 'complete');
      writeFileSync(join(stateDir(worker), 'events.log'), `${start}${new Date().toISOString()} run-end iter=17 rc=0 class=ok\n`);
      // Exercise isolation even when the outer suite has already scrubbed the runner.
      const inherited = { ...process.env, REV_LABEL: 'inherited-live', HELMO_REQUIRE_BINDING: '1', HELMO_BINDING: '/unused-live-binding' };
      const file = join(home, 'request.json'), env = { ...testEnv(inherited, { home }), HOME: home, HELMO_DB: db, HELMO_INSTALLATION: 'missing-fixture' };
      writeFileSync(file, JSON.stringify({ ticket_id: ticket.id, session: actor.session, generation }));
      const args = ['--worker', worker, '--record', file, '--installation', 'missing-fixture'];
      const inspect = spawnSync(process.execPath, [runtime, 'inspect-missing-claim', ...args], { env, encoding: 'utf8' });
      expect(inspect.status, inspect.stderr).toBe(0);
      writeFileSync(file, inspect.stdout);
      const roster = readFileSync(join(home, 'roster.toml'), 'utf8');
      writeFileSync(join(home, 'roster.toml'), `[global]\nhelmo_cli=${JSON.stringify(work)}\nhelmo_mcp_server="/unused"\nhelmo_db=${JSON.stringify(db)}\n[loops.fixture]\nseat="builder"\nworkstream="fixture"\ncwd=${JSON.stringify(home + '/one')}\nruntime="mock"\n`);
      const unpooled = spawnSync(process.execPath, [runtime, 'reconcile-missing-claim', ...args], { env, encoding: 'utf8' });
      expect(unpooled.status).not.toBe(0); expect(unpooled.stderr).toContain('journaled pool worker');
      const unchanged = spawnSync(process.execPath, [work, 'get', '--ticket', ticket.id], { env, encoding: 'utf8' });
      expect(JSON.parse(unchanged.stdout).status).toBe('in_progress');
      writeFileSync(join(home, 'roster.toml'), roster);
      const wrong = spawnSync(process.execPath, [runtime, 'reconcile-missing-claim', ...args.slice(0, -1), 'foreign'], { env, encoding: 'utf8' }); expect(wrong.status).not.toBe(0);
      const repair = spawnSync(process.execPath, [runtime, 'reconcile-missing-claim', ...args], { env, encoding: 'utf8' }); expect(repair.status, repair.stderr).toBe(0);
      const read = spawnSync(process.execPath, [work, 'get', '--ticket', ticket.id], { env, encoding: 'utf8' }); expect(read.status, read.stderr).toBe(0);
      expect(JSON.parse(read.stdout)).toMatchObject({ status: 'open', assignee: 'builder', lane: 'copy', body: ticket.body });
      const next = { ...actor, generation: `rev:fixture:${process.pid}:18:456` };
      const claim = spawnSync(process.execPath, [work, 'launch-claim', '--workstream', 'fixture', '--assignee', 'builder', '--launch-id', next.generation, '--lane', 'copy'], { env: { ...env, HELMO_ACTOR: JSON.stringify(next) }, encoding: 'utf8' });
      expect(claim.status, claim.stderr).toBe(0); expect(JSON.parse(claim.stdout)).toMatchObject({ admitted: true, claimed: true, ticket_id: ticket.id });
      const old = spawnSync(process.execPath, [work, 'update', '--ticket', ticket.id, '--note', 'Old writer'], { env: { ...env, HELMO_ACTOR: JSON.stringify(actor) }, encoding: 'utf8' }); expect(old.status).not.toBe(0); expect(old.stderr).toContain('stale_generation');
    } finally {
      if (prior === undefined) delete process.env.REV_HOME; else process.env.REV_HOME = prior;
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('admits a clean historical session on an idle live worker, refuses holds, live children and new intents', async () => {
    const home = mkdtempSync(join(tmpdir(), 'missing-claim-')), prior = process.env.REV_HOME;
    process.env.REV_HOME = home;
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    try {
      await once(child, 'spawn');
      const worker = 'fixture', pid = child.pid!, generation = `rev:fixture:${pid}:17:123`;
      const request = { ticket_id: 'H-fixture', session: 'rev:fixture', generation, expected_updated_at: 'unused', expected_event_seq: 1, expected_worker_launch_id: generation };
      const cmd = execFileSync('ps', ['-ww', '-p', String(process.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
      writeFileSync(join(stateDir(worker), 'RUNNING'), `${process.pid}\ncmd ${cmd}\n`);
      writeFileSync(join(stateDir(worker), 'IDLE'), '1\nNo executable work\n');
      const start = `${new Date().toISOString()} run-start iter=17\n`;
      recordLaunchIntent(worker, generation, { claim: true }); recordLaunchClaim(worker, generation, request.ticket_id); recordLaunchDispatch(worker, generation);
      writeFileSync(launchGroupFile(worker, generation), String(pid)); settleLaunch(worker, generation, 'complete');
      const log = `${start}${new Date().toISOString()} run-end iter=17 rc=0 class=ok\n${new Date().toISOString()} run-start iter=18\n${new Date().toISOString()} run-end iter=18 rc=0 class=ok\n`;
      writeFileSync(join(stateDir(worker), 'events.log'), log);
      expect(() => missingClaimEvidence(worker, request)).toThrow(/live/);
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
      const evidence = missingClaimEvidence(worker, request);
      expect(evidence.proof.worker).toBe(worker); expect(evidence.snapshot).toHaveLength(64);
      for (const control of ['STOP', 'HOLD', 'BLOCKED.json']) {
        writeFileSync(join(stateDir(worker), control), 'preserve');
        expect(() => missingClaimEvidence(worker, request)).toThrow(/hold/);
        expect(readFileSync(join(stateDir(worker), control), 'utf8')).toBe('preserve');
        rmSync(join(stateDir(worker), control));
      }
      writeFileSync(join(stateDir(worker), 'events.log'), log.replace('rc=0', 'rc=1'));
      expect(() => missingClaimEvidence(worker, request)).toThrow(/clean/);
      writeFileSync(join(stateDir(worker), 'events.log'), log);
      recordLaunchIntent(worker, 'rev:fixture:456:19:456', { claim: true });
      expect(() => missingClaimEvidence(worker, request)).toThrow(/Unsettled/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (prior === undefined) delete process.env.REV_HOME; else process.env.REV_HOME = prior;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
