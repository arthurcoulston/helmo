// Pool workers (H-574): several roster loops sharing one accountable seat,
// each launching only on a ticket Helmo claimed for it atomically. Real store,
// real helm-cli, mock runtime — the claim race, the binding of a session to
// its ticket, and every path that must put a claim back down.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELMO_CLI as HELM_CLI, HELMO_SERVER, HELMO_STORE } from './helmo.js';
import { loadRoster } from '../src/config.js';
import { launchClaim } from '../src/helm.js';
import { recordLaunchIntent } from '../src/launch-journal.js';

const { Store } = await import(HELMO_STORE);

const REV_CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

interface Env { home: string; db: string; env: NodeJS.ProcessEnv }

// The bound ticket is read back out of the prompt, which is the only place a
// real model session learns it.
const BOUND = `T=$(printf '%s' "$REV_PROMPT" | grep -oE '(claimed|resumed) ticket H-[0-9]+' | grep -oE 'H-[0-9]+'); echo "$REV_LOOP $T" >> $REV_HOME/bound`;
const FINISH = `node ${HELM_CLI} update --ticket $T --note "done by $REV_LOOP" --status done --evidence-kind other --evidence-ref pool`;

function worker(name: string, home: string, mock: string, extra = ''): string {
  return `[loops.${name}]
seat = "builder"
workstream = "rev-test"
cwd = "${join(home, name)}"
runtime = "mock"
mock_cmd = '''
${mock}
'''
${extra}`;
}

function setup(loops: (home: string) => string, cli = HELM_CLI): Env {
  const home = mkdtempSync(join(tmpdir(), 'rev-pool-'));
  const db = join(home, 'helm.db');
  for (const w of ['w1', 'w2', 'w3', 'w4']) mkdirSync(join(home, w), { recursive: true });
  writeFileSync(join(home, 'roster.toml'), `[global]
helmo_cli = "${cli}"
helmo_mcp_server = "${HELMO_SERVER}"
helmo_db = "${db}"
poll_seconds = 0.1
fail_cap = 1
wedge_cap = 3
usage_poll_seconds = 0
${loops(home)}`);
  return { home, db, env: { ...process.env, REV_HOME: home, HELMO_DB: db } };
}

function helm(e: Env, args: string[]): Record<string, unknown> {
  return JSON.parse(execFileSync('node', [HELM_CLI, ...args], {
    env: { ...e.env, HELMO_ACTOR: '{"name":"seeder","kind":"agent","model":"t","version":"0"}' }, encoding: 'utf8',
  })) as Record<string, unknown>;
}

// helm-cli has no --project flag on create, so a lane's ticket is filed
// through the store itself.
function seed(e: Env, title: string, project?: string, priority?: number): string {
  if (!project) return (helm(e, ['create', '--title', title, '--body', 'pool work', '--workstream', 'rev-test', '--type', 'ops']) as { id: string }).id;
  const store = new Store(e.db);
  try {
    return store.createTicket({ name: 'seeder', kind: 'agent', model: 't', version: '0' }, { title, body: 'pool work', workstream: 'rev-test', type: 'ops', project, priority }).id;
  } finally { store.close?.(); }
}

function ticket(e: Env, id: string): { status: string; assignee: string | null } {
  return helm(e, ['get', id]) as { status: string; assignee: string | null };
}

function runAsync(e: Env, loop: string): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', REV_CLI, 'run', loop, '--count', '1'], { env: e.env, cwd: join(import.meta.dirname, '..'), stdio: 'ignore' });
}

const exited = (child: ChildProcess) => new Promise<void>((r) => (child.exitCode !== null ? r() : child.once('exit', () => r())));

function events(e: Env, loop: string): string {
  const f = join(e.home, 'state', loop, 'events.log');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

function journal(e: Env, loop: string): Record<string, unknown>[] {
  const dir = join(e.home, 'state', loop, 'launches');
  return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as Record<string, unknown>);
}

async function waitFor(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (!check()) throw new Error('condition never held');
}

// A workflow-bound ticket in the real store, admissible for one launch: its
// one requirement holds a standing pass from an independent reviewer.
const REVIEWER = { name: 'reviewer', kind: 'agent', model: 't', version: '0' };
function seedWorkflow(e: Env, title: string): string {
  const store = new Store(e.db, undefined, REVIEWER);
  try {
    store.addWorkflowDefinition({ workflow_id: 'release', revision: 'v1', stages: [{ id: 'build' }] });
    store.addWorkflowRun({ id: 'run-1', workflow_id: 'release', definition_revision: 'v1' });
    store.addWorkflowAttempt({ id: 'attempt-1', run_id: 'run-1', stage_id: 'build', ordinal: 1 });
    store.addWorkflowManifest({ id: 'manifest-a', attempt_id: 'attempt-1', kind: 'input', subjects: [`repo@${'0'.repeat(40)}`], creators: [{ name: 'builder', kind: 'agent' }] });
    store.addWorkflowRequirement({ id: 'technical', workflow_id: 'release', definition_revision: 'v1', scope: 'technical', subject_manifest_id: 'manifest-a', allowed_verdicts: ['pass'], authorities: [{ name: 'reviewer', kind: 'agent' }], independence: 'different_from_manifest_creators' });
    store.recordWorkflowDecision({ id: 'pass-1', requirement_id: 'technical', manifest_id: 'manifest-a', verdict: 'pass', source: 'review:1' });
    return store.createTicket({ name: 'seeder', kind: 'agent', model: 't', version: '0' }, { title, body: 'gated work', workstream: 'rev-test', type: 'ops', workflow_attempt_id: 'attempt-1' }).id;
  } finally { store.close?.(); }
}

function attemptState(e: Env): string {
  const store = new Store(e.db);
  try { return (store.db.prepare("SELECT state FROM workflow_attempts WHERE id = 'attempt-1'").get() as { state: string }).state; }
  finally { store.close?.(); }
}

