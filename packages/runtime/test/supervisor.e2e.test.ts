// End-to-end for the v1 fleet: a real supervisor process over mock-runtime
// loops against a real (temp) Helm store. Proves: general start runs the whole
// roster; a SIGKILLed loop comes back through the backoff; STOP is honored
// until resume, then picked up without touching the supervisor; `rev stop`
// drains the machine to a clean exit.
import { describe, it, expect } from 'vitest';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELMO_CLI as HELM_CLI, HELMO_SERVER, HELMO_STORE } from './helmo.js';

// Loaded by path rather than by specifier so it follows REV_TEST_HELMO like
// the rest of this suite's Helmo references. A written-out sibling path is
// what broke this: it resolves only on a machine that has ../helmo, which is
// the assumption REV_TEST_HELMO exists to remove (H-1400).
const { Store } = await import(HELMO_STORE);

const REV_CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

interface Env {
  home: string;
  env: NodeJS.ProcessEnv;
}

// min_uptime_seconds is how long a restarted loop must stay alive before the
// supervisor calls the resume healthy and closes the answered ticket. Most
// cases want it tiny so nothing waits on it; a case that asserts the FAILED
// resume path must set it wide, because the two paths race — see the
// resume-failure case below.
function setup(loopsToml: string, extraGlobal = '', minUptimeSeconds = 1): Env {
  const home = mkdtempSync(join(tmpdir(), 'rev-fleet-'));
  const db = join(home, 'helm.db');
  writeFileSync(
    join(home, 'roster.toml'),
    `[global]
helmo_cli = "${HELM_CLI}"
helmo_mcp_server = "${HELMO_SERVER}"
helmo_db = "${db}"
poll_seconds = 1
respawn_backoff_seconds = 1
respawn_backoff_cap_seconds = 4
min_uptime_seconds = ${minUptimeSeconds}
usage_poll_seconds = 0
${extraGlobal}
${loopsToml}`,
  );
  return { home, env: { ...process.env, REV_HOME: home, HELMO_DB: db } };
}

function helm(e: Env, args: string[], actor = '{"name":"seeder","kind":"agent","model":"t","version":"0"}'): Record<string, unknown> {
  return JSON.parse(
    execFileSync('node', [HELM_CLI, ...args], { env: { ...e.env, HELMO_ACTOR: actor }, encoding: 'utf8' }),
  ) as Record<string, unknown>;
}

function rev(e: Env, args: string[]): string {
  return execFileSync('npx', ['tsx', REV_CLI, ...args], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });
}

function answerResume(e: Env, ticketId: string): void {
  const store = new Store(join(e.home, 'helm.db'));
  try {
    store.answerTicket(
      { name: 'Arthur', kind: 'human' },
      ticketId,
      { answer: 'Yes, resume this loop once.', chosen_option: 'Yes, resume this loop once.', resolution: 'resume' },
    );
  } finally {
    store.close();
  }
}

function answerInvestigate(e: Env, ticketId: string): void {
  const store = new Store(join(e.home, 'helm.db'));
  try {
    store.answerTicket(
      { name: 'Arthur', kind: 'human', session: 'dashboard' },
      ticketId,
      {
        answer: 'Ratified from the dashboard',
        chosen_option: 'investigate — consecutive failures usually mean something real',
        resolution: 'resume',
      },
    );
  } finally {
    store.close();
  }
}

function startFleet(e: Env): { proc: ChildProcess; out: () => string } {
  let buf = '';
  const proc = spawn(process.execPath, ['--import', 'tsx', REV_CLI, 'run'], { env: e.env, cwd: join(import.meta.dirname, '..') });
  proc.stdout!.on('data', (d: Buffer) => (buf += d.toString()));
  proc.stderr!.on('data', (d: Buffer) => (buf += d.toString()));
  return { proc, out: () => buf };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A burn-breaker halt is two mock iterations of serial helmo-cli spawns, so it
// scales with host load (H-675): measured for H-740 at load 27-65, the halt
// took 20.6-25.1s and a restart's failure return 20.1s, past the old 20s. 60s
// is over twice the worst measured; a hang still fails, naming what it awaited.
async function waitFor(cond: () => boolean, what: string, timeoutMs = 60000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(200);
  }
}

