import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { buildServer } from '../src/tools.js';
import type { Actor } from '../src/types.js';

const desk: Actor = { name: 'builder', kind: 'agent', model: 'launcher-model', version: 'launcher-version' };
const loop: Actor = { ...desk, session: 'rev:builder' };
const meeting: Actor = { ...desk, session: 'meeting:attended' };
const stated: Actor = { ...desk, model: 'caller-model', version: 'caller-version' };
const planner: Actor = { name: 'planner', kind: 'orchestrator', model: 'test', version: '1' };
const task = { title: 'Independent work', body: 'Original body.', workstream: 'test', type: 'build', assignee: desk.name };

async function connect(store: Store, env: Actor | null) {
  const server = buildServer(store, env);
  const client = new Client({ name: 'session-ownership-test', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    call: (args: Record<string, unknown>) => client.callTool({ name: 'helmo_update_ticket', arguments: args }),
    close: async () => { await client.close(); await server.close(); },
  };
}

// Claims and attempted edits both travel through MCP. The caller's model and
// version differ from the launcher's to prove provenance survives the fence.
describe('server-bound session ownership through MCP (H-1382)', () => {
  const servers = [
    { label: 'attended', env: desk, owner: desk, foreign: loop },
    { label: 'remote attended', env: null, owner: desk, foreign: loop },
    { label: 'single loop', env: loop, owner: loop, foreign: desk },
    { label: 'stamped attended', env: meeting, owner: meeting, foreign: loop },
    { label: 'single loop beside stamped attended', env: loop, owner: loop, foreign: meeting },
  ];
  const stamps = ['absent', 'matching', 'forged', 'empty'] as const;

  describe.each(servers)('$label server', ({ env, owner, foreign }) => {
    it.each(stamps)('checks an %s stamp against both its own and the other session claim', async stamp => {
      const store = new Store(':memory:');
      const writer = await connect(store, env);
      const other = await connect(store, foreign);
      try {
        const own = store.createTicket(planner, task);
        const held = store.createTicket(planner, task);
        expect((await writer.call({ ticket_id: own.id, status: 'in_progress', note: 'Claim own work.', actor: stated })).isError).toBeFalsy();
        expect((await other.call({ ticket_id: held.id, status: 'in_progress', note: 'Claim other work.', actor: stated })).isError).toBeFalsy();
        const expectedActor = { ...stated, ...(owner.session ? { session: owner.session } : {}) };
        expect(store.seatHolds(desk.name).find(h => h.ticket_id === own.id)?.claim_actor).toEqual(expectedActor);

        const actor = stamp === 'absent' ? stated : {
          ...stated,
          // A desk has no matching stamp. Omitting it is the only truthful
          // representation; an empty string must not shed a loop's stamp.
          ...(stamp === 'matching' ? (owner.session ? { session: owner.session } : {}) :
            { session: stamp === 'empty' ? '' : (foreign.session ?? 'meeting:forged') }),
        };
        const conflict = stamp === 'forged' || stamp === 'empty';
        for (const [ticket, isOwn] of [[held, false], [own, true]] as const) {
          const before = store.getEvents(ticket.id);
          const result = await writer.call({ ticket_id: ticket.id, actor, note: 'Edit work.', body_append: 'Recorded progress.' });
          if (conflict || !isOwn) {
            expect(result.isError).toBe(true);
            expect(JSON.stringify(result)).toMatch(conflict ? /session_identity_conflict/ : /session_claim_held/);
            expect(store.getEvents(ticket.id)).toEqual(before);
            expect(store.getTicket(ticket.id)).toMatchObject({ status: 'in_progress', body: task.body });
          } else {
            expect(result.isError).toBeFalsy();
            expect(store.getTicket(ticket.id).body).toContain('Recorded progress.');
            expect(store.getEvents(ticket.id).at(-1)?.actor).toEqual(expectedActor);
          }
        }
        // Same-name foreign sessions can still coordinate with truthful notes.
        expect((await writer.call({ ticket_id: held.id, actor: stated, note: 'Coordination only.' })).isError).toBeFalsy();
        expect(store.getEvents(held.id).at(-1)?.actor).toEqual(expectedActor);
      } finally {
        await writer.close(); await other.close(); store.close();
      }
    });
  });

  it.each([desk, loop])('inherits the whole server actor when the actor is omitted (%j)', async env => {
    const store = new Store(':memory:');
    const writer = await connect(store, env);
    try {
      const ticket = store.createTicket(planner, task);
      expect((await writer.call({ ticket_id: ticket.id, status: 'in_progress', note: 'Claim.' })).isError).toBeFalsy();
      expect(store.seatHolds(desk.name)[0]?.claim_actor).toEqual(env);
    } finally {
      await writer.close(); store.close();
    }
  });

  it('preserves pooled binding, launch scope and retirement for absent, matching and forged stamps', async () => {
    const store = new Store(':memory:');
    const a: Actor = { ...desk, session: 'rev:builder-a', generation: 'launch-a' };
    const b: Actor = { ...desk, session: 'rev:builder-b', generation: 'launch-b' };
    const own = store.createTicket(planner, task);
    const sibling = store.createTicket(planner, task);
    const open = store.createTicket(planner, task);
    store.launchClaim({ ...a, generation: undefined }, task.workstream, desk.name, a.generation!, undefined, [own.id]);
    store.launchClaim({ ...b, generation: undefined }, task.workstream, desk.name, b.generation!, undefined, [sibling.id]);
    const writer = await connect(store, a);
    const attended = await connect(store, desk);
    try {
      for (const actor of [undefined, stated, { ...stated, session: a.session, generation: a.generation }]) {
        const args = { actor, note: 'Progress.', body_append: 'Pool progress.' };
        expect((await writer.call({ ...args, ticket_id: own.id })).isError).toBeFalsy();
        expect(store.getEvents(own.id).at(-1)?.actor).toEqual(actor ? { ...a, model: stated.model, version: stated.version } : a);
        for (const [ticket, error] of [[sibling, /execution_claim_held/], [open, /launch_assignment_conflict/]] as const) {
          const before = store.getEvents(ticket.id);
          const result = await writer.call({ ...args, ticket_id: ticket.id });
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).toMatch(error);
          expect(store.getEvents(ticket.id)).toEqual(before);
        }
      }
      for (const actor of [
        { ...stated, session: b.session },
        { ...stated, generation: b.generation },
        { ...stated, session: b.session, generation: b.generation },
        { ...stated, session: '' },
        { ...stated, name: 'someone-else' },
        { ...stated, kind: 'orchestrator' },
      ]) {
        const before = store.getEvents(sibling.id);
        const result = await writer.call({ ticket_id: sibling.id, actor, note: 'Forged write.', body_append: 'Forbidden.' });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toMatch(/supervised_identity_conflict/);
        expect(store.getEvents(sibling.id)).toEqual(before);
      }
      const before = store.getEvents(own.id);
      for (const actor of [stated, { ...stated, session: a.session }, { ...stated, session: a.session, generation: a.generation }]) {
        const result = await attended.call({ ticket_id: own.id, actor, note: 'Desk write.', body_append: 'Forbidden.' });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toMatch(/execution_claim_held|session_identity_conflict|generation is bound/);
        expect(store.getEvents(own.id)).toEqual(before);
      }
      expect((await writer.call({ ticket_id: own.id, note: 'Finished.', status: 'done', evidence: [{ kind: 'other', ref: 'fixture-output' }] })).isError).toBeFalsy();
      const retired = await writer.call({ ticket_id: own.id, note: 'Late note.' });
      expect(retired.isError).toBe(true);
      expect(JSON.stringify(retired)).toMatch(/stale_generation/);
    } finally {
      await writer.close(); await attended.close(); store.close();
    }
  });
});

describe('the CLI shares the server-bound session rule', () => {
  it.each([desk, loop])('refuses a forged --actor session without writing (%j)', env => {
    const dir = mkdtempSync(join(tmpdir(), 'helmo-session-'));
    const dbPath = join(dir, 'helmo.db');
    try {
      const store = new Store(dbPath);
      const ticket = store.createTicket(planner, task);
      const holder = env.session ? desk : loop;
      store.updateTicket(holder, { ticket_id: ticket.id, status: 'in_progress', note: 'Claim.' });
      const before = store.getEvents(ticket.id);
      store.close();
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', 'src/cli.ts', 'update', '--ticket', ticket.id, '--note', 'Forged edit.', '--body-append', 'Forbidden.',
        '--actor', JSON.stringify({ ...stated, session: holder.session ?? '' }),
      ], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, HELMO_DB: dbPath, HELMO_ACTOR: JSON.stringify(env) }, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(/session_identity_conflict/);
      const reopened = new Store(dbPath);
      expect(reopened.getEvents(ticket.id)).toEqual(before);
      expect(reopened.getTicket(ticket.id).body).toBe(task.body);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
