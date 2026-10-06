import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/tools.js';
import { Actor } from '../src/types.js';

// A pool worker's scope was a Rev-side ticket allowlist, read at config
// load, so every new lane ticket needed a roster edit and a restart (an
// idle worker woke in 29 s and could not take its own lane's new ticket). A
// lane is a ticket field instead: the worker serving it claims it on the next
// poll, and nothing else ever does.

const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '0.1' };
const builder: Actor = { name: 'builder-loop', kind: 'agent', model: 'claude-opus-5', version: '1.0', session: 'rev:builder' };
const product: Actor = { ...builder, session: 'rev:builder-product' };
const backend: Actor = { ...builder, session: 'rev:builder-backend' };

/** Filed the way Orchestrator routes work: assigned to the seat, so no
 *  self-triage stands between the filing and the claim. */
function file(s: Store, over: Record<string, unknown> = {}) {
  return s.createTicket(orch, {
    title: 'Build the importer',
    body: 'Goal: import CSVs from ./data. Current state: not started.',
    workstream: 'acme',
    type: 'build',
    assignee: builder.name,
    ...over,
  });
}

const claim = (s: Store, w: Actor, id: string, lane?: string, tickets?: string[], exclude?: string[]) =>
  s.launchClaim(w, 'acme', builder.name, id, undefined, tickets, exclude, lane);

describe('claiming by lane', () => {
  it('reaches the lane worker on its next poll when filed after it went idle', () => {
    const s = new Store(':memory:');
    expect(claim(s, product, 'p-1', 'frontend')).toEqual({ admitted: false, launch_id: 'p-1' });
    const filed = Date.now();
    const t = file(s, { lane: 'frontend' });
    const r = claim(s, product, 'p-2', 'frontend');
    expect(r).toMatchObject({ claimed: true, ticket_id: t.id, scope: { lane: 'frontend' } });
    expect(Date.now() - filed).toBeLessThan(1000);
    // A same-lane child needs only its own lane, no inheritance and no edit.
    const child = file(s, { lane: 'frontend', deps: [{ to: t.id, type: 'parent' }] });
    s.updateTicket({ ...product, generation: 'p-2' }, { ticket_id: t.id, note: 'built', status: 'done', evidence: [{ kind: 'other', ref: 'x' }] });
    expect(claim(s, product, 'p-3', 'frontend')).toMatchObject({ claimed: true, ticket_id: child.id });
  });

  it('runs two lanes at once and keeps lane work from the general worker, another lane and a lane-less caller', () => {
    const s = new Store(':memory:');
    const prep = file(s, { lane: 'frontend', priority: 0 });
    const harn = file(s, { lane: 'backend', priority: 0 });
    const general = file(s, { priority: 3 });
    // The general worker passes no lane, exactly as a caller installed before
    // lanes does; both higher-priority lane tickets are invisible to it.
    expect(claim(s, builder, 'g-1')).toMatchObject({ ticket_id: general.id });
    expect(claim(s, { ...builder, session: 'rev:builder-old' }, 'o-1')).toEqual({ admitted: false, launch_id: 'o-1' });
    expect(claim(s, { ...builder, session: 'rev:builder-other' }, 'x-1', 'mobile')).toEqual({ admitted: false, launch_id: 'x-1' });
    expect(claim(s, backend, 'h-1', 'backend')).toMatchObject({ ticket_id: harn.id });
    expect(claim(s, product, 'p-1', 'frontend')).toMatchObject({ ticket_id: prep.id });
    for (const id of [prep.id, harn.id, general.id]) expect(s.getTicket(id).status).toBe('in_progress');
  });

  it('keeps routed work routed across workstreams, inside the lane', () => {
    const s = new Store(':memory:');
    const elsewhere = file(s, { workstream: 'acme-lab', lane: 'backend' });
    expect(claim(s, product, 'p-1', 'frontend')).toEqual({ admitted: false, launch_id: 'p-1' });
    expect(claim(s, backend, 'h-1', 'backend')).toMatchObject({ ticket_id: elsewhere.id });
    // Continuation must preserve the worker's routing scope, not require the
    // assigned ticket's accounting workstream to equal that scope.
    expect(() => s.launchClaim(backend, 'changed-stream', builder.name, 'h-bad', undefined, undefined, undefined, 'backend'))
      .toThrow(/launch_claim_scope_conflict/);
    expect(claim(s, backend, 'h-2', 'backend')).toMatchObject({ resumed: true, ticket_id: elsewhere.id });
    expect(claim(s, backend, 'h-3', 'backend')).toMatchObject({ resumed: true, ticket_id: elsewhere.id });
  });

  it('keeps every readiness gate inside a lane', () => {
    const s = new Store(':memory:');
    const blocker = file(s, { lane: 'qa', priority: 3 });
    file(s, { lane: 'qa', deps: [{ to: blocker.id, type: 'blocks' }] });
    file(s, { lane: 'qa', not_before: '2999-01-01' });
    file(s, { lane: 'qa', needs_human: 'Ten minutes to choose the importer source' });
    const held = file(s, { lane: 'qa' });
    s.updateTicket(orch, { ticket_id: held.id, note: 'held', capacity_hold: { reason: 'r', provenance: 'p', reconsider_when: 'w' } });
    s.createTicket(builder, { title: 'own filing', body: 'b', workstream: 'acme', type: 'build', lane: 'qa' });
    // Only the unblocked blocker is claimable, though it is the lowest priority.
    expect(claim(s, product, 'q-1', 'qa')).toMatchObject({ ticket_id: blocker.id });
  });

  it('refuses a malformed lane and a lane beside an allowlist', () => {
    const s = new Store(':memory:');
    for (const bad of ['', 'Frontend', '-prep', 'design prep', 'a'.repeat(41)]) {
      expect(() => file(s, { lane: bad })).toThrow(/not a lane name/);
      expect(() => claim(s, product, `bad-${bad.length}`, bad)).toThrow(/not a lane name/);
    }
    expect(() => claim(s, product, 'both', 'frontend', ['H-1'])).toThrow(/lane or a ticket allowlist/);
    // An exclusion beside a lane is redundant but harmless: the lane already
    // confines the claim.
    const t = file(s, { lane: 'frontend' });
    expect(claim(s, product, 'ex', 'frontend', undefined, ['H-99'])).toMatchObject({ ticket_id: t.id });
  });
});

