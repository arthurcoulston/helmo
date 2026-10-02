import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installation } from '../src/install.js';
import { localRecordRef, qualifiedRecordRef } from '../src/reference.js';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

// T1.b, the legacy installation-name alias set. One installation answers to two
// names: the path-derived `dev.helmo…` it would have called itself standing
// alone, and the `dev.rev…` the supervisor writes into every environment it
// spawns. 45 references recorded in this estate's own stores are in the first
// spelling, and the alias is the only reason they still reach their records.
//
// What makes this the test and not a restatement: the window is declared in
// VERSIONING.md, and a qualifier OUTSIDE the alias set must still refuse. A
// rename that resolved every spelling to whatever store happened to be open is
// the H-2431 failure the refusal exists to prevent, so a resolve in the last
// case below would be a worse failure than a refusal in the first.

const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '0.1' };
const seat: Actor = { name: 'mason', kind: 'agent', model: 'claude-opus-5', version: 'claude-code-2.1.221' };

let root: string;
let home: string;
let standalone: string;
let shared: string;
let install: ReturnType<typeof installation>;

/** The name this home derives when nothing names it, and the supervised name
 *  for the same installation — read from the resolver rather than spelled, so
 *  the fixture holds for any temporary path. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helmo-alias-'));
  home = join(root, '.helmo-gp');
  mkdirSync(home, { recursive: true });
  standalone = installation({ HELMO_HOME: home }).label;
  expect(standalone).toMatch(/^dev\.helmo\./);
  shared = standalone.replace(/^dev\.helmo/, 'dev.rev');
  install = installation({ HELMO_HOME: home, REV_LABEL: shared });
  expect(install.label).toBe(shared);
  const store = new Store(install.db, install);
  expect(store.createTicket(orch, { title: 'The record the old refs cite', body: 'Body.', workstream: 'helmo-dev', type: 'build' }).id).toBe('H-1');
  store.close();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('the legacy installation-name alias set (T1.b)', () => {
  it('resolves the path-derived legacy spelling and the supervised one to the same record', () => {
    expect(localRecordRef(`H-1@${shared}`, install)).toBe('H-1');
    expect(localRecordRef(`H-1@${standalone}`, install)).toBe('H-1');
  });

  it('mints only the canonical spelling, so the alias set never grows', () => {
    expect(qualifiedRecordRef('H-1', install)).toBe(`H-1@${shared}`);
    expect(qualifiedRecordRef('H-1', install)).not.toContain('dev.helmo');
  });

  it('still refuses a qualifier naming a different installation, saying both names', () => {
    const other = `${standalone}.elsewhere`;
    expect(() => localRecordRef(`H-1@${other}`, install)).toThrow(other);
    expect(() => localRecordRef(`H-1@${other}`, install)).toThrow(shared);
  });

  it('does not stretch to the sibling product’s derived name', () => {
    expect(() => localRecordRef(`H-1@${standalone.replace('dev.helmo', 'dev.roadmap')}`, install)).toThrow(/dev\.roadmap/);
  });
});

describe('the alias set through a real CLI process', () => {
  // A child process is the only way to claim nothing opened the store: an
  // in-process call shares this suite's handles, so a byte digest across it
  // would prove nothing.
  function cli(label: string, ...argv: string[]) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...argv], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, ROADMAP_LABEL: '', HELMO_HOME: home, HELMO_LABEL: '', REV_LABEL: label, HELMO_DB: '', HELMO_ACTOR: JSON.stringify(seat) },
      encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  }

  it('reads the record through the legacy spelling, supervised under the canonical name', () => {
    const read = cli(shared, 'get', '--ticket', `H-1@${standalone}`);
    expect(read.status).toBe(0);
    expect((JSON.parse(read.out) as { title: string }).title).toBe('The record the old refs cite');
  });

  it('writes through the legacy spelling, and stamps the store with the canonical name', () => {
    const wrote = cli(shared, 'update', '--ticket', `H-1@${standalone}`, '--note', 'The old spelling still reaches it.', '--confidence', 'spot_check');
    expect(wrote.err).toBe('');
    expect(wrote.status).toBe(0);
    expect((JSON.parse(cli(shared, 'get', '--ticket', 'H-1').out) as { confidence: string }).confidence).toBe('spot_check');
    const store = new Store(install.db, install);
    expect(store.installationIdentity()).toEqual({ process: shared, stored: shared, clear: true });
    store.close();
  });

  it('refuses a foreign qualifier without opening the store at all', () => {
    const before = digest(install.db);
    const refused = cli(shared, 'get', '--ticket', `H-1@${standalone}.elsewhere`);
    expect(refused.status).toBe(1);
    expect(refused.out).toBe('');
    expect(refused.err).not.toContain('The record the old refs cite');
    expect(digest(install.db)).toBe(before);
  });
});
