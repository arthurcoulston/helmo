import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

// H-1782 / H-1783. `flag()` read a flag's value as "the argv slot after the
// flag's name", so a flag written bare returned undefined — indistinguishable
// from never passed. Rev wrote `--needs-human` bare, the marker silently never
// landed, and the failure looked exactly like success for a whole day.

const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '0.1' };
const writer: Actor = { name: 'builder-loop', kind: 'agent', model: 'claude-opus-5', version: 'claude-code-2.1.221' };

let dir: string;
let dbPath: string;
let ticket: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'helmo-cli-'));
  dbPath = join(dir, 'helmo.db');
  const s = new Store(dbPath);
  ticket = s.createTicket(orch, {
    title: 'Build the importer',
    body: 'Goal: import CSVs from ./data. Current state: not started.',
    workstream: 'helmo-dev',
    type: 'build',
    assignee: 'builder-loop',
  }).id;
  s.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cli(...argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', ...argv],
    {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, HELMO_DB: dbPath, HELMO_ACTOR: JSON.stringify(writer) },
      encoding: 'utf8',
    },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function read() {
  const s = new Store(dbPath);
  const t = s.getTicket(ticket);
  s.close();
  return t;
}

describe('get carries the ticket\'s links', () => {
  it('returns deps as the MCP get does, so a link-only change is visible to a CLI reader', () => {
    expect(JSON.parse(cli('get', '--ticket', ticket).stdout).deps).toEqual({ outgoing: [], incoming: [] });
    const child = JSON.parse(cli('create', '--title', 'Subtask', '--body', 'Goal: a link. Current state: none.', '--workstream', 'helmo-dev', '--type', 'ops', '--dep', ticket, '--dep-type', 'parent').stdout).id;
    expect(JSON.parse(cli('get', '--ticket', ticket).stdout).deps).toEqual({ outgoing: [], incoming: [{ from_id: child, to_id: ticket, type: 'parent' }] });
  });

  it('adds history and open blocker ownership only when requested', () => {
    const blocker = JSON.parse(cli('create', '--title', 'Review', '--body', 'Review the candidate.', '--workstream', 'helmo-dev', '--type', 'review', '--assignee', 'proof').stdout).id;
    const s = new Store(dbPath);
    s.linkTickets(orch, ticket, blocker, 'blocks', 'add');
    s.close();
    expect(JSON.parse(cli('get', '--ticket', ticket).stdout).events).toBeUndefined();
    const history = JSON.parse(cli('get', '--ticket', ticket, '--history').stdout);
    expect(history.events.length).toBeGreaterThan(0);
    expect(history.blockers).toEqual([{ id: blocker, status: 'open', assignee: 'proof', needs_human: false }]);
  });

  it('projects trace metadata without ticket or event content', () => {
    const secret = 'SYNTHETIC_PRIVATE_' + 'x'.repeat(10_000);
    const s = new Store(dbPath);
    s.updateTicket(orch, { ticket_id: ticket, note: secret });
    s.close();
    const trace = cli('get', '--ticket', ticket, '--trace');
    expect(trace.status).toBe(0);
    expect(trace.stdout).not.toContain('Build the importer');
    expect(trace.stdout).not.toContain('SYNTHETIC_PRIVATE_');
    expect(JSON.parse(trace.stdout)).toMatchObject({
      id: ticket, events: expect.arrayContaining([expect.objectContaining({ actor: expect.any(Object) })]),
    });
  });
});

describe('a flag that takes a value must be given one (H-1783)', () => {
  it('refuses the bare flag at the end of argv, by name, and writes nothing', () => {
    const r = cli('update', '--ticket', ticket, '--note', 'quarantined: no answer in 24h', '--needs-human');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--needs-human was given no value');
    // The harm in H-1782 was not the missing marker alone: the rest of the
    // write landed, so the call looked like it had worked. A refused call
    // leaves the ticket exactly as it was.
    expect(read().needs_human).toBeFalsy();
    expect(read().status).toBe('open');
  });

  it('refuses a bare flag sitting immediately before the next flag', () => {
    const r = cli('update', '--ticket', ticket, '--note', '--status', 'in_progress');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--note was given no value');
    expect(read().status).toBe('open');
  });

  it('takes a value that itself starts with dashes through --flag=value', () => {
    const r = cli('update', '--ticket', ticket, '--note=--needs-human never reached the store');

    expect(r.status, r.stderr).toBe(0);
    expect(read().status).toBe('open');
  });

  it('still reads an ordinary value written after the flag', () => {
    // Marking a sitting and claiming are separate writes by the store's own
    // rule, so this is the marker on its own — the write H-1782 lost.
    const r = cli('update', '--ticket', ticket, '--note', 'this one needs Arthur', '--needs-human', 'Two clicks in the Cloudflare dashboard');

    expect(r.status, r.stderr).toBe(0);
    const t = read();
    expect(t.needs_human).toBe(true);
    expect(t.sitting).toBe('Two clicks in the Cloudflare dashboard');
  });
});