describe('the scope receipt', () => {
  it('writes no lane key for a lane-less call and replays only the same lane', () => {
    const s = new Store(':memory:');
    file(s);
    const t = file(s, { lane: 'frontend' });
    const plain = claim(s, builder, 'g-1');
    expect(Object.keys(plain.scope as object)).toEqual(['workstream', 'assignee', 'launch_id', 'session', 'project']);
    const laned = claim(s, product, 'p-1', 'frontend');
    expect(laned).toMatchObject({ ticket_id: t.id, scope: { lane: 'frontend' } });
    expect(claim(s, product, 'p-1', 'frontend')).toEqual(laned);
    expect(() => claim(s, product, 'p-1', 'backend')).toThrow(/different scope/);
    expect(() => claim(s, product, 'p-1')).toThrow(/different scope/);
  });
});

describe('moving work between lanes', () => {
  it('refuses a lane change under a live claim; the release may relane, and the new lane resumes it', () => {
    const s = new Store(':memory:');
    const t = file(s, { lane: 'frontend' });
    claim(s, product, 'p-1', 'frontend');
    const before = s.getEvents(t.id).length;
    for (const writer of [{ ...product, generation: 'p-1' }, orch]) {
      expect(() => s.updateTicket(writer, { ticket_id: t.id, note: 'move it', lane: 'backend' })).toThrow(/lane cannot change|execution_claim_held/);
    }
    expect(s.getEvents(t.id)).toHaveLength(before);
    expect(s.getTicket(t.id)).toMatchObject({ status: 'in_progress', lane: 'frontend' });

    s.updateTicket({ ...product, generation: 'p-1' }, {
      ticket_id: t.id, status: 'open', lane: 'backend',
      note: 'Releasing to the backend lane: branch codex/importer in ~/lanes/frontend; next step is the CSV parser.',
    });
    expect(s.getTicket(t.id)).toMatchObject({ status: 'open', lane: 'backend', assignee: builder.name });
    expect(claim(s, product, 'p-2', 'frontend')).toEqual({ admitted: false, launch_id: 'p-2' });
    expect(claim(s, backend, 'h-1', 'backend')).toMatchObject({ claimed: true, ticket_id: t.id });
  });

  it('keeps the lane through a review handback and a relabel, and lets a handoff pass a new one', () => {
    const s = new Store(':memory:');
    const t = file(s, { lane: 'frontend', labels: ['obj:OBJ-4'] });
    const gen = { ...product, generation: 'p-1' };
    claim(s, product, 'p-1', 'frontend');
    s.updateTicket(gen, { ticket_id: t.id, note: 'ready for review', handoff_to: 'reviewer-loop' });
    s.updateTicket(orch, { ticket_id: t.id, note: 'relabel', labels: ['obj:OBJ-4', 'acct:direction'] });
    s.updateTicket(orch, { ticket_id: t.id, note: 'FAIL, back to builder', handoff_to: builder.name });
    expect(s.getTicket(t.id)).toMatchObject({ lane: 'frontend', labels: ['obj:OBJ-4', 'acct:direction'] });
    expect(claim(s, product, 'p-2', 'frontend')).toMatchObject({ ticket_id: t.id });
    s.updateTicket({ ...product, generation: 'p-2' }, { ticket_id: t.id, note: 'over to the backend lane', handoff_to: builder.name, lane: 'backend' });
    expect(s.getTicket(t.id).lane).toBe('backend');
    s.updateTicket(orch, { ticket_id: t.id, note: 'back to the general pool', lane: '' });
    expect(s.getTicket(t.id).lane).toBeNull();
  });

  it('routes a lane template\'s instances to the same lane', () => {
    const s = new Store(':memory:');
    const tpl = file(s, { lane: 'backend', schedule: 'every 1m' });
    const spawned = s.materializeDue(new Date(Date.now() + 120_000));
    expect(spawned).toHaveLength(1);
    expect(s.getTicket(spawned[0]!).lane).toBe('backend');
    expect(s.getTicket(tpl.id).lane).toBe('backend');
  });
});

