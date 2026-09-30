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

describe('truth-preserving record edits (R-39 Q3/Q4)', () => {
  async function call(store: Store, args: Record<string, unknown>) {
    const client = await connect(store);
    const res = await client.callTool({ name: 'helmo_update_ticket', arguments: args });
    await client.close();
    return { text: (res.content as { text: string }[])[0]!.text, isError: res.isError === true };
  }

  it('publishes safe append and anchored patch inputs', async () => {
    const store = new Store(':memory:');
    const client = await connect(store);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'helmo_update_ticket')!;
    const properties = tool.inputSchema['properties'] as Record<string, unknown>;
    expect(properties).toHaveProperty('body_append');
    expect(properties).toHaveProperty('body_patch');
    await client.close();
    store.close();
  });

  it('refuses a stale MCP body anchor before recording its note', async () => {
    const store = new Store(':memory:');
    const t = store.createTicket(orch, { title: 'Ship it', body: 'Current body.', workstream: 'helmo-dev', type: 'build' });
    const seq = store.maxSeq();
    const res = await call(store, { ticket_id: t.id, note: 'stale attempt', body_patch: { old: 'Earlier body.', new: 'New body.' } });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('stale');
    expect(store.maxSeq()).toBe(seq);
    expect(store.getTicket(t.id).body).toBe('Current body.');
    store.close();
  });

  it('appends evidence through MCP after done but refuses state changes', async () => {
    const store = new Store(':memory:');
    const t = store.createTicket(orch, { title: 'Ship it', body: 'Current body.', workstream: 'helmo-dev', type: 'build' });
    store.updateTicket(orch, { ticket_id: t.id, note: 'done', status: 'done' });
    const evidence = await call(store, { ticket_id: t.id, note: 'late proof', evidence: [{ kind: 'url', ref: 'https://example.test/proof' }] });
    expect(evidence.isError).toBe(false);
    expect(store.getTicket(t.id).evidence).toHaveLength(1);
    const seq = store.maxSeq();
    const rewrite = await call(store, { ticket_id: t.id, note: 'change title', title: 'Different' });
    expect(rewrite.isError).toBe(true);
    expect(store.maxSeq()).toBe(seq);
    expect(store.getTicket(t.id).title).toBe('Ship it');
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

  it('exposes zero as uncapped without a negative remainder (H-267)', async () => {
    const store = new Store(':memory:');
    const t = store.createTicket(orch, { title: 'Build the importer', body: 'Goal: import CSVs. Current state: not started.', workstream: 'helmo-dev', type: 'build' });
    store.setWorkstream(orch, { name: 'helmo-dev', budget_usd: 0 });
    store.recordSpend(orch, t.id, { cost_usd: 12, note: 'metered' });
    const client = await connect(store);
    const queue = await client.callTool({ name: 'helmo_list_tickets', arguments: {} });
    const row = JSON.parse((queue.content as { text: string }[])[0]!.text).result.workstreams.find((w: { name: string }) => w.name === 'helmo-dev');
    expect(row).toMatchObject({ budget_usd: 0, spent_usd: 12, remaining_usd: null });
    const ticket = await client.callTool({ name: 'helmo_get_ticket', arguments: { ticket_id: t.id } });
    expect(JSON.parse((ticket.content as { text: string }[])[0]!.text).result.workstream_steering).toMatchObject({ budget_usd: 0, spent_usd: 12, remaining_usd: null });
    await client.close();
    store.close();
  });
});

// R-39 Q9. Handed a raw shape the SDK wraps it in a plain object, which strips
// an undeclared key: `capacity_hold` on a create, or a misspelled `projekt`,
// returned a new ticket ID with the field quietly unset. helmo-cli enforces the
// same rule over its flags; these hold the MCP door to it.
describe('a key the tool does not declare (R-39 Q9)', () => {
  async function call(store: Store, name: string, args: Record<string, unknown>) {
    const client = await connect(store);
    const res = await client.callTool({ name, arguments: args });
    await client.close();
    return { text: (res.content as { text: string }[])[0]!.text, isError: res.isError === true };
  }

  const NEW_TICKET = { title: 'Ship the release gate', body: 'Goal: gate the release. Current state: not started.', workstream: 'helmo-dev', type: 'build' };

  it('refuses the undeclared keys by name and creates nothing', async () => {
    const store = new Store(':memory:');
    const before = JSON.stringify({ state: store.dumpState(), seq: store.maxSeq() });

    const r = await call(store, 'helmo_create_ticket', { ...NEW_TICKET, projekt: 'R-41', capacity_hold: { reason: 'held' } });

    expect(r.isError).toBe(true);
    expect(r.text).toContain('projekt');
    expect(r.text).toContain('capacity_hold');
    expect(JSON.stringify({ state: store.dumpState(), seq: store.maxSeq() })).toBe(before);
    store.close();
  });

  it('refuses a misspelled key on an update without writing the note', async () => {
    const store = new Store(':memory:');
    const t = store.createTicket(orch, NEW_TICKET);

    const r = await call(store, 'helmo_update_ticket', { ticket_id: t.id, note: 'handing this on', assinee: 'mason' });

    expect(r.isError).toBe(true);
    expect(r.text).toContain('assinee');
    expect(store.getTicket(t.id).assignee).toBeNull();
    store.close();
  });

  it('refuses an unknown filter on a read, so a filter that does not exist cannot read as no filter', async () => {
    const store = new Store(':memory:');
    store.createTicket(orch, NEW_TICKET);

    const r = await call(store, 'helmo_list_tickets', { labels: ['acct:estate'] });

    expect(r.isError).toBe(true);
    expect(r.text).toContain('labels');
    store.close();
  });

  it('still accepts every key it declares', async () => {
    const store = new Store(':memory:');
    const r = await call(store, 'helmo_create_ticket', {
      ...NEW_TICKET, project: 'R-41', labels: ['acct:estate'], priority: 1, status: 'open',
      assignee: 'mason', not_before: '2026-12-01', needs_human: 'Two clicks in a dashboard', actor: orch,
    });

    expect(r.isError).toBe(false);
    const t = store.getTicket(JSON.parse(r.text).result.id as string);
    expect(t).toMatchObject({ project: 'R-41', labels: ['acct:estate'], priority: 1, assignee: 'mason' });
    store.close();
  });

  it('declares the arguments of every tool strictly, so no door is left on the old rule', async () => {
    const store = new Store(':memory:');
    const client = await connect(store);
    const loose = (await client.listTools()).tools.filter((t) => (t.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false);
    expect(loose.map((t) => t.name)).toEqual([]);
    await client.close();
    store.close();
  });
});
