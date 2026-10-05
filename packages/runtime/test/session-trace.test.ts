import { describe, expect, it } from 'vitest';
import { sessionTrace } from '../src/session-trace.js';

const ticket = {
  installation: { label: 'fixture.personal' }, id: 'H-7', status: 'in_progress', assignee: 'mason', action: null,
  deps: { outgoing: [] },
  events: [{ seq: 9, ts: '2026-10-05T00:00:03.000Z', event_type: 'updated', actor: { generation: 'rev:mason:1' } }],
};

describe('session trace diagnostic', () => {
  it('joins only by the durable launch identity and keeps content out', () => {
    const result = sessionTrace(ticket, [{
      format: 1, phase: 'complete', launch_id: 'rev:mason:1', ticket_id: 'H-7', intent_at: '2026-10-05T00:00:00.000Z',
      completed_at: '2026-10-05T00:00:04.000Z', session: { provider: 'codex', model: 'fixture', provider_session_id: 'thread-1', provider_session_id_state: 'observed', started_at: '2026-10-05T00:00:01.000Z', ended_at: '2026-10-05T00:00:02.000Z', outcome: 'ok', tokens: 0, cost_usd: 0 },
    }], 0) as any;
    expect(result.content).toBe('excluded');
    expect(result.ticket.value).toBe('H-7@fixture.personal');
    expect(result.launches[0].work_event.value).toEqual({ seq: 9, type: 'updated', at: '2026-10-05T00:00:03.000Z' });
    expect(result.launches[0].usage.state).toBe('measured_zero');
    expect(JSON.stringify(result)).not.toContain('thread transcript');
  });

  it('names the owner of an open dependency as the next actor', () => {
    const result = sessionTrace({
      ...ticket,
      deps: { outgoing: [{ type: 'blocks', to_id: 'H-8' }] },
      blockers: [{ id: 'H-8', assignee: 'proof', needs_human: false }],
    }, [], 0) as any;
    expect(result.next_owner.value).toEqual([{ ticket: 'H-8', owner: 'proof' }]);
    expect(result.wait_reason.value).toBe('dependency_blocked');
  });

  it('separates unsupported, not observed and malformed states', () => {
    const result = sessionTrace({ ...ticket, events: [] }, [{ format: 1, phase: 'dispatching', launch_id: 'rev:mason:2', ticket_id: 'H-7', intent_at: '2026-10-05T00:00:00.000Z' }], 2) as any;
    expect(result.launches[0].provider.state).toBe('not_observed');
    expect(result.launches[0].source_revision.state).toBe('unsupported');
    expect(result.malformed_launch_records).toMatchObject({ state: 'malformed/refused', value: 2 });
  });
});