describe('resuming a held claim across a scope change (migration)', () => {
  it('denies a worker swapped to a lane while it holds a lane-null claim, and leaves the claim untouched', () => {
    const s = new Store(':memory:');
    const t = file(s);
    claim(s, product, 'p-1', undefined, [t.id]);
    const before = { ticket: s.getTicket(t.id), events: s.getEvents(t.id).length };
    let message = '';
    try { claim(s, product, 'p-2', 'frontend'); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/^launch_claim_scope_conflict /);
    expect(JSON.parse(message.slice('launch_claim_scope_conflict '.length))).toMatchObject({ held_ticket_id: t.id, lane: null });
    expect(s.getTicket(t.id)).toEqual(before.ticket);
    expect(s.getEvents(t.id)).toHaveLength(before.events);
    // Restoring the allowlist the claim was taken under resumes it.
    expect(claim(s, product, 'p-3', undefined, [t.id])).toMatchObject({ resumed: true, ticket_id: t.id });
  });

  it('runs the barrier: relaning a held ticket refuses; after release, relane, swap, the next poll claims new lane work', () => {
    const s = new Store(':memory:');
    const listed = file(s);
    const other = file(s);
    claim(s, product, 'p-1', undefined, [listed.id, other.id]);
    // 3.1 fails: the worker holds a listed ticket, so the relane refuses.
    expect(() => s.updateTicket(orch, { ticket_id: listed.id, note: 'cutover', lane: 'frontend' })).toThrow();
    // The worker releases at a natural stop, with its continuation note.
    s.updateTicket({ ...product, generation: 'p-1' }, { ticket_id: listed.id, status: 'open', note: 'Natural stop: branch codex/importer; next step the parser.' });
    // 3.3: every listed non-terminal ticket is relaned while unclaimed.
    for (const id of [listed.id, other.id]) s.updateTicket(orch, { ticket_id: id, note: 'cutover to lanes', lane: 'frontend' });
    // 3.4 swap: the worker now claims by lane; the general worker cannot see them.
    expect(claim(s, builder, 'g-1')).toEqual({ admitted: false, launch_id: 'g-1' });
    expect(claim(s, product, 'p-2', 'frontend')).toMatchObject({ ticket_id: listed.id });
    const fresh = file(s, { lane: 'frontend' });
    s.updateTicket({ ...product, generation: 'p-2' }, { ticket_id: listed.id, note: 'done', status: 'done', evidence: [{ kind: 'other', ref: 'x' }] });
    s.updateTicket(orch, { ticket_id: other.id, note: 'not needed', status: 'cancelled' });
    expect(claim(s, product, 'p-3', 'frontend')).toMatchObject({ claimed: true, ticket_id: fresh.id });
  });
});

