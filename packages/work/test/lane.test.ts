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

// H-824. A pool worker's scope was a Rev-side ticket allowlist, read at config
// load, so every new lane ticket needed a roster edit and a restart (H-822: an
// idle worker woke in 29 s and could not take its own lane's new ticket). A
// lane is a ticket field instead: the worker serving it claims it on the next
// poll, and nothing else ever does.

const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '0.1' };
const builder: Actor = { name: 'builder-loop', kind: 'agent', model: 'claude-opus-5', version: '1.0', session: 'rev:builder' };
const product: Actor = { ...builder, session: 'rev:builder-product' };
const harness: Actor = { ...builder, session: 'rev:builder-harness' };

/** Filed the way Orchestrator routes work: assigned to the seat, so no
 *  self-triage stands between the filing and the claim. */
function file(s: Store, over: Record<string, unknown> = {}) {
  return s.createTicket(orch, {
    title: 'Build the importer',
    body: 'Goal: import CSVs from ./data. Current state: not started.',
    workstream: 'goodplumb',
    type: 'build',
    assignee: builder.name,
    ...over,
  });
}

const claim = (s: Store, w: Actor, id: string, lane?: string, tickets?: string[], exclude?: string[]) =>
  s.launchClaim(w, 'goodplumb', builder.name, id, undefined, tickets, exclude, lane);

describe('claiming by lane (H-824)', () => {
  it('reaches the lane worker on its next poll when filed after it went idle', () => {
    const s = new Store(':memory:');
    expect(claim(s, product, 'p-1', 'design-prep')).toEqual({ admitted: false, launch_id: 'p-1' });
    const filed = Date.now();
    const t = file(s, { lane: 'design-prep' });
    const r = claim(s, product, 'p-2', 'design-prep');
    expect(r).toMatchObject({ claimed: true, ticket_id: t.id, scope: { lane: 'design-prep' } });
    expect(Date.now() - filed).toBeLessThan(1000);
    // A same-lane child needs only its own lane, no inheritance and no edit.
    const child = file(s, { lane: 'design-prep', deps: [{ to: t.id, type: 'parent' }] });
    s.updateTicket({ ...product, generation: 'p-2' }, { ticket_id: t.id, note: 'built', status: 'done', evidence: [{ kind: 'other', ref: 'x' }] });
    expect(claim(s, product, 'p-3', 'design-prep')).toMatchObject({ claimed: true, ticket_id: child.id });
  });

  it('runs two lanes at once and keeps lane work from the general worker, another lane and a lane-less caller', () => {
    const s = new Store(':memory:');
    const prep = file(s, { lane: 'design-prep', priority: 0 });
    const harn = file(s, { lane: 'harness', priority: 0 });
    const general = file(s, { priority: 3 });
    // The general worker passes no lane, exactly as a caller installed before
    // lanes does; both higher-priority lane tickets are invisible to it.
    expect(claim(s, builder, 'g-1')).toMatchObject({ ticket_id: general.id });
    expect(claim(s, { ...builder, session: 'rev:builder-old' }, 'o-1')).toEqual({ admitted: false, launch_id: 'o-1' });
    expect(claim(s, { ...builder, session: 'rev:builder-other' }, 'x-1', 'design-process')).toEqual({ admitted: false, launch_id: 'x-1' });
    expect(claim(s, harness, 'h-1', 'harness')).toMatchObject({ ticket_id: harn.id });
    expect(claim(s, product, 'p-1', 'design-prep')).toMatchObject({ ticket_id: prep.id });
    for (const id of [prep.id, harn.id, general.id]) expect(s.getTicket(id).status).toBe('in_progress');
  });

  it('keeps routed work routed across workstreams (H-661), inside the lane', () => {
    const s = new Store(':memory:');
    const elsewhere = file(s, { workstream: 'goodplumb-lab', lane: 'harness' });
    expect(claim(s, product, 'p-1', 'design-prep')).toEqual({ admitted: false, launch_id: 'p-1' });
    expect(claim(s, harness, 'h-1', 'harness')).toMatchObject({ ticket_id: elsewhere.id });
    // Continuation must preserve the worker's routing scope, not require the
    // assigned ticket's accounting workstream to equal that scope (H-837).
    expect(() => s.launchClaim(harness, 'changed-stream', builder.name, 'h-bad', undefined, undefined, undefined, 'harness'))
      .toThrow(/launch_claim_scope_conflict/);
    expect(claim(s, harness, 'h-2', 'harness')).toMatchObject({ resumed: true, ticket_id: elsewhere.id });
    expect(claim(s, harness, 'h-3', 'harness')).toMatchObject({ resumed: true, ticket_id: elsewhere.id });
  });

  it('keeps every readiness gate inside a lane', () => {
    const s = new Store(':memory:');
    const blocker = file(s, { lane: 'qa', priority: 3 });
    file(s, { lane: 'qa', deps: [{ to: blocker.id, type: 'blocks' }] });
    file(s, { lane: 'qa', not_before: '2999-01-01' });
    file(s, { lane: 'qa', needs_human: 'Ten minutes to choose the importer source' });
    const held = file(s, { lane: 'qa' });
    s.updateTicket(orch, { ticket_id: held.id, note: 'held', capacity_hold: { reason: 'r', provenance: 'p', reconsider_when: 'w' } });
    s.createTicket(builder, { title: 'own filing', body: 'b', workstream: 'goodplumb', type: 'build', lane: 'qa' });
    // Only the unblocked blocker is claimable, though it is the lowest priority.
    expect(claim(s, product, 'q-1', 'qa')).toMatchObject({ ticket_id: blocker.id });
  });

  it('refuses a malformed lane and a lane beside an allowlist', () => {
    const s = new Store(':memory:');
    for (const bad of ['', 'Design-Prep', '-prep', 'design prep', 'a'.repeat(41)]) {
      expect(() => file(s, { lane: bad })).toThrow(/not a lane name/);
      expect(() => claim(s, product, `bad-${bad.length}`, bad)).toThrow(/not a lane name/);
    }
    expect(() => claim(s, product, 'both', 'design-prep', ['H-1'])).toThrow(/lane or a ticket allowlist/);
    // An exclusion beside a lane is redundant but harmless: the lane already
    // confines the claim.
    const t = file(s, { lane: 'design-prep' });
    expect(claim(s, product, 'ex', 'design-prep', undefined, ['H-99'])).toMatchObject({ ticket_id: t.id });
  });
});

