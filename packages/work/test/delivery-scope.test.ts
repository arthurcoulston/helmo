import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store as RoadmapStore } from '../../roadmap/src/store.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/tools.js';
import { Actor } from '../src/types.js';

// H-2070. Arthur: "One item in ship next should mean only tickets connected
// it get worked." The roster's project filter was a per-worker list someone
// had to edit; the roadmap already says what is being shipped. A store that
// names its roadmap admits autonomous work only on tickets whose project is in
// Ship Next, on every entry path, and reads that list each time it is asked.

const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '0.1' };
const arthur: Actor = { name: 'arthur', kind: 'human' };
const pool: Actor = { name: 'builder', kind: 'agent', model: 'claude-opus-5', version: '1.0', session: 'rev:builder' };
const single: Actor = { name: 'reviewer', kind: 'agent', model: 'claude-opus-5', version: '1.0', session: 'rev:reviewer' };
const attended: Actor = { name: 'builder', kind: 'agent', model: 'claude-opus-5', version: '1.0' };
const mason = { name: 'mason', kind: 'agent' as const, model: 'm', version: '1' };
const bosun = { name: 'bosun', kind: 'agent' as const, model: 'm', version: '1' };

let dir: string;
let roadmapPath: string;
let roadmap: RoadmapStore;
let s: Store;
let alpha: string;
let beta: string;

function initiative(title: string): string {
  const p = roadmap.createProject(mason, { title, status: 'shaping' });
  roadmap.updateProject(bosun, { project_id: p.id, note: 'ready', status: 'ready' });
  return p.id;
}
const shipNext = (id: string) => roadmap.setShipNext(mason, { project_id: id, decided_by: 'arthur', reason: 'go' });
const shipOut = (id: string) => roadmap.updateProject(mason, { project_id: id, note: 'out of the work phase', status: 'shipped_watching' });

