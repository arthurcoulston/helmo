// Connects to the Helmo MCP server exactly as a registered agent would
// (same command + env as the user-scope Claude Code config) and does a
// read-only sanity check. Safe to run anytime.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: [new URL('../dist/server.js', import.meta.url).pathname],
  env: {
    ...process.env,
    HELMO_ACTOR: JSON.stringify({ name: 'claude-code-interactive', kind: 'agent', model: 'claude-fable-5', version: 'claude-code-2.1.201' }),
  },
});
const client = new Client({ name: 'helmo-check', version: '0.1.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log(`tools (${tools.tools.length}): ${tools.tools.map((t) => t.name).join(', ')}`);

const r = await client.callTool({ name: 'helmo_list_tickets', arguments: {} });
const body = JSON.parse(r.content[0].text);
console.log(`tickets: ${body.result.count}, workstreams: ${JSON.stringify(body.result.workstreams)}`);

await client.close();
console.log('CONNECTION OK');