describe('a flag that takes no value must not be given one (H-1783)', () => {
  it('refuses --takeover=true rather than ignoring it', () => {
    const r = cli('update', '--ticket', ticket, '--note', 'taking it over', '--status', 'in_progress', '--takeover=true');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--takeover takes no value');
  });
});

describe('explicit human request commands (R-42 I13)', () => {
  it('requests an action and records the human report without granting permission', () => {
    const requested = cli(
      'action', '--ticket', ticket,
      '--situation', 'The preview is ready and only the registrar remains.',
      '--action', 'Five minutes in the registrar: bind the domain.',
      '--why-human', 'The account belongs to Arthur and the agent has no credential.',
    );
    expect(requested.status, requested.stderr).toBe(0);
    expect(read()).toMatchObject({ status: 'awaiting_human', question: null, action: { kind: 'action' } });

    const reported = cli('action-report', '--ticket', ticket, '--did', 'I bound the domain to the supplied nameservers.');
    expect(reported.status, reported.stderr).toBe(0);
    expect(read()).toMatchObject({ status: 'open', question: null, action: null });
  });

  it('names the agent on a sitting rather than burying it in prose', () => {
    const marked = cli(
      'update', '--ticket', ticket, '--note', 'This needs interpretation together.',
      '--needs-human', 'Twenty minutes comparing the migration paths and choosing which risk to carry.',
      '--sitting-with', 'mason',
    );
    expect(marked.status, marked.stderr).toBe(0);
    expect(read()).toMatchObject({ needs_human: true, sitting_with: 'mason' });
  });
});

describe('the bounded release-handoff command', () => {
  it('records the handoff and sitting atomically from one JSON record', () => {
    const proof: Actor = { name: 'proof', kind: 'agent', model: 'gpt-6', version: '1' };
    const ward: Actor = { name: 'ward', kind: 'agent', model: 'gpt-6', version: '1' };
    const s = new Store(dbPath);
    const clearance = s.createTicket(orch, {
      title: 'Clear the release', body: 'Independent security clearance.', workstream: 'security', type: 'review', assignee: 'ward',
    });
    const ref = `crew@${'a'.repeat(40)}`;
    s.recordProductCompletion(writer, { ticket_id: ticket, artifacts: [{ ref, author: writer.name }], note: 'candidate' });
    const technical = s.recordAcceptanceVerdict(proof, { ticket_id: ticket, refs: [ref], verdict: 'pass', note: 'passes' });
    s.recordProductCompletion(writer, { ticket_id: clearance.id, artifacts: [{ ref, author: writer.name }], note: 'candidate' });
    const security = s.recordAcceptanceVerdict(ward, { ticket_id: clearance.id, refs: [ref], verdict: 'pass', note: 'clear' });
    s.close();

    const record = {
      manifest_sha256: 'b'.repeat(64), manifest: { refs: [ref] },
      technical_ticket: ticket, technical_completion_seq: technical.completion!.seq,
      technical_verdict_seq: technical.verdict!.seq, technical_reviewer: proof.name,
      clearance_ticket: clearance.id, clearance_completion_seq: security.completion!.seq,
      clearance_verdict_seq: security.verdict!.seq, clearance_reviewer: ward.name,
      gate_receipt: { path: '/tmp/gate.json', sha256: 'c'.repeat(64) },
      publisher_receipt: { path: '/tmp/publish.json', sha256: 'd'.repeat(64) },
      decision: 'Ten minutes deciding whether to carry the named material release risk.',
      why_human: 'material_risk_exception: A material risk exception is reserved to Arthur.', sitting_with: 'mason',
    };
    const r = cli('release-handoff', '--ticket', ticket, '--record', JSON.stringify(record));
    expect(r.status, r.stderr).toBe(0);
    expect(read()).toMatchObject({ needs_human: true, sitting_with: 'mason', release_handoff: { current: true } });
  });
});

