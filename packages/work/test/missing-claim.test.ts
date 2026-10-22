import { describe, it, expect } from 'vitest';
import { Store } from '../src/store.js';
import type { Actor } from '../src/types.js';
const planner: Actor = { name: 'planner', kind: 'orchestrator', model: 'fixture', version: '1' };
const worker: Actor = { name: 'builder', kind: 'agent', model: 'fixture', version: '1', session: 'rev:copy', generation: 'rev:copy:123:1:123' };
const runtime: Actor = { name: 'rev', kind: 'agent', model: 'rev-harness', version: '1' };
function fixture(strand = true) {
  const s = new Store(':memory:');
  const t = s.createTicket(planner, { title: 'Restore unfinished work', body: 'Frozen source and failure retained', workstream: 'fixture', type: 'build', assignee: 'builder', lane: 'copy' });
  s.launchClaim(worker, 'fixture', 'builder', worker.generation!, undefined, undefined, undefined, 'copy');
  s.updateTicket(worker, { ticket_id: t.id, status: 'in_progress', note: 'Saved incomplete work.', evidence: [{ kind: 'other', ref: 'fixture:immutable-source' }] });
  const ref = `fixture@${'a'.repeat(40)}`;
  s.recordProductCompletion(worker, { ticket_id: t.id, artifacts: [{ ref, author: 'builder' }], note: 'Frozen source under review.' });
  s.recordAcceptanceVerdict({ ...planner, name: 'reviewer', kind: 'agent' }, { ticket_id: t.id, refs: [ref], verdict: 'fail', note: 'Material technical failure retained.' });
  // Inject ONLY the pre-fix defect's effect, whose real update path is
  // reproduced by checkpoint-claim.test.ts. Synthetic store.
  if (strand) s['endExecution'](t.id, 'status:in_progress', new Date().toISOString());
  const proof = { worker: 'copy', observed_at: new Date().toISOString(), completed_at: new Date(Date.now() - 2000).toISOString(), run_end_at: new Date(Date.now() - 1000).toISOString(), idle: '123\nNo work', snapshot: 'a'.repeat(64) };
  return { s, id: t.id, proof };
}
describe('exact missing-claim recovery', () => {
  it('reopens only the strand, preserves all other fields and claims under a fresh normal generation', () => {
    const { s, id, proof } = fixture();
    try {
      const input = { ...s.inspectMissingClaim(id, worker.session!, worker.generation!), proof };
      const before = s.getTicket(id), after = s.reconcileMissingClaim(runtime, input);
      expect(s.productAcceptance(id).state).toBe('failed');
      expect(after).toEqual({ ...before, status: 'open', updated_at: after.updated_at });
      expect(() => s.reconcileMissingClaim(runtime, input)).toThrow(/conflict/);
      expect(() => s.updateTicket(worker, { ticket_id: id, note: 'Old writer' })).toThrow(/stale_generation/);
      expect(() => s.launchClaim(worker, 'fixture', 'builder', worker.generation!, undefined, undefined, undefined, 'copy')).toThrow(/launch_claim_stale/);
      const next = { ...worker, generation: 'rev:copy:456:2:456' };
      expect(s.launchClaim(next, 'fixture', 'builder', next.generation!, undefined, undefined, undefined, 'copy')).toMatchObject({ admitted: true, claimed: true, ticket_id: id });
      expect(() => s.updateTicket(next, { ticket_id: id, status: 'in_progress', note: 'Fresh normal owner advances.' })).not.toThrow();
      expect(s.getTicket(id).body).toBe(before.body);
    } finally { s.close(); }
  });
  it('refuses live claims and mismatched generations/sessions', () => {
    const { s, id } = fixture(false);
    try {
      expect(() => s.inspectMissingClaim(id, worker.session!, worker.generation!)).toThrow(/conflict/);
      s['endExecution'](id, 'status:in_progress', new Date().toISOString());
      expect(() => s.inspectMissingClaim(id, 'rev:sibling', worker.generation!)).toThrow(/conflict/);
      expect(() => s.inspectMissingClaim(id, worker.session!, 'rev:copy:456:2:456')).toThrow(/conflict/);
    } finally { s.close(); }
  });
  for (const change of ['note', 'held', 'human', 'gated', 'lane', 'owner', 'blocked', 'workflow', 'concurrent', 'ended_otherwise']) it(`refuses ${change} without changing records`, () => {
    const { s, id, proof } = fixture();
    try {
      const input = { ...s.inspectMissingClaim(id, worker.session!, worker.generation!), proof };
      if (change === 'note') s.updateTicket(planner, { ticket_id: id, note: 'Concurrent event' });
      if (change === 'held') s['db'].prepare('UPDATE tickets SET capacity_hold = ? WHERE id = ?').run(JSON.stringify({ reason: 'Deliberate pause', provenance: 'fixture', reconsider_when: 'Owner direction' }), id);
      if (change === 'human') s.updateTicket(planner, { ticket_id: id, note: 'Sitting', needs_human: 'Ten minutes deciding the remaining scope with the owner' });
      if (change === 'gated') s.updateTicket(planner, { ticket_id: id, note: 'Wait', not_before: '2099-01-01' });
      if (change === 'lane') s.updateTicket(planner, { ticket_id: id, note: 'Route changed', lane: 'sibling' });
      if (change === 'owner') s.updateTicket({ ...planner, name: 'other' }, { ticket_id: id, note: 'Owner changed', status: 'in_progress', takeover: true });
      if (change === 'blocked') { const b = s.createTicket(planner, { title: 'Real prerequisite', body: 'Independent synthetic work.', workstream: 'fixture', type: 'build' }); s.linkTickets(planner, id, b.id, 'blocks'); }
      if (change === 'workflow') s['db'].prepare('UPDATE tickets SET workflow_attempt_id = ? WHERE id = ?').run('synthetic-spent-admission', id);
      if (change === 'ended_otherwise') s['db'].prepare('UPDATE retired_generations SET reason = ? WHERE generation = ?').run('handoff', worker.generation);
      if (change === 'concurrent') {
        const b = s.createTicket(planner, { title: 'Other useful work', body: 'Independent synthetic work.', workstream: 'fixture', type: 'build', assignee: 'builder', lane: 'copy' });
        const next = { ...worker, generation: 'rev:copy:456:2:456' };
        expect(s.launchClaim(next, 'fixture', 'builder', next.generation!, undefined, undefined, undefined, 'copy').ticket_id).toBe(b.id);
        s.updateTicket(next, { ticket_id: b.id, status: 'open', note: 'New launch finished its release.' });
      }
      const before = s.getTicket(id), events = s.getEvents(id);
      expect(() => s.reconcileMissingClaim(runtime, input)).toThrow(/conflict/);
      expect(s.getTicket(id)).toEqual(before); expect(s.getEvents(id)).toEqual(events);
    } finally { s.close(); }
  });
  it('refuses self-recovery and stale proof without mutation', () => {
    const { s, id, proof } = fixture();
    try {
      const input = { ...s.inspectMissingClaim(id, worker.session!, worker.generation!), proof };
      expect(() => s.reconcileMissingClaim(worker, input)).toThrow(/runtime actor/);
      expect(() => s.reconcileMissingClaim(runtime, { ...input, proof: { ...proof, observed_at: '2000-01-01' } })).toThrow(/stale/);
      expect(s.getTicket(id).status).toBe('in_progress');
    } finally { s.close(); }
  });
});
