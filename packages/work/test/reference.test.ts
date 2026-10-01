import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installation } from '../src/install.js';
import { localRecordRef, qualifiedRecordRef } from '../src/reference.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/tools.js';
import { Actor } from '../src/types.js';

// H-2502. Two installations mint ids from their own counters, so H-1 exists in
// both and means two unrelated records. The fixture is the proof: A and B are
// seeded with the SAME ticket id and the SAME seat name, so nothing here can
// pass by the two stores happening to differ.

const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '0.1' };
const seat: Actor = { name: 'mason', kind: 'agent', model: 'claude-opus-5', version: 'claude-code-2.1.221' };

let root: string;
let a: ReturnType<typeof makeInstall>;
let b: ReturnType<typeof makeInstall>;

function makeInstall(root: string, name: string) {
  const home = join(root, name, '.helmo');
  mkdirSync(home, { recursive: true });
  const install = installation({ HELMO_HOME: home, HELMO_LABEL: `dev.helmo.${name}` });
  return { install, home, db: install.db };
}

/** Seed one installation with a ticket whose id and assignee are identical in
 *  both — the confusable pair the whole feature exists to refuse. */
function seed(db: string, title: string): string {
  const s = new Store(db);
  const id = s.createTicket(orch, { title, body: 'Body for the fixture.', workstream: 'helmo-dev', type: 'build', assignee: 'mason' }).id;
  s.close();
  return id;
}

async function connect(install: ReturnType<typeof makeInstall>['install'], db: string) {
  const store = new Store(db, install);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildServer(store, seat);
  const client = new Client({ name: 'test-agent', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, store, close: async () => { await client.close(); store.close(); } };
}

function body(res: unknown): Record<string, unknown> {
  return JSON.parse(((res as { content: { text: string }[] }).content[0] as { text: string }).text) as Record<string, unknown>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helmo-installs-'));
  a = makeInstall(root, 'a');
  b = makeInstall(root, 'b');
  expect(seed(a.db, 'A: build the importer')).toBe('H-1');
  expect(seed(b.db, 'B: draft the letter')).toBe('H-1');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the qualified spelling itself', () => {
  it('leaves a bare id alone and qualifies with the installation label', () => {
    expect(localRecordRef('H-1', a.install)).toBe('H-1');
    expect(qualifiedRecordRef('H-1', a.install)).toBe('H-1@dev.helmo.a');
  });

  it('accepts the three spellings --installation takes', () => {
    expect(localRecordRef('H-1@dev.helmo.a', a.install)).toBe('H-1');
    expect(localRecordRef(`H-1@${a.home}`, a.install)).toBe('H-1');
    expect(localRecordRef(`H-1@${a.db}`, a.install)).toBe('H-1');
  });

  it('refuses a qualifier naming another installation, saying both', () => {
    expect(() => localRecordRef('H-1@dev.helmo.a', b.install)).toThrow(/dev\.helmo\.a/);
    expect(() => localRecordRef('H-1@dev.helmo.a', b.install)).toThrow(/dev\.helmo\.b/);
  });

  it('refuses a half-written qualifier rather than reading it as bare', () => {
    expect(() => localRecordRef('H-1@', a.install)).toThrow(/no installation after it/);
    expect(() => localRecordRef('@dev.helmo.a', a.install)).toThrow(/no record/);
  });

  it('refuses a qualified reference it cannot check at all', () => {
    expect(() => localRecordRef('H-1@dev.helmo.a', undefined)).toThrow(/resolved no installation/);
  });
});