// H-1830. A verdict is the write that lets reviewed work through, and Helmo's
// actor is caller-supplied on a store file the user can write. Ward's daily
// sweep replays every verdict recorded in ward's name so a forged PASS is seen
// within a day — and it must do that without opening helmo.db itself (H-936),
// which is what this command is for.
describe('the verdicts replay (H-1830)', () => {
  function reviewed(
    s: Store,
    { workstream, reviewer, verdict, note, sha }:
      { workstream: string; reviewer: Actor; verdict: 'pass' | 'fail'; note: string; sha: string },
  ): string {
    const t = s.createTicket(orch, {
      title: `Change the routing in ${workstream}`,
      body: 'Goal: one reviewed configuration change. Current state: awaiting review.',
      workstream,
      type: 'build',
      status: 'in_progress',
      assignee: writer.name,
    });
    const ref = `crew@${sha.repeat(40)}`;
    s.recordProductCompletion(writer, {
      ticket_id: t.id,
      artifacts: [{ ref, author: writer.name }],
      note: 'This exact source is ready for review.',
    });
    s.recordAcceptanceVerdict(reviewer, { ticket_id: t.id, refs: [ref], verdict, note });
    return t.id;
  }

  const ward: Actor = { name: 'ward', kind: 'agent', model: 'claude-fable-5-1', version: '0.5', session: 'rev:ward' };
  const proof: Actor = { name: 'proof', kind: 'agent', model: 'gpt-6-astra', version: 'rev 0.4' };

  let securityTicket: string;
  let devTicket: string;
  let maxSeq: number;

  beforeEach(() => {
    const s = new Store(dbPath);
    securityTicket = reviewed(s, { workstream: 'security', reviewer: ward, verdict: 'pass', note: 'The runner refuses an unpinned target.', sha: 'a' });
    devTicket = reviewed(s, { workstream: 'helmo-dev', reviewer: proof, verdict: 'fail', note: 'The negative control never went red.', sha: 'b' });
    maxSeq = s.maxSeq();
    s.close();
  });

  it('returns every verdict oldest first, with the fields the sweep parses', () => {
    const r = cli('verdicts', '--since-seq', '0');

    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { max_seq: number; verdicts: Record<string, unknown>[] };
    expect(out.max_seq).toBe(maxSeq);
    expect(out.verdicts.map((v) => v['ticket_id'])).toEqual([securityTicket, devTicket]);
    expect(out.verdicts[0]).toMatchObject({
      ticket_id: securityTicket,
      workstream: 'security',
      actor: { name: 'ward', kind: 'agent', session: 'rev:ward' },
      refs: [`crew@${'a'.repeat(40)}`],
      verdict: 'pass',
      note: 'The runner refuses an unpinned target.',
    });
    // A failed review is not an absence of one: the sweep has to see it.
    expect(out.verdicts[1]).toMatchObject({ verdict: 'fail', workstream: 'helmo-dev' });
    // No session recorded is the field absent, not null — same shape as answers.
    expect(out.verdicts[1]!['actor']).not.toHaveProperty('session');
  });

  it('narrows to one reviewer and to one workstream', () => {
    const byWard = JSON.parse(cli('verdicts', '--since-seq', '0', '--actor', 'ward').stdout) as { verdicts: { ticket_id: string }[] };
    expect(byWard.verdicts.map((v) => v.ticket_id)).toEqual([securityTicket]);

    const inDev = JSON.parse(cli('verdicts', '--since-seq', '0', '--workstream', 'helmo-dev').stdout) as { verdicts: { ticket_id: string }[] };
    expect(inDev.verdicts.map((v) => v.ticket_id)).toEqual([devTicket]);

    const both = JSON.parse(cli('verdicts', '--since-seq', '0', '--actor', 'ward', '--workstream', 'helmo-dev').stdout) as { verdicts: unknown[] };
    expect(both.verdicts).toEqual([]);
  });

  it('advances the caller\'s checkpoint from the same read', () => {
    const first = JSON.parse(cli('verdicts', '--since-seq', '0').stdout) as { max_seq: number; verdicts: unknown[] };
    expect(first.verdicts).toHaveLength(2);

    // The sweep stores max_seq and passes it back next day. Nothing new since
    // means an empty replay, not the same two verdicts reported again.
    const next = JSON.parse(cli('verdicts', '--since-seq', String(first.max_seq)).stdout) as { verdicts: unknown[] };
    expect(next.verdicts).toEqual([]);
  });

  it('truncates a long note to a scannable line, like answers', () => {
    const s = new Store(dbPath);
    reviewed(s, { workstream: 'security', reviewer: ward, verdict: 'pass', note: 'x'.repeat(500), sha: 'c' });
    s.close();

    const out = JSON.parse(cli('verdicts', '--since-seq', String(maxSeq)).stdout) as { verdicts: { note: string }[] };
    expect(out.verdicts[0]!.note).toHaveLength(200);
  });

  it('still reports a verdict whose ticket row has been deleted underneath it', () => {
    // The threat this replay exists for is a store file the user can write.
    // Helmo's own API refuses to purge a ticket that has events, so the only
    // way this row disappears is tampering — and dropping the verdict along
    // with it would make the tidiest forgery the quietest one.
    const s = new Store(dbPath);
    (s as unknown as { db: { prepare(q: string): { run(...a: string[]): void } } })
      .db.prepare('DELETE FROM tickets WHERE id = ?').run(securityTicket);
    s.close();

    const out = JSON.parse(cli('verdicts', '--since-seq', '0').stdout) as { verdicts: { ticket_id: string; workstream: string }[] };
    expect(out.verdicts.map((v) => v.ticket_id)).toContain(securityTicket);
    expect(out.verdicts.find((v) => v.ticket_id === securityTicket)!.workstream).toBe('');
  });

  it('refuses an identity JSON passed to --actor instead of matching nothing', () => {
    // Every other command reads --actor as the writer's identity. Here it is a
    // reviewer's name, so habit would produce a silent empty replay — which is
    // indistinguishable from "no forged verdicts today".
    const r = cli('verdicts', '--since-seq', '0', `--actor=${JSON.stringify(ward)}`);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("takes a reviewer's NAME");
  });
});

