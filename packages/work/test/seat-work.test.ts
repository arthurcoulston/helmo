// What each agent is holding right now (H-3091) — the half of Overview's
// condensed roster that comes out of the work record.
//
// Driven through the real store rather than hand-built tickets: the question
// here is "which rows does a CLAIM produce", and the claim is the store's own
// transition. A fixture setting `status` and `assignee` by hand would pass
// while the store's idea of a held ticket moved.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { seatWork } from '../src/presentation.js';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

const home = mkdtempSync(join(tmpdir(), 'seat-work-'));
const store = new Store(join(home, 'helmo.db'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const operator: Actor = { name: 'arthur', kind: 'human' };
const agent = (name: string): Actor => ({ name, kind: 'agent', model: 'fixture', version: '0.1' });

function ticket(title: string, extra: Record<string, unknown> = {}) {
  return store.createTicket(operator, { title, body: 'The handoff', type: 'build', workstream: 'fixture', labels: ['acct:direction'], ...extra });
}

const held = () => seatWork(store.listTickets({ limit: -1 }));

describe('what each seat is holding', () => {
  it('reports a claimed ticket under the agent that claimed it', () => {
    const claimed = ticket('Work in hand');
    store.updateTicket(agent('mason'), { ticket_id: claimed.id, status: 'in_progress', note: 'Claimed it.' });
    expect(held()['mason']).toEqual([{ id: claimed.id, title: 'Work in hand' }]);
  });

  it('does not report work merely reserved for an agent', () => {
    // The distinction the whole card rests on: reserved is work handed to a
    // seat, not work it is doing. Reading this as current work is how an idle
    // agent starts looking busy.
    ticket('Reserved, not started', { assignee: 'ward' });
    expect(held()['ward']).toBeUndefined();
  });

  it('drops a claim the moment the work closes', () => {
    const finished = ticket('Finished work');
    store.updateTicket(agent('proof'), { ticket_id: finished.id, status: 'in_progress', note: 'Claimed it.' });
    expect(held()['proof']).toHaveLength(1);
    store.updateTicket(agent('proof'), { ticket_id: finished.id, status: 'done', note: 'Done.', completion_account: { category: 'maintenance', summary: 'The fixture obligation is discharged.' } });
    expect(held()['proof']).toBeUndefined();
  });

  it('keeps every ticket one agent holds', () => {
    const first = ticket('First of two');
    const second = ticket('Second of two');
    for (const t of [first, second]) store.updateTicket(agent('bosun'), { ticket_id: t.id, status: 'in_progress', note: 'Claimed it.' });
    expect(held()['bosun']!.map((w) => w.id)).toEqual([first.id, second.id]);
  });

  it('answers for no seat it was not told about', () => {
    // A prototype-free map, so a seat named for an inherited property cannot
    // answer for one that holds nothing (H-3004).
    const empty = seatWork([]);
    expect(Object.keys(empty)).toEqual([]);
    expect((empty as Record<string, unknown>)['toString']).toBeUndefined();
    expect((empty as Record<string, unknown>)['constructor']).toBeUndefined();
  });
});
