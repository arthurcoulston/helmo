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
      ['node_modules/.bin/tsx', 'src/cli.ts', 'update', '--ticket', id, '--note', 'claiming to build it', '--status', 'in_progress', '--actor', JSON.stringify(stated)],
      { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, HELMO_DB: dbPath, HELMO_ACTOR: JSON.stringify(seat) }, encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);

    const reopened = new Store(dbPath);
    expect(reopened.seatHolds('builder-loop')[0]?.claim_actor?.session).toBe('rev:builder-loop');
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