// R-39 Q9, the other half of the same silence. `flag()` returns undefined for a
// flag nobody declared, and undefined is what "not passed" looks like — so
// `create --project R-41` filed an untagged ticket and `update --assinee mason`
// reserved nobody, both exiting 0. The MCP surface refuses the same class with
// a strict input schema; these hold the CLI to the identical rule.
describe('a flag the command has no field for (R-39 Q9)', () => {
  function snapshot() {
    const s = new Store(dbPath);
    const state = JSON.stringify({ state: s.dumpState(), seq: s.maxSeq() });
    s.close();
    return state;
  }

  it('refuses a field the CLI has no flag for, rather than filing the ticket without it', () => {
    const before = snapshot();
    const r = cli('create', '--title', 'Ship the release gate', '--body', 'Goal: gate the release. Current state: not started.',
      '--workstream', 'helmo-dev', '--type', 'build', '--project', 'R-41');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--project');
    expect(r.stderr).toContain('go through the MCP server');
    expect(snapshot()).toBe(before);
  });

  it('refuses a misspelled flag by name and leaves the ticket untouched', () => {
    const before = snapshot();
    const r = cli('update', '--ticket', ticket, '--note', 'handing this on', '--assinee', 'mason');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--assinee');
    expect(r.stderr).toContain('--handoff-to'); // the flag it should have reached for
    expect(snapshot()).toBe(before);
  });

  it('requires both halves of an anchored body patch', () => {
    const before = snapshot();
    const r = cli('update', '--ticket', ticket, '--note', 'incomplete patch', '--body-old', 'before');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--body-old and --body-new must be passed together');
    expect(snapshot()).toBe(before);
  });

  it('catches the --flag=value form too', () => {
    const r = cli('update', '--ticket', ticket, '--note', 'n', '--blast-radus=records');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--blast-radus');
  });

  it('lets every ordinary write through', () => {
    const r = cli('update', '--ticket', ticket, '--note', 'the importer reads ./data now', '--blast-radius', 'records', '--confidence', 'routine');

    expect(r.status).toBe(0);
    expect(read().blast_radius).toBe('records');
    expect(read().confidence).toBe('routine');
  });

  it('refuses an unknown flag on a read command as well, so a filter that does not exist cannot look like no filter', () => {
    const r = cli('list', '--project', 'R-41');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--project');
  });

  // One tsx spawn per command, so this one is slow on purpose: the table is
  // only trustworthy if every command has actually been run against it.
  it('declares every flag its own code reads, so the table cannot drift behind it', { timeout: 60_000 }, () => {
    // The refusal is only as good as the table. A flag the code reads but the
    // table omits would refuse every legitimate caller, so flag()/has() assert
    // the other direction and this exercises each command once.
    const ok = (...argv: string[]) => {
      const r = cli(...argv);
      expect(r.stderr).not.toContain('does not list it in COMMAND_FLAGS');
      return r;
    };
    ok('wake-check', '--since-seq', '0', '--workstream', 'helmo-dev', '--assignee', 'builder-loop');
    ok('seat-check', '--assignee', 'builder-loop');
    ok('actor-activity', '--name', 'builder-loop', '--since-seq', '0', '--session', 's', '--advancing');
    ok('actor-tickets', '--name', 'builder-loop', '--since-seq', '0', '--session', 's');
    ok('actor-spend', '--name', 'builder-loop', '--since-seq', '0', '--session', 's');
    ok('answers', '--since-seq', '0', '--session', 'dashboard');
    ok('verdicts', '--since-seq', '0', '--workstream', 'helmo-dev');
    ok('hygiene');
    ok('workstream', '--name', 'helmo-dev');
    ok('list', '--ready', '--status', 'open', '--workstream', 'helmo-dev', '--assignee', 'builder-loop', '--limit', '5');
    ok('get', '--ticket', ticket);
    ok('acceptance-check', '--ticket', ticket, '--refs', '[]');
    ok('record-spend', '--ticket', ticket, '--tokens', '10', '--cost-usd', '0.01', '--note', 'metered');
    ok('update', '--ticket', ticket, '--note', 'every update flag at once', '--status', 'in_progress',
      '--evidence-kind', 'commit', '--evidence-ref', 'helmo@' + 'a'.repeat(40), '--evidence-role', 'result', '--confidence', 'spot_check',
      '--uncertainty-note', 'where the doubt is', '--blast-radius', 'records', '--tokens', '10', '--cost-usd', '0.01',
      '--handoff-to', 'mason', '--not-before', '', '--takeover');
    ok('create', '--title', 'Every create flag at once', '--body', 'Goal: exercise the table. Current state: none.',
      '--workstream', 'helmo-dev', '--type', 'build', '--priority', '2', '--status', 'open', '--assignee', 'mason',
      '--dep', ticket, '--dep-type', 'relates', '--not-before', '2026-12-01', '--needs-human', 'Two clicks in a dashboard');
    ok('return', '--ticket', ticket, '--situation', 'Where this stands.', '--question', 'Which way?',
      '--recommendation', 'This way.', '--if-unanswered', 'It waits.');
    ok('hygiene-dispose', '--check', 'spend_anomaly', '--ticket', ticket, '--reason', 'accounted for');
    ok('rename-workstream', '--from', 'helmo-dev', '--to', 'helmo-dev', '--note', 'no-op rename');
    ok('workstream-set', '--name', 'helmo-dev', '--budget-usd', '1', '--seat', 'mason');
    ok('purge-orphan', '--ticket', ticket, '--confirm');
    ok('product-complete', '--ticket', ticket, '--artifacts', '[]', '--note', 'n');
    ok('acceptance-verdict', '--ticket', ticket, '--refs', '[]', '--verdict', 'pass', '--note', 'n');
    // `--no-needs-human` and `--schedule` have no companion above: they conflict
    // with a flag already exercised, so each gets its own minimal call.
    ok('update', '--ticket', ticket, '--note', 'clearing the marker', '--no-needs-human');
    ok('create', '--title', 'A recurring template', '--body', 'Goal: recur. Current state: none.',
      '--workstream', 'helmo-dev', '--type', 'ops', '--schedule', 'every 1d');
  });
});