describe('the scope receipt (H-824)', () => {
  it('writes no lane key for a lane-less call and replays only the same lane', () => {
    const s = new Store(':memory:');
    file(s);
    const t = file(s, { lane: 'design-prep' });
    const plain = claim(s, builder, 'g-1');
    expect(Object.keys(plain.scope as object)).toEqual(['workstream', 'assignee', 'launch_id', 'session', 'project']);
    const laned = claim(s, product, 'p-1', 'design-prep');
    expect(laned).toMatchObject({ ticket_id: t.id, scope: { lane: 'design-prep' } });
    expect(claim(s, product, 'p-1', 'design-prep')).toEqual(laned);
    expect(() => claim(s, product, 'p-1', 'harness')).toThrow(/different scope/);
    expect(() => claim(s, product, 'p-1')).toThrow(/different scope/);
  });
});

describe('moving work between lanes (H-824)', () => {
  it('refuses a lane change under a live claim; the release may relane, and the new lane resumes it', () => {
    const s = new Store(':memory:');
    const t = file(s, { lane: 'design-prep' });
    claim(s, product, 'p-1', 'design-prep');
    const before = s.getEvents(t.id).length;
    for (const writer of [{ ...product, generation: 'p-1' }, orch]) {
      expect(() => s.updateTicket(writer, { ticket_id: t.id, note: 'move it', lane: 'harness' })).toThrow(/lane cannot change|execution_claim_held/);
    }
    expect(s.getEvents(t.id)).toHaveLength(before);
    expect(s.getTicket(t.id)).toMatchObject({ status: 'in_progress', lane: 'design-prep' });

    s.updateTicket({ ...product, generation: 'p-1' }, {
      ticket_id: t.id, status: 'open', lane: 'harness',
      note: 'Releasing to the harness lane: branch codex/importer in ~/projects/gp-lanes/design-prep; next step is the CSV parser.',
    });
    expect(s.getTicket(t.id)).toMatchObject({ status: 'open', lane: 'harness', assignee: builder.name });
    expect(claim(s, product, 'p-2', 'design-prep')).toEqual({ admitted: false, launch_id: 'p-2' });
    expect(claim(s, harness, 'h-1', 'harness')).toMatchObject({ claimed: true, ticket_id: t.id });
  });

  it('keeps the lane through a review handback and a relabel, and lets a handoff pass a new one', () => {
    const s = new Store(':memory:');
    const t = file(s, { lane: 'design-prep', labels: ['obj:OBJ-4'] });
    const gen = { ...product, generation: 'p-1' };
    claim(s, product, 'p-1', 'design-prep');
    s.updateTicket(gen, { ticket_id: t.id, note: 'ready for review', handoff_to: 'reviewer-loop' });
    s.updateTicket(orch, { ticket_id: t.id, note: 'relabel', labels: ['obj:OBJ-4', 'acct:direction'] });
    s.updateTicket(orch, { ticket_id: t.id, note: 'FAIL, back to builder', handoff_to: builder.name });
    expect(s.getTicket(t.id)).toMatchObject({ lane: 'design-prep', labels: ['obj:OBJ-4', 'acct:direction'] });
    expect(claim(s, product, 'p-2', 'design-prep')).toMatchObject({ ticket_id: t.id });
    s.updateTicket({ ...product, generation: 'p-2' }, { ticket_id: t.id, note: 'over to the harness lane', handoff_to: builder.name, lane: 'harness' });
    expect(s.getTicket(t.id).lane).toBe('harness');
    s.updateTicket(orch, { ticket_id: t.id, note: 'back to the general pool', lane: '' });
    expect(s.getTicket(t.id).lane).toBeNull();
  });

  it('routes a lane template\'s instances to the same lane', () => {
    const s = new Store(':memory:');
    const tpl = file(s, { lane: 'harness', schedule: 'every 1m' });
    const spawned = s.materializeDue(new Date(Date.now() + 120_000));
    expect(spawned).toHaveLength(1);
    expect(s.getTicket(spawned[0]!).lane).toBe('harness');
    expect(s.getTicket(tpl.id).lane).toBe('harness');
  });
});