// A store written by a release from before lanes. Point LEGACY_WORK_DIST at
// that release's work dist (the directory holding store.js) to prove the
// migration from it; without one the case is skipped. Not HELMO_-prefixed,
// because scripts/test-env.mjs strips product variables.
const legacyDists = process.env['LEGACY_WORK_DIST'] ? [['LEGACY_WORK_DIST', process.env['LEGACY_WORK_DIST']]] : [];
describe.each(legacyDists)('a store written before lanes, by %s', (_release, legacyDist) => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'helmo-lane-legacy-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(!existsSync(join(legacyDist!, 'store.js')))('opens a pre-lane store holding an allowlist claim, resumes it and replays its receipt', async () => {
    const dbPath = join(dir, 'helmo.db');
    const legacy = await import(pathToFileURL(join(legacyDist!, 'store.js')).href) as { Store: new (path: string) => {
      createTicket: Store['createTicket']; launchClaim: (a: Actor, w: string, as: string, id: string, p?: string, t?: string[]) => Record<string, unknown>; close(): void;
    } };
    const old = new legacy.Store(dbPath);
    const t = old.createTicket(orch, { title: 'Build the importer', body: 'Goal: import CSVs.', workstream: 'acme', type: 'build', assignee: builder.name });
    const receipt = old.launchClaim(product, 'acme', builder.name, 'p-1', undefined, [t.id]);
    old.close();
    const columns = (new Database(dbPath).prepare('PRAGMA table_info(tickets)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain('lane');

    const s = new Store(dbPath);
    expect(s.getTicket(t.id)).toMatchObject({ status: 'in_progress', lane: null });
    expect(claim(s, product, 'p-1', undefined, [t.id])).toEqual(receipt);
    expect(claim(s, product, 'p-2', undefined, [t.id])).toMatchObject({ resumed: true, ticket_id: t.id });
    s.close();
  });
});

describe('waking by lane', () => {
  it('narrows the wake to what that lane\'s claim could take, and keeps the whole queue without one', () => {
    const s = new Store(':memory:');
    const seq = s.maxSeq();
    const prep = file(s, { lane: 'frontend' });
    const general = file(s);
    expect(s.wakeCheck(seq, 'acme', builder.name, 'frontend')).toMatchObject({ ready_ids: [prep.id], newly_ready_ids: [prep.id] });
    expect(s.wakeCheck(seq, 'acme', builder.name, null)).toMatchObject({ ready_ids: [general.id], newly_ready_ids: [general.id] });
    expect(s.wakeCheck(seq, 'acme', builder.name, 'backend')).toMatchObject({ ready_count: 0 });
    expect(s.wakeCheck(seq, 'acme', builder.name).ready_ids.sort()).toEqual([prep.id, general.id].sort());
  });
});

