import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { endedClaimEvidence } from '../src/ended-claim.js';
import { recordLaunchIntent, recordLaunchClaim, recordLaunchDispatch, settleLaunch, launchGroupFile } from '../src/launch-journal.js';
import { stateDir } from '../src/config.js';
describe('ended owner evidence', () => {
  it('admits a reaped synthetic owner and refuses live, missing, failed or later launches', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ended-claim-')); const prior = process.env.REV_HOME; process.env.REV_HOME = home;
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    try {
      await once(child, 'spawn');
      const worker = 'fixture', pid = child.pid!, generation = `rev:fixture:${pid}:17:123`;
      const request = { ticket_id: 'H-fixture', session: 'rev:fixture', generation, expected_updated_at: 'unused', expected_event_seq: 1, hold: { reason: 'pause', provenance: 'fixture', reconsider_when: 'operator' }, body_patch: { old: 'continue', new: 'pause' } };
      writeFileSync(join(stateDir(worker), 'STOP'), 'STOP\n');
      recordLaunchIntent(worker, generation, { claim: true }); recordLaunchClaim(worker, generation, request.ticket_id); recordLaunchDispatch(worker, generation);
      writeFileSync(launchGroupFile(worker, generation), String(pid)); settleLaunch(worker, generation, 'complete');
      const log = `${new Date().toISOString()} run-start    iter=17\n${new Date().toISOString()} run-end      iter=17 rc=0 class=ok\n${new Date().toISOString()} loop-stop    reason=STOP runs=17\n`;
      writeFileSync(join(stateDir(worker), 'events.log'), log);
      expect(() => endedClaimEvidence(worker, request)).toThrow(/live/);
      const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
      expect(endedClaimEvidence(worker, request).proof.worker).toBe(worker);
      // The other strand's precondition refuses here: a worker with no STOP is
      // reconcile-missing-claim's business, and never this command's.
      rmSync(join(stateDir(worker), 'STOP'));
      expect(() => endedClaimEvidence(worker, request)).toThrow(/STOP/);
      writeFileSync(join(stateDir(worker), 'STOP'), 'STOP\n');
      for (const badLog of [log + `${new Date().toISOString()} run-start iter=18\n`, log.replace('rc=0', 'rc=1'), log.replace('reason=STOP', 'reason=drain')]) {
        writeFileSync(join(stateDir(worker), 'events.log'), badLog); expect(() => endedClaimEvidence(worker, request)).toThrow();
      }
      writeFileSync(join(stateDir(worker), 'events.log'), log); rmSync(launchGroupFile(worker, generation));
      expect(() => endedClaimEvidence(worker, request)).toThrow(/missing/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (prior === undefined) delete process.env.REV_HOME; else process.env.REV_HOME = prior;
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('drives the installed Runtime→Work CLI path only in a disposable installation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ended-cli-')), prior = process.env.REV_HOME;
    process.env.REV_HOME = home;
    const work = join(import.meta.dirname, '../../work/dist/cli.js');
    const runtime = join(import.meta.dirname, '../dist/cli.js');
    const env = { ...process.env, HOME: home, REV_HOME: home, HELMO_DB: join(home, 'fixture.db'), HELMO_INSTALLATION: 'ended-fixture' };
    const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
    try {
      const exit = once(child, 'exit'); await once(child, 'spawn'); await exit;
      const generation = `rev:fixture:${child.pid}:17:123`;
      const actor = { name: 'builder', kind: 'agent', model: 'fixture', version: '1', session: 'rev:fixture', generation };
      const created = spawnSync(process.execPath, [work, 'create', '--title', 'Pause fixture', '--body', 'Saved evidence. NEXT: continue.', '--workstream', 'fixture', '--type', 'ops', '--assignee', 'builder', '--status', 'in_progress'], { env: { ...env, HELMO_ACTOR: JSON.stringify(actor) }, encoding: 'utf8' });
      expect(created.status, created.stderr).toBe(0);
      const ticketId = JSON.parse(created.stdout).id;
      const initial = spawnSync(process.execPath, [work, 'get', '--ticket', ticketId], { env, encoding: 'utf8' });
      expect(initial.status, initial.stderr).toBe(0); const ticket = JSON.parse(initial.stdout);
      writeFileSync(join(home, 'roster.toml'), `[global]\nhelmo_cli = ${JSON.stringify(work)}\nhelmo_mcp_server = "/unused"\nhelmo_db = ${JSON.stringify(env.HELMO_DB)}\n[loops.fixture]\nworkstream="fixture"\ncwd=${JSON.stringify(home)}\nruntime="mock"\n`);
      writeFileSync(join(stateDir('fixture'), 'STOP'), 'STOP\n');
      recordLaunchIntent('fixture', generation, { claim: true }); recordLaunchClaim('fixture', generation, ticket.id); recordLaunchDispatch('fixture', generation);
      writeFileSync(launchGroupFile('fixture', generation), String(child.pid)); settleLaunch('fixture', generation, 'complete');
      writeFileSync(join(stateDir('fixture'), 'events.log'), `${new Date().toISOString()} run-start iter=17\n${new Date().toISOString()} run-end iter=17 rc=0 class=ok\n${new Date().toISOString()} loop-stop reason=STOP runs=17\n`);
      const file = join(home, 'operation.json');
      writeFileSync(file, JSON.stringify({ ticket_id: ticket.id, session: 'rev:fixture', generation, expected_updated_at: ticket.updated_at, expected_event_seq: 1,
        hold: { reason: 'Pause fixture', provenance: 'operator fixture', reconsider_when: 'Explicit resume' }, body_patch: { old: 'NEXT: continue.', new: 'PAUSED: explicit resume only.' } }));
      const args = ['reconcile-ended-claim', '--worker', 'fixture', '--record', file, '--installation', 'ended-fixture'];
      const wrong = spawnSync(process.execPath, [runtime, ...args.slice(0, -1), 'foreign'], { env, encoding: 'utf8' }); expect(wrong.status).not.toBe(0);
      const repaired = spawnSync(process.execPath, [runtime, ...args], { env, encoding: 'utf8' });
      expect(repaired.status, repaired.stderr).toBe(0);
      const read = spawnSync(process.execPath, [work, 'get', '--ticket', ticket.id], { env, encoding: 'utf8' }); expect(read.status, read.stderr).toBe(0);
      const after = JSON.parse(read.stdout); expect(after.status).toBe('open'); expect(after.capacity_hold.reason).toBe('Pause fixture'); expect(after.assignee).toBe('builder'); expect(after.body).toContain('Saved evidence. PAUSED');
      expect(readFileSync(join(stateDir('fixture'), 'STOP'), 'utf8')).toBe('STOP\n');
      const replay = spawnSync(process.execPath, [runtime, ...args], { env, encoding: 'utf8' }); expect(replay.status).not.toBe(0);
      const stale = spawnSync(process.execPath, [work, 'update', '--ticket', ticket.id, '--note', 'stale child'], { env: { ...env, HELMO_ACTOR: JSON.stringify(actor) }, encoding: 'utf8' }); expect(stale.status).not.toBe(0); expect(stale.stderr).toContain('stale_generation');
    } finally {
      if (prior === undefined) delete process.env.REV_HOME; else process.env.REV_HOME = prior;
      rmSync(home, { recursive: true, force: true });
    }
  });

});
