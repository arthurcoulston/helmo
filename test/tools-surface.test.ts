import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/tools.js';
import { Actor } from '../src/types.js';

// What the tool surface offers IS the guidance agents act on, so retiring a
// mechanism means retiring its tool and its response field, not just its docs
// (H-1126: the standing notice; H-1186: the workstream goal).
const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '0.1' };

async function connect(store: Store) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildServer(store, orch);
  const client = new Client({ name: 'test-agent', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe('the MCP tool surface after the standing notice was retired (H-1126)', () => {
  it('offers no notice tool', async () => {
    const store = new Store(':memory:');
    const client = await connect(store);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('helmo_set_workstream');
    expect(names).not.toContain('helmo_set_notice');
    await client.close();
    store.close();
  });

  it('carries no notice on a queue read', async () => {
    const store = new Store(':memory:');
    store.createTicket(orch, { title: 'Build the importer', body: 'Goal: import CSVs. Current state: not started.', workstream: 'helmo-dev', type: 'build' });
    const client = await connect(store);
    const res = await client.callTool({ name: 'helmo_list_tickets', arguments: {} });
    const text = (res.content as { text: string }[])[0]!.text;
    expect(JSON.parse(text).result).not.toHaveProperty('notice');
    expect(text).toContain('helmo-dev');
    await client.close();
    store.close();
  });
});

// Steering fields carry numbers and names only. A prose field here would be
// standing instruction every agent reads on every queue pass, outside caps
// and review — so the shapes are pinned, and a new string field fails here
// before it reaches a prompt (H-1186).
const STEERING_KEYS = ['budget_usd', 'spent_usd', 'remaining_usd'];
const WORKSTREAM_ROW_KEYS = ['name', 'seat', ...STEERING_KEYS];

describe('the steering surface after the workstream goal was retired (H-1186)', () => {
  it('offers no goal input on helmo_set_workstream', async () => {
    const store = new Store(':memory:');
    const client = await connect(store);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'helmo_set_workstream')!;
    expect(Object.keys(tool.inputSchema['properties'] as object).sort()).toEqual(['actor', 'budget_usd', 'name', 'seat']);
    await client.close();
    store.close();
  });

  it('workstream rows on a queue read carry only names and numbers', async () => {
    const store = new Store(':memory:');
    store.createTicket(orch, { title: 'Build the importer', body: 'Goal: import CSVs. Current state: not started.', workstream: 'helmo-dev', type: 'build' });
    store.setWorkstream(orch, { name: 'helmo-dev', budget_usd: 40, seat: 'mason' });
    const client = await connect(store);
    const res = await client.callTool({ name: 'helmo_list_tickets', arguments: {} });
    const rows = JSON.parse((res.content as { text: string }[])[0]!.text).result.workstreams as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const key of Object.keys(row)) expect(WORKSTREAM_ROW_KEYS, `unexpected field '${key}' on a workstream row`).toContain(key);
      for (const key of STEERING_KEYS) if (key in row) expect(typeof row[key]).toBe('number');
    }
    await client.close();
    store.close();
  });

  it('a ticket read carries only the budget numbers as steering', async () => {
    const store = new Store(':memory:');
    const t = store.createTicket(orch, { title: 'Build the importer', body: 'Goal: import CSVs. Current state: not started.', workstream: 'helmo-dev', type: 'build' });
    store.setWorkstream(orch, { name: 'helmo-dev', budget_usd: 40 });
    const client = await connect(store);
    const res = await client.callTool({ name: 'helmo_get_ticket', arguments: { ticket_id: t.id } });
    const steering = JSON.parse((res.content as { text: string }[])[0]!.text).result.workstream_steering as Record<string, unknown>;
    expect(Object.keys(steering).sort()).toEqual([...STEERING_KEYS].sort());
    for (const key of STEERING_KEYS) expect(typeof steering[key]).toBe('number');
    await client.close();
    store.close();
  });
});
