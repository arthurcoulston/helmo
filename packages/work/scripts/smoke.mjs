import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Never fall through to the default (live) database: an unset SMOKE_DB
// would otherwise smoke-test the operator's real record.
const smokeDb = process.env.SMOKE_DB ?? join(mkdtempSync(join(tmpdir(), 'helmo-smoke-')), 'smoke.db');

const transport = new StdioClientTransport({
  command: 'node',
  args: ['--import', 'tsx', 'src/server.ts'],
  cwd: join(import.meta.dirname, '..'),
  env: {
    ...process.env,
    HELMO_DB: smokeDb,
    HELMO_ACTOR: JSON.stringify({ name: 'smoke-agent', kind: 'agent', model: 'claude-fable-5', version: '0.1', session: 'rev:smoke-agent' }),
  },
});
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));
for (const name of [
  'helmo_create_ticket', 'helmo_update_ticket', 'helmo_return_to_human', 'helmo_request_action', 'helmo_report_action', 'helmo_answer_ticket', 'helmo_get_ticket',
  'helmo_record_product_completion', 'helmo_record_acceptance_verdict', 'helmo_check_product_acceptance', 'helmo_acceptance_holds',
]) {
  assert(tools.tools.some((t) => t.name === name), `missing MCP tool ${name}`);
}

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  console.log(`\n== ${name} ==\n${text.slice(0, 500)}`);
  const body = JSON.parse(text);
  assert.notEqual(r.isError, true, `${name} returned an MCP error: ${text}`);
  assert.equal(body.error, undefined, `${name} returned an application error: ${text}`);
  return body;
};

const created = await call('helmo_create_ticket', {
  title: 'Smoke test the Helmo walking skeleton',
  body: 'Goal: verify create/claim/return/answer over stdio. State: running now.',
  workstream: 'helmo-dev',
  type: 'build',
  actor: { name: 'smoke-intake', kind: 'agent', model: 'gpt-5.6-luna', version: 'smoke 1.0' },
});
const id = created.result.id;
assert.equal(created.result.ticket.status, 'open');

const claimed = await call('helmo_update_ticket', {
  ticket_id: id,
  note: 'claiming via smoke test',
  status: 'in_progress',
  tokens: 42,
  actor: { name: 'smoke-builder', kind: 'agent', model: 'gpt-5.6-sol', version: 'smoke 1.0' },
});
assert.equal(claimed.result.status, 'in_progress');
assert.equal(claimed.result.assignee, 'smoke-builder');

const returned = await call('helmo_return_to_human', {
  ticket_id: id,
  situation: 'Smoke-testing the skeleton; all tools respond.',
  question: 'Ship the skeleton?',
  options: [
    { label: 'ship', consequence: 'dogfooding starts' },
    { label: 'hold', consequence: 'more polish first' },
  ],
  recommendation: 'ship — it is a skeleton, dogfooding is the point',
  actor: { name: 'smoke-builder', kind: 'agent', model: 'gpt-5.6-sol', version: 'smoke 1.0' },
});
assert.equal(returned.result.ticket.status, 'awaiting_human');

const answered = await call('helmo_answer_ticket', {
  ticket_id: id,
  answer: 'Ship it.',
  chosen_option: 'ship',
  resolution: 'resume',
  actor: { name: 'helmo-orchestrator', kind: 'orchestrator' },
});
assert.equal(answered.result.ticket.status, 'open');
assert.equal(answered.result.ticket.assignee, null);

const detail = await call('helmo_get_ticket', { ticket_id: id, format: 'history' });
console.log('\nAGENT CHAIN:', JSON.stringify(detail.result.agent_chain));
console.log('EVENTS:', detail.result.events.map((e) => e.event_type).join(' -> '));
console.log('LAST ANSWER:', JSON.stringify(detail.result.last_answer));
assert.deepEqual(detail.result.events.map((e) => e.event_type), ['created', 'updated', 'returned', 'answered']);
assert.deepEqual(detail.result.agent_chain.map((x) => x.split(' ')[0]), ['smoke-intake', 'smoke-builder', 'helmo-orchestrator']);
assert.equal(detail.result.last_answer.answer, 'Ship it.');

const actionTicket = await call('helmo_create_ticket', {
  title: 'Bind the smoke-test domain',
  body: 'The preview is ready; only the registrar binding remains.',
  workstream: 'helmo-dev',
  type: 'ops',
  actor: { name: 'smoke-intake', kind: 'agent', model: 'gpt-5.6-luna', version: 'smoke 1.0' },
});
const actionId = actionTicket.result.id;
const action = await call('helmo_request_action', {
  ticket_id: actionId,
  situation: 'The preview is verified and only the registrar binding remains.',
  action: 'Five minutes in the registrar: bind smoke.example to the supplied nameservers.',
  why_human: 'The registrar account belongs to the operator and agents have no credential.',
  actor: { name: 'smoke-builder', kind: 'agent', model: 'gpt-5.6-sol', version: 'smoke 1.0' },
});
assert.equal(action.result.ticket.status, 'awaiting_human');
const wrongResponse = await client.callTool({ name: 'helmo_answer_ticket', arguments: {
  ticket_id: actionId,
  answer: 'yes',
  actor: { name: 'helmo-orchestrator', kind: 'orchestrator' },
} });
assert.equal(wrongResponse.isError, true, 'an action accepted a decision response');
const acted = await call('helmo_report_action', {
  ticket_id: actionId,
  did: 'I bound smoke.example to the supplied nameservers.',
  actor: { name: 'helmo-orchestrator', kind: 'orchestrator' },
});
assert.equal(acted.result.ticket.status, 'open');

