import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
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

  it('reports, turns off and restores the rule', () => {
    expect(JSON.parse(cli(worker, 'self-triage').stdout).self_triage).toBe('on');
    const refused = cli(workerLoop, 'self-triage', '--off');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr + refused.stdout).toMatch(/self_triage_refused/);
    expect(JSON.parse(cli(operator, 'self-triage', '--off').stdout).self_triage).toBe('off');
    expect(JSON.parse(cli(worker, 'self-triage').stdout).self_triage).toBe('off');
    expect(JSON.parse(cli(operator, 'self-triage', '--on').stdout).self_triage).toBe('on');
  });
});
