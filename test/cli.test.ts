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
