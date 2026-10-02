import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Store } from '../src/store.js';
import { buildServer as workTools } from '../src/tools.js';
import { Actor } from '../src/types.js';
import { Store as RoadmapStore } from '../../roadmap/src/store.js';
import { buildServer as roadmapTools } from '../../roadmap/src/tools.js';

const actor: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '0' };

async function connect(server: McpServer) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture-client', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe('the unified MCP entry point', () => {
  it('serves byte-identical Work and Roadmap schemas and both fixture records', async () => {
    const work = new Store(':memory:');
    const roadmap = new RoadmapStore(':memory:');
    work.createTicket(actor, { title: 'Fixture ticket', body: 'Contract fixture.', workstream: 'estate-ui', type: 'build' });
    roadmap.createProject(actor, { title: 'Fixture project', body: 'Contract fixture.' });

    const workClient = await connect(workTools(work, actor));
    const roadmapClient = await connect(roadmapTools(roadmap, actor));
    const expected = [
      ...(await workClient.listTools()).tools,
      ...(await roadmapClient.listTools()).tools,
    ];

    const unified = new McpServer({ name: 'helmo', version: 'test' });
    workTools(work, actor, unified);
    roadmapTools(roadmap, actor, undefined, unified);
    const unifiedClient = await connect(unified);
    expect((await unifiedClient.listTools()).tools).toEqual(expected);

    const tickets = await unifiedClient.callTool({ name: 'helmo_list_tickets', arguments: {} });
    const projects = await unifiedClient.callTool({ name: 'roadmap_list_projects', arguments: {} });
    expect(JSON.stringify(tickets.content)).toContain('Fixture ticket');
    expect(JSON.stringify(projects.content)).toContain('Fixture project');

    await Promise.all([workClient.close(), roadmapClient.close(), unifiedClient.close()]);
    work.close();
    roadmap.close();
  });
});