describe('resuming a held claim across a scope change (H-824 migration)', () => {
  it('denies a worker swapped to a lane while it holds a lane-null claim, and leaves the claim untouched', () => {
    const s = new Store(':memory:');
    const t = file(s);
    claim(s, product, 'p-1', undefined, [t.id]);
    const before = { ticket: s.getTicket(t.id), events: s.getEvents(t.id).length };
    let message = '';
    try { claim(s, product, 'p-2', 'design-prep'); } catch (e) { message = (e as Error).message; }
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
    expect(() => s.updateTicket(orch, { ticket_id: listed.id, note: 'cutover', lane: 'design-prep' })).toThrow();
    // The worker releases at a natural stop, with its continuation note.
    s.updateTicket({ ...product, generation: 'p-1' }, { ticket_id: listed.id, status: 'open', note: 'Natural stop: branch codex/importer; next step the parser.' });
    // 3.3: every listed non-terminal ticket is relaned while unclaimed.
    for (const id of [listed.id, other.id]) s.updateTicket(orch, { ticket_id: id, note: 'cutover to lanes', lane: 'design-prep' });
    // 3.4 swap: the worker now claims by lane; the general worker cannot see them.
    expect(claim(s, builder, 'g-1')).toEqual({ admitted: false, launch_id: 'g-1' });
    expect(claim(s, product, 'p-2', 'design-prep')).toMatchObject({ ticket_id: listed.id });
    const fresh = file(s, { lane: 'design-prep' });
    s.updateTicket({ ...product, generation: 'p-2' }, { ticket_id: listed.id, note: 'done', status: 'done', evidence: [{ kind: 'other', ref: 'x' }] });
    s.updateTicket(orch, { ticket_id: other.id, note: 'not needed', status: 'cancelled' });
    expect(claim(s, product, 'p-3', 'design-prep')).toMatchObject({ claimed: true, ticket_id: fresh.id });
  });
});

