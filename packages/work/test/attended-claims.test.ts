import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/tools.js';
import type { Actor } from '../src/types.js';

// An attended agent — a desk session or a remote MCP caller — has a true
// identity but no worker session. It claims through the ordinary path; the
// removed desk-claim guard is not replaced by any other permit.
const desk: Actor = { name: 'builder', kind: 'agent', model: 'test-model', version: 'test-harness' };
const planner: Actor = { name: 'planner', kind: 'orchestrator', model: 'test-model', version: 'test-harness' };
const task = { title: 'Disable duplicate invitation delivery', body: 'Change only invitation delivery; keep sign-in codes enabled.', workstream: 'ops', type: 'ops', assignee: desk.name };

describe('ordinary attended work', () => {
  it('claims, completes and replays unmarked work under the actual agent identity', () => {
    const s = new Store(':memory:');
    const t = s.createTicket(planner, task);
    s.updateTicket(desk, { ticket_id: t.id, status: 'in_progress', note: 'The operator directed this change; carrying it out.' });
    expect(s.seatHolds(desk.name)[0]?.claim_actor).toEqual(desk);
    expect(s.getTicket(t.id).needs_human).toBe(false);
    s.updateTicket(desk, { ticket_id: t.id, status: 'done', completion_account: { category: 'maintenance', summary: 'Closed by a test fixture.' }, note: 'Saved and verified.', evidence: [{ kind: 'other', ref: 'Reload and sign-in check passed.' }] });
    s.rebuild();
    expect(s.getTicket(t.id).status).toBe('done');
    expect(s.getEvents(t.id).filter(e => e.event_type === 'updated').map(e => e.actor)).toEqual([desk, desk]);
    s.close();
  });

  it('retains self-triage, reservations, capacity holds and pending human actions', () => {
    const s = new Store(':memory:');
    const claim = (id: string) => s.updateTicket(desk, { ticket_id: id, status: 'in_progress', note: 'Start the directed work.' });
    const own = s.createTicket(desk, task);
    expect(() => claim(own.id)).toThrow(/untouched/);
    const reserved = s.createTicket(planner, { ...task, assignee: 'someone-else' });
    expect(() => claim(reserved.id)).toThrow(/reserved/);
    const held = s.createTicket(planner, task);
    s.updateTicket(planner, { ticket_id: held.id, note: 'Keep the reserve.', capacity_hold: { reason: 'Preserve capacity.', provenance: 'Operator decision.', reconsider_when: 'Next review.' } });
    expect(() => claim(held.id)).toThrow(/capacity/);
    const pending = s.createTicket(planner, task);
    s.requestAction(planner, pending.id, { situation: 'A physical action is required.', action: 'Connect the test device.', why_human: 'Only the operator can connect it.' });
    expect(() => claim(pending.id)).toThrow(/report_action/);
    for (const id of [own.id, reserved.id, held.id]) expect(s.getTicket(id).status).toBe('open');
    s.close();
  });

  it.each([true, false])('uses the existing MCP claim API with no added approval field (env actor=%s)', async local => {
    const store = new Store(':memory:');
    const t = store.createTicket(planner, task);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildServer(store, local ? desk : null);
    const client = new Client({ name: 'attended-test', version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const result = await client.callTool({ name: 'helmo_update_ticket', arguments: { actor: desk, ticket_id: t.id, status: 'in_progress', note: 'Executing the existing operator direction.' } });
      expect(result.isError).not.toBe(true);
      expect(store.getTicket(t.id).status).toBe('in_progress');
      expect(store.seatHolds(desk.name)[0]?.claim_actor).toEqual(desk);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