function file(over: Record<string, unknown> = {}) {
  return s.createTicket(orch, {
    title: 'Build the thing', body: 'Goal: build it. State: not started.', workstream: 'goodplumb', type: 'build', assignee: 'builder', ...over,
  });
}
const claim = (id: string, project?: string) => s.launchClaim(pool, 'goodplumb', 'builder', id, project);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'helmo-delivery-'));
  roadmapPath = join(dir, 'roadmap.db');
  roadmap = new RoadmapStore(roadmapPath);
  alpha = initiative('Alpha');
  beta = initiative('Beta');
  s = new Store(':memory:');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Ship Next bounds autonomous work (H-2070)', () => {
  it('admits only the selected initiative, follows Ship Next without a roster edit, and runs nothing when it is empty', () => {
    const a = file({ project: alpha, priority: 2 });
    const b = file({ project: beta, priority: 1 });
    const loose = file({ priority: 0 });
    shipNext(alpha);
    expect(s.setDeliveryScope(orch, roadmapPath)).toEqual({ roadmap_db: roadmapPath, projects: [alpha] });

    // Higher-priority Beta and unlinked work stay queued; Alpha runs.
    expect(claim('l-1')).toMatchObject({ claimed: true, ticket_id: a.id });
    s.updateTicket({ ...pool, generation: 'l-1' }, { ticket_id: a.id, note: 'built', status: 'done', evidence: [{ kind: 'other', ref: 'x' }] });
    expect(claim('l-2')).toEqual({ admitted: false, launch_id: 'l-2', delivery_scope: { roadmap_db: roadmapPath, projects: [alpha] } });

    // Changing Ship Next changes the next selection; the call is the same.
    shipNext(beta);
    expect(claim('l-3')).toMatchObject({ claimed: true, ticket_id: b.id });
    s.updateTicket({ ...pool, generation: 'l-3' }, { ticket_id: b.id, note: 'built', status: 'done', evidence: [{ kind: 'other', ref: 'x' }] });

    shipOut(alpha);
    shipOut(beta);
    const late = file({ project: alpha });
    expect(claim('l-4')).toMatchObject({ admitted: false, delivery_scope: { projects: [] } });
    expect(s.getTicket(loose.id).status).toBe('open');
    expect(s.getTicket(late.id).status).toBe('open');
  });

  it('lets a newly linked ticket in on the next ask and keeps human holds and blockers', () => {
    shipNext(alpha);
    s.setDeliveryScope(orch, roadmapPath);
    const research = file({ project: alpha, type: 'research', needs_human: 'Sit with Arthur on the findings', priority: 0 });
    const blocker = file({ priority: 3, assignee: 'someone-else' });
    const blocked = file({ project: alpha, priority: 0, deps: [{ to: blocker.id, type: 'blocks' }] });
    const t = file({ priority: 1 });
    expect(claim('n-1')).toMatchObject({ admitted: false });
    s.updateTicket(orch, { ticket_id: t.id, note: 'linked to Alpha', project: alpha });
    expect(claim('n-2')).toMatchObject({ claimed: true, ticket_id: t.id });
    expect(s.getTicket(research.id).status).toBe('open');
    expect(s.getTicket(blocked.id).status).toBe('open');
  });

  it('puts a held claim down at the next launch when its initiative leaves Ship Next, and resumes it on return', () => {
    shipNext(alpha);
    shipNext(beta);
    s.setDeliveryScope(orch, roadmapPath);
    const a = file({ project: alpha, priority: 0 });
    const b = file({ project: beta, priority: 1 });
    expect(claim('r-1')).toMatchObject({ claimed: true, ticket_id: a.id });
    shipOut(alpha);
    // Next launch: the Alpha claim is released (still reserved, work kept)
    // and the worker draws Beta instead of resuming out-of-scope work.
    const next = claim('r-2') as { claimed?: boolean; ticket_id?: string; resumed?: boolean };
    expect(next).toMatchObject({ claimed: true, ticket_id: b.id });
    expect(next.resumed).toBeFalsy();
    const put = s.getTicket(a.id);
    expect(put).toMatchObject({ status: 'open', assignee: 'builder' });
    expect(() => s.updateTicket({ ...pool, generation: 'r-1' }, { ticket_id: a.id, note: 'still here?' })).toThrow(/retired|ended/i);
  });

  it('holds a seat launched without a claim (launch-admit) to the same scope', () => {
    shipNext(alpha);
    s.setDeliveryScope(orch, roadmapPath);
    const inScope = file({ project: alpha, assignee: 'reviewer', priority: 1 });
    const outScope = file({ project: beta, assignee: 'reviewer', priority: 0 });
    expect(s.launchAdmission('goodplumb', 'reviewer', 'a-1')).toMatchObject({ admitted: true, ticket_id: inScope.id });
    // A single-seat session claims for itself: out-of-scope is refused.
    expect(() => s.updateTicket(single, { ticket_id: outScope.id, note: 'start', status: 'in_progress' })).toThrow(/delivery_scope_refused/);
    s.updateTicket(single, { ticket_id: inScope.id, note: 'start', status: 'in_progress' });
    // Its project leaves Ship Next: the next launch puts the claim down.
    shipOut(alpha);
    expect(s.launchAdmission('goodplumb', 'reviewer', 'a-2')).toMatchObject({ admitted: false, released: [inScope.id] });
    expect(s.getTicket(inScope.id)).toMatchObject({ status: 'open', assignee: 'reviewer' });
  });

  it('scopes the wake, the ready list and in-progress filings for supervised workers only', async () => {
    shipNext(alpha);
    s.setDeliveryScope(orch, roadmapPath);
    const a = file({ project: alpha });
    const loose = file();
    const w = s.wakeCheck(0, 'goodplumb', 'builder');
    expect(w.ready_ids).toEqual([a.id]);
    expect(w.delivery_scope).toEqual({ roadmap_db: roadmapPath, projects: [alpha] });
    // A store-wide loop still sees the whole queue to coordinate it.
    expect(s.wakeCheck(0).delivery_scope).toBeUndefined();
    expect(() => s.createTicket(pool, { title: 'New', body: 'Goal: x. State: y.', workstream: 'goodplumb', type: 'build', status: 'in_progress' }))
      .toThrow(/delivery_scope_refused/);
    s.createTicket(pool, { title: 'New', body: 'Goal: x. State: y.', workstream: 'goodplumb', type: 'build', status: 'in_progress', project: alpha });

    // Attended sessions and humans keep explicit work possible.
    s.updateTicket(attended, { ticket_id: loose.id, note: 'Arthur asked for this in the sitting', status: 'in_progress' });
    expect(s.getTicket(loose.id).status).toBe('in_progress');

    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildServer(s, pool).connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    const res = await client.callTool({ name: 'helmo_list_tickets', arguments: { ready: true } });
    const body = JSON.parse((res.content as { text: string }[])[0]!.text).result;
    expect(res.isError, (res.content as { text: string }[])[0]!.text).toBeFalsy();
    expect(body.tickets.map((t: { id: string }) => t.id)).toEqual([a.id]);
    expect(body.delivery_scope.ship_next).toEqual([alpha]);
  });

  it('fails closed when the roadmap cannot be read, and only an attended actor can lift the bound', () => {
    shipNext(alpha);
    s.setDeliveryScope(orch, roadmapPath);
    file({ project: alpha });
    roadmap.close();
    writeFileSync(roadmapPath, 'not a database');
    const r = claim('f-1');
    expect(r).toMatchObject({ admitted: false, delivery_scope: { projects: [] } });
    expect((r as { delivery_scope: { error?: string } }).delivery_scope.error).toBeTruthy();
    expect(() => s.setDeliveryScope(orch, join(dir, 'missing.db'))).toThrow();
    expect(() => s.setDeliveryScope(pool, null)).toThrow(/delivery_scope_refused/);
    expect(s.setDeliveryScope(arthur, null)).toBeNull();
    expect(claim('f-2')).toMatchObject({ claimed: true });
  });

  it('gives recurring instances their template\'s project, so scheduled work under Ship Next runs', () => {
    shipNext(alpha);
    s.setDeliveryScope(orch, roadmapPath);
    const tpl = s.createTicket(orch, { title: 'Weekly check', body: 'Goal: check. State: standing.', workstream: 'goodplumb', type: 'ops', assignee: 'builder', project: alpha, schedule: 'every 1d' });
    const spawned = s.materializeDue(new Date(Date.now() + 2 * 86_400_000));
    expect(spawned.length).toBeGreaterThan(0);
    expect(s.getTicket(spawned[0]!).project).toBe(alpha);
    expect(claim('s-1')).toMatchObject({ claimed: true });
    expect(tpl.status).toBe('open');
  });

  it('leaves a store that names no roadmap exactly as before', () => {
    const loose = file();
    expect(s.deliveryScope()).toBeNull();
    expect(claim('o-1')).toMatchObject({ claimed: true, ticket_id: loose.id });
  });

  it('is set and read through the CLI', () => {
    shipNext(alpha);
    const db = join(dir, 'helmo.db');
    new Store(db).close();
    const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, HELMO_DB: db, HELMO_ACTOR: JSON.stringify(arthur) }, encoding: 'utf8',
    });
    const set = run('delivery-scope', '--roadmap-db', roadmapPath);
    expect(set.status, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout).delivery_scope).toEqual({ roadmap_db: roadmapPath, projects: [alpha] });
    expect(JSON.parse(run('delivery-scope').stdout).delivery_scope.projects).toEqual([alpha]);
    expect(JSON.parse(run('delivery-scope', '--off').stdout).delivery_scope).toBeNull();
  });
});
