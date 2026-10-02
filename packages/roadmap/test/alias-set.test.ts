import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installation } from '../src/install.js';
import { localRecordRef, qualifiedRecordRef } from '../src/reference.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/tools.js';
import { Actor } from '../src/types.js';

// T1.b's Roadmap half, the sibling of Work's `alias-set.test.ts`. The same
// installation answers to the path-derived `dev.roadmap…` and the supervised
// `dev.rev…`, which is why `R-32@dev.roadmap` and `R-41@dev.roadmap` — recorded
// in the Work store, resolved by this product — still reach their projects.
//
// Roadmap ships no CLI, so the end-to-end leg here is the MCP surface. That
// means the digest below says nothing was WRITTEN; only Work's child-process
// case can say no store was opened at all.

const mason: Actor = { name: 'mason', kind: 'agent', model: 'claude-opus-5', version: 'claude-code-2.1.221' };

let root: string;
let home: string;
let standalone: string;
let shared: string;
let install: ReturnType<typeof installation>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roadmap-alias-'));
  home = join(root, '.helmo-roadmap-gp');
  mkdirSync(home, { recursive: true });
  standalone = installation({ ROADMAP_HOME: home }).label;
  expect(standalone).toMatch(/^dev\.roadmap\./);
  shared = standalone.replace(/^dev\.roadmap/, 'dev.rev');
  install = installation({ ROADMAP_HOME: home, REV_LABEL: shared });
  expect(install.label).toBe(shared);
  const store = new Store(install.db, install);
  expect(store.createProject(mason, { title: 'The project the old refs cite' }).id).toBe('R-1');
  store.close();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function connect() {
  const store = new Store(install.db, install);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildServer(store, mason, install);
  const client = new Client({ name: 'test-agent', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, close: async () => { await client.close(); store.close(); } };
}

const body = (res: unknown) =>
  JSON.parse(((res as { content: { text: string }[] }).content[0] as { text: string }).text) as Record<string, unknown>;

describe('the legacy installation-name alias set (T1.b)', () => {
  it('resolves the path-derived legacy spelling and the supervised one to the same project', () => {
    expect(localRecordRef(`R-1@${shared}`, install)).toBe('R-1');
    expect(localRecordRef(`R-1@${standalone}`, install)).toBe('R-1');
  });

  it('mints only the canonical spelling, so the alias set never grows', () => {
    expect(qualifiedRecordRef('R-1', install)).toBe(`R-1@${shared}`);
    expect(qualifiedRecordRef('R-1', install)).not.toContain('dev.roadmap');
  });

  it('still refuses a qualifier naming a different installation, saying both names', () => {
    const other = `${standalone}.elsewhere`;
    expect(() => localRecordRef(`R-1@${other}`, install)).toThrow(other);
    expect(() => localRecordRef(`R-1@${other}`, install)).toThrow(shared);
  });

  it('does not stretch to the sibling product’s derived name', () => {
    expect(() => localRecordRef(`R-1@${standalone.replace('dev.roadmap', 'dev.helmo')}`, install)).toThrow(/dev\.helmo/);
  });
});

describe('the alias set across the MCP surface', () => {
  it('reads and writes through the legacy spelling, and stamps the store canonically', async () => {
    const A = await connect();
    const read = body(await A.client.callTool({ name: 'roadmap_get_project', arguments: { project_id: `R-1@${standalone}` } }));
    expect((read['result'] as { title: string }).title).toBe('The project the old refs cite');

    const wrote = body(await A.client.callTool({
      name: 'roadmap_update_project',
      arguments: { project_id: `R-1@${standalone}`, note: 'The old spelling still reaches it.', title: 'Renamed through the alias' },
    }));
    expect(wrote['error']).toBeUndefined();
    await A.close();

    const store = new Store(install.db, install);
    expect(store.getProject('R-1').title).toBe('Renamed through the alias');
    expect(store.installationIdentity()).toEqual({ process: shared, stored: shared, clear: true });
    store.close();
  });

  it('refuses a foreign qualifier on a write without changing the records', async () => {
    const A = await connect();
    const before = digest(install.db);
    const refused = body(await A.client.callTool({
      name: 'roadmap_update_project',
      arguments: { project_id: `R-1@${standalone}.elsewhere`, note: 'must not land', title: 'Wrong target' },
    }));
    expect(refused['error']).toMatch(/elsewhere/);
    expect(refused['error']).toContain(shared);
    expect(digest(install.db)).toBe(before);
    await A.close();
  });
});