// H-574. The atomic claim arrived by replacing `launch-admit`'s body, which
// made the gate demand the WORKER's identity on a call the harness makes with
// its own. Rev's reply to that refusal is 'unavailable' — a deny for every
// workflow-bound candidate — so adopting the store would have stopped gated
// launches across the estate. The claim is a separate command; these two tests
// are the installed caller and the new one, exercised through argv.
describe('launch-admit stays the harness call it was (H-574)', () => {
  const rev: Actor = { name: 'rev', kind: 'agent', model: 'rev-harness', version: '0.2.0' };
  const worker: Actor = { ...writer, session: 'rev:builder-loop' };

  function as(actor: Actor, ...argv: string[]) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...argv], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, HELMO_DB: dbPath, HELMO_ACTOR: JSON.stringify(actor) },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it('admits for the harness actor without a session, and leaves the ticket open', () => {
    const r = as(rev, 'launch-admit', '--workstream', 'helmo-dev', '--assignee', 'builder-loop',
      '--launch-id', 'rev:builder-loop:4242:1:1700000000000');

    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ admitted: true, ticket_id: ticket, admission_id: null });
    expect(read().status).toBe('open');
  });

  it('claims for the worker itself, and refuses the harness actor', () => {
    const claimed = as(worker, 'launch-claim', '--workstream', 'helmo-dev', '--assignee', 'builder-loop',
      '--launch-id', 'rev:builder-loop:4242:2:1700000000001');
    expect(claimed.status).toBe(0);
    expect(JSON.parse(claimed.stdout)).toMatchObject({ claimed: true, ticket_id: ticket });
    expect(read().status).toBe('in_progress');

    const refused = as(rev, 'launch-claim', '--workstream', 'helmo-dev', '--assignee', 'builder-loop',
      '--launch-id', 'rev:builder-loop:4242:3:1700000000002');
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr).error).toMatch(/launch-claim must be written by the exact accountable agent/);
  });

  it('passes --tickets through as an exact allowlist (H-671)', () => {
    const elsewhere = as(worker, 'launch-claim', '--workstream', 'helmo-dev', '--assignee', 'builder-loop',
      '--launch-id', 'rev:builder-loop:4242:4:1700000000003', '--tickets', 'H-999,H-998');
    expect(elsewhere.stderr).toBe('');
    expect(JSON.parse(elsewhere.stdout)).toMatchObject({ admitted: false, launch_id: 'rev:builder-loop:4242:4:1700000000003' });
    expect(read().status).toBe('open');

    const listed = as(worker, 'launch-claim', '--workstream', 'helmo-dev', '--assignee', 'builder-loop',
      '--launch-id', 'rev:builder-loop:4242:5:1700000000004', '--tickets', `H-999,${ticket}`);
    expect(JSON.parse(listed.stdout)).toMatchObject({ claimed: true, ticket_id: ticket, scope: { tickets: ['H-999', ticket].sort() } });
  });
});