function loopPid(e: Env, loop: string): number | null {
  const p = join(e.home, 'state', loop, 'RUNNING');
  if (!existsSync(p)) return null;
  const pid = parseInt(readFileSync(p, 'utf8').split('\n')[0] ?? '', 10);
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

const claimAndClose = (ws: string) => `'''
set -e
ID=$(node ${HELM_CLI} list --ready --workstream ${ws} --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -n "$ID" ]; then
  node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
  node ${HELM_CLI} update --ticket $ID --note "completed by mock" --status done --evidence-kind file --evidence-ref /tmp/out
fi
'''`;

describe('rev fleet e2e (supervisor over mock loops, real helm store)', () => {
  it('keeps a scheduled-capacity loop down until its resume time', async () => {
    const e = setup(`[loops.scheduled]
workstream = "ws-scheduled"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`);
    const dir = join(e.home, 'state', 'scheduled');
    mkdirSync(dir, { recursive: true });
    const resumeAt = new Date(Date.now() + 2500).toISOString();
    writeFileSync(join(dir, 'LIMIT'), `kind=capacity\nresume_at=${resumeAt}\nreason=test fixture\n`);
    const { proc } = startFleet(e);
    try {
      await sleep(1200);
      expect(loopPid(e, 'scheduled')).toBeNull();
      expect(existsSync(join(dir, 'LIMIT'))).toBe(true);
      await waitFor(() => loopPid(e, 'scheduled') !== null, 'scheduled loop relaunched', 10000);
      expect(existsSync(join(dir, 'LIMIT'))).toBe(false);
      expect(readFileSync(join(dir, 'events.log'), 'utf8')).toContain('capacity-resume');
    } finally {
      proc.kill('SIGKILL');
      const p = loopPid(e, 'scheduled');
      if (p) process.kill(p, 'SIGKILL');
    }
  });

  it('general start runs every roster loop; both complete their work; rev stop drains cleanly', { timeout: 60000 }, async () => {
    const e = setup(`[loops.alpha]
workstream = "ws-a"
cwd = "/tmp"
runtime = "mock"
mock_cmd = ${claimAndClose('ws-a')}

[loops.beta]
workstream = "ws-b"
cwd = "/tmp"
runtime = "mock"
mock_cmd = ${claimAndClose('ws-b')}
`);
    const a = (helm(e, ['create', '--title', 'work A', '--body', 'x', '--workstream', 'ws-a', '--type', 'ops']) as { id: string }).id;
    const b = (helm(e, ['create', '--title', 'work B', '--body', 'x', '--workstream', 'ws-b', '--type', 'ops']) as { id: string }).id;

    const { proc, out } = startFleet(e);
    try {
      await waitFor(
        () =>
          (helm(e, ['get', a]) as { status: string }).status === 'done' &&
          (helm(e, ['get', b]) as { status: string }).status === 'done',
        'both tickets done',
      );
      // Both loops settle at the cursor; child output landed in per-loop console logs.
      await waitFor(() => existsSync(join(e.home, 'state', 'alpha', 'IDLE')) && existsSync(join(e.home, 'state', 'beta', 'IDLE')), 'both loops idle');
      expect(existsSync(join(e.home, 'state', 'alpha', 'console.log'))).toBe(true);

      const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
      rev(e, ['stop']);
      expect(await exited).toBe(0);

      const sup = readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8');
      expect(sup).toContain('fleet-start');
      expect(sup).toMatch(/spawn\s+loop=alpha/);
      expect(sup).toMatch(/spawn\s+loop=beta/);
      expect(sup).toContain('drain');
      expect(sup).toMatch(/fleet-stop\s+drained/);
      expect(out()).toContain('draining the fleet');
    } finally {
      proc.kill('SIGKILL');
    }
  });

  it('a SIGKILLed loop returns through the backoff; STOP holds until resume', { timeout: 60000 }, async () => {
    const e = setup(`[loops.solo]
workstream = "ws-solo"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`);
    const { proc } = startFleet(e);
    try {
      await waitFor(() => loopPid(e, 'solo') !== null, 'solo loop up');
      const pid1 = loopPid(e, 'solo')!;

      // Crash it: the supervisor must notice, mark BACKOFF, and respawn.
      process.kill(pid1, 'SIGKILL');
      await waitFor(() => {
        const p = loopPid(e, 'solo');
        return p !== null && p !== pid1;
      }, 'respawn with a new pid');
      const sup1 = readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8');
      expect(sup1).toMatch(/exit\s+loop=solo code=null .*action=respawn/);

      // STOP: the loop exits and stays down — the supervisor waits for clearance.
      rev(e, ['stop', 'solo']);
      await waitFor(() => loopPid(e, 'solo') === null, 'solo halted');
      await sleep(3000); // several polls: it must NOT come back on its own
      expect(loopPid(e, 'solo')).toBe(null);

      // Resume: the running supervisor picks it back up, no rev run needed.
      rev(e, ['resume', 'solo']);
      await waitFor(() => loopPid(e, 'solo') !== null, 'picked up after resume');
    } finally {
      proc.kill('SIGKILL');
    }
  });

  // A reload respawns one loop on the current roster and never clears a halt
  // (H-891). The roster edit changes what the mock runs, so the new marker
  // proves the respawned child read the roster again; the sibling's pid proves
  // the rest of the fleet was not drained.
  it('reload respawns one loop on the edited roster after its turn, leaving siblings running (H-891)', { timeout: 90000 }, async () => {
    const roster = (marker: string) => `[loops.solo]
workstream = "ws-solo"
cwd = "/tmp"
runtime = "mock"
mock_cmd = '''
sleep 2
touch "$REV_HOME/${marker}"
'''

[loops.sibling]
workstream = "ws-sibling"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`;
    const e = setup(roster('v1'));
    const { proc } = startFleet(e);
    try {
      await waitFor(() => loopPid(e, 'solo') !== null && loopPid(e, 'sibling') !== null, 'both loops up');
      const solo1 = loopPid(e, 'solo')!;
      const sibling1 = loopPid(e, 'sibling')!;
      await waitFor(() => existsSync(join(e.home, 'v1')), 'v1 session ran');

      const rosterPath = join(e.home, 'roster.toml');
      writeFileSync(rosterPath, readFileSync(rosterPath, 'utf8').replace('"$REV_HOME/v1"', '"$REV_HOME/v2"'));
      expect(rev(e, ['reload', 'solo'])).toMatch(/Reload requested for 'solo'/);

      await waitFor(() => existsSync(join(e.home, 'v2')), 'respawned loop runs the edited roster');
      expect(loopPid(e, 'solo')).not.toBe(solo1);
      expect(loopPid(e, 'sibling')).toBe(sibling1);
      const log = readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8');
      expect(log).toMatch(/reload\s+loop=solo pid=/);
      expect(log).toMatch(/exit\s+loop=solo code=143 action=respawn wait=0s \(reload\)/);
      expect(log).not.toMatch(/\bdrain\b/);
      expect(existsSync(join(e.home, 'state', 'solo', 'RELOAD'))).toBe(false);
    } finally {
      proc.kill('SIGKILL');
    }
  });

  // The race H-841 named: a halt set by someone else while the reload is in
  // flight. The STOP/HOLD lands after the supervisor has asked the loop to exit
  // and before the turn ends; the loop must stay down with the marker intact.
  for (const halt of ['STOP', 'HOLD'] as const) {
    it(`a ${halt} set by someone else during a reload survives it and keeps the loop down (H-891)`, { timeout: 90000 }, async () => {
      const e = setup(`[loops.solo]
workstream = "ws-solo"
cwd = "/tmp"
runtime = "mock"
mock_cmd = '''
touch "$REV_HOME/in-turn"
sleep 15
touch "$REV_HOME/turn-done"
'''
`);
      const { proc } = startFleet(e);
      const events = () => readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8');
      try {
        await waitFor(() => existsSync(join(e.home, 'in-turn')), 'session mid-turn');
        const pid1 = loopPid(e, 'solo')!;
        rev(e, ['reload', 'solo']);
        await waitFor(() => /reload\s+loop=solo/.test(events()), 'supervisor acted on the reload');
        expect(existsSync(join(e.home, 'turn-done'))).toBe(false); // still mid-operation

        const marker = join(e.home, 'state', 'solo', halt);
        writeFileSync(marker, 'by=someone-else\n');

        await waitFor(() => loopPid(e, 'solo') === null, 'loop exited after its turn');
        expect(existsSync(join(e.home, 'turn-done'))).toBe(true); // the turn finished, not killed
        await sleep(3000); // several polls: it must NOT come back on its own
        expect(loopPid(e, 'solo')).toBe(null);
        expect(readFileSync(marker, 'utf8')).toBe('by=someone-else\n');
        expect(events()).toMatch(/exit\s+loop=solo code=143 action=await_clearance \(reload\)/);
        expect(pid1).toBeGreaterThan(0);
      } finally {
        proc.kill('SIGKILL');
      }
    });
  }

  it('turns a human resume answer into a healthy running loop and closes the escalation (H-1038)',{ timeout: 150000 }, async () => {
    const e = setup(`[loops.resume-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
continue_cap = 1
mock_cmd = '''
if [ -f "$REV_HOME/resume-succeeds" ]; then exit 0; fi
ID=$(node ${HELM_CLI} list --assignee resume-loop --status in_progress --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -z "$ID" ]; then
  ID=$(node ${HELM_CLI} list --ready --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
  node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
fi
node ${HELM_CLI} update --ticket $ID --note "kept producing" --evidence-kind other --evidence-ref burn
exit 1
'''
`, 'fail_cap = 1');
    helm(e, ['create', '--title', 'work that burns', '--body', 'x', '--workstream', 'rev-test', '--type', 'ops']);
    const { proc } = startFleet(e);
    try {
      await waitFor(() => existsSync(join(e.home, 'state', 'resume-loop', 'BLOCKED')), 'burn breaker halt');
      await waitFor(() => (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets.length === 1, 'burn breaker escalation');
      const escalation = (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: { id: string }[] }).tickets[0]!;
      writeFileSync(join(e.home, 'resume-succeeds'), '');
      answerResume(e, escalation.id);

      await waitFor(() => loopPid(e, 'resume-loop') !== null, 'answered loop running');
      await waitFor(() => (helm(e, ['get', escalation.id]) as { status: string }).status === 'done', 'resume ticket closed');
      expect(existsSync(join(e.home, 'state', 'resume-loop', 'BLOCKED'))).toBe(false);
      // The supervisor closes the ticket before it logs the completion.
      await waitFor(() => /resume-complete.*ticket=H-/.test(readFileSync(join(e.home, 'state', 'resume-loop', 'events.log'), 'utf8')), 'resume completion logged');
    } finally {
      proc.kill('SIGKILL');
    }
  });

  it('stops completing a resume once another agent has already closed its escalation (H-2164)', { timeout: 150000 }, async () => {
    const e = setup(`[loops.closed-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
continue_cap = 1
mock_cmd = '''
if [ -f "$REV_HOME/resume-succeeds" ]; then exit 0; fi
ID=$(node ${HELM_CLI} list --assignee closed-loop --status in_progress --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -z "$ID" ]; then
  ID=$(node ${HELM_CLI} list --ready --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
  node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
fi
node ${HELM_CLI} update --ticket $ID --note "kept producing" --evidence-kind other --evidence-ref burn
exit 1
'''
`, 'fail_cap = 1', 6);
    helm(e, ['create', '--title', 'work that burns', '--body', 'x', '--workstream', 'rev-test', '--type', 'ops']);
    const { proc } = startFleet(e);
    const events = () => readFileSync(join(e.home, 'state', 'closed-loop', 'events.log'), 'utf8');
    try {
      await waitFor(() => (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets.length === 1, 'burn breaker escalation');
      const escalation = (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: { id: string }[] }).tickets[0]!;
      writeFileSync(join(e.home, 'resume-succeeds'), '');
      answerResume(e, escalation.id);
      await waitFor(() => /answer-resume/.test(events()), 'answered loop restarted');

      // A sweeping agent reads the answer and closes the escalation inside
      // the min-uptime window, before the supervisor gets to.
      helm(e, ['update', '--ticket', escalation.id, '--note', 'closed by a sweep', '--status', 'done', '--evidence-kind', 'other', '--evidence-ref', 'x'],
        '{"name":"sweeper","kind":"agent","model":"t","version":"0"}');

      await waitFor(() => /resume-complete.*already closed/.test(events()), 'completion stands down');
      await sleep(3000); // several polls: it must not keep retrying
      expect(events()).not.toMatch(/resume-completion-failed/);
      expect(events().match(/resume-complete/g)).toHaveLength(1);
    } finally {
      proc.kill('SIGKILL');
    }
  });

  it('leaves a blocked loop down when the dashboard answer chooses investigate (H-1320)', { timeout: 150000 }, async () => {
    const e = setup(`[loops.investigate-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
continue_cap = 1
mock_cmd = '''
ID=$(node ${HELM_CLI} list --assignee investigate-loop --status in_progress --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -z "$ID" ]; then
  ID=$(node ${HELM_CLI} list --ready --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
  node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
fi
node ${HELM_CLI} update --ticket $ID --note "kept producing" --evidence-kind other --evidence-ref burn
exit 1
'''
`, 'fail_cap = 1');
    helm(e, ['create', '--title', 'work that reaches the breaker', '--body', 'x', '--workstream', 'rev-test', '--type', 'ops']);
    const { proc } = startFleet(e);
    try {
      await waitFor(() => existsSync(join(e.home, 'state', 'investigate-loop', 'BLOCKED')), 'burn breaker halt');
      await waitFor(() => (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets.length === 1, 'burn breaker escalation');
      const escalation = (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: { id: string }[] }).tickets[0]!;
      answerInvestigate(e, escalation.id);

      await sleep(3000); // several supervisor polls: the answer must not restart it
      expect(loopPid(e, 'investigate-loop')).toBeNull();
      expect(existsSync(join(e.home, 'state', 'investigate-loop', 'BLOCKED'))).toBe(true);
      expect((helm(e, ['get', escalation.id]) as { status: string }).status).toBe('open');
      expect(readFileSync(join(e.home, 'state', 'investigate-loop', 'events.log'), 'utf8')).not.toContain('answer-resume');
    } finally {
      proc.kill('SIGKILL');
    }
  });

  it('accepts one matching peer false-alarm disposition without involving the human (H-188)', { timeout: 60000 }, async () => {
    const e = setup(`[loops.worker]
workstream = "ws-worker"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"

[loops.reviewer]
workstream = "ws-review"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`);
    const reason = 'anomaly: fixture rate';
    const ticket = (helm(e, ['create', '--title', "Loop 'worker' is blocked: needs a decision", '--body', 'investigate', '--workstream', 'rev-test', '--type', 'ops', '--priority', '0', '--assignee', 'reviewer']) as { id: string }).id;
    helm(e, ['update', '--ticket', ticket, '--note', 'claimed investigation and proved the fixture baseline stale', '--status', 'in_progress', '--evidence-kind', 'other', '--evidence-ref', `rev:false_alarm:${encodeURIComponent(reason)}`],
      '{"name":"reviewer","kind":"agent","model":"t","version":"0","session":"rev:reviewer"}');
    const dir = join(e.home, 'state', 'worker');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'BLOCKED'), `kind=anomaly\nreason=${reason}\n`);
    writeFileSync(join(dir, 'BLOCKED.json'), JSON.stringify({ kind: 'anomaly', reason, investigation_ticket: ticket }));
    const { proc } = startFleet(e);
    try {
      await waitFor(() => loopPid(e, 'worker') !== null, 'peer-released loop running');
      await waitFor(() => (helm(e, ['get', ticket]) as { status: string }).status === 'done', 'investigation closed after healthy restart');
      expect(existsSync(join(dir, 'BLOCKED'))).toBe(false);
      expect(existsSync(join(dir, 'BLOCKED.json'))).toBe(false);
      expect(existsSync(join(dir, '.auto_release.json'))).toBe(false);
      expect(readFileSync(join(dir, 'events.log'), 'utf8')).toMatch(/agent-resume.*BLOCKED cleared/);
      expect((helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets).toHaveLength(0);
    } finally {
      proc.kill('SIGKILL');
    }
  });

  it('does not consume a new incident disposition from stale release state (H-2779)', { timeout: 60000 }, async () => {
    const e = setup(`[loops.worker]
workstream = "ws-worker"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`);
    const reason = 'burn breaker: fixture repeat';
    const ticket = (helm(e, ['create', '--title', "Loop 'worker' is blocked: needs a decision", '--body', 'investigate', '--workstream', 'rev-test', '--type', 'ops', '--priority', '0', '--assignee', 'reviewer']) as { id: string }).id;
    helm(e, ['update', '--ticket', ticket, '--note', 'claimed the new incident and found one false alarm', '--status', 'in_progress', '--evidence-kind', 'other', '--evidence-ref', `rev:false_alarm:${encodeURIComponent(reason)}`],
      '{"name":"reviewer","kind":"agent","model":"t","version":"0","session":"rev:reviewer"}');
    const dir = join(e.home, 'state', 'worker');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'BLOCKED'), `kind=burn\nreason=${reason}\n`);
    writeFileSync(join(dir, 'BLOCKED.json'), JSON.stringify({ kind: 'burn', reason, investigation_ticket: ticket }));
    writeFileSync(join(dir, '.auto_release.json'), JSON.stringify({ ticket: 'H-previous', reason, at: new Date(Date.now() - 172800000).toISOString(), attempts: 1, dispositions: 1, relapse_recorded: true }));
    const { proc } = startFleet(e);
    try {
      await waitFor(() => loopPid(e, 'worker') !== null, 'new incident disposition releases loop');
      await waitFor(() => (helm(e, ['get', ticket]) as { status: string }).status === 'done', 'new investigation closes');
      const store = new Store(join(e.home, 'helm.db'));
      try {
        expect(store.getEvents(ticket).some((event: { payload?: { note?: string } }) =>
          event.payload?.note?.includes('authorized one restart only'))).toBe(false);
      } finally {
        store.close();
      }
    } finally {
      proc.kill('SIGKILL');
    }
  });

  it('keeps a same-reason relapse with its peer investigator instead of releasing twice (H-2779)', { timeout: 60000 }, async () => {
    const e = setup(`[loops.worker]
workstream = "ws-worker"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`);
    const reason = 'capacity: fixture exhausted';
    const ticket = (helm(e, ['create', '--title', "Loop 'worker' is blocked: needs a decision", '--body', 'investigate', '--workstream', 'rev-test', '--type', 'ops', '--priority', '0', '--assignee', 'reviewer']) as { id: string }).id;
    helm(e, ['update', '--ticket', ticket, '--note', 'claimed investigation and found one false alarm', '--status', 'in_progress', '--evidence-kind', 'other', '--evidence-ref', `rev:false_alarm:${encodeURIComponent(reason)}`],
      '{"name":"reviewer","kind":"agent","model":"t","version":"0","session":"rev:reviewer"}');
    const dir = join(e.home, 'state', 'worker');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'BLOCKED'), `kind=capacity\nreason=${reason}\n`);
    writeFileSync(join(dir, 'BLOCKED.json'), JSON.stringify({ kind: 'capacity', reason, investigation_ticket: ticket }));
    writeFileSync(join(dir, '.auto_release.json'), JSON.stringify({ ticket, reason, at: new Date().toISOString(), dispositions: 1 }));
    const { proc } = startFleet(e);
    try {
      await waitFor(() => {
        const store = new Store(join(e.home, 'helm.db'));
        try {
          return store.getEvents(ticket).some((event: { payload?: { note?: string } }) => event.payload?.note?.includes('authorized one restart only'));
        } finally {
          store.close();
        }
      }, 'relapse recorded');
      expect(loopPid(e, 'worker')).toBeNull();
      expect(existsSync(join(dir, 'BLOCKED'))).toBe(true);
      expect((helm(e, ['get', ticket]) as { status: string }).status).toBe('in_progress');
      expect((helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets).toHaveLength(0);
      await sleep(2500);
      const store = new Store(join(e.home, 'helm.db'));
      try {
        const relapseNotes = store.getEvents(ticket).filter((event: { payload?: { note?: string } }) =>
          event.payload?.note?.includes('authorized one restart only'));
        expect(relapseNotes).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      proc.kill('SIGKILL');
    }
  });

  it('restores structured peer ownership when the released loop trips its own fail ladder (H-2779)', { timeout: 60000 }, async () => {
    const e = setup(`[loops.worker]
workstream = "ws-worker"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "exit 1"

[loops.reviewer]
workstream = "ws-review"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`, 'fail_cap = 1\nrelapse_window_seconds = 1', 20);
    helm(e, ['create', '--title', 'work that exposes a persistent runtime fault', '--body', 'x', '--workstream', 'ws-worker', '--type', 'ops']);
    const reason = 'burn breaker: fixture iteration cap';
    const ticket = (helm(e, ['create', '--title', "Loop 'worker' is blocked: needs a decision", '--body', 'investigate', '--workstream', 'rev', '--type', 'ops', '--priority', '0', '--assignee', 'reviewer']) as { id: string }).id;
    helm(e, ['update', '--ticket', ticket, '--note', 'claimed investigation and found one false alarm', '--status', 'in_progress', '--evidence-kind', 'other', '--evidence-ref', `rev:false_alarm:${encodeURIComponent(reason)}`],
      '{"name":"reviewer","kind":"agent","model":"t","version":"0","session":"rev:reviewer"}');
    const dir = join(e.home, 'state', 'worker');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'BLOCKED'), `kind=burn\nreason=${reason}\n`);
    writeFileSync(join(dir, 'BLOCKED.json'), JSON.stringify({ kind: 'burn', reason, investigation_ticket: ticket }));
    const { proc } = startFleet(e);
    try {
      await waitFor(() => existsSync(join(dir, 'events.log')) && /agent-resume-failed/.test(readFileSync(join(dir, 'events.log'), 'utf8')), 'peer-owned failed resume recorded');
      const blocked = JSON.parse(readFileSync(join(dir, 'BLOCKED.json'), 'utf8')) as { kind: string; reason: string; investigation_ticket: string };
      const release = JSON.parse(readFileSync(join(dir, '.auto_release.json'), 'utf8')) as { ticket: string; reason: string; attempts: number; dispositions: number; relapse_recorded: boolean };
      expect(blocked).toMatchObject({ kind: 'burn', investigation_ticket: ticket });
      expect(blocked.reason).toContain('runtime failed');
      expect(release).toMatchObject({ ticket, reason: blocked.reason, attempts: 1, dispositions: 0, relapse_recorded: true });
      expect((helm(e, ['get', ticket]) as { status: string }).status).toBe('in_progress');
      expect((helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets).toHaveLength(0);
      const store = new Store(join(e.home, 'helm.db'));
      try {
        expect(store.getEvents(ticket).some((event: { payload?: { note?: string } }) =>
          event.payload?.note?.includes('authorized restart failed before becoming healthy'))).toBe(true);
      } finally {
        store.close();
      }
      await sleep(2500);
      expect(readFileSync(join(dir, 'events.log'), 'utf8').match(/agent-resume .*BLOCKED cleared/g) ?? []).toHaveLength(1);
    } finally {
      proc.kill('SIGKILL');
    }
  });

  it('keeps peer-owned recovery structured across a supervisor drain (H-2779)', { timeout: 60000 }, async () => {
    const e = setup(`[loops.worker]
workstream = "ws-worker"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "sleep 2; exit 1"

[loops.reviewer]
workstream = "ws-review"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`, 'fail_cap = 1', 20);
    helm(e, ['create', '--title', 'work that survives the fleet drain', '--body', 'x', '--workstream', 'ws-worker', '--type', 'ops']);
    const reason = 'burn breaker: fixture drain';
    const ticket = (helm(e, ['create', '--title', "Loop 'worker' is blocked: needs a decision", '--body', 'investigate', '--workstream', 'rev', '--type', 'ops', '--priority', '0', '--assignee', 'reviewer']) as { id: string }).id;
    helm(e, ['update', '--ticket', ticket, '--note', 'claimed investigation and found one false alarm', '--status', 'in_progress', '--evidence-kind', 'other', '--evidence-ref', `rev:false_alarm:${encodeURIComponent(reason)}`],
      '{"name":"reviewer","kind":"agent","model":"t","version":"0","session":"rev:reviewer"}');
    const dir = join(e.home, 'state', 'worker');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'BLOCKED'), `kind=burn\nreason=${reason}\n`);
    writeFileSync(join(dir, 'BLOCKED.json'), JSON.stringify({ kind: 'burn', reason, investigation_ticket: ticket }));
    const first = startFleet(e);
    let second: ChildProcess | null = null;
    try {
      await waitFor(() => existsSync(join(dir, 'events.log')) && /agent-resume .*BLOCKED cleared/.test(readFileSync(join(dir, 'events.log'), 'utf8')), 'peer release before drain');
      const exited = new Promise<number | null>((resolve) => first.proc.on('exit', resolve));
      first.proc.kill('SIGTERM');
      expect(await exited).toBe(0);
      second = startFleet(e).proc;
      await waitFor(() => {
        const history = JSON.parse(readFileSync(join(dir, '.auto_release.json'), 'utf8')) as { relapse_recorded?: boolean };
        return history.relapse_recorded === true;
      }, 'drain-safe relapse record');
      const blocked = JSON.parse(readFileSync(join(dir, 'BLOCKED.json'), 'utf8')) as { kind: string; reason: string; investigation_ticket: string };
      expect(blocked).toMatchObject({ kind: 'burn', investigation_ticket: ticket });
      expect(blocked.reason).toContain('runtime failed');
      expect(existsSync(join(dir, 'BLOCKED'))).toBe(true);
      expect((helm(e, ['get', ticket]) as { status: string }).status).toBe('in_progress');
      expect((helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets).toHaveLength(0);
      const store = new Store(join(e.home, 'helm.db'));
      try {
        expect(store.getEvents(ticket).filter((event: { payload?: { note?: string } }) =>
          event.payload?.note?.includes('authorized one restart only'))).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      first.proc.kill('SIGKILL');
      second?.kill('SIGKILL');
      const p = loopPid(e, 'worker');
      if (p) process.kill(p, 'SIGKILL');
    }
  });

  // The restarted loop does not die on its first failed run: it fails, retries,
  // and only the burn breaker halts it, so its death is a couple of seconds
  // out. Against min_uptime_seconds = 1 that is a race the supervisor can win
  // on a loaded machine — it finds the child still alive one second in, calls
  // the resume healthy, closes the ticket, and the failure return this case
  // asserts never happens. Idle it loses that race and the case passes, which
  // is why the flake only showed under load (H-1419). Twenty seconds is the
  // real fleet's shape anyway (the shipped default is 60) and leaves the loop
  // roughly ten times the room it needs to block itself. Do not compress it
  // back for speed: nothing in this case waits on it.
  it('blocks again and returns the answered ticket when the restarted loop fails (H-1038)', { timeout: 150000 }, async () => {
    const e = setup(
      `[loops.resume-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
continue_cap = 1
mock_cmd = '''
if [ -f "$REV_HOME/resume-fails" ]; then exit 1; fi
ID=$(node ${HELM_CLI} list --assignee resume-loop --status in_progress --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -z "$ID" ]; then
  ID=$(node ${HELM_CLI} list --ready --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
  node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
fi
node ${HELM_CLI} update --ticket $ID --note "kept producing" --evidence-kind other --evidence-ref burn
exit 1
'''
`,
      'fail_cap = 1',
      20,
    );
    helm(e, ['create', '--title', 'work that burns', '--body', 'x', '--workstream', 'rev-test', '--type', 'ops']);
    const { proc } = startFleet(e);
    try {
      await waitFor(() => existsSync(join(e.home, 'state', 'resume-loop', 'BLOCKED')), 'burn breaker halt');
      await waitFor(() => (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets.length === 1, 'burn breaker escalation');
      const escalation = (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: { id: string }[] }).tickets[0]!;
      writeFileSync(join(e.home, 'resume-fails'), '');
      answerResume(e, escalation.id);

      await waitFor(() => {
        const t = helm(e, ['get', escalation.id]) as { status: string; question?: { situation: string } };
        return t.status === 'awaiting_human' && !!t.question?.situation.includes('restarted worker failed');
      }, 'restart failure returned to human');
      expect(existsSync(join(e.home, 'state', 'resume-loop', 'BLOCKED'))).toBe(true);
      // Logged after the return to the human, so wait for it.
      await waitFor(() => /resume-failed.*ticket=H-/.test(readFileSync(join(e.home, 'state', 'resume-loop', 'events.log'), 'utf8')), 'resume failure logged');
    } finally {
      proc.kill('SIGKILL');
    }
  });

  it('an abandoned tree drains itself: killing an ancestor takes the whole fleet down (H-281)', { timeout: 60000 }, async () => {
    const e = setup(`[loops.stray]
workstream = "ws-stray"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`);
    // This case deliberately needs a disposable wrapper above the supervisor:
    // killing that ancestor is the behavior under test.
    const proc = spawn('npx', ['tsx', REV_CLI, 'run'], { env: e.env, cwd: join(import.meta.dirname, '..') });
    try {
      await waitFor(() => loopPid(e, 'stray') !== null, 'loop up');
      expect(loopPid(e, 'supervisor')).not.toBeNull();
      // Kill only the outermost wrapper (npx). The real supervisor and its
      // loop survive with every inner ppid link intact — the exact shape of
      // the 2026-08-28 orphan swarm. The lineage watchdog must notice the
      // broken chain and drain the whole tree.
      proc.kill('SIGKILL');
      await waitFor(() => loopPid(e, 'supervisor') === null && loopPid(e, 'stray') === null, 'orphaned tree self-terminated', 30000);
      const log = readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8');
      expect(log).toContain('orphaned');
      expect(log).toMatch(/fleet-stop\s+drained/);
    } finally {
      // If the watchdog failed, reap the real pids so the suite leaves no swarm.
      for (const n of ['supervisor', 'stray']) {
        const p = loopPid(e, n);
        if (p) process.kill(p, 'SIGKILL');
      }
    }
  });
  it('the drain escalation ends the straggler\'s session, not just its loop (H-1089)', { timeout: 60000 }, async () => {
    // The shape that cost H-1086 a gate run: a redeploy drains while an agent
    // CLI is mid-turn, the grace expires, the loop is SIGKILLed — and the CLI,
    // in its own detached group (H-467), reparents to init and keeps working
    // while the returning fleet starts a second session for the same seat.
    // The mock stands in for the CLI: it records its own pid and outlives any
    // grace. What must be true after the drain is that pid is gone.
    const e = setup(
      `[loops.slow]
workstream = "ws-slow"
cwd = "/tmp"
runtime = "mock"
mock_cmd = '''
echo $$ > "$REV_HOME/session.pid"
sleep 300
'''
`,
      'drain_grace_seconds = 3',
    );
    const { proc } = startFleet(e);
    const sessionPid = (): number => parseInt(readFileSync(join(e.home, 'session.pid'), 'utf8').trim(), 10);
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let session = 0;
    try {
      await waitFor(() => existsSync(join(e.home, 'session.pid')), 'session started');
      session = sessionPid();
      // Two assertions, not one: the session must be genuinely mid-flight when
      // the drain lands, or its absence afterwards proves nothing.
      expect(alive(session)).toBe(true);

      const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
      rev(e, ['stop']);
      expect(await exited).toBe(0);

      await waitFor(() => !alive(session), 'session ended with its loop', 10000);
      const log = readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8');
      expect(log).toMatch(/drain-kill\s+loop=slow/);
      expect(log).toMatch(new RegExp(`drain-kill-session\\s+loop=slow group=${session}`));
    } finally {
      proc.kill('SIGKILL');
      try {
        if (session) process.kill(-session, 'SIGKILL');
      } catch {
        /* already gone: the point of the test */
      }
    }
  });

  it('a loop redeploys the fleet to activate its own fix, with no human in the path (H-1046)', { timeout: 90000 }, async () => {
    const e = setup(`[loops.shipper]
workstream = "ws-ship"
cwd = "${join(import.meta.dirname, '..')}"
runtime = "mock"
mock_cmd = '''
set -e
if [ -f "$REV_HOME/asked" ]; then exit 0; fi
ID=$(node ${HELM_CLI} list --ready --workstream ws-ship --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -z "$ID" ]; then exit 0; fi
node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
touch "$REV_HOME/asked"
npx tsx ${REV_CLI} redeploy --ticket $ID --reason "activate the fix this iteration landed"
'''
`);
    const t = (helm(e, ['create', '--title', 'a fix in rev itself', '--body', 'x', '--workstream', 'ws-ship', '--type', 'build']) as { id: string }).id;

    const first = startFleet(e);
    let supEvents = '';
    try {
      // The supervisor drains itself and exits UNSUCCESSFULLY on purpose:
      // that is the exit launchd and systemd bring back on the new code.
      const exited = new Promise<number | null>((r) => first.proc.on('exit', (code) => r(code)));
      expect(await exited).toBe(75);
      supEvents = readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8');
      expect(supEvents).toMatch(/redeploy-ask\s+by=shipper ticket=H-/);
      expect(supEvents).toMatch(/drain\s+signal=redeploy/);
      expect(supEvents).toMatch(/fleet-stop\s+drained for redeploy/);
      expect(existsSync(join(e.home, 'state', 'supervisor', 'REDEPLOY'))).toBe(true);
      // Nothing was asked of the human anywhere in that.
      expect((helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets).toHaveLength(0);
    } finally {
      first.proc.kill('SIGKILL');
    }

    // The service manager's part, played by hand: start it again. The new
    // supervisor treats the sentinel as the record of a landing, not a fresh
    // ask — otherwise a redeploy would loop forever — and says so on the ticket.
    const second = startFleet(e);
    try {
      await waitFor(() => !existsSync(join(e.home, 'state', 'supervisor', 'REDEPLOY')), 'redeploy record cleared at startup');
      await waitFor(() => (helm(e, ['get', t]) as { evidence: unknown[] }).evidence.length > 0, 'landing noted on the ticket');
      const ticket = helm(e, ['get', t]) as { status: string; evidence: { ref: string }[] };
      expect(ticket.status).toBe('in_progress');
      expect(ticket.evidence[0]!.ref).toBe(join(e.home, 'state', 'supervisor', 'events.log'));
      const after = readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8');
      expect(after).toMatch(/redeploy-done\s+by=shipper ticket=H-/);
      expect(after.slice(supEvents.length)).toContain('fleet-start');
      // It stays landed: the record is gone, so no second drain follows.
      await sleep(3000);
      expect(loopPid(e, 'supervisor')).not.toBeNull();
    } finally {
      second.proc.kill('SIGKILL');
      const p = loopPid(e, 'shipper');
      if (p) process.kill(p, 'SIGKILL');
    }
  });

  it('a redeploy nothing comes back from reaches the human, named (H-1046)', { timeout: 90000 }, async () => {
    const e = setup(
      `[loops.quiet]
workstream = "ws-quiet"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`,
      'redeploy_deadline_seconds = 6',
    );
    const { proc } = startFleet(e);
    try {
      await waitFor(() => loopPid(e, 'quiet') !== null, 'loop up');
      const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
      rev(e, ['redeploy', '--reason', 'activate a fix', '--by', 'tester']);
      expect(await exited).toBe(75);

      // Nothing restarts it. The watch armed at the drain is the only thing
      // still running, and the outage must not be silent.
      await waitFor(
        () => (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets.length === 1,
        'the failed redeploy reached the human',
        40000,
      );
      const filed = (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: { id: string; title: string }[] }).tickets[0]!;
      expect(filed.title).toContain('no supervisor came back');
      const full = helm(e, ['get', filed.id]) as { question: { situation: string } };
      expect(full.question.situation).toContain('no supervisor returned within 6s');
      expect(readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8')).toContain('redeploy-failed');
    } finally {
      proc.kill('SIGKILL');
      const p = loopPid(e, 'quiet');
      if (p) process.kill(p, 'SIGKILL');
    }
  });
});
