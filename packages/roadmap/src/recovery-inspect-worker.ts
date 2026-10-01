import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync, statSync } from 'node:fs';

const TABLES = ['events', 'projects', 'deps', 'claims', 'citations', 'objectives', 'bets', 'meta'] as const;
const { path, installation, delayMs } = workerData as { path: string; installation: string; delayMs: number };
try {
  if (delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>; if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('SQLite integrity check failed');
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('SQLite foreign-key check failed');
    const actual = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(r => r.name).sort();
    if (actual.join('\0') !== [...TABLES].sort().join('\0')) throw new Error('Roadmap application schema does not match');
    const id = db.prepare("SELECT value FROM meta WHERE key='installation_name'").get() as { value?: string } | undefined; if (id?.value !== installation) throw new Error('backup installation identity does not match');
    const tables = Object.fromEntries(TABLES.map(name => [name, (db.prepare(`SELECT count(*) AS n FROM ${name}`).get() as { n: number }).n]));
    const bytes = statSync(path).size; const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    parentPort?.postMessage({ report: { installation, file: path, sha256, bytes, tables } });
  } finally { db.close(); }
} catch (error) { parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