// The releases a migration starts from: 923cc49, the split runtime the lane
// design was drawn against, and 4cd5392, the unified v0.9.2 release serving
// when this port was built. Present on the GP runtime host; elsewhere, point
// HELMO_LEGACY_DIST at one such dist.
const RELEASES = join(process.env['HOME'] ?? '', 'projects/gp-runtime/releases');
const legacyDists = process.env['HELMO_LEGACY_DIST'] ? [['HELMO_LEGACY_DIST', process.env['HELMO_LEGACY_DIST']]] : [
  ['923cc49', join(RELEASES, 'helmo-923cc49d8cf85c78d0e50fca2d08ee50c50a8c26/dist')],
  ['4cd5392', join(RELEASES, 'helmo-4cd5392621be850df24ca9661a4460c69143bf19/packages/work/dist')],
];
describe.each(legacyDists)('a store written before lanes, by %s (H-824)', (_release, legacyDist) => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'helmo-lane-legacy-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(!existsSync(join(legacyDist!, 'store.js')))('opens a pre-lane store holding an allowlist claim, resumes it and replays its receipt', async () => {
    const dbPath = join(dir, 'helmo.db');
    const legacy = await import(pathToFileURL(join(legacyDist!, 'store.js')).href) as { Store: new (path: string) => {
      createTicket: Store['createTicket']; launchClaim: (a: Actor, w: string, as: string, id: string, p?: string, t?: string[]) => Record<string, unknown>; close(): void;
    } };
    const old = new legacy.Store(dbPath);
    const t = old.createTicket(orch, { title: 'Build the importer', body: 'Goal: import CSVs.', workstream: 'goodplumb', type: 'build', assignee: builder.name });
    const receipt = old.launchClaim(product, 'goodplumb', builder.name, 'p-1', undefined, [t.id]);
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

describe('waking by lane (H-824)', () => {
  it('narrows the wake to what that lane\'s claim could take, and keeps the whole queue without one', () => {
    const s = new Store(':memory:');
    const seq = s.maxSeq();
    const prep = file(s, { lane: 'design-prep' });
    const general = file(s);
    expect(s.wakeCheck(seq, 'goodplumb', builder.name, 'design-prep')).toMatchObject({ ready_ids: [prep.id], newly_ready_ids: [prep.id] });
    expect(s.wakeCheck(seq, 'goodplumb', builder.name, null)).toMatchObject({ ready_ids: [general.id], newly_ready_ids: [general.id] });
    expect(s.wakeCheck(seq, 'goodplumb', builder.name, 'harness')).toMatchObject({ ready_count: 0 });
    expect(s.wakeCheck(seq, 'goodplumb', builder.name).ready_ids.sort()).toEqual([prep.id, general.id].sort());
  });
});

describe('lane through the MCP surface (H-824)', () => {
  it('passes lane through create, update and list rather than stripping it', async () => {
    const store = new Store(':memory:');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildServer(store, orch);
    const client = new Client({ name: 'test-agent', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const text = (r: Awaited<ReturnType<typeof client.callTool>>) => JSON.parse((r.content as { text: string }[])[0]!.text);
    const parse = (r: Awaited<ReturnType<typeof client.callTool>>) => text(r).result;

    const created = parse(await client.callTool({ name: 'helmo_create_ticket', arguments: {
      title: 'Build the importer', body: 'Goal: import CSVs.', workstream: 'goodplumb', type: 'build', assignee: builder.name, lane: 'design-prep',
    } }));
    expect(created.ticket).toMatchObject({ lane: 'design-prep' });
    expect(store.getTicket(created.id).lane).toBe('design-prep');

    const bad = await client.callTool({ name: 'helmo_update_ticket', arguments: { ticket_id: created.id, note: 'move', lane: 'Harness' } });
    expect(bad.isError).toBe(true);
    expect(text(bad).error).toMatch(/not a lane name/);

    expect(parse(await client.callTool({ name: 'helmo_update_ticket', arguments: { ticket_id: created.id, note: 'move', lane: 'harness' } }))).toMatchObject({ lane: 'harness' });
    store.createTicket(orch, { title: 'Other', body: 'b', workstream: 'goodplumb', type: 'build' });
    const listed = parse(await client.callTool({ name: 'helmo_list_tickets', arguments: { lane: 'harness' } }));
    expect(listed.tickets.map((t: { id: string }) => t.id)).toEqual([created.id]);
    await client.close();
    store.close();
  });
});

describe('lane through the CLI (H-824)', () => {
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
    const base = ['--workstream', 'goodplumb', '--assignee', builder.name];
    const { id } = as(orch, 'create', '--title', 'Build the importer', '--body', 'Goal: import CSVs.', '--type', 'build', ...base, '--lane', 'harness').out;
    const other = as(orch, 'create', '--title', 'General work', '--body', 'Goal: tidy.', '--type', 'build', ...base).out.id;
    expect(as(orch, 'list', '--lane', 'harness').out.tickets).toMatchObject([{ id, lane: 'harness' }]);
    expect(as(orch, 'wake-check', ...base, '--since-seq', '0', '--lane', 'harness').out.ready_ids).toEqual([id]);
    expect(as(orch, 'wake-check', ...base, '--since-seq', '0', '--no-lane').out.ready_ids).toEqual([other]);
    expect(as(orch, 'wake-check', ...base, '--since-seq', '0', '--lane', 'harness', '--no-lane').status).toBe(1);

    expect(as(harness, 'launch-claim', ...base, '--launch-id', 'h-1', '--lane', 'design-prep').out).toEqual(expect.objectContaining({ admitted: false }));
    expect(as(harness, 'launch-claim', ...base, '--launch-id', 'h-2', '--lane', 'harness').out).toMatchObject({ claimed: true, ticket_id: id, scope: { lane: 'harness' } });
    expect(as(orch, 'update', '--ticket', other, '--note', 'route it', '--lane', 'design-prep').status).toBe(0);
    expect(as(orch, 'update', '--ticket', other, '--note', 'unroute it', '--lane', '').status).toBe(0);
    expect(as(builder, 'launch-claim', ...base, '--launch-id', 'g-1').out).toMatchObject({ claimed: true, ticket_id: other });
  });
});