describe('the MCP surface, across two installations with the same ids', () => {
  it('says which installation answered, on results and on refusals', async () => {
    const A = await connect(a.install, a.db);
    const read = body(await A.client.callTool({ name: 'helmo_get_ticket', arguments: { ticket_id: 'H-1' } }));
    expect(read['installation']).toBe('dev.helmo.a');
    const missing = body(await A.client.callTool({ name: 'helmo_get_ticket', arguments: { ticket_id: 'H-999' } }));
    expect(missing['installation']).toBe('dev.helmo.a');
    expect(missing['error']).toMatch(/not found/);
    await A.close();
  });

  it('hands back a reference that carries the installation with the id', async () => {
    const A = await connect(a.install, a.db);
    const read = body(await A.client.callTool({ name: 'helmo_get_ticket', arguments: { ticket_id: 'H-1' } }));
    const result = read['result'] as { id: string; ref: string; assignee: string };
    expect(result.id).toBe('H-1');
    expect(result.ref).toBe('H-1@dev.helmo.a');
    expect(result.assignee).toBe('mason');
    await A.close();
  });

  it("refuses A's reference in B instead of answering with B's own H-1", async () => {
    const A = await connect(a.install, a.db);
    const carried = (body(await A.client.callTool({ name: 'helmo_get_ticket', arguments: { ticket_id: 'H-1' } }))['result'] as { ref: string }).ref;
    await A.close();

    const B = await connect(b.install, b.db);
    const refused = body(await B.client.callTool({ name: 'helmo_get_ticket', arguments: { ticket_id: carried } }));
    expect(refused['error']).toMatch(/dev\.helmo\.a/);
    expect(refused['error']).toMatch(/dev\.helmo\.b/);
    expect(JSON.stringify(refused)).not.toContain('draft the letter');

    // ...and the same reference still resolves at home, so the refusal is
    // about the target and not about the spelling.
    const B_own = body(await B.client.callTool({ name: 'helmo_get_ticket', arguments: { ticket_id: 'H-1@dev.helmo.b' } }));
    expect((B_own['result'] as { title: string }).title).toBe('B: draft the letter');
    await B.close();
  });

  it('refuses a carried reference on a WRITE without touching the record', async () => {
    const B = await connect(b.install, b.db);
    const refused = body(await B.client.callTool({
      name: 'helmo_update_ticket',
      arguments: { ticket_id: 'H-1@dev.helmo.a', note: 'Claiming this.', status: 'in_progress' },
    }));
    expect(refused['error']).toMatch(/dev\.helmo\.a/);
    const still = body(await B.client.callTool({ name: 'helmo_get_ticket', arguments: { ticket_id: 'H-1' } }));
    expect((still['result'] as { status: string }).status).toBe('open');
    await B.close();
  });

  it('refuses a carried reference on the far side of a link', async () => {
    const B = await connect(b.install, b.db);
    const refused = body(await B.client.callTool({
      name: 'helmo_link_tickets',
      arguments: { from_id: 'H-1', to_id: 'H-1@dev.helmo.a', type: 'blocks' },
    }));
    expect(refused['error']).toMatch(/dev\.helmo\.a/);
    const deps = (body(await B.client.callTool({ name: 'helmo_get_ticket', arguments: { ticket_id: 'H-1' } }))['result'] as { deps: { outgoing: unknown[] } }).deps;
    expect(deps.outgoing).toHaveLength(0);
    await B.close();
  });
});

describe('helmo-cli, across two installations with the same ids', () => {
  // A real child process, because the CLI's refusal has to reach the caller as
  // its own JSON on stderr with a non-zero exit, not as a thrown object.
  function cli(target: ReturnType<typeof makeInstall>, ...argv: string[]) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...argv], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, ROADMAP_LABEL: '', HELMO_HOME: target.home, HELMO_LABEL: target.install.label, REV_LABEL: '', HELMO_ACTOR: JSON.stringify(seat), HELMO_DB: '' },
      encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  }

  // A child that never got as far as the CLI leaves stdout empty, and parsing
  // that fails as "Unexpected end of JSON input" — which says nothing about
  // why. Name the child's own stderr instead.
  function json(r: { out: string; err: string }): Record<string, unknown> {
    try {
      return JSON.parse(r.out) as Record<string, unknown>;
    } catch {
      throw new Error(`the CLI wrote no JSON to stdout; its stderr was:\n${r.err}`);
    }
  }

  it('resolves a bare id and a matching qualifier, and refuses the other installation’s', () => {
    expect(json(cli(b, 'get', '--ticket', 'H-1'))['title']).toBe('B: draft the letter');
    expect(json(cli(b, 'get', '--ticket', 'H-1@dev.helmo.b'))['title']).toBe('B: draft the letter');

    const refused = cli(b, 'get', '--ticket', 'H-1@dev.helmo.a');
    expect(refused.status).toBe(1);
    expect(refused.out).toBe('');
    const reported = JSON.parse(refused.err) as { error: string; installation: { label: string } };
    expect(reported.error).toMatch(/dev\.helmo\.a/);
    expect(reported.installation.label).toBe('dev.helmo.b');
    expect(refused.err).not.toContain('draft the letter');
  });

  it('refuses a carried reference on a write, leaving the record alone', () => {
    const refused = cli(b, 'update', '--ticket', 'H-1@dev.helmo.a', '--note', 'Claiming this.', '--status', 'in_progress');
    expect(refused.status).toBe(1);
    expect(json(cli(b, 'get', '--ticket', 'H-1'))['status']).toBe('open');
  });
});
