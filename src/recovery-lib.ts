import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const TABLES = ['events', 'projects', 'deps', 'claims', 'citations', 'objectives', 'bets', 'meta'] as const;
const LIMIT_MS = 30_000;
export interface RecoveryReport { installation: string; file: string; sha256: string; bytes: number; tables: Record<string, number>; }
function deadline(start: number): void { if (performance.now() - start > LIMIT_MS) throw new Error('recovery operation exceeded 30 seconds'); }
function effectiveUid(): number { if (!process.geteuid) throw new Error('roadmap-recovery requires a platform with effective-user ownership checks'); return process.geteuid(); }
function ownedRegular(path: string): void { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || s.uid !== effectiveUid()) throw new Error(`${path} must be an owner-owned regular file`); }

function source(sourceHome: string, installation: string): Database.Database {
  if (!sourceHome || !isAbsolute(sourceHome)) throw new Error('--source-home must be an explicit absolute path');
  if (!installation.trim()) throw new Error('--installation must be nonempty');
  const stated = resolve(sourceHome); const parent = realpathSync(dirname(stated)); const home = join(parent, stated.slice(dirname(stated).length + 1));
  const hs = lstatSync(home); if (!hs.isDirectory() || hs.isSymbolicLink() || hs.uid !== effectiveUid()) throw new Error('source home must be an owner-owned real directory');
  const path = join(realpathSync(home), 'roadmap.db'); ownedRegular(path);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { const row = db.prepare("SELECT value FROM meta WHERE key = 'installation_name'").get() as { value?: string } | undefined; if (!row?.value || row.value !== installation) throw new Error(`stored installation identity does not match '${installation}'`); return db; }
  catch (e) { db.close(); throw e; }
}

function freshDir(outputRoot: string, outputDir: string): string {
  if (!isAbsolute(outputRoot) || !isAbsolute(outputDir)) throw new Error('output root and directory must be absolute');
  const statedRoot = lstatSync(outputRoot); if (statedRoot.isSymbolicLink()) throw new Error('output root must not be a symlink');
  const root = realpathSync(outputRoot); const rs = statSync(root);
  if (!rs.isDirectory() || rs.uid !== effectiveUid() || (rs.mode & 0o777) !== 0o700) throw new Error('output root must be an owner-owned 0700 directory');
  const stated = resolve(outputDir); const parent = realpathSync(dirname(stated));
  if (parent !== root) throw new Error('output directory must be a direct child of the canonical output root');
  const target = join(parent, basename(stated));
  mkdirSync(target, { mode: 0o700 });
  const made = realpathSync(target); const ms = lstatSync(made);
  if (dirname(made) !== root || !ms.isDirectory() || ms.isSymbolicLink() || ms.uid !== effectiveUid() || (ms.mode & 0o777) !== 0o700) throw new Error('fresh output directory changed during creation');
  return made;
}

function inspect(path: string, installation: string, start: number): RecoveryReport {
  deadline(start); ownedRegular(path); const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>; if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('SQLite integrity check failed');
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('SQLite foreign-key check failed');
    const actual = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(r => r.name).sort();
    if (actual.join('\0') !== [...TABLES].sort().join('\0')) throw new Error('Roadmap application schema does not match');
    const id = db.prepare("SELECT value FROM meta WHERE key='installation_name'").get() as { value?: string } | undefined; if (id?.value !== installation) throw new Error('backup installation identity does not match');
    const tables = Object.fromEntries(TABLES.map(name => [name, (db.prepare(`SELECT count(*) AS n FROM ${name}`).get() as { n: number }).n]));
    deadline(start); const bytes = statSync(path).size; const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex'); deadline(start);
    return { installation, file: path, sha256, bytes, tables };
  } finally { db.close(); }
}

export async function backup(sourceHome: string, installation: string, outputRoot: string, outputDir: string): Promise<RecoveryReport> {
  const start = performance.now(); const db = source(sourceHome, installation);
  try { const file = join(freshDir(outputRoot, outputDir), 'roadmap-backup.db'); process.umask(0o077); await db.backup(file, { progress: () => { deadline(start); return 100; } }); ownedRegular(file); if ((statSync(file).mode & 0o777) !== 0o600) throw new Error('backup was not created mode 0600'); return inspect(file, installation, start); }
  finally { db.close(); }
}

export function validate(backupFile: string, installation: string, outputRoot: string, outputDir: string): RecoveryReport {
  const start = performance.now(); if (!isAbsolute(backupFile) || !installation.trim()) throw new Error('backup file must be absolute and installation nonempty');
  if (lstatSync(backupFile).isSymbolicLink()) throw new Error('backup file must not be a symlink');
  const original = inspect(realpathSync(backupFile), installation, start); const copy = join(freshDir(outputRoot, outputDir), 'roadmap-restore-check.db'); process.umask(0o077);
  const fd = openSync(copy, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); closeSync(fd); copyFileSync(backupFile, copy);
  const restored = inspect(copy, installation, start);
  if (original.sha256 !== restored.sha256 || original.bytes !== restored.bytes || JSON.stringify(original.tables) !== JSON.stringify(restored.tables)) throw new Error('isolated restore copy does not match the completed backup');
  return restored;
}
