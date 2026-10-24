/* The API floor: the JSON documents the application actually reads, measured
 * against the budget on a record at capacity with an archive behind it
 * (H-3512 M1, issue #32).
 *
 * This is the runner the declared budget did not have. `floor.ts` named
 * DOCUMENT_BYTES 4,200,000 while the service served 15,210,873 on the default
 * Work poll — 3.62× it, four times a minute — because the capacity seed lost
 * its runner in H-2939 and `live-floor.mjs` throws in `renderMs` before it
 * measures anything. A budget nothing can fail is a comment.
 *
 * The defect that got through was a whole TICKET STORE on two polled routes,
 * and the case that catches it coming back is not an absolute ceiling: it is
 * GROWTH. A document that costs more on a bigger store is carrying the store.
 * So the fixture is built twice, at 1,000 and 10,000 closed tickets with the
 * same live rows, and the two readings have to agree within ARCHIVE_GROWTH.
 *
 * It is slow by construction — two stores, tens of megabytes of real-sized
 * bodies and evidence each — and that is the price of a budget measured on a
 * record bigger than the one it protects.
 */

import { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_FLOOR, overApiBudget } from '../src/floor.js';
import { ARCHIVE_PAGE } from '../src/presentation.js';
import { seedBuriedWeight, seedCapacityRecord, seedClosedHistory, serveRecord } from './support/served-record.js';

const DEPTHS = [1_000, 10_000] as const;

interface Reading {
  bytes: number;
  rows: number;
  data: {
    records?: unknown;
    record: {
      total: number;
      rows: { id: string }[];
      archive: { cursor: number; limit: number; returned: number; closed_total: number; next_cursor: number | null } | null;
    };
  };
}

interface Fixture {
  depth: number;
  dir: string;
  view: ChildProcess;
  origin: string;
  buried: string;
  closed: number;
  read(path: string, warm?: boolean): Promise<Reading>;
}

const fixtures: Fixture[] = [];

/** Warmed once, then measured: the first read of a document pays for opening
 *  the store and warming the module, which is a real cost once per process and
 *  pure noise in a byte budget. Bytes are what this floor measures — the view
 *  emits no render timing on an API route, so there is nothing honest to time
 *  here (see `live-floor.mjs` and R-32's pause). */
async function reader(origin: string) {
  return async function read(path: string, warm = true): Promise<Reading> {
    if (warm) await (await fetch(`${origin}${path}`)).text();
    const response = await fetch(`${origin}${path}`);
    const text = await response.text();
    if (response.status !== 200) throw new Error(`${path} answered ${response.status}`);
    const data = JSON.parse(text).data;
    return { bytes: Buffer.byteLength(text), rows: data.record.rows.length, data };
  };
}

beforeAll(async () => {
  for (const depth of DEPTHS) {
    const dir = mkdtempSync(join(tmpdir(), `helmo-api-floor-${depth}-`));
    const db = join(dir, 'work.db');
    const capacity = seedCapacityRecord(db);
    // Written before the filler so the filler closes after it: the heaviest
    // closed ticket in the store sits behind the page a reader is served.
    const buried = seedBuriedWeight(db);
    const archive = seedClosedHistory(db, depth, { heavyNewest: ARCHIVE_PAGE });
    expect(capacity.storedTextBytes).toBeGreaterThan(0);
    const { view, origin } = await serveRecord(db);
    fixtures.push({ depth, dir, view, origin, buried: buried.id, closed: archive.closed, read: await reader(origin) });
  }
}, 600_000);

