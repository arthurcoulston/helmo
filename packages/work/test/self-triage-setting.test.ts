import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/tools.js';
import { Actor } from '../src/types.js';

// H-2147. The self-triage rule waits for a second seat's touch. An
// installation with no seat giving that touch sees its filings stall until
// someone touches each by hand, so it can turn the rule off. The rule stays on
// by default, and only the leader, an attended session or a human can change it.

const operator: Actor = { name: 'operator', kind: 'human' };
const lead: Actor = { name: 'lead', kind: 'agent', model: 'test-model', version: '1.0' };
const leadLoop: Actor = { ...lead, session: 'rev:lead' };
const worker: Actor = { name: 'worker', kind: 'agent', model: 'test-model', version: '1.0' };
const workerLoop: Actor = { ...worker, session: 'rev:worker' };

let s: Store;
beforeEach(() => { s = new Store(':memory:'); });

const fileAs = (actor: Actor) => s.createTicket(actor, {
  title: 'Own filing', body: 'Goal: something. State: not started.', workstream: 'ops', type: 'build', assignee: actor.name,
}).id;
const ready = (caller: string) => s.listTickets({ ready: true, caller }).map((t) => t.id);

describe('self-triage setting (H-2147)', () => {
  it('is on by default', () => {
    expect(s.selfTriage()).toBe(true);
    const id = fileAs(workerLoop);
    expect(ready('worker')).not.toContain(id);
    expect(s.selfFiledPending('worker')).toEqual([id]);
    expect(() => s.updateTicket(workerLoop, { ticket_id: id, note: 'claim', status: 'in_progress' })).toThrow(/your own filing/);
  });

  it('turned off, a filer sees and claims its own filing, and hygiene raises nothing', () => {
    s.setSelfTriage(operator, false);
    const seq = s.maxSeq();
    const id = fileAs(workerLoop);
    expect(ready('worker')).toContain(id);
    expect(s.selfFiledPending('worker')).toEqual([]);
    expect(s.wakeCheck(seq, undefined, 'worker').newly_ready_ids).toContain(id);
    expect(s.hygiene().filter((f) => f.check === 'awaiting_second_eyes')).toEqual([]);
    expect(s.updateTicket(workerLoop, { ticket_id: id, note: 'claim', status: 'in_progress' }).ticket.status).toBe('in_progress');
  });

  it('turned back on, the rule binds again', () => {
    s.setSelfTriage(operator, false);
    s.setSelfTriage(operator, true);
    const id = fileAs(workerLoop);
    expect(ready('worker')).not.toContain(id);
  });

  it('changes only by the leader, an attended session or a human', () => {
    expect(() => s.setSelfTriage(workerLoop, false)).toThrow(/self_triage_refused/);
    expect(s.selfTriage()).toBe(true);
    s.setLeaderActor(operator, 'lead');
    expect(() => s.setSelfTriage(workerLoop, false)).toThrow(/self_triage_refused/);
    expect(s.setSelfTriage(leadLoop, false)).toBe(false);
    expect(s.selfTriage()).toBe(false);
    expect(() => s.setSelfTriage(workerLoop, true)).toThrow(/self_triage_refused/);
    expect(s.setSelfTriage(worker, true)).toBe(true);
    expect(s.selfTriage()).toBe(true);
  });
});