describe('lane through the MCP surface', () => {
  it('passes lane through create, update and list rather than stripping it', async () => {
    const store = new Store(':memory:');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildServer(store, orch);
    const client = new Client({ name: 'test-agent', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const text = (r: Awaited<ReturnType<typeof client.callTool>>) => JSON.parse((r.content as { text: string }[])[0]!.text);
    const parse = (r: Awaited<ReturnType<typeof client.callTool>>) => text(r).result;

    const created = parse(await client.callTool({ name: 'helmo_create_ticket', arguments: {
      title: 'Build the importer', body: 'Goal: import CSVs.', workstream: 'acme', type: 'build', assignee: builder.name, lane: 'frontend',
    } }));
    expect(created.ticket).toMatchObject({ lane: 'frontend' });
    expect(store.getTicket(created.id).lane).toBe('frontend');

    const bad = await client.callTool({ name: 'helmo_update_ticket', arguments: { ticket_id: created.id, note: 'move', lane: 'Backend' } });
    expect(bad.isError).toBe(true);
    expect(text(bad).error).toMatch(/not a lane name/);

    expect(parse(await client.callTool({ name: 'helmo_update_ticket', arguments: { ticket_id: created.id, note: 'move', lane: 'backend' } }))).toMatchObject({ lane: 'backend' });
    store.createTicket(orch, { title: 'Other', body: 'b', workstream: 'acme', type: 'build' });
    const listed = parse(await client.callTool({ name: 'helmo_list_tickets', arguments: { lane: 'backend' } }));
    expect(listed.tickets.map((t: { id: string }) => t.id)).toEqual([created.id]);
    await client.close();
    store.close();
  });
});

describe('lane through the CLI', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'helmo-lane-cli-')); dbPath = join(dir, 'helmo.db'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function as(actor: Actor, ...argv: string[]) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...argv], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, HELMO_DB: dbPath, HELMO_ACTOR: JSON.stringify(actor) },
      encoding: 'utf8',
    });
    return { status: r.status, out: r.status === 0 ? JSON.parse(r.stdout) : undefined, err: r.stderr };
  }

  it('files, lists, wakes, claims and clears by --lane', { timeout: 60_000 }, () => {
    const base = ['--workstream', 'acme', '--assignee', builder.name];
    const { id } = as(orch, 'create', '--title', 'Build the importer', '--body', 'Goal: import CSVs.', '--type', 'build', ...base, '--lane', 'backend').out;
    const other = as(orch, 'create', '--title', 'General work', '--body', 'Goal: tidy.', '--type', 'build', ...base).out.id;
    expect(as(orch, 'list', '--lane', 'backend').out.tickets).toMatchObject([{ id, lane: 'backend' }]);
    expect(as(orch, 'wake-check', ...base, '--since-seq', '0', '--lane', 'backend').out.ready_ids).toEqual([id]);
    expect(as(orch, 'wake-check', ...base, '--since-seq', '0', '--no-lane').out.ready_ids).toEqual([other]);
    expect(as(orch, 'wake-check', ...base, '--since-seq', '0', '--lane', 'backend', '--no-lane').status).toBe(1);

    expect(as(backend, 'launch-claim', ...base, '--launch-id', 'h-1', '--lane', 'frontend').out).toEqual(expect.objectContaining({ admitted: false }));
    expect(as(backend, 'launch-claim', ...base, '--launch-id', 'h-2', '--lane', 'backend').out).toMatchObject({ claimed: true, ticket_id: id, scope: { lane: 'backend' } });
    expect(as(orch, 'update', '--ticket', other, '--note', 'route it', '--lane', 'frontend').status).toBe(0);
    expect(as(orch, 'update', '--ticket', other, '--note', 'unroute it', '--lane', '').status).toBe(0);
    expect(as(builder, 'launch-claim', ...base, '--launch-id', 'g-1').out).toMatchObject({ claimed: true, ticket_id: other });
  });
});
