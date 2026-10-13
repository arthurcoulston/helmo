import { describe, it, expect } from 'vitest';
import { Store } from '../src/store.js';
import type { Actor } from '../src/types.js';
const planner: Actor = { name: 'planner', kind: 'orchestrator', model: 'fixture', version: '1' };
const worker: Actor = { name: 'builder', kind: 'agent', model: 'fixture', version: '1', session: 'rev:builder', generation: 'rev:builder:123:17:123' };
const runtime: Actor = { name: 'rev', kind: 'agent', model: 'rev-harness', version: '1' };
function fixture() {
  const s = new Store(':memory:');
  const t = s.createTicket(worker, { status: 'in_progress', title: 'Preserve paused work', body: 'Evidence retained. NEXT LAUNCH: continue.', workstream: 'fixture', type: 'ops', assignee: 'builder' });
  const input = { ticket_id: t.id, session: worker.session!, generation: worker.generation!, expected_updated_at: s.getTicket(t.id).updated_at, expected_event_seq: s.getEvents(t.id).at(-1)!.seq,
    hold: { reason: 'Operator paused this outcome.', provenance: 'H-fixture', reconsider_when: 'Explicit operator resume.' },
    body_patch: { old: 'NEXT LAUNCH: continue.', new: 'PAUSED: wait for explicit operator resume.' },
    proof: { worker: 'builder', observed_at: new Date().toISOString(), completed_at: new Date(Date.now() - 2000).toISOString(), run_end_at: new Date(Date.now() - 1000).toISOString(), stop: 'STOP\n' } };
  return { s, input };
}
describe('hold-only ended-generation repair', () => {
  it('atomically retires the ended claim, preserves ownership/evidence and survives replay', () => {
    const { s, input } = fixture();
    const before = s.getTicket(input.ticket_id);
    const after = s.reconcileEndedClaim(runtime, input);
    expect(after.status).toBe('open'); expect(after.capacity_hold).toEqual(input.hold);
    expect(after.assignee).toBe('builder'); expect(after.evidence).toEqual(before.evidence);
    expect(after.body).toBe('Evidence retained. PAUSED: wait for explicit operator resume.');
    expect(() => s.updateTicket(worker, { ticket_id: after.id, note: 'old child' })).toThrow(/stale_generation/);
    expect(s.launchClaim({ ...worker, generation: 'rev:builder:123:18:456' }, 'fixture', 'builder', 'rev:builder:123:18:456').admitted).toBe(false);
    expect(() => s.reconcileEndedClaim(runtime, input)).toThrow(/conflict/);
    s.rebuild(); expect(s.getTicket(after.id)).toEqual(after); s.close();
  });
  it('refuses a replacement generation or a concurrent ticket edit without writing', () => {
    for (const replacement of [true, false]) {
      const { s, input } = fixture();
      if (replacement) s.launchClaim({ ...worker, generation: 'rev:builder:123:18:456' }, 'fixture', 'builder', 'rev:builder:123:18:456');
      else s.updateTicket(worker, { ticket_id: input.ticket_id, note: 'Owner changed continuation.', body_append: ' Preserve this new evidence.' });
      const before = s.getTicket(input.ticket_id), events = s.getEvents(input.ticket_id);
      expect(() => s.reconcileEndedClaim(runtime, input)).toThrow(/conflict/);
      expect(s.getTicket(input.ticket_id)).toEqual(before); expect(s.getEvents(input.ticket_id)).toEqual(events); s.close();
    }
  });
  it('refuses execution callers, stale evidence, release holds and ambiguous correction', () => {
    const { s, input } = fixture();
    expect(() => s.reconcileEndedClaim(worker, input)).toThrow(/runtime actor/);
    expect(() => s.reconcileEndedClaim(runtime, { ...input, proof: { ...input.proof, observed_at: '2000-01-01T00:00:00Z' } })).toThrow(/stale/);
    expect(() => s.reconcileEndedClaim(runtime, { ...input, body_patch: { old: 'missing', new: 'pause' } })).toThrow(/anchor/);
    expect(() => s.reconcileEndedClaim(runtime, { ...input, session: 'rev:other' })).toThrow(/exact/);
    expect(() => s.reconcileEndedClaim(runtime, { ...input, hold: { ...input.hold, release: { batch_id: 'bad', until: '2099-01-01', stop_conditions: 'none', shared_reserve: 'none' } } })).toThrow(/without a release/);
    s.updateTicket(worker, { ticket_id: input.ticket_id, note: 'Owner recorded a material event.' });
    expect(() => s.reconcileEndedClaim(runtime, input)).toThrow(/conflict/);
    expect(s.getTicket(input.ticket_id).status).toBe('in_progress'); s.close();
  });
});