// H-3402. Before this, both settings wrote `meta` alone: after naming a leader
// and lifting the rule the events table held nothing, so the record could not
// say who removed a check, and the dashboard showed no sign of it either.
describe('a lifted guard leaves a record and shows on the dashboard (H-3402)', () => {
  const leaderEvents = () => s.getEvents('installation:leader');
  const triageEvents = () => s.getEvents('installation:self_triage');
  const finding = (check: string) => s.hygiene().find((f) => f.check === check);

  it('records who changed each setting, from what to what', () => {
    s.setLeaderActor(workerLoop, 'lead');
    s.setSelfTriage(leadLoop, false);

    expect(leaderEvents()).toHaveLength(1);
    expect(leaderEvents()[0]).toMatchObject({
      event_type: 'leader_set',
      actor: { name: 'worker', kind: 'agent' },
      payload: { from: null, to: 'lead', supervised: true },
    });
    expect(leaderEvents()[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(triageEvents()).toHaveLength(1);
    expect(triageEvents()[0]).toMatchObject({
      event_type: 'self_triage_set',
      actor: { name: 'lead', kind: 'agent' },
      payload: { from: true, to: false, supervised: true },
    });
  });

  it('records a human and an attended session as what they wrote as', () => {
    s.setLeaderActor(operator, 'lead');
    s.setSelfTriage(lead, false);
    expect(leaderEvents()[0]!.payload).toMatchObject({ supervised: false });
    expect(leaderEvents()[0]!.actor).toMatchObject({ name: 'operator', kind: 'human' });
    expect(triageEvents()[0]!.payload).toMatchObject({ supervised: false });
  });

  it('records nothing when the standing value is re-asserted', () => {
    expect(s.setSelfTriage(operator, true)).toBe(true);
    expect(triageEvents()).toEqual([]);
    s.setLeaderActor(operator, 'lead');
    s.setLeaderActor(operator, 'lead');
    expect(leaderEvents()).toHaveLength(1);
    expect(s.setLeaderActor(operator, null)).toBeNull();
    expect(leaderEvents()).toHaveLength(2);
    expect(leaderEvents()[1]!.payload).toMatchObject({ from: 'lead', to: null });
  });

  it('reports the off rule to the operator, naming who lifted it, until it is restored', () => {
    expect(finding('self_triage_off')).toBeUndefined();
    s.setLeaderActor(workerLoop, 'lead');
    s.setSelfTriage(leadLoop, false);

    const off = finding('self_triage_off')!;
    expect(off.ticket_id).toBeUndefined();
    expect(off.detail).toMatch(/off installation-wide/);
    expect(off.detail).toMatch(/set by lead, writing as a supervised worker/);

    s.setSelfTriage(operator, true);
    expect(finding('self_triage_off')).toBeUndefined();
  });

  it('reports a named leader as the standing exemption it is', () => {
    expect(finding('leader_named')).toBeUndefined();
    s.setLeaderActor(workerLoop, 'lead');
    const named = finding('leader_named')!;
    expect(named.detail).toMatch(/^lead is this installation's leader/);
    expect(named.detail).toMatch(/set by worker, writing as a supervised worker/);
    s.setLeaderActor(operator, null);
    expect(finding('leader_named')).toBeUndefined();
  });

  it('names a pre-existing setting as one the record cannot attribute', () => {
    // A store whose meta was written before H-3402, or by hand: the state
    // stands, the actor does not, and the finding says so rather than guessing.
    const dir = mkdtempSync(join(tmpdir(), 'helmo-triage-legacy-'));
    try {
      const dbPath = join(dir, 'helmo.db');
      new Store(dbPath).close();
      const side = new Database(dbPath);
      side.prepare("INSERT INTO meta (key, value) VALUES ('self_triage', 'off')").run();
      side.close();
      const legacy = new Store(dbPath);
      try {
        const off = legacy.hygiene().find((x) => x.check === 'self_triage_off')!;
        expect(off.detail).toMatch(/set before Helmo recorded these changes/);
      } finally {
        legacy.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads back the provenance of each setting, and null where there is none', () => {
    expect(s.settingProvenance('leader')).toBeNull();
    expect(s.settingProvenance('self_triage')).toBeNull();
    s.setLeaderActor(workerLoop, 'lead');
    s.setSelfTriage(lead, false);
    expect(s.settingProvenance('leader')).toMatchObject({
      actor: { name: 'worker' }, writing_as: 'a supervised worker', from: null, to: 'lead',
    });
    expect(s.settingProvenance('self_triage')).toMatchObject({
      actor: { name: 'lead' }, writing_as: 'an attended session', from: true, to: false,
    });
    s.setSelfTriage(operator, true);
    expect(s.settingProvenance('self_triage')).toMatchObject({
      writing_as: 'a human', from: false, to: true,
    });
  });

  it('cannot be acknowledged away — it clears by changing the setting', () => {
    s.setSelfTriage(operator, false);
    expect(() => s.disposeHygieneFinding(operator, { check: 'self_triage_off', ticket_id: 'H-1', reason: 'intended' }))
      .toThrow(/clears by changing the setting/);
    expect(finding('self_triage_off')).toBeDefined();
  });
});

describe('tool guidance follows the setting (H-2147)', () => {
  async function descriptions(store: Store) {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-agent', version: '0' });
    await Promise.all([buildServer(store, worker).connect(serverSide), client.connect(clientSide)]);
    const text = JSON.stringify((await client.listTools()).tools);
    await client.close();
    return text;
  }

  it('says filings wait only where the rule runs', async () => {
    expect(await descriptions(s)).toMatch(/second pair of eyes/);
    s.setSelfTriage(operator, false);
    const off = await descriptions(s);
    expect(off).not.toMatch(/second pair of eyes|the triage rule|Ready-queue triage rule/);
    expect(off).toMatch(/runs no self-triage rule/);
  });
});

describe('helmo self-triage CLI (H-2147)', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'helmo-self-triage-'));
    dbPath = join(dir, 'helmo.db');
    new Store(dbPath).close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (actor: Actor, ...argv: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...argv], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, HELMO_DB: dbPath, HELMO_ACTOR: JSON.stringify(actor) },
    encoding: 'utf8',
  });

  it('reports, turns off and restores the rule, and says who set it', () => {
    expect(JSON.parse(cli(worker, 'self-triage').stdout).self_triage).toBe('on');
    expect(JSON.parse(cli(worker, 'self-triage').stdout).set_by).toBeNull();
    const refused = cli(workerLoop, 'self-triage', '--off');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr + refused.stdout).toMatch(/self_triage_refused/);
    expect(JSON.parse(cli(operator, 'self-triage', '--off').stdout).self_triage).toBe('off');
    const read = JSON.parse(cli(worker, 'self-triage').stdout);
    expect(read.self_triage).toBe('off');
    expect(read.set_by).toMatchObject({ actor: { name: 'operator' }, writing_as: 'a human', from: true, to: false });
    expect(JSON.parse(cli(operator, 'self-triage', '--on').stdout).self_triage).toBe('on');
  });
});
