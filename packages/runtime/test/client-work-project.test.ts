import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientWorkProject, createIntakeAssignment } from '../src/helm.js';
import { GlobalConfig } from '../src/types.js';

// H-2219. Client intake assignments were filed under a hand-set roster
// project that went stale whenever Ship Next moved, so the client's work sat
// withheld with no error. Against the real Work CLI and a real roadmap store:
// move Ship Next, file again, and the new assignment is still ready for its
// supervised seat.

const work = join(import.meta.dirname, '../../work/dist/cli.js');
const mason = { name: 'mason', kind: 'agent' as const, model: 'm', version: '1' };
const bosun = { name: 'bosun', kind: 'agent' as const, model: 'm', version: '1' };
const operator = JSON.stringify({ name: 'operator', kind: 'human' });

let dir: string;
let g: GlobalConfig;
let roadmap: {
  createProject(a: object, i: object): { id: string };
  updateProject(a: object, i: object): unknown;
  setShipNext(a: object, i: object): unknown;
};

function cli(args: string[], actor: string) {
  const r = spawnSync(process.execPath, [work, ...args], { env: { ...process.env, HELMO_DB: g.helmo_db, HELMO_ACTOR: actor }, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}
function initiative(title: string): string {
  const p = roadmap.createProject(mason, { title, status: 'shaping' });
  roadmap.updateProject(bosun, { project_id: p.id, note: 'ready', status: 'ready' });
  return p.id;
}
const shipNext = (id: string) => roadmap.setShipNext(mason, { project_id: id, decided_by: 'operator', reason: 'go' });
const shipOut = (id: string) => roadmap.updateProject(mason, { project_id: id, note: 'shipped', status: 'shipped_watching' });
function readyFor(seat: string): string[] {
  const actor = JSON.stringify({ name: seat, kind: 'agent', model: 'm', version: '1', session: `rev:${seat}` });
  return (cli(['list', '--ready', '--assignee', seat], actor).tickets as { id: string }[]).map((t) => t.id);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rev-client-project-'));
  const { Store } = await import('../../roadmap/dist/store.js');
  roadmap = new Store(join(dir, 'roadmap.db'));
  g = { helmo_cli: work, helmo_db: join(dir, 'work.db'), intake_preparation_project: undefined } as GlobalConfig;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('client work follows Ship Next (H-2219)', () => {
  it('files intake under the live Ship Next, so moving it strands nothing', () => {
    const first = initiative('Client entry');
    const second = initiative('Client steering');
    shipNext(first);
    cli(['delivery-scope', '--roadmap-db', join(dir, 'roadmap.db')], operator);
    g.intake_preparation_project = first;

    const intake = createIntakeAssignment(g, 'prepare the intake');
    expect(cli(['get', '--ticket', intake], operator).project).toBe(first);
    expect(readyFor('builder')).toContain(intake);

    // Ship Next moves; nobody edits the roster.
    shipOut(first);
    shipNext(second);
    const next = createIntakeAssignment(g, 'prepare the next intake');
    expect(cli(['get', '--ticket', next], operator).project).toBe(second);
    expect(readyFor('builder')).toContain(next);
  });

  it('keeps the configured project while it is in Ship Next, and with no scope at all', () => {
    const a = initiative('A');
    const b = initiative('B');
    expect(clientWorkProject({ ...g, intake_preparation_project: b })).toBe(b);
    expect(clientWorkProject(g)).toBeUndefined();
    shipNext(a);
    shipNext(b);
    cli(['delivery-scope', '--roadmap-db', join(dir, 'roadmap.db')], operator);
    expect(clientWorkProject({ ...g, intake_preparation_project: b })).toBe(b);
    expect(clientWorkProject({ ...g, intake_preparation_project: 'R-999' })).toBe(a);
    expect(clientWorkProject(g)).toBe(a);
  });
});