describe('pool workers on one seat (H-574)', { timeout: 60000 }, () => {
  it('two workers launched together each claim, are told, and finish a different ticket', async () => {
    // The sessions overlap on purpose: each waits until both have started, so
    // a pass here is two live sessions on one seat, not two in a row.
    const both = `${BOUND}; touch $REV_HOME/started-$REV_LOOP; for i in $(seq 100); do [ -f $REV_HOME/started-w1 ] && [ -f $REV_HOME/started-w2 ] && break; sleep 0.1; done; [ -f $REV_HOME/started-w1 ] && [ -f $REV_HOME/started-w2 ] && echo overlapped >> $REV_HOME/overlap; ${FINISH}`;
    const e = setup((h) => worker('w1', h, both) + worker('w2', h, both));
    const a = seed(e, 'First pool ticket');
    const b = seed(e, 'Second pool ticket');

    const kids = [runAsync(e, 'w1'), runAsync(e, 'w2')];
    await Promise.all(kids.map(exited));

    const bound = readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n').map((l) => l.split(' '));
    expect(bound).toHaveLength(2);
    expect(new Set(bound.map(([, t]) => t))).toEqual(new Set([a, b]));
    expect(new Set(bound.map(([w]) => w))).toEqual(new Set(['w1', 'w2']));
    expect(readFileSync(join(e.home, 'overlap'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(ticket(e, a).status).toBe('done');
    expect(ticket(e, b).status).toBe('done');
    for (const w of ['w1', 'w2']) {
      expect(events(e, w)).toMatch(/launch-claimed\s+claimed H-\d+/);
      expect(journal(e, w)).toEqual([expect.objectContaining({ phase: 'complete', claim: true, ticket_id: expect.stringMatching(/^H-\d+$/) })]);
    }
    // Helmo recorded each claim against the worker that took it: each worker
    // session touched exactly the ticket it was told.
    for (const [w, t] of bound) {
      const touched = (helm(e, ['actor-tickets', '--name', 'builder', '--session', `rev:${w}`, '--since-seq', '0']) as { tickets: { id: string }[] }).tickets;
      expect(touched.map((x) => x.id)).toEqual([t]);
    }
  });

  it('a worker that finds the only ticket taken idles without spending a session', async () => {
    const slow = `${BOUND}; sleep 1; ${FINISH}`;
    const e = setup((h) => worker('w1', h, slow) + worker('w2', h, slow));
    const only = seed(e, 'The only ticket');

    const kids = [runAsync(e, 'w1'), runAsync(e, 'w2')];
    await Promise.all(kids.map(exited));

    expect(readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(ticket(e, only).status).toBe('done');
    const idle = ['w1', 'w2'].filter((w) => /launch-idle\s+nothing ready to claim/.test(events(e, w)));
    expect(idle).toHaveLength(1);
    expect(events(e, idle[0]!)).not.toMatch(/run-start/);
  });

  it('charges the metered session to the claimed ticket, not to one the worker filed and touched more', () => {
    // The worker claims A, files B with several notes (so B is its most-touched
    // ticket), and finishes A. A carries the session; the note names B.
    const fileB = `B=$(node ${HELM_CLI} create --title "Residual found while working" --body residual --workstream rev-test --type ops | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))"); for n in 1 2 3; do node ${HELM_CLI} update --ticket $B --note "residual note $n"; done; echo $B > $REV_HOME/filed`;
    const e = setup((h) => worker('w1', h, `${BOUND}; ${fileB}; ${FINISH}; echo "rev-mock-usage tokens=4200 cost_usd=0.42"`) + worker('w2', h, 'true'));
    const a = seed(e, 'Claimed work');
    execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    const b = readFileSync(join(e.home, 'filed'), 'utf8').trim();
    const touched = (helm(e, ['actor-tickets', '--name', 'builder', '--session', 'rev:w1', '--since-seq', '0']) as { tickets: { id: string }[] }).tickets;
    expect(touched[0]!.id).toBe(b);
    const spent = (id: string) => helm(e, ['get', id]) as { tokens_total: number; cost_usd_total: number };
    expect(spent(a).tokens_total).toBe(4200);
    expect(spent(a).cost_usd_total).toBeCloseTo(0.42);
    expect(spent(b).tokens_total).toBe(0);
    expect(events(e, 'w1')).toMatch(new RegExp(`spend\\s+iter=1 ticket=${a} tokens=4200 cost=0\\.42`));
    const store = new Store(e.db);
    try {
      const notes = (store.getEvents(a) as { payload: { note?: string } }[]).map((ev) => ev.payload.note ?? '');
      expect(notes.join('\n')).toContain(`session also touched ${b}`);
    } finally { store.close?.(); }
  });

  it('keeps unfinished work with its worker, and that worker\'s next launch resumes it', () => {
    // The first session works the ticket and stops mid-way, leaving it in
    // progress; the second finds it handed back to it, not to the queue.
    const resume = `${BOUND}; printf '%s' "$REV_PROMPT" > $REV_HOME/prompt-$(wc -l < $REV_HOME/bound | tr -d ' '); [ -f $REV_HOME/second ] || { node ${HELM_CLI} update --ticket $T --note "partial progress"; exit 1; }; ${FINISH}`;
    const e = setup((h) => worker('w1', h, resume) + worker('w2', h, 'true'));
    const id = seed(e, 'Unfinished work');
    const run = () => execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    run();
    expect(ticket(e, id)).toMatchObject({ status: 'in_progress', assignee: 'builder' });
    expect(events(e, 'w1')).toMatch(new RegExp(`claim-kept\\s+${id} session ended failure; the next launch resumes it`));
    expect(events(e, 'w1')).not.toMatch(/claim-released/);
    // The session's own note was accepted, so its identity carried the
    // generation Helmo bound the claim to.
    expect(events(e, 'w1')).not.toMatch(/execution_claim_held/);

    writeFileSync(join(e.home, 'second'), '');
    run();
    expect(ticket(e, id).status).toBe('done');
    expect(events(e, 'w1')).toMatch(new RegExp(`launch-claimed\\s+resumed ${id}`));
    expect(readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n')).toEqual([`w1 ${id}`, `w1 ${id}`]);
    const resumedPrompt = readFileSync(join(e.home, 'prompt-2'), 'utf8');
    expect(resumedPrompt).toContain(`Rev has resumed ticket ${id}`);
    expect(resumedPrompt).toContain(`Your workspace is ${join(e.home, 'w1')}`);
    expect(readFileSync(join(e.home, 'prompt-1'), 'utf8')).not.toContain('Rev has resumed');
    // An ordinary claim may be set back to open while it waits, and
    // no claimed prompt asks for an iteration-sized split or a plan closure.
    for (const n of ['1', '2']) {
      const p = readFileSync(join(e.home, `prompt-${n}`), 'utf8');
      expect(p).toContain(`link that blocker and set ${id} back to open`);
      expect(p).toContain('Split a ticket only into independently useful deliverables');
      expect(p).not.toContain('close the parent as a plan');
    }
  });

  it('a worker idle on a kept claim wakes when another seat writes on it, and only then', async () => {
    // A deployed fleet hit this: the claim was kept waiting on review, the
    // worker idled on it, and a Reviewer PASS and a coordinator's note on the
    // claim itself left it asleep until a manual reload.
    const kept = `${BOUND}; if [ -f $REV_HOME/go ]; then ${FINISH}; elif [ ! -f $REV_HOME/noted ]; then touch $REV_HOME/noted; node ${HELM_CLI} update --ticket $T --note "candidate ready; waiting for review"; fi`;
    const e = setup((h) => worker('w1', h, kept, 'idle_floor_s = 0\n') + worker('w2', h, 'true'));
    const id = seed(e, 'Kept claim waiting on review');
    const child = spawn(process.execPath, ['--import', 'tsx', REV_CLI, 'run', 'w1'], { env: e.env, cwd: join(import.meta.dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; child.stderr!.on('data', (d) => { err += String(d); });
    try {
      await waitFor(() => /run-end\s+iter=1 .*action=idle/.test(events(e, 'w1'))).catch(() => { throw new Error(events(e, 'w1') + err); });
      expect(events(e, 'w1')).toMatch(new RegExp(`claim-kept\\s+${id} session ended ok`));
      expect(ticket(e, id)).toMatchObject({ status: 'in_progress', assignee: 'builder' });
      // Main already resumes a fresh keep once on its own claim edge; after
      // that the worker idles on its own exhaust: many polls, no wake.
      await waitFor(() => /run-end\s+iter=2 .*action=idle/.test(events(e, 'w1'))).catch(() => { throw new Error(events(e, 'w1') + err); });
      const settled = events(e, 'w1');
      await new Promise((r) => setTimeout(r, 1500));
      expect(events(e, 'w1')).toBe(settled);

      writeFileSync(join(e.home, 'go'), '');
      helm(e, ['update', '--ticket', id, '--note', 'Reviewer PASS recorded; your next step is unblocked.']);
      await waitFor(() => ticket(e, id).status === 'done').catch(() => { throw new Error(events(e, 'w1') + err); });
      expect(events(e, 'w1').slice(settled.length)).toMatch(new RegExp(`wake\\s+since=\\d+ ready=0\\n.*launch-claimed\\s+resumed ${id}`));
      expect(readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n').at(-1)).toBe(`w1 ${id}`);
    } finally {
      child.kill('SIGTERM');
      await exited(child);
    }
  });

  it('an ordinary claim set back to open while it waits stays with the seat and frees the worker for ready work', () => {
    // A resumed claim blocked on a prerequisite held its worker, and the
    // only-ticket rule kept that worker off the prerequisite. Setting the claim
    // back to open keeps the seat's reservation and lets the next launch draw.
    const wait = `${BOUND}; if [ ! -f $REV_HOME/second ]; then node ${HELM_CLI} update --ticket $T --note "waiting on its prerequisite; next step recorded" --status open --not-before 2099-01-01; else ${FINISH}; fi`;
    const e = setup((h) => worker('w1', h, wait) + worker('w2', h, 'true'));
    const waiting = seed(e, 'Waits on a prerequisite');
    const prerequisite = seed(e, 'The prerequisite');
    const run = () => execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    run();
    expect(ticket(e, waiting)).toMatchObject({ status: 'open', assignee: 'builder' });
    writeFileSync(join(e.home, 'second'), '');
    run();
    expect(readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n')).toEqual([`w1 ${waiting}`, `w1 ${prerequisite}`]);
    expect(ticket(e, prerequisite).status).toBe('done');
    expect(ticket(e, waiting)).toMatchObject({ status: 'open', assignee: 'builder' });
    expect((helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets).toHaveLength(0);
  });

  it('puts the claim back when the session never started', () => {
    const e = setup((h) => worker('w1', h, `${BOUND}; exit 78`) + worker('w2', h, 'true'));
    const id = seed(e, 'Launch that never ran');

    execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    expect(ticket(e, id)).toMatchObject({ status: 'open', assignee: 'builder' });
    expect(events(e, 'w1')).toMatch(new RegExp(`claim-released\\s+${id} its session never started`));
  });

  it('a killed worker keeps its claim, holds its next launch while the dead launch\'s session runs, then resumes it, and the dead launch can write nothing', async () => {
    // The session outlives its SIGKILLed loop: it runs in its own process
    // group (H-1089). It waits for the test to let it go, then exits.
    const e = setup((h) => worker('w1', h, `${BOUND}; touch $REV_HOME/model-started; until [ -f $REV_HOME/release ]; do sleep 0.1; done`) + worker('w2', h, 'true'));
    const id = seed(e, 'Work interrupted by a crash');

    const child = runAsync(e, 'w1');
    await waitFor(() => existsSync(join(e.home, 'model-started')));
    expect(ticket(e, id).status).toBe('in_progress');
    const loopPid = Number(/loop-start\s+pid=(\d+)/.exec(events(e, 'w1'))![1]);
    const dead = journal(e, 'w1')[0]!['launch_id'] as string;
    const groupFile = readdirSync(join(e.home, 'state', 'w1', 'launches')).find((n) => n.endsWith('.group'))!;
    const group = Number(readFileSync(join(e.home, 'state', 'w1', 'launches', groupFile), 'utf8').trim());
    process.kill(loopPid, 'SIGKILL');
    child.kill('SIGKILL');
    await exited(child);
    const groupAlive = (): boolean => { try { process.kill(-group, 0); return true; } catch { return false; } };
    expect(groupAlive()).toBe(true);

    const restarted = runAsync(e, 'w1');
    try {
      // A restart while that session runs launches nothing for this worker,
      // and Helmo still holds the claim for the dead launch's generation.
      await waitFor(() => events(e, 'w1').includes('launch-session-running'));
      await new Promise((r) => setTimeout(r, 1500)); // several polls at 0.1s
      let log = events(e, 'w1');
      expect(log).toMatch(new RegExp(`launch-session-running\\s+${dead} session group ${group} is still running`));
      expect(log).not.toMatch(/launch-claimed\s+resumed/);
      expect(log).not.toMatch(/claim-kept/);
      expect(readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n')).toEqual([`w1 ${id}`]);
      expect(journal(e, 'w1').find((j) => j['launch_id'] === dead)!['phase']).toBe('dispatching');
      expect(restarted.exitCode).toBeNull();

      // Once it ends, the same process settles the dead launch and resumes.
      writeFileSync(join(e.home, 'release'), '');
      await exited(restarted);
      expect(groupAlive()).toBe(false);
      log = events(e, 'w1');
      expect(log).toMatch(/launch-session-ended/);
      expect(log).toMatch(new RegExp(`claim-kept\\s+${id} recovered dispatching`));
      expect(log).toMatch(/launch-quarantined.*recovered dispatching/);
      expect(log).toMatch(new RegExp(`launch-claimed\\s+resumed ${id}`));
      expect(log).not.toMatch(/claim-released/);
      expect(readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n')).toEqual([`w1 ${id}`, `w1 ${id}`]);
    } finally {
      writeFileSync(join(e.home, 'release'), '');
      restarted.kill('SIGKILL');
    }
    // A child of the dead launch that outlived it writes as that generation,
    // which the resume retired.
    let refused = '';
    try {
      execFileSync('node', [HELM_CLI, 'update', '--ticket', id, '--note', 'late write'], {
        env: { ...e.env, HELMO_ACTOR: JSON.stringify({ name: 'builder', kind: 'agent', model: 't', version: '0', session: 'rev:w1', generation: dead }) }, encoding: 'utf8', stdio: 'pipe',
      });
    } catch (err) { refused = String((err as { stderr?: string }).stderr); }
    expect(refused).toMatch(/stale_generation/);
  });

  it('a replayed launch id whose claim has since been resumed is refused and never reads as a claim to dispatch on', () => {
    const e = setup((h) => worker('w1', h, 'true') + worker('w2', h, 'true'));
    const id = seed(e, 'Work whose first launch was replayed');
    const before = process.env['REV_HOME'];
    process.env['REV_HOME'] = e.home;
    let roster: ReturnType<typeof loadRoster>;
    try { roster = loadRoster(); } finally { if (before === undefined) delete process.env['REV_HOME']; else process.env['REV_HOME'] = before; }
    const l = roster.loops['w1']!;

    expect(launchClaim(roster.global, l, 'rev:w1:1:1:1')).toMatchObject({ act: 'launch', how: 'claimed', ticketId: id });
    // The same id asked again while it still holds the claim answers the same
    // receipt: that is how an uncertain reply is reconciled.
    expect(launchClaim(roster.global, l, 'rev:w1:1:1:1')).toMatchObject({ act: 'launch', how: 'claimed', ticketId: id });
    expect(launchClaim(roster.global, l, 'rev:w1:1:2:2')).toMatchObject({ act: 'launch', how: 'claimed', ticketId: id, resumed: true });
    const stale = launchClaim(roster.global, l, 'rev:w1:1:1:1');
    expect(stale).toMatchObject({ act: 'deny', how: 'stale', ticketId: null });
    expect(stale.reason).toMatch(/launch_claim_stale/);
    expect(ticket(e, id).status).toBe('in_progress');
  });

  it('a claim whose reply was lost is reconciled by asking again under the same launch id', () => {
    // The store commits the claim; the reply never reaches Rev (H-686).
    const home = mkdtempSync(join(tmpdir(), 'rev-pool-lost-'));
    const proxy = join(home, 'lossy-helmo.mjs');
    writeFileSync(proxy, `import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const r = spawnSync(process.execPath, [${JSON.stringify(HELM_CLI)}, ...args], { stdio: ['inherit', 'pipe', 'inherit'], env: process.env });
const lost = process.env.REV_HOME + '/reply-lost';
if (args[0] === 'launch-claim' && !existsSync(lost)) {
  writeFileSync(lost, args[args.indexOf('--launch-id') + 1]);
  process.stderr.write('ETIMEDOUT: reply lost after commit\\n');
  process.exit(1);
}
process.stdout.write(r.stdout);
process.exit(r.status ?? 1);
`);
    const e = setup((h) => worker('w1', h, `${BOUND}; ${FINISH}`) + worker('w2', h, 'true'), proxy);
    const id = seed(e, 'Claim whose reply was lost');

    // One iteration: waiting on the unanswered claim spends none, and its own
    // write is not motion, so an idle worker would never ask again.
    execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    const lostId = readFileSync(join(e.home, 'reply-lost'), 'utf8');
    const log = events(e, 'w1');
    expect(log).toMatch(new RegExp(`launch-denied\\s+launch claim could not be asked: ETIMEDOUT.*; asking again as ${lostId}`));
    expect(log).toMatch(new RegExp(`claim-reconciled\\s+${lostId} answered claimed ${id}`));
    expect(log).toMatch(new RegExp(`launch-claimed\\s+claimed ${id}`));
    expect(log).not.toMatch(/resumed/);
    expect(ticket(e, id).status).toBe('done');
    expect(readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n')).toEqual([`w1 ${id}`]);
    // One launch identity end to end: the lost one, settled by its session.
    expect(journal(e, 'w1')).toEqual([expect.objectContaining({ launch_id: lostId, ticket_id: id, phase: 'complete', claim: true })]);
  });

  function roster(e: Env): ReturnType<typeof loadRoster> {
    const before = process.env['REV_HOME'];
    process.env['REV_HOME'] = e.home;
    try { return loadRoster(); } finally { if (before === undefined) delete process.env['REV_HOME']; else process.env['REV_HOME'] = before; }
  }
  function intent(e: Env, loop: string, launchId: string): void {
    const before = process.env['REV_HOME'];
    process.env['REV_HOME'] = e.home;
    try { recordLaunchIntent(loop, launchId, { claim: true }); } finally { if (before === undefined) delete process.env['REV_HOME']; else process.env['REV_HOME'] = before; }
  }

  it('a restart replays a claim its dead process asked but never heard, rather than settling it and resuming under a new id', () => {
    const e = setup((h) => worker('w1', h, `${BOUND}; ${FINISH}`) + worker('w2', h, 'true'));
    const id = seed(e, 'Claim asked before a crash');
    const r = roster(e);
    const dead = 'rev:w1:999:1:1';
    intent(e, 'w1', dead);
    expect(launchClaim(r.global, r.loops['w1']!, dead)).toMatchObject({ how: 'claimed', ticketId: id });

    execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    const log = events(e, 'w1');
    expect(log).toMatch(new RegExp(`claim-reconciled\\s+${dead} answered claimed ${id}`));
    expect(log).not.toMatch(/claim-kept|launch-quarantined|resumed/);
    expect(ticket(e, id).status).toBe('done');
    expect(journal(e, 'w1')).toEqual([expect.objectContaining({ launch_id: dead, ticket_id: id, phase: 'complete' })]);
  });

  it('an unanswered claim that has since moved on is settled as stale and the launch takes a fresh id', () => {
    const e = setup((h) => worker('w1', h, `${BOUND}; ${FINISH}`) + worker('w2', h, 'true'));
    const id = seed(e, 'Claim resumed before its reply was reconciled');
    const r = roster(e);
    const lost = 'rev:w1:999:1:1';
    intent(e, 'w1', lost);
    expect(launchClaim(r.global, r.loops['w1']!, lost)).toMatchObject({ how: 'claimed', ticketId: id });
    // A later generation of this worker took the claim forward, retiring the lost one.
    expect(launchClaim(r.global, r.loops['w1']!, 'rev:w1:999:2:2')).toMatchObject({ how: 'claimed', ticketId: id, resumed: true });

    execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    const log = events(e, 'w1');
    expect(log).toMatch(new RegExp(`claim-reconciled\\s+${lost} launch ${lost} can no longer claim: launch_claim_stale`));
    expect(log).toMatch(new RegExp(`launch-claimed\\s+resumed ${id}`));
    expect(ticket(e, id).status).toBe('done');
    const entries = journal(e, 'w1');
    expect(entries.find((j) => j['launch_id'] === lost)).toMatchObject({ phase: 'quarantined' });
    expect(entries.filter((j) => j['launch_id'] !== lost)).toEqual([expect.objectContaining({ ticket_id: id, phase: 'complete' })]);
  });

  describe('a workflow-bound claim (H-687)', () => {
    const run = (e: Env) => execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    it('keeps an unfinished claim unquarantined, and its next launch resumes and revalidates it by the launch its admission belongs to', () => {
      const e = setup((h) => worker('w1', h, `${BOUND}; printf '%s' "$REV_PROMPT" > $REV_HOME/prompt-wf; [ -f $REV_HOME/second ] || exit 1; ${FINISH}`) + worker('w2', h, 'true'));
      const id = seedWorkflow(e, 'Gated work left unfinished');

      run(e);
      expect(ticket(e, id)).toMatchObject({ status: 'in_progress', assignee: 'builder' });
      expect(attemptState(e)).toBe('running');
      expect(events(e, 'w1')).not.toMatch(/launch-quarantined/);
      expect(events(e, 'w1')).toMatch(new RegExp(`claim-kept\\s+${id} session ended failure`));

      writeFileSync(join(e.home, 'second'), '');
      run(e);
      const log = events(e, 'w1');
      expect(log).toMatch(new RegExp(`launch-claimed\\s+resumed ${id} admitted as `));
      // Revalidation by this launch's own id would refuse: the admission is
      // the first launch's.
      expect(log).not.toMatch(/failed pre-dispatch revalidation|post-session revalidation failed/);
      expect(ticket(e, id).status).toBe('done');
      expect(journal(e, 'w1').map((j) => j['phase']).sort()).toEqual(['complete', 'quarantined']);
      // Its admission is spent, so it is never told to set the claim back to open.
      expect(readFileSync(join(e.home, 'prompt-wf'), 'utf8')).toContain(`Rev has resumed ticket ${id}`);
      expect(readFileSync(join(e.home, 'prompt-wf'), 'utf8')).not.toContain('back to open');
    });

    it('keeps a claim whose session never started, because its launch admission is spent', () => {
      const e = setup((h) => worker('w1', h, `${BOUND}; exit 78`) + worker('w2', h, 'true'));
      const id = seedWorkflow(e, 'Gated launch that never ran');

      run(e);
      expect(ticket(e, id)).toMatchObject({ status: 'in_progress', assignee: 'builder' });
      expect(events(e, 'w1')).toMatch(new RegExp(`claim-kept\\s+${id} its session never started; workflow-bound`));
      expect(events(e, 'w1')).not.toMatch(/claim-released/);
      expect(attemptState(e)).toBe('running');
    });

    it('a held claim whose authority has gone goes to the human, and the worker draws its next ticket', () => {
      const e = setup((h) => worker('w1', h, `${BOUND}; [ -f $REV_HOME/second ] || exit 1; ${FINISH}`) + worker('w2', h, 'true'));
      const id = seedWorkflow(e, 'Gated work whose review is withdrawn');
      run(e);
      expect(ticket(e, id).status).toBe('in_progress');
      const store = new Store(e.db, undefined, REVIEWER);
      try { store.recordWorkflowDecision({ id: 'revoke-1', requirement_id: 'technical', manifest_id: 'manifest-a', verdict: 'revocation', revokes_decision_id: 'pass-1', source: 'review:2' }); }
      finally { store.close?.(); }
      const next = seed(e, 'Ordinary work behind it');

      writeFileSync(join(e.home, 'second'), '');
      run(e);
      expect(events(e, 'w1')).toMatch(new RegExp(`launch-claimed\\s+claimed ${next}`));
      expect(ticket(e, next).status).toBe('done');
      expect(helm(e, ['get', id])).toMatchObject({ status: 'open', needs_human: true });
    });

    it('a killed worker\'s workflow claim is not quarantined at restart, and the restart resumes it', async () => {
      const e = setup((h) => worker('w1', h, `${BOUND}; touch $REV_HOME/model-started; [ -f $REV_HOME/release ] && ${FINISH}; until [ -f $REV_HOME/release ]; do sleep 0.1; done`) + worker('w2', h, 'true'));
      const id = seedWorkflow(e, 'Gated work interrupted by a crash');

      const child = runAsync(e, 'w1');
      await waitFor(() => existsSync(join(e.home, 'model-started')));
      const loopPid = Number(/loop-start\s+pid=(\d+)/.exec(events(e, 'w1'))![1]);
      process.kill(loopPid, 'SIGKILL');
      child.kill('SIGKILL');
      await exited(child);
      writeFileSync(join(e.home, 'release'), '');

      const restarted = runAsync(e, 'w1');
      try { await exited(restarted); } finally { restarted.kill('SIGKILL'); }
      const log = events(e, 'w1');
      expect(log).toMatch(new RegExp(`claim-kept\\s+${id} recovered dispatching`));
      expect(attemptState(e)).not.toBe('quarantined');
      expect(log).toMatch(new RegExp(`launch-claimed\\s+resumed ${id} admitted as `));
      expect(ticket(e, id).status).toBe('done');
    });
  });

  it('claims only inside its project lane', () => {
    const e = setup((h) => worker('w1', h, `${BOUND}; ${FINISH}`, 'project = "R-lane"\n') + worker('w2', h, 'true'));
    const outside = seed(e, 'Outside the lane');
    const inside = seed(e, 'Inside the lane', 'R-lane');

    execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    expect(readFileSync(join(e.home, 'bound'), 'utf8').trim()).toBe(`w1 ${inside}`);
    expect(ticket(e, outside).status).toBe('open');
  });

  it('four workers in ONE project each claim only their allowlisted ticket, overlap, and write only their own checkout (H-671)', async () => {
    // Every session writes its output into its own cwd, then waits until all
    // four have started: a pass is four live sessions at once, never a queue.
    const four = `${BOUND}; echo "$T" > out-$REV_LOOP; touch $REV_HOME/started-$REV_LOOP; for i in $(seq 200); do n=$(ls $REV_HOME | grep -c '^started-'); [ "$n" -ge 4 ] && break; sleep 0.1; done; [ "$(ls $REV_HOME | grep -c '^started-')" -ge 4 ] && echo "$REV_LOOP" >> $REV_HOME/overlap; ${FINISH}`;
    const lane = (t: string) => `project = "R-31"\ntickets = ["${t}"]\n`;
    // Ids are minted in order, so the allowlists can name them before seeding.
    const ids = ['H-2', 'H-3', 'H-4', 'H-5'];
    const e = setup((h) => ['w1', 'w2', 'w3', 'w4'].map((w, i) => worker(w, h, four, lane(ids[i]!))).join(''));
    // The decoy is first in the project's queue and in no allowlist.
    const decoy = seed(e, 'Nobody may take this', 'R-31', 0);
    const seeded = ['product', 'harness', 'design', 'voice'].map((t) => seed(e, t, 'R-31', 2));
    expect([decoy, ...seeded]).toEqual(['H-1', ...ids]);

    // Launched in reverse, so no worker is helped by arriving first.
    await Promise.all(['w4', 'w3', 'w2', 'w1'].map((w) => runAsync(e, w)).map(exited));

    const bound = Object.fromEntries(readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n').map((l) => l.split(' ')));
    expect(bound).toEqual({ w1: 'H-2', w2: 'H-3', w3: 'H-4', w4: 'H-5' });
    expect(readFileSync(join(e.home, 'overlap'), 'utf8').trim().split('\n').sort()).toEqual(['w1', 'w2', 'w3', 'w4']);
    for (const [i, w] of ['w1', 'w2', 'w3', 'w4'].entries()) {
      expect(readdirSync(join(e.home, w))).toEqual([`out-${w}`]);
      expect(readFileSync(join(e.home, w, `out-${w}`), 'utf8').trim()).toBe(ids[i]);
      expect(ticket(e, ids[i]!).status).toBe('done');
    }
    expect(ticket(e, decoy).status).toBe('open');
  });

  it('the role\'s worker with no allowlist leaves a lane\'s ticket to its owner (H-671)', () => {
    const e = setup((h) => worker('w1', h, `${BOUND}; ${FINISH}`) + worker('w2', h, 'true', 'tickets = ["H-1"]\n'));
    const lane = seed(e, 'Owned by the w2 lane', 'R-31', 0);
    const general = seed(e, 'Anyone may take this', 'R-31', 2);
    expect(lane).toBe('H-1');

    execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    expect(readFileSync(join(e.home, 'bound'), 'utf8').trim()).toBe(`w1 ${general}`);
    expect(ticket(e, lane).status).toBe('open');
  });

  it('a worker whose allowlist holds nothing ready idles, leaving the project\'s other work alone (H-671)', () => {
    const e = setup((h) => worker('w1', h, `${BOUND}; ${FINISH}`, 'project = "R-31"\ntickets = ["H-99"]\n') + worker('w2', h, 'true'));
    const other = seed(e, 'Another lane\'s ticket', 'R-31');

    execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    expect(existsSync(join(e.home, 'bound'))).toBe(false);
    expect(events(e, 'w1')).toMatch(/launch-idle\s+nothing ready to claim/);
    expect(ticket(e, other).status).toBe('open');
  });

  it('a store that ignores the allowlist is refused once, and the ticket it handed over is put back (H-671)', () => {
    // The receipt is an answer, so it must not be re-asked forever as if the
    // reply had been lost — this run used to spin at the poll interval.
    const home = mkdtempSync(join(tmpdir(), 'rev-pool-wide-'));
    const proxy = join(home, 'wide-helmo.mjs');
    writeFileSync(proxy, `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const at = args.indexOf('--tickets');
if (at >= 0) args.splice(at, 2);
const r = spawnSync(process.execPath, [${JSON.stringify(HELM_CLI)}, ...args], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
`);
    const e = setup((h) => worker('w1', h, `touch $REV_HOME/session-launched`, 'tickets = ["H-99"]\n') + worker('w2', h, 'true'), proxy);
    const id = seed(e, 'Outside the allowlist');

    execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..'), timeout: 30_000 });

    expect(existsSync(join(e.home, 'session-launched'))).toBe(false);
    expect(events(e, 'w1')).toMatch(new RegExp(`launch-denied\\s+Helmo's claim receipt for \\S+ did not match this worker; released ${id}`));
    expect(events(e, 'w1')).not.toMatch(/claim-reconciled/);
    expect(ticket(e, id).status).toBe('open');
  });

  it('refuses to launch against a store with no launch-claim, leaving the ticket untouched', () => {
    // An installation that predates the command answers with its usage text.
    const home = mkdtempSync(join(tmpdir(), 'rev-pool-old-'));
    const proxy = join(home, 'old-helmo.mjs');
    writeFileSync(proxy, `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === 'launch-claim') { process.stderr.write('usage: helmo-cli <command> [flags]\\n'); process.exit(1); }
const r = spawnSync(process.execPath, [${JSON.stringify(HELM_CLI)}, ...args], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
`);
    const e = setup((h) => worker('w1', h, `touch $REV_HOME/session-launched`) + worker('w2', h, 'true'), proxy);
    const id = seed(e, 'Must not be raced');

    execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    expect(existsSync(join(e.home, 'session-launched'))).toBe(false);
    expect(events(e, 'w1')).toMatch(/launch-denied\s+this store has no launch-claim command/);
    expect(ticket(e, id).status).toBe('open');
  });
});

// Lanes: a ticket's lane routes it to the worker serving that lane,
// with no allowlist to edit and no restart. Files the way Orchestrator does,
// through helm-cli, after the workers are already running.
describe('lane workers on one seat', { timeout: 90000 }, () => {
  function seedLane(e: Env, title: string, lane: string | null, priority = 2, by = 'seeder'): string {
    return (JSON.parse(execFileSync('node', [HELM_CLI, 'create', '--title', title, '--body', 'lane work', '--workstream', 'rev-test', '--type', 'ops',
      '--priority', String(priority), ...(lane ? ['--lane', lane] : [])], {
      env: { ...e.env, HELMO_ACTOR: JSON.stringify({ name: by, kind: 'agent', model: 't', version: '0' }) }, encoding: 'utf8',
    })) as { id: string }).id;
  }
  const runOnce = (e: Env, loop: string) =>
    execFileSync('npx', ['tsx', REV_CLI, 'run', loop, '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });
  const swap = (e: Env, from: string, to: string) => {
    const path = join(e.home, 'roster.toml');
    const before = readFileSync(path, 'utf8');
    expect(before).toContain(from);
    writeFileSync(path, before.replace(from, to));
  };

  it('claims a lane ticket filed after its worker went idle on the next poll, then a child the session filed mid-run', async () => {
    // Orchestrator files a child while the parent's session is still at work,
    // work that became ready mid-session must be taken by the
    // next claim, not lost.
    const child = `${BOUND}; if [ "$T" = "H-2" ]; then touch $REV_HOME/mid; for i in $(seq 200); do [ -f $REV_HOME/child-filed ] && break; sleep 0.1; done; fi; ${FINISH}`;
    const e = setup((h) => worker('w1', h, child, 'lane = "frontend"\n') + worker('w2', h, 'true'));
    const general = seedLane(e, 'General work, first in the queue', null, 0);
    const proc = spawn(process.execPath, ['--import', 'tsx', REV_CLI, 'run', 'w1', '--count', '3'], { env: e.env, cwd: join(import.meta.dirname, '..'), stdio: 'ignore' });
    try {
      await waitFor(() => /launch-idle\s+nothing ready to claim/.test(events(e, 'w1')));
      const filed = Date.now();
      const lane = seedLane(e, 'Frontend work', 'frontend');
      await waitFor(() => existsSync(join(e.home, 'bound')) && readFileSync(join(e.home, 'bound'), 'utf8').includes(lane));
      const delayMs = Date.now() - filed;
      console.log(`lane claim: ${lane} filed after w1 idled, bound in ${delayMs} ms (poll_seconds 0.1)`);
      expect(delayMs).toBeLessThan(15_000);
      await waitFor(() => existsSync(join(e.home, 'mid')));
      expect(seedLane(e, 'Child filed mid-session', 'frontend')).toBe('H-3');
      writeFileSync(join(e.home, 'child-filed'), '');
      await exited(proc);
      expect(readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n')).toEqual([`w1 ${lane}`, 'w1 H-3']);
      expect(ticket(e, 'H-3').status).toBe('done');
      expect(ticket(e, general).status).toBe('open');
    } finally { proc.kill(); }
  });

  it('runs two lanes and the general worker at once, each on its own work, in its own checkout', async () => {
    const three = `${BOUND}; echo "$T" > out-$REV_LOOP; touch $REV_HOME/started-$REV_LOOP; for i in $(seq 200); do [ "$(ls $REV_HOME | grep -c '^started-')" -ge 3 ] && break; sleep 0.1; done; [ "$(ls $REV_HOME | grep -c '^started-')" -ge 3 ] && echo "$REV_LOOP" >> $REV_HOME/overlap; ${FINISH}`;
    const e = setup((h) => worker('w1', h, three, 'lane = "frontend"\n') + worker('w2', h, three, 'lane = "backend"\n') + worker('w3', h, three));
    const prep = seedLane(e, 'frontend work', 'frontend', 3);
    const backend = seedLane(e, 'backend work', 'backend', 3);
    const general = seedLane(e, 'general work', null, 3);
    // Higher priority lane work in a lane nobody serves: everyone leaves it.
    const orphan = seedLane(e, 'a lane with no worker', 'mobile', 0);

    await Promise.all(['w3', 'w2', 'w1'].map((w) => runAsync(e, w)).map(exited));

    const bound = Object.fromEntries(readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n').map((l) => l.split(' ')));
    expect(bound).toEqual({ w1: prep, w2: backend, w3: general });
    expect(readFileSync(join(e.home, 'overlap'), 'utf8').trim().split('\n').sort()).toEqual(['w1', 'w2', 'w3']);
    for (const w of ['w1', 'w2', 'w3']) expect(readdirSync(join(e.home, w))).toEqual([`out-${w}`]);
    expect(ticket(e, orphan).status).toBe('open');

    const status = JSON.parse(execFileSync('npx', ['tsx', REV_CLI, 'status', '--json'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') }));
    expect(status.loops.map((l: { loop: string; lane: string | null }) => [l.loop, l.lane])).toEqual([['w1', 'frontend'], ['w2', 'backend'], ['w3', null]]);
    expect(status.unserved_lanes).toEqual([{ ticket: orphan, seat: 'builder', lane: 'mobile', reason: "no builder worker serves lane 'mobile'" }]);
    const human = execFileSync('npx', ['tsx', REV_CLI, 'status'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });
    expect(human).toContain('LANES: frontend=w1  backend=w2');
    expect(human).toContain(`UNSERVED LANE WORK: ${orphan} (builder, lane mobile) — no builder worker serves lane 'mobile'`);
  });

  it('a worker swapped to a lane while it holds work launches nothing and releases nothing; restoring its allowlist resumes it', () => {
    const keep = `${BOUND}; [ -f $REV_HOME/second ] || { node ${HELM_CLI} update --ticket $T --note "partial progress"; exit 1; }; ${FINISH}`;
    const e = setup((h) => worker('w1', h, keep, 'tickets = ["H-1"]\n') + worker('w2', h, 'true'));
    const id = seedLane(e, 'Held across the swap', null);
    runOnce(e, 'w1');
    expect(ticket(e, id)).toMatchObject({ status: 'in_progress', assignee: 'builder' });

    swap(e, 'tickets = ["H-1"]', 'lane = "frontend"');
    writeFileSync(join(e.home, 'second'), '');
    runOnce(e, 'w1');
    expect(events(e, 'w1')).toMatch(new RegExp(`launch-denied\\s+holds ${id} \\(lane none\\) outside this worker's scope \\(lane frontend\\)`));
    expect(readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n')).toEqual([`w1 ${id}`]);
    expect(ticket(e, id)).toMatchObject({ status: 'in_progress', assignee: 'builder' });
    expect(events(e, 'w1')).not.toMatch(/claim-released/);
    const status = execFileSync('npx', ['tsx', REV_CLI, 'status'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });
    expect(status).toContain(`HELD OUT OF SCOPE: w1 holds ${id} (lane none) outside this worker's scope (lane frontend)`);

    swap(e, 'lane = "frontend"', 'tickets = ["H-1"]');
    runOnce(e, 'w1');
    expect(events(e, 'w1')).toMatch(new RegExp(`launch-claimed\\s+resumed ${id}`));
    expect(ticket(e, id).status).toBe('done');
    expect(existsSync(join(e.home, 'state', 'w1', 'OUT_OF_SCOPE'))).toBe(false);
  });

  it('cuts a worker over behind the barrier: a held listed ticket cannot be relaned; after release, relane and swap, the next poll takes new lane work', () => {
    // First session stops mid-way holding H-1; the second puts it down at a
    // natural stop with its continuation note.
    const stopThenRelease = `${BOUND}; if [ -f $REV_HOME/release ]; then node ${HELM_CLI} update --ticket $T --status open --note "Natural stop: branch codex/x; next step the parser" >/dev/null; else node ${HELM_CLI} update --ticket $T --note "partial progress" >/dev/null; exit 1; fi`;
    const e = setup((h) => worker('w1', h, stopThenRelease, 'tickets = ["H-1", "H-2"]\n') + worker('w2', h, `${BOUND}; ${FINISH}`));
    const held = seedLane(e, 'Listed and held', null, 1);
    const listed = seedLane(e, 'Listed, not held', null, 2);
    runOnce(e, 'w1');
    expect(ticket(e, held).status).toBe('in_progress');

    // 3.1: the barrier is not met, and Helmo refuses the relane outright.
    const relane = (id: string) => execFileSync('node', [HELM_CLI, 'update', '--ticket', id, '--note', 'cutover to lanes', '--lane', 'frontend'], {
      env: { ...e.env, HELMO_ACTOR: JSON.stringify({ name: 'orchestrator', kind: 'orchestrator', model: 't', version: '0' }) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(() => relane(held)).toThrow(/lane cannot change/);

    writeFileSync(join(e.home, 'release'), '');
    runOnce(e, 'w1');
    expect(ticket(e, held).status).toBe('open');
    // 3.3 then 3.4: relane every listed ticket, swap the config.
    relane(held); relane(listed);
    swap(e, 'tickets = ["H-1", "H-2"]', 'lane = "frontend"');
    // The general worker sees none of the relaned work.
    runOnce(e, 'w2');
    expect(events(e, 'w2')).toMatch(/launch-idle\s+nothing ready to claim/);
    // A ticket filed after the swap, routed by lane alone, is the next claim.
    const fresh = seedLane(e, 'Filed after the cutover', 'frontend', 0);
    swap(e, 'if [ -f $REV_HOME/release ]', 'if false');
    writeFileSync(join(e.home, 'roster.toml'), readFileSync(join(e.home, 'roster.toml'), 'utf8'));
    runOnce(e, 'w1');
    const bound = readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n');
    expect(bound.at(-1)).toBe(`w1 ${fresh}`);
    expect(events(e, 'w1')).toMatch(/launch-claimed\s+claimed H-3/);
  });
});
