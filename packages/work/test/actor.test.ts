import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/tools.js';
import { Actor, writingActor } from '../src/types.js';

// The seat stamp (H-687). Rev stamps a loop server's HELMO_ACTOR with the seat
// id; the agent inside cannot know it, but the tool guidance asks it to send a
// full explicit actor on every write. Before the fix that override replaced the
// env actor whole, so the stamp vanished — and rev's same-seat guard (H-558)
// read the loop's own finished claim as a foreign live session and stood the
// seat down for the full 24h staleness window.
const seat: Actor = { name: 'builder-loop', kind: 'agent', model: 'gpt-5.6-luna', version: '0.1', session: 'rev:builder-loop' };
const stated: Actor = { name: 'builder-loop', kind: 'agent', model: 'claude-opus-5', version: 'claude-code-2.1.221' };
const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '0.1' };

function ticketToClaim(s: Store): string {
  const t = s.createTicket(orch, {
    title: 'Build the importer',
    body: 'Goal: import CSVs from ./data. Current state: not started.',
    workstream: 'helmo-dev',
    type: 'build',
    assignee: 'builder-loop',
  });
  return t.id;
}

describe('writingActor', () => {
  it('takes identity from the caller and the session stamp from the environment', () => {
    expect(writingActor(stated, seat)).toEqual({ ...stated, session: 'rev:builder-loop' });
  });
  it('leaves a caller that states its own session alone', () => {
    const own = { ...stated, session: 'desk-summon' };
    expect(writingActor(own, seat).session).toBe('desk-summon');
  });
  it('adds nothing when the environment carries no stamp', () => {
    expect(writingActor(stated, { name: 'placeholder', kind: 'agent' })).toEqual(stated);
  });
  it('falls back to the environment actor whole when the caller states none', () => {
    expect(writingActor(undefined, seat)).toEqual(seat);
  });
  it('does not invent an identity when there is neither', () => {
    expect(writingActor(undefined, null)).toEqual({});
  });
});

