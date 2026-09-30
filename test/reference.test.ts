import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installation } from '../src/install.js';
import { localRecordRef, qualifiedRecordRef } from '../src/reference.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/tools.js';
import { Actor } from '../src/types.js';

// H-2506, the sibling of Helmo's H-2502. Two installations mint ids from their
// own counters, so R-1 exists in both and means two unrelated projects. The
// fixture is the proof: A and B are seeded so that BOTH hold an R-1, so nothing
// here can pass by the two stores happening to differ.

const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '0.1' };
const seat: Actor = { name: 'mason', kind: 'agent', model: 'claude-opus-5', version: 'claude-code-2.1.221' };

let root: string;
let a: ReturnType<typeof makeInstall>;
let b: ReturnType<typeof makeInstall>;

function makeInstall(root: string, name: string) {
  const home = join(root, name, '.helmo-roadmap');
  mkdirSync(home, { recursive: true });
  const install = installation({ ROADMAP_HOME: home, ROADMAP_LABEL: `dev.roadmap.${name}` });
  return { install, home, db: install.db };
}

/** Seed one installation with the project id the other one also holds — the
 *  confusable pair the whole feature exists to refuse. */
function seed(db: string, title: string): string {
  const s = new Store(db);
  const id = s.createProject(orch, { title, body: 'Body for the fixture.' }).id;
  s.close();
  return id;
}

async function connect(target: ReturnType<typeof makeInstall>) {
  const store = new Store(target.db, target.install);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildServer(store, seat, target.install);
  const client = new Client({ name: 'test-agent', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, store, close: async () => { await client.close(); store.close(); } };
}

function body(res: unknown): Record<string, unknown> {
  return JSON.parse(((res as { content: { text: string }[] }).content[0] as { text: string }).text) as Record<string, unknown>;
}

/** What `ok()` advertises for one id in a result. */
function offeredRef(payload: Record<string, unknown>, id: string): string | undefined {
  const result = payload['result'] as { references?: { id: string; qualified: string }[] };
  return result.references?.find((r) => r.id === id)?.qualified;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roadmap-installs-'));
  a = makeInstall(root, 'a');
  b = makeInstall(root, 'b');
  expect(seed(a.db, 'A: build the importer')).toBe('R-1');
  expect(seed(b.db, 'B: draft the letter')).toBe('R-1');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the qualified spelling itself', () => {
  it('leaves a bare id alone and qualifies with the installation label', () => {
    expect(localRecordRef('R-1', a.install)).toBe('R-1');
    expect(qualifiedRecordRef('R-1', a.install)).toBe('R-1@dev.roadmap.a');
  });

  it('accepts the three spellings --installation takes', () => {
    expect(localRecordRef('R-1@dev.roadmap.a', a.install)).toBe('R-1');
    expect(localRecordRef(`R-1@${a.home}`, a.install)).toBe('R-1');
    expect(localRecordRef(`R-1@${a.db}`, a.install)).toBe('R-1');
  });

  it('refuses a qualifier naming another installation, saying both', () => {
    expect(() => localRecordRef('R-1@dev.roadmap.a', b.install)).toThrow(/dev\.roadmap\.a/);
    expect(() => localRecordRef('R-1@dev.roadmap.a', b.install)).toThrow(/dev\.roadmap\.b/);
  });

  it('refuses a half-written qualifier rather than reading it as bare', () => {
    expect(() => localRecordRef('R-1@', a.install)).toThrow(/no installation after it/);
    expect(() => localRecordRef('@dev.roadmap.a', a.install)).toThrow(/no record/);
  });

  it('refuses a qualified reference it cannot check at all', () => {
    expect(() => localRecordRef('R-1@dev.roadmap.a', undefined)).toThrow(/resolved no installation/);
  });
});

describe('the MCP surface, across two installations with the same ids', () => {
  it('advertises a reference the installation that minted it accepts back', async () => {
    const A = await connect(a);
    const read = body(await A.client.callTool({ name: 'roadmap_get_project', arguments: { project_id: 'R-1' } }));
    const carried = offeredRef(read, 'R-1');
    expect(carried).toBe('R-1@dev.roadmap.a');

    // The whole defect in one line: what the product hands you, handed back.
    const home = body(await A.client.callTool({ name: 'roadmap_get_project', arguments: { project_id: carried as string } }));
    expect((home['result'] as { title: string }).title).toBe('A: build the importer');
    await A.close();
  });

  it("refuses A's reference in B instead of answering with B's own R-1", async () => {
    const B = await connect(b);
    const refused = body(await B.client.callTool({ name: 'roadmap_get_project', arguments: { project_id: 'R-1@dev.roadmap.a' } }));
    expect(refused['error']).toMatch(/dev\.roadmap\.a/);
    expect(refused['error']).toMatch(/dev\.roadmap\.b/);
    expect(JSON.stringify(refused)).not.toContain('draft the letter');

    // ...and a bare id still resolves, so the refusal is about the target and
    // not about having started to check at all.
    const own = body(await B.client.callTool({ name: 'roadmap_get_project', arguments: { project_id: 'R-1' } }));
    expect((own['result'] as { title: string }).title).toBe('B: draft the letter');
    await B.close();
  });

  it('refuses a carried reference on a WRITE without touching the record', async () => {
    const B = await connect(b);
    const refused = body(await B.client.callTool({
      name: 'roadmap_update_project',
      arguments: { project_id: 'R-1@dev.roadmap.a', note: 'Reshaping this.', title: 'Wrong target' },
    }));
    expect(refused['error']).toMatch(/dev\.roadmap\.a/);
    const still = body(await B.client.callTool({ name: 'roadmap_get_project', arguments: { project_id: 'R-1' } }));
    expect((still['result'] as { title: string }).title).toBe('B: draft the letter');
    await B.close();
  });

  it('refuses a carried reference on the far side of a link', async () => {
    const B = await connect(b);
    const refused = body(await B.client.callTool({
      name: 'roadmap_link_projects',
      arguments: { from_id: 'R-1', to_id: 'R-1@dev.roadmap.a', type: 'blocks' },
    }));
    expect(refused['error']).toMatch(/dev\.roadmap\.a/);
    const deps = (body(await B.client.callTool({ name: 'roadmap_get_project', arguments: { project_id: 'R-1' } }))['result'] as { deps: { outgoing: unknown[] } }).deps;
    expect(deps.outgoing).toHaveLength(0);
    await B.close();
  });

  it('refuses a carried objective reference on a citation', async () => {
    const B = await connect(b);
    const made = body(await B.client.callTool({
      name: 'roadmap_set_charter_item',
      arguments: { shape: 'objective', statement: 'Ship the thing', source: 'the charter', horizon: 'near', rank: 1 },
    }));
    expect((made['result'] as { id: string }).id).toBe('OBJ-1');
    const refused = body(await B.client.callTool({
      name: 'roadmap_cite',
      arguments: { project_id: 'R-1', objective_id: 'OBJ-1@dev.roadmap.a', claim: 'advances it, because' },
    }));
    expect(refused['error']).toMatch(/dev\.roadmap\.a/);
    const cites = (body(await B.client.callTool({ name: 'roadmap_get_project', arguments: { project_id: 'R-1' } }))['result'] as { citations: unknown[] }).citations;
    expect(cites).toHaveLength(0);
    await B.close();
  });
});
