import { describe, it, expect } from 'vitest';
import { Store } from '../src/store.js';
import type { Actor } from '../src/types.js';

const planner: Actor = { name: 'planner', kind: 'orchestrator', model: 'fixture', version: '1' };
const worker: Actor = { name: 'builder', kind: 'agent', model: 'fixture', version: '1', session: 'rev:fixture', generation: 'rev:fixture:123:1:123' };
function fixture() {
  const store = new Store(':memory:');
  const ticket = store.createTicket(planner, { title: 'Keep unfinished work', body: 'Exact continuation', workstream: 'fixture', type: 'build', assignee: 'builder', lane: 'copy' });
  expect(store.launchClaim(worker, 'fixture', 'builder', worker.generation!, undefined, undefined, undefined, 'copy').ticket_id).toBe(ticket.id);
  return { store, id: ticket.id };
}
describe('owner checkpoints retain execution', () => {
  for (const repeated of [false, true]) it(`${repeated ? 'repeated in_progress' : 'note-only'} keeps the writer and next-worker resume`, () => {
    const { store, id } = fixture();
    try {
      store.updateTicket(worker, { ticket_id: id, note: 'Working slice saved.', ...(repeated ? { status: 'in_progress' as const } : {}) });
      expect(() => store.updateTicket(worker, { ticket_id: id, note: 'Same owner continues.' })).not.toThrow();
      const successor = { ...worker, generation: 'rev:fixture:123:2:456' };
      const receipt = store.launchClaim(successor, 'fixture', 'builder', successor.generation!, undefined, undefined, undefined, 'copy');
      expect(receipt).toMatchObject({ ticket_id: id, admitted: true, claimed: true, resumed: true });
      expect(() => store.updateTicket(worker, { ticket_id: id, note: 'Retired child' })).toThrow(/stale_generation/);
    } finally { store.close(); }
  });
  for (const handoff of [false, true]) it(`${handoff ? 'explicit same-seat handoff' : 'OPEN release'} still retires the writer`, () => {
    const { store, id } = fixture();
    try {
      store.updateTicket(worker, { ticket_id: id, note: 'Release to next owner.', ...(handoff ? { handoff_to: 'builder' } : { status: 'open' as const }) });
      expect(() => store.updateTicket(worker, { ticket_id: id, note: 'Old writer' })).toThrow(/stale_generation/);
      expect(() => store.launchClaim(worker, 'fixture', 'builder', worker.generation!, undefined, undefined, undefined, 'copy')).toThrow(/launch_claim_stale/);
    } finally { store.close(); }
  });
  it('real ownership change retires the prior writer', () => {
    const { store, id } = fixture();
    try {
      store.updateTicket({ ...planner, name: 'replacement' }, { ticket_id: id, status: 'in_progress', takeover: true, note: 'Authorized owner replacement.' });
      expect(store.getTicket(id).assignee).toBe('replacement');
      expect(() => store.updateTicket(worker, { ticket_id: id, note: 'Prior writer' })).toThrow(/stale_generation/);
    } finally { store.close(); }
  });
  it('records the replacement execution when a worker takes over an untracked claim', () => {
    const store = new Store(':memory:');
    const prior = { ...planner, name: 'prior' };
    const replacement = { ...worker, name: 'replacement', session: 'rev:replacement', generation: 'rev:replacement:456:1:789' };
    const ticket = store.createTicket(planner, { title: 'Recover stale work', body: 'Exact continuation', workstream: 'fixture', type: 'build', assignee: prior.name, lane: 'copy' });
    try {
      store.updateTicket(prior, { ticket_id: ticket.id, status: 'in_progress', note: 'Attended claim has no supervised execution.' });
      store.updateTicket(replacement, { ticket_id: ticket.id, status: 'in_progress', takeover: true, note: 'Take over the abandoned claim.' });
      expect(store.getTicket(ticket.id).assignee).toBe('replacement');
      expect(() => store.updateTicket(replacement, { ticket_id: ticket.id, note: 'Move active work.', lane: 'other' })).toThrow(/running execution/);
    } finally { store.close(); }
  });
});
