import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

// H-2073. An installation may name one agent as the leader that directs its
// roadmap. The store's independence rules — the shaper cannot judge its own
// text ready, nothing enters work or ships without the human's go — stay for
// every other agent and are lifted for the leader. Planned is still entered
// only through roadmap_set_ship_next, by anyone.

const lead: Actor = { name: 'lead', kind: 'agent', model: 'test-model', version: 'test' };
const other: Actor = { name: 'other', kind: 'agent', model: 'test-model', version: 'test' };

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roadmap-leader-'));
  store = new Store(join(dir, 'test.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const shapedBy = (actor: Actor) => store.createProject(actor, { title: 'Shaped', body: 'A description.' }).id;
const verdict = (actor: Actor, id: string) => store.recordReadinessVerdict(actor, {
  project_id: id, reviewed_revision: store.projectSnapshot(id).readiness_revision, verdict: 'pass', note: 'enough is known',
});

describe('roadmap leader (H-2073)', () => {
  it('without a leader, the shaper cannot judge its own text ready', () => {
    const id = shapedBy(lead);
    expect(() => verdict(lead, id)).toThrow(/last shaped by you/);
  });

  it('the leader records a readiness verdict on its own shaping', () => {
    store.setLeader('lead');
    const id = shapedBy(lead);
    expect(verdict(lead, id).project.readiness).toBe('shaped');
  });

  it('the leader moves a project any direction, and the event names it', () => {
    store.setLeader('lead');
    const id = shapedBy(lead);
    expect(store.updateProject(lead, { project_id: id, note: 'start', status: 'Active' }).project.status).toBe('Active');
    expect(store.updateProject(lead, { project_id: id, note: 'back down', status: 'Proposed' }).project.status).toBe('Proposed');
    expect(store.updateProject(lead, { project_id: id, note: 'shipped', status: 'Monitoring' }).project.status).toBe('Monitoring');
    expect(store.updateProject(lead, { project_id: id, note: 'reopen', status: 'Proposed' }).project.status).toBe('Proposed');
    const last = store.projectSnapshot(id).events.at(-1)!;
    expect(last.actor).toMatchObject({ name: 'lead', kind: 'agent' });
    expect(() => store.updateProject(lead, { project_id: id, note: 'go', status: 'Planned' as never })).toThrow(/roadmap_set_ship_next/);
  });

  it('every other agent keeps both rules while a leader is named', () => {
    store.setLeader('lead');
    const id = shapedBy(other);
    expect(() => verdict(other, id)).toThrow(/last shaped by you/);
    expect(() => store.updateProject(other, { project_id: id, note: 'start', status: 'Active' })).toThrow(/declared go on/);
    expect(() => store.updateProject(other, { project_id: id, note: 'ship', status: 'Monitoring' })).toThrow(/only an Active project/);
  });
});

describe('ROADMAP_LEADER is honoured only in the leader\'s own process (H-2073)', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  function spawnEnv(vars: Record<string, string>): Record<string, string> {
    const base = { ...process.env } as Record<string, string>;
    for (const k of ['ROADMAP_DB', 'ROADMAP_HOME', 'HELMO_INSTALLATION', 'ROADMAP_LABEL', 'HELMO_LABEL', 'REV_LABEL', 'ROADMAP_ACTOR', 'HELMO_ACTOR', 'ROADMAP_LEADER']) delete base[k];
    return { ...base, ...vars };
  }
  const text = (res: unknown) => ((res as { content: { text: string }[] }).content)[0]!.text;
  async function judgeOwnAs(home: string, actor: Actor, leader: string, perCall?: Actor): Promise<string> {
    const client = new Client({ name: 'leader-test', version: '0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ['--import', 'tsx', 'src/server.ts'], cwd: repo,
      env: spawnEnv({ ROADMAP_HOME: home, ROADMAP_ACTOR: JSON.stringify(actor), ROADMAP_LEADER: leader }),
    }));
    try {
      const as = perCall ? { actor: perCall } : {};
      const added = await client.callTool({ name: 'roadmap_add_project', arguments: { title: 'Mine', body: 'Shaped here.', ...as } });
      const id = text(added).match(/R-\d+/)![0];
      const got = await client.callTool({ name: 'roadmap_get_project', arguments: { project_id: id } });
      const revision = Number(text(got).match(/"readiness_revision":\s*(\d+)/)![1]);
      const res = await client.callTool({ name: 'roadmap_record_readiness_verdict', arguments: { project_id: id, reviewed_revision: revision, verdict: 'pass', note: 'ready', ...as } });
      return text(res);
    } finally {
      await client.close();
    }
  }

  it('lifts the rule for the pinned leader, and not for another seat carrying the variable', async () => {
    const home = join(dir, '.helmo-roadmap');
    mkdirSync(home, { recursive: true });
    expect(await judgeOwnAs(home, lead, 'lead')).toMatch(/"readiness":\s*"shaped"/);
    expect(await judgeOwnAs(home, other, 'lead')).toMatch(/last shaped by you/);
    expect(await judgeOwnAs(home, other, 'lead', lead)).toMatch(/last shaped by you/);
  }, 30_000);
});

describe('Store.pinLeader (H-2073)', () => {
  it('honours the configured leader only for the pinned agent', () => {
    const id = shapedBy(lead);
    store.pinLeader('lead', other);
    expect(() => verdict(lead, id)).toThrow(/last shaped by you/);
    store.pinLeader(undefined, lead);
    expect(() => verdict(lead, id)).toThrow(/last shaped by you/);
    store.pinLeader('lead', { name: 'lead', kind: 'human' });
    expect(() => verdict(lead, id)).toThrow(/last shaped by you/);
    store.pinLeader('lead', lead);
    expect(verdict(lead, id).project.readiness).toBe('shaped');
  });
});