const sitting = await call('helmo_create_ticket', {
  title: 'Choose the smoke-test migration path',
  body: 'The tradeoff needs interpretation together.',
  workstream: 'helmo-dev',
  type: 'planning',
  needs_human: 'Twenty minutes comparing the migration paths and agreeing which risk to carry.',
  sitting_with: 'smoke-builder',
  actor: { name: 'smoke-intake', kind: 'agent', model: 'gpt-5.6-luna', version: 'smoke 1.0' },
});
assert.equal(sitting.result.ticket.needs_human, 'Twenty minutes comparing the migration paths and agreeing which risk to carry.');
const sittingDetail = await call('helmo_get_ticket', { ticket_id: sitting.result.id });
assert.equal(sittingDetail.result.sitting_with, 'smoke-builder');

const sourceRef = `helmo@${'a'.repeat(40)}`;
const completion = await call('helmo_record_product_completion', {
  ticket_id: id,
  artifacts: [{ ref: sourceRef, author: 'smoke-builder' }],
  note: 'This exact fixture source is ready for acceptance.',
  actor: { name: 'smoke-builder', kind: 'agent', model: 'gpt-5.6-sol', version: 'smoke 1.0' },
});
assert.equal(completion.result.state, 'pending');
assert.equal(completion.result.reason, 'missing_verdict');

// The same gate asked by commit, while the verdict is genuinely outstanding
// (H-3012). Crew's publication gate holds a branch head and no ticket id, so
// this is the question it actually has.
const holds = await call('helmo_acceptance_holds', { repo: 'helmo' });
assert.deepEqual(holds.result.holds.map((h) => h.ticket_id), [id], 'the outstanding completion was not found by commit');
assert.deepEqual(holds.result.holds[0].refs, [sourceRef]);

const verdict = await call('helmo_record_acceptance_verdict', {
  ticket_id: id,
  refs: [sourceRef],
  verdict: 'pass',
  note: 'The fixture lifecycle and refusal checks pass.',
  actor: { name: 'smoke-proof', kind: 'agent', model: 'gpt-6-astra', version: 'smoke 1.0' },
});
assert.equal(verdict.result.state, 'accepted');

const acceptance = await call('helmo_check_product_acceptance', { ticket_id: id, refs: [sourceRef] });
assert.equal(acceptance.result.state, 'accepted');

// A smoke that only checks happy output can print green after a refused write.
// Exercise the process contract too: the CLI must reject and exit nonzero.
const cliEnv = {
  ...process.env,
  HELMO_DB: smokeDb,
  HELMO_ACTOR: JSON.stringify({ name: 'smoke-builder', kind: 'agent', model: 'gpt-5.6-sol', version: 'smoke 1.0', session: 'rev:smoke-agent' }),
};
const wake = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'wake-check', '--workstream', 'helmo-dev', '--assignee', 'smoke-builder', '--since-seq', '0'], {
  cwd: join(import.meta.dirname, '..'), encoding: 'utf8', env: cliEnv,
});
assert.equal(wake.status, 0, `wake-check exited nonzero: ${wake.stderr}`);
const wakeBody = JSON.parse(wake.stdout);
assert.equal(wakeBody.ready_count, wakeBody.ready_ids.length);
assert.equal(wakeBody.newly_ready_count, wakeBody.newly_ready_ids.length);
assert(wakeBody.ready_ids.includes(id), 'wake-check omitted the current ready ticket');
assert(wakeBody.newly_ready_ids.includes(id), 'wake-check omitted the newly ready ticket');
const accepted = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'acceptance-check', '--ticket', id, '--refs', JSON.stringify([sourceRef])], {
  cwd: join(import.meta.dirname, '..'), encoding: 'utf8', env: cliEnv,
});
assert.equal(accepted.status, 0, `accepted manifest exited nonzero: ${accepted.stderr}`);
const stale = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'acceptance-check', '--ticket', id, '--refs', JSON.stringify([`helmo@${'b'.repeat(40)}`])], {
  cwd: join(import.meta.dirname, '..'), encoding: 'utf8', env: cliEnv,
});
assert.notEqual(stale.status, 0, 'a different manifest passed acceptance');
assert.match(stale.stdout, /stale_verdict/);
const cleared = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'acceptance-holds', '--repo', 'helmo'], {
  cwd: join(import.meta.dirname, '..'), encoding: 'utf8', env: cliEnv,
});
assert.equal(cleared.status, 0, `a repo with no outstanding verdict exited nonzero: ${cleared.stderr}`);
assert.deepEqual(JSON.parse(cleared.stdout).holds, [], 'a passed completion is still reported as a hold');

const refused = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'update', '--ticket', 'H-999', '--note', 'deliberate refusal probe'], {
  cwd: join(import.meta.dirname, '..'),
  encoding: 'utf8',
  env: cliEnv,
});
assert.notEqual(refused.status, 0, `rejected CLI write exited zero: ${refused.stdout}`);
assert.match(refused.stderr, /not found/i);
console.log('EXPECTED REFUSAL EXIT:', refused.status);

await client.close();
console.log('\nSMOKE OK');
