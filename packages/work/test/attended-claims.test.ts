import { describe, it, expect, vi } from 'vitest';
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
    s.updateTicket(desk, { ticket_id: t.id, status: 'done', note: 'Saved and verified.', evidence: [{ kind: 'other', ref: 'Reload and sign-in check passed.' }] });
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

// One crew name, two live sessions (H-1382): an attended sitting holds its
// ticket while the same role's Rev loop keeps working. The name cannot say
// whose a ticket is; the claiming session can.
describe('a sitting and its loop share a name', () => {
  const single: Actor = { ...desk, session: 'rev:builder' };
  const pooled = (launch: string): Actor => ({ ...desk, session: 'rev:builder-a', generation: launch });
  const ticket = (s: Store, title: string) => s.createTicket(planner, { ...task, title });
  const claim = (s: Store, who: Actor, id: string) => s.updateTicket(who, { ticket_id: id, status: 'in_progress', note: 'Working it.' });
  const evidence = [{ kind: 'other' as const, ref: 'output' }];

  it('lets a single loop worker take other work but not the sitting\'s ticket', () => {
    const s = new Store(':memory:');
    const x = ticket(s, 'The sitting');
    const y = ticket(s, 'Independent work');
    claim(s, desk, x.id);
    expect(s.listTickets({ ready: true, workstream: task.workstream, caller: desk.name }).map((t) => t.id)).toEqual([y.id]);
    claim(s, single, y.id);
    s.updateTicket(single, { ticket_id: y.id, status: 'done', note: 'Shipped.', evidence });

    const before = s.getEvents(x.id).length;
    const attempts: (() => unknown)[] = [
      () => s.updateTicket(single, { ticket_id: x.id, status: 'done', note: 'Closing.', evidence }),
      () => s.updateTicket(single, { ticket_id: x.id, status: 'in_progress', note: 'Resuming.' }),
      () => s.updateTicket(single, { ticket_id: x.id, status: 'open', note: 'Putting it down.' }),
      () => s.updateTicket(single, { ticket_id: x.id, body_append: '\nLoop edit.', note: 'Editing.' }),
      () => s.updateTicket(single, { ticket_id: x.id, handoff_to: 'reviewer', note: 'Passing it on.' }),
      () => s.recordProductCompletion(single, { ticket_id: x.id, note: 'Ready.', artifacts: [{ ref: `helmo@${'a'.repeat(40)}`, author: 'builder' }] }),
      () => s.returnToHuman(single, x.id, { situation: 'Midway.', question: 'Which?', recommendation: 'This one.' }),
    ];
    for (const attempt of attempts) expect(attempt).toThrow(/session_claim_held.*attended session/);
    expect(s.getEvents(x.id)).toHaveLength(before);
    s.updateTicket(single, { ticket_id: x.id, note: 'Coordination note from the loop.' });
    expect(s.getTicket(x.id)).toMatchObject({ status: 'in_progress', assignee: desk.name });
    s.updateTicket(desk, { ticket_id: x.id, status: 'done', note: 'Sitting finished.', evidence });
    s.close();
  });

  it('keeps the loop\'s claim from the sitting, single and pooled', () => {
    const s = new Store(':memory:');
    const y = ticket(s, 'Loop work');
    claim(s, single, y.id);
    expect(() => s.updateTicket(desk, { ticket_id: y.id, status: 'done', note: 'Closing.', evidence })).toThrow(/session_claim_held.*'rev:builder'/);
    s.updateTicket(desk, { ticket_id: y.id, note: 'A note from the sitting.' });
    const z = ticket(s, 'Pooled loop work');
    expect(s.launchClaim({ ...desk, session: 'rev:builder-a' }, task.workstream, desk.name, 'launch-a')).toMatchObject({ claimed: true, ticket_id: z.id });
    expect(() => s.updateTicket(desk, { ticket_id: z.id, status: 'open', note: 'Taking it.' })).toThrow(/execution_claim_held/);
    s.close();
  });

  it('gives a pooled worker the next ready ticket while the sitting holds its own', () => {
    const s = new Store(':memory:');
    const x = ticket(s, 'The sitting');
    const y = ticket(s, 'Independent work');
    claim(s, desk, x.id);
    expect(s.launchClaim({ ...desk, session: 'rev:builder-a' }, task.workstream, desk.name, 'launch-a')).toMatchObject({ claimed: true, ticket_id: y.id });
    expect(() => s.updateTicket(pooled('launch-a'), { ticket_id: x.id, status: 'done', note: 'Closing.', evidence })).toThrow(/session_claim_held|launch_assignment_conflict/);
    // Nothing else ready: the next launch idles rather than resuming the sitting.
    expect(s.launchClaim({ ...desk, session: 'rev:builder-b' }, task.workstream, desk.name, 'launch-b')).toEqual({ admitted: false, launch_id: 'launch-b' });
    expect(s.getTicket(x.id)).toMatchObject({ status: 'in_progress', assignee: desk.name });
    s.close();
  });

  it('lets an ended sitting\'s claim be taken over only when stale and explicit', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-01-01T09:00:00.000Z'));
      const s = new Store(':memory:');
      const x = ticket(s, 'An abandoned sitting');
      claim(s, desk, x.id);
      vi.setSystemTime(new Date('2030-01-01T20:00:00.000Z'));
      expect(() => s.updateTicket(single, { ticket_id: x.id, status: 'in_progress', takeover: true, note: 'Taking over.' })).toThrow(/session_claim_held/);
      vi.setSystemTime(new Date('2030-01-02T10:00:00.000Z'));
      expect(() => s.updateTicket(single, { ticket_id: x.id, status: 'in_progress', note: 'Taking over.' })).toThrow(/session_claim_held/);
      s.updateTicket(single, { ticket_id: x.id, status: 'in_progress', takeover: true, note: 'The sitting ended a day ago; taking over.' });
      expect(s.seatHolds(desk.name)[0]?.claim_actor).toEqual(single);
      expect(() => s.updateTicket(desk, { ticket_id: x.id, status: 'done', note: 'Closing.', evidence })).toThrow(/session_claim_held/);
      s.updateTicket(single, { ticket_id: x.id, status: 'done', note: 'Finished.', evidence });
      s.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves orchestrator steering of the held ticket as it was', () => {
    const s = new Store(':memory:');
    const x = ticket(s, 'The sitting');
    claim(s, desk, x.id);
    s.updateTicket(planner, { ticket_id: x.id, priority: 0, note: 'Raising it for the sitting.' });
    expect(s.getTicket(x.id)).toMatchObject({ status: 'in_progress', assignee: desk.name, priority: 0 });
    s.close();
  });
});