afterAll(() => {
  for (const fixture of fixtures) {
    fixture.view.kill('SIGKILL');
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

describe.each(DEPTHS)('the served Work document on a store of %i closed tickets', (depth) => {
  const fixture = () => fixtures.find((f) => f.depth === depth)!;

  it('carries the rows it draws and not the store behind them', async () => {
    const { data, bytes, rows } = await fixture().read('/api/v1/work');
    // The array that was 98.4% of this document. Its absence is the fix, and
    // `record.total` is how a reader still learns how big the store is.
    expect(data.records).toBeUndefined();
    expect(data.record.total).toBeGreaterThan(depth);
    expect(data.record.archive).toBeNull();
    console.log(`default ${depth}`, JSON.stringify({ bytes, rows, perRow: Math.round(bytes / rows) }));
    expect(overApiBudget({ route: '/api/v1/work', bytes, rows })).toEqual([]);
  });

  it('serves the archive one page at a time, and says where the page sits', async () => {
    const { data, bytes, rows } = await fixture().read('/api/v1/work?whole=1');
    const archive = data.record.archive!;
    expect(archive).not.toBeNull();
    expect(archive.limit).toBe(ARCHIVE_PAGE);
    expect(archive.cursor).toBe(0);
    expect(archive.returned).toBe(ARCHIVE_PAGE);
    expect(archive.closed_total).toBeGreaterThan(depth);
    expect(archive.next_cursor).toBe(ARCHIVE_PAGE);
    console.log(`archive ${depth}`, JSON.stringify({ bytes, rows, perRow: Math.round(bytes / rows), archive }));
    expect(overApiBudget({ route: '/api/v1/work?whole=1', bytes, rows })).toEqual([]);
  });

  /* Walked in full on the smaller store only. Every read of this route costs
     a whole-store query — which is the cost the next improvement is about —
     so walking ten thousand closed tickets in pages of two hundred is fifty
     reads of a sixty-megabyte record for a property that does not depend on
     depth. The deep store gets the two readings that DO: that the last page
     terminates where the arithmetic says it should, and that nothing in the
     walk's shape changed at scale. */
  it(depth === DEPTHS[0] ? 'reaches every closed ticket by walking the cursor to the end' : 'ends the walk where the count says it ends', async () => {
    if (depth !== DEPTHS[0]) {
      const last = Math.floor((await fixture().read('/api/v1/work?whole=1')).data.record.archive!.closed_total / ARCHIVE_PAGE) * ARCHIVE_PAGE;
      const { data } = await fixture().read(`/api/v1/work?whole=1&cursor=${last}`, false);
      const archive = data.record.archive!;
      expect(archive.cursor).toBe(last);
      expect(archive.next_cursor).toBeNull();
      expect(archive.returned).toBe(archive.closed_total - last);
      return;
    }
    const seen = new Set<string>();
    let cursor: number | null = 0;
    let pages = 0;
    while (cursor !== null) {
      const { data } = await fixture().read(`/api/v1/work?whole=1&cursor=${cursor}`, false);
      for (const row of data.record.rows) seen.add(row.id);
      const archive = data.record.archive!;
      expect(archive.cursor).toBe(cursor);
      cursor = archive.next_cursor;
      pages++;
      // A walk that never ends is the failure this guards against: offset
      // paging that does not advance looks identical to a short store.
      expect(pages).toBeLessThanOrEqual(Math.ceil(data.record.total / ARCHIVE_PAGE) + 2);
    }
    const { data: whole } = await fixture().read('/api/v1/work?whole=1', false);
    expect(seen.size).toBe(whole.record.total);
    expect(seen.has(fixture().buried)).toBe(true);
  }, 600_000);

  it('does not inflate the list with text on a row nobody draws', async () => {
    const buried = fixture().buried;
    const { data: byDefault } = await fixture().read('/api/v1/work');
    // The heaviest closed ticket in the store: four times the longest body the
    // deployed record holds, and its longest evidence list.
    expect(byDefault.record.rows.some((row) => row.id === buried)).toBe(false);
    // Still reachable the supported way, which is what makes bounding the
    // list honest rather than lossy.
    const { data: pinned } = await fixture().read(`/api/v1/work?ticket=${buried}`);
    expect(pinned.record.rows.some((row) => row.id === buried)).toBe(true);
  });
});

it('costs the same on a store ten times the size', async () => {
  const [small, large] = fixtures;
  const readings = await Promise.all([small!.read('/api/v1/work'), large!.read('/api/v1/work')]);
  const [lean, heavy] = readings.map((r) => r.bytes) as [number, number];
  // The same live rows and the same archive page on both stores, so anything
  // left here that scales with `record.total` is a store on the wire again.
  expect(readings[0]!.rows).toBe(readings[1]!.rows);
  const growth = (heavy - lean) / lean;
  console.log('store growth', JSON.stringify({ lean, heavy, growth: Number(growth.toFixed(4)), budget: API_FLOOR.STORE_GROWTH }));
  expect(growth).toBeLessThan(API_FLOOR.STORE_GROWTH);
}, 600_000);