describe('the seat stamp survives an explicit actor (H-687)', () => {
  it('through the MCP tools: the claim event carries the seat, not null', async () => {
    const store = new Store(':memory:');
    const id = ticketToClaim(store);

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildServer(store, seat);
    const client = new Client({ name: 'test-agent', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    await client.callTool({
      name: 'helmo_update_ticket',
      arguments: { ticket_id: id, note: 'claiming to build it', status: 'in_progress', actor: stated },
    });
    await client.close();

    const [hold] = store.seatHolds('builder-loop');
    expect(hold?.claim_actor?.session).toBe('rev:builder-loop');
    // and the identity the agent stated is what got recorded, not the env's
    expect(hold?.claim_actor?.model).toBe('claude-opus-5');
    store.close();
  });

  it('through the CLI: --actor over a stamped environment keeps the stamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helmo-seat-'));
    const dbPath = join(dir, 'helmo.db');
    const store = new Store(dbPath);
    const id = ticketToClaim(store);
    store.close();

    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'update', '--ticket', id, '--note', 'claiming to build it', '--status', 'in_progress', '--actor', JSON.stringify(stated)],
      { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, HELMO_DB: dbPath, HELMO_ACTOR: JSON.stringify(seat) }, encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);

    const reopened = new Store(dbPath);
    expect(reopened.seatHolds('builder-loop')[0]?.claim_actor?.session).toBe('rev:builder-loop');
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('hygiene through the MCP surface (H-758)', () => {
  it('lists findings and records a terminal-ticket disposition with the caller identity', async () => {
    const store = new Store(':memory:');
    const ticket = store.createTicket(orch, {
      title: 'Conversational deliverable', body: 'The answer was given live.', workstream: 'helmo-dev', type: 'writing',
    });
    store.updateTicket(orch, { ticket_id: ticket.id, note: 'finished in the meeting', status: 'done' });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildServer(store, seat);
    const client = new Client({ name: 'test-agent', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    const scan = await client.callTool({ name: 'helmo_hygiene', arguments: {} });
    expect(JSON.stringify(scan)).toContain('done_without_evidence');
    const disposed = await client.callTool({
      name: 'helmo_dispose_hygiene_finding',
      arguments: { check: 'done_without_evidence', ticket_id: ticket.id, reason: 'accepted live', actor: stated },
    });
    expect(JSON.stringify(disposed)).toContain(`done_without_evidence on ${ticket.id}`);
    expect(store.hygiene()).toEqual([]);
    expect(store.getEvents(ticket.id).at(-1)?.actor).toEqual({ ...stated, session: 'rev:builder-loop' });

    await client.close();
    store.close();
  });
});

// A supervised parallel worker's environment binds role, worker and launch
// generation (H-574). Its siblings share the role name, so the H-687 rule that
// lets a desk caller restate its session would let B write as A.
describe('a supervised worker cannot shed or borrow its binding (H-574)', () => {
  const boundA: Actor = { ...seat, session: 'rev:builder-a', generation: 'launch-a' };
  const boundB: Actor = { ...seat, session: 'rev:builder-b', generation: 'launch-b' };

  it('refuses conflicting identity fields and inherits omitted ones', () => {
    expect(() => writingActor({ ...stated, session: 'rev:builder-a' }, boundB)).toThrow(/supervised_identity_conflict/);
    expect(() => writingActor({ ...stated, session: 'rev:builder-b', generation: 'launch-a' }, boundB)).toThrow(/supervised_identity_conflict/);
    expect(() => writingActor({ ...stated, name: 'reviewer-loop' }, boundB)).toThrow(/supervised_identity_conflict/);
    expect(writingActor(stated, boundB)).toEqual({ ...boundB, model: stated.model, version: stated.version });
    expect(writingActor(undefined, boundB)).toEqual(boundB);
  });

  it('refuses a generation stated outside a supervised environment', () => {
    expect(() => writingActor({ ...stated, generation: 'launch-a' }, seat)).toThrow(/generation is bound/);
  });

  it('through the MCP tools: B cannot close, complete or impersonate A, and A can', async () => {
    const store = new Store(':memory:');
    const id = ticketToClaim(store);
    store.launchClaim({ ...boundA, generation: undefined }, 'helmo-dev', 'builder-loop', 'launch-a');
    const connect = async (env: Actor) => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-agent', version: '0' });
      await Promise.all([buildServer(store, env).connect(serverSide), client.connect(clientSide)]);
      return client;
    };
    const b = await connect(boundB);
    const before = store.getEvents(id).length;
    const attempts: [string, Record<string, unknown>][] = [
      ['helmo_update_ticket', { ticket_id: id, note: 'closing', status: 'done' }],
      ['helmo_update_ticket', { ticket_id: id, note: 'closing', status: 'done', actor: stated }],
      ['helmo_update_ticket', { ticket_id: id, note: 'closing', status: 'done', actor: { ...stated, session: 'rev:builder-a' } }],
      ['helmo_update_ticket', { ticket_id: id, note: 'closing', status: 'done', actor: { ...stated, session: 'rev:builder-a', generation: 'launch-a' } }],
      ['helmo_update_ticket', { ticket_id: id, note: 'passing it on', handoff_to: 'reviewer-loop' }],
      ['helmo_record_product_completion', { ticket_id: id, note: 'ready', artifacts: [{ ref: `helmo@${'a'.repeat(40)}`, author: 'builder-loop' }] }],
    ];
    for (const [name, args] of attempts) {
      const r = await b.callTool({ name, arguments: args });
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(JSON.stringify(r)).toMatch(/execution_claim_held|supervised_identity_conflict/);
    }
    expect(store.getEvents(id)).toHaveLength(before);
    expect(store.getTicket(id).status).toBe('in_progress');

    const a = await connect(boundA);
    const done = await a.callTool({ name: 'helmo_update_ticket', arguments: { ticket_id: id, note: 'built', status: 'done', evidence: [{ kind: 'other', ref: 'x' }], actor: stated } });
    expect(done.isError).toBeFalsy();
    expect(store.getEvents(id).at(-1)?.actor).toEqual({ ...boundA, model: stated.model, version: stated.version });
    const late = await a.callTool({ name: 'helmo_update_ticket', arguments: { ticket_id: id, note: 'one more thing' } });
    expect(JSON.stringify(late)).toMatch(/stale_generation/);
    await a.close(); await b.close();
    store.close();
  });

  it('through the CLI: a bound environment refuses a borrowed session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helmo-bound-'));
    const dbPath = join(dir, 'helmo.db');
    const store = new Store(dbPath);
    const id = ticketToClaim(store);
    store.launchClaim({ ...boundA, generation: undefined }, 'helmo-dev', 'builder-loop', 'launch-a');
    store.close();
    const cli = (env: Actor, ...extra: string[]) => spawnSync(
      process.execPath,
      ['node_modules/.bin/tsx', 'src/cli.ts', 'update', '--ticket', id, '--note', 'closing', '--status', 'done', ...extra],
      { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, HELMO_DB: dbPath, HELMO_ACTOR: JSON.stringify(env) }, encoding: 'utf8' },
    );
    const spoof = cli(boundB, '--actor', JSON.stringify({ ...stated, session: 'rev:builder-a', generation: 'launch-a' }));
    expect(spoof.status).toBe(1);
    expect(spoof.stderr).toMatch(/supervised_identity_conflict/);
    const sibling = cli(boundB);
    expect(sibling.status).toBe(1);
    expect(sibling.stderr).toMatch(/execution_claim_held/);
    const owner = cli(boundA);
    expect(owner.status, owner.stderr).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
