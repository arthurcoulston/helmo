import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/server.ts'],
  cwd: '/Users/arthurcoulston/projects/helm',
  env: {
    ...process.env,
    HELM_DB: process.env.SMOKE_DB,
    HELM_ACTOR: JSON.stringify({ name: 'smoke-agent', kind: 'agent', model: 'claude-fable-5', version: '0.1' }),
  },
});
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  console.log(`\n== ${name} ==\n${text.slice(0, 500)}`);
  return JSON.parse(text);
};

const created = await call('helm_create_ticket', {
  title: 'Smoke test the Helm walking skeleton',
  body: 'Goal: verify create/claim/return/answer over stdio. State: running now.',
  workstream: 'helm-dev',
  type: 'build',
});
const id = created.result.id;

await call('helm_update_ticket', { ticket_id: id, note: 'claiming via smoke test', status: 'in_progress', tokens: 42 });
await call('helm_return_to_human', {
  ticket_id: id,
  situation: 'Smoke-testing the skeleton; all tools respond.',
  question: 'Ship the skeleton?',
  options: [
    { label: 'ship', consequence: 'dogfooding starts' },
    { label: 'hold', consequence: 'more polish first' },
  ],
  recommendation: 'ship — it is a skeleton, dogfooding is the point',
});
await call('helm_answer_ticket', {
  ticket_id: id,
  answer: 'Ship it.',
  chosen_option: 'ship',
  resolution: 'resume',
  actor: { name: 'helm-orchestrator', kind: 'orchestrator' },
});
const detail = await call('helm_get_ticket', { ticket_id: id, format: 'history' });
console.log('\nAGENT CHAIN:', JSON.stringify(detail.result.agent_chain));
console.log('EVENTS:', detail.result.events.map((e) => e.event_type).join(' -> '));
console.log('LAST ANSWER:', JSON.stringify(detail.result.last_answer));

// error teaching check: claim an awaiting ticket / bad return
const err = await call('helm_update_ticket', { ticket_id: 'H-999', note: 'x' });
console.log('MISSING-TICKET ERROR OK:', !!err.error);

await client.close();
console.log('\nSMOKE OK');
