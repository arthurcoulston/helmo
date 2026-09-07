import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/tools.js';
import { Actor } from '../src/types.js';

// What the tool surface offers IS the guidance agents act on, so retiring a
// mechanism means retiring its tool and its response field, not just its docs
// (H-1126: the standing notice).
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