describe('attended CLI work', () => {
  it('claims and completes through ordinary commands with the actual agent identity', () => {
    const claimed = cli('update', '--ticket', ticket, '--note', 'The operator directed this work.', '--status', 'in_progress');
    expect(claimed.status, claimed.stdout + claimed.stderr).toBe(0);
    const s = new Store(dbPath);
    expect(s.seatHolds(writer.name)[0]?.claim_actor).toEqual(writer);
    s.close();
    expect(cli('update', '--ticket', ticket, '--note', 'Verified.', '--status', 'done', '--evidence-ref', 'Fixture verification').status).toBe(0);
  });
});

describe('an evidence item states what it is for (R-42 I5)', () => {
  it('writes the role through --evidence-role and leaves it unset without it', () => {
    const roled = cli('update', '--ticket', ticket, '--note', 'The contract is the result.',
      '--evidence-kind', 'file', '--evidence-ref', 'crew:projects/r39/RESULT-ROLE-CONTRACT.md', '--evidence-role', 'result');
    expect(roled.status, roled.stdout + roled.stderr).toBe(0);
    const unroled = cli('update', '--ticket', ticket, '--note', 'And the run that produced it.',
      '--evidence-kind', 'url', '--evidence-ref', 'https://example.test/run/1');
    expect(unroled.status, unroled.stdout + unroled.stderr).toBe(0);

    const s = new Store(dbPath);
    const items = s.getTicket(ticket)!.evidence;
    s.close();
    // H-1782's lesson applied to this flag: the assertion is that the value
    // LANDED, not that the command exited 0 — a flag the parser never read
    // writes an item with no role and reports success.
    expect(items[0]).toEqual({ kind: 'file', ref: 'crew:projects/r39/RESULT-ROLE-CONTRACT.md', role: 'result' });
    expect(items[1]).toEqual({ kind: 'url', ref: 'https://example.test/run/1' });
    expect('role' in items[1]!).toBe(false);
  });

  it('refuses a role the contract does not define, writing nothing', () => {
    const refused = cli('update', '--ticket', ticket, '--note', 'Trying a role of my own.',
      '--evidence-kind', 'commit', '--evidence-ref', 'helmo@' + 'b'.repeat(40), '--evidence-role', 'primary');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/result, supporting, review/);
    const s = new Store(dbPath);
    expect(s.getTicket(ticket)!.evidence).toEqual([]);
    s.close();
  });
});
