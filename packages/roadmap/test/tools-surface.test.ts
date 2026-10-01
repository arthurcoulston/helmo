import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/tools.js';
import { Actor } from '../src/types.js';

const actor: Actor = { name: 'test-agent', kind: 'agent', model: 'test', version: '0' };

async function connect(store: Store) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildServer(store, actor);
  const client = new Client({ name: 'test-agent', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe('undeclared MCP arguments (R-41)', () => {
  it('refuses an undeclared write field before recording anything', async () => {
    const store = new Store(':memory:');
    const client = await connect(store);
    const before = JSON.stringify(store.dumpState());

    const response = await client.callTool({
      name: 'roadmap_add_project',
      arguments: { title: 'Strict input schemas', body_append: 'This field does not exist.' },
    });

    expect(response.isError).toBe(true);
    expect((response.content as { text: string }[])[0]!.text).toContain('body_append');
    expect(JSON.stringify(store.dumpState())).toBe(before);
    await client.close();
    store.close();
  });

  it('refuses an unknown read filter instead of returning an unfiltered roadmap', async () => {
    const store = new Store(':memory:');
    store.createProject(actor, { title: 'Visible project' });
    const client = await connect(store);

    const response = await client.callTool({
      name: 'roadmap_list_projects',
      arguments: { workstream: 'estate-ui' },
    });

    expect(response.isError).toBe(true);
    expect((response.content as { text: string }[])[0]!.text).toContain('workstream');
    await client.close();
    store.close();
  });

  it('publishes every tool as strict, so no new door can silently opt out', async () => {
    const store = new Store(':memory:');
    const client = await connect(store);
    const loose = (await client.listTools()).tools.filter(
      (tool) => (tool.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false,
    );

    expect(loose.map((tool) => tool.name)).toEqual([]);
    await client.close();
    store.close();
  });
});
