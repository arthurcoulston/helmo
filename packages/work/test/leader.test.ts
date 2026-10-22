import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

// H-2073. An installation may name one agent as its leader: the seat that sets
// direction for the backlog. A store that names its leader lets that agent
// draw its own filings without the self-triage touch; every other agent keeps
// the rule, and no agent can make itself leader.

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

describe('installation leader (H-2073)', () => {
  it('is unset by default, and the self-triage rule binds every agent', () => {
    expect(s.leaderActor()).toBeNull();
    const id = fileAs(lead);
    expect(ready('lead')).not.toContain(id);
    expect(() => s.updateTicket(lead, { ticket_id: id, note: 'claim', status: 'in_progress' })).toThrow(/your own filing/);
  });

  it('lets the named leader see and claim its own filing, attended or supervised', () => {
    s.setLeaderActor(operator, 'lead');
    const attended = fileAs(lead);
    const looped = fileAs(leadLoop);
    expect(ready('lead')).toEqual(expect.arrayContaining([attended, looped]));
    expect(s.selfFiledPending('lead')).toEqual([]);
    expect(s.updateTicket(lead, { ticket_id: attended, note: 'claim', status: 'in_progress' }).ticket.assignee).toBe('lead');
    expect(s.updateTicket(leadLoop, { ticket_id: looped, note: 'claim', status: 'in_progress' }).ticket.status).toBe('in_progress');
    expect(s.hygiene().filter((f) => f.check === 'awaiting_second_eyes')).toEqual([]);
  });

  it('leaves every other agent under the rule, and records the true actor', () => {
    s.setLeaderActor(operator, 'lead');
    const id = fileAs(worker);
    expect(ready('worker')).not.toContain(id);
    expect(s.selfFiledPending('worker')).toEqual([id]);
    expect(() => s.updateTicket(worker, { ticket_id: id, note: 'claim', status: 'in_progress' })).toThrow(/your own filing/);

    const mine = fileAs(lead);
    s.updateTicket(lead, { ticket_id: mine, note: 'claim', status: 'in_progress' });
    const claimEvent = s.getEvents(mine).at(-1)!;
    expect(claimEvent.actor).toMatchObject({ name: 'lead', kind: 'agent' });
  });

  // H-3405. Naming the first leader was once open to a supervised worker, on
  // the reading that a store with no leader had nothing to take away. It had:
  // the leader may lift the self-triage rule, so the grant is the check.
  it('is never self-granted, and never named by an unattended loop', () => {
    expect(() => s.setLeaderActor(lead, 'lead')).toThrow(/leader_refused: lead cannot name itself/);
    expect(() => s.setLeaderActor(leadLoop, 'lead')).toThrow(/leader_refused: lead cannot name itself/);
    expect(s.leaderActor()).toBeNull();
    expect(() => s.setLeaderActor(workerLoop, 'lead')).toThrow(/a caller writing as a supervised worker cannot name lead this installation's first leader/);
    expect(s.leaderActor()).toBeNull();
    expect(s.setLeaderActor(worker, 'lead')).toBe('lead');
    expect(() => s.setLeaderActor(workerLoop, 'reviewer')).toThrow(/leader_refused: a caller writing as a supervised worker cannot replace lead with reviewer/);
    expect(() => s.setLeaderActor(workerLoop, null)).toThrow(/leader_refused: a caller writing as a supervised worker cannot clear/);
    expect(s.leaderActor()).toBe('lead');
    expect(s.setLeaderActor(worker, 'reviewer')).toBe('reviewer');
    expect(s.setLeaderActor(operator, null)).toBeNull();
    expect(s.leaderActor()).toBeNull();
  });
});

describe('helmo leader CLI (H-2073)', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'helmo-leader-'));
    dbPath = join(dir, 'helmo.db');
    new Store(dbPath).close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (actor: Actor, ...argv: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...argv], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, HELMO_DB: dbPath, HELMO_ACTOR: JSON.stringify(actor) },
    encoding: 'utf8',
  });

  it('reports, names and clears the leader', () => {
    expect(JSON.parse(cli(worker, 'leader').stdout).leader).toBeNull();
    expect(JSON.parse(cli(worker, 'leader', '--actor-name', 'lead').stdout).leader).toBe('lead');
    expect(JSON.parse(cli(worker, 'leader').stdout).leader).toBe('lead');
    const refused = cli(workerLoop, 'leader', '--off');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr + refused.stdout).toMatch(/leader_refused/);
    expect(JSON.parse(cli(operator, 'leader', '--off').stdout).leader).toBeNull();
  });
});

describe('the unified entry honours ROADMAP_LEADER only for its pinned actor (H-2073)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'helmo-unified-leader-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const repo = fileURLToPath(new URL('..', import.meta.url));
  function spawnEnv(vars: Record<string, string>): Record<string, string> {
    const base = { ...process.env } as Record<string, string>;
    for (const k of Object.keys(base)) if (/^(HELMO_|ROADMAP_|REV_)/.test(k)) delete base[k];
    return { ...base, ...vars };
  }
  const text = (res: unknown) => ((res as { content: { text: string }[] }).content)[0]!.text;
  async function judgeOwnAs(actor: Actor, leader: string): Promise<string> {
    const helmoHome = join(dir, '.helmo');
    const roadmapHome = join(dir, '.helmo-roadmap');
    mkdirSync(helmoHome, { recursive: true });
    mkdirSync(roadmapHome, { recursive: true });
    const client = new Client({ name: 'leader-test', version: '0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ['--import', 'tsx', 'src/unified-server.ts'], cwd: repo,
      env: spawnEnv({ HELMO_HOME: helmoHome, ROADMAP_HOME: roadmapHome, HELMO_ACTOR: JSON.stringify(actor), ROADMAP_LEADER: leader }),
    }));
    try {
      const added = await client.callTool({ name: 'roadmap_add_project', arguments: { title: 'Mine', body: 'Shaped here.' } });
      const id = text(added).match(/R-\d+/)![0];
      const got = await client.callTool({ name: 'roadmap_get_project', arguments: { project_id: id } });
      const revision = Number(text(got).match(/"readiness_revision":\s*(\d+)/)![1]);
      return text(await client.callTool({ name: 'roadmap_record_readiness_verdict', arguments: { project_id: id, reviewed_revision: revision, verdict: 'pass', note: 'ready' } }));
    } finally {
      await client.close();
    }
  }

  it('lifts the shaper rule for the pinned leader and not for another seat', async () => {
    expect(await judgeOwnAs(lead, 'lead')).toMatch(/"readiness":\s*"shaped"/);
    expect(await judgeOwnAs(worker, 'lead')).toMatch(/last shaped by you/);
  }, 30_000);
});
