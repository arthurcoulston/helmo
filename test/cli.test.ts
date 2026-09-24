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
    ['node_modules/.bin/tsx', 'src/cli.ts', ...argv],
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
