import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const TABLES = ['events', 'projects', 'deps', 'claims', 'citations', 'objectives', 'bets', 'meta'] as const;
const LIMIT_MS = 30_000;
export interface RecoveryReport { installation: string; file: string; sha256: string; bytes: number; tables: Record<string, number>; }
export interface RecoveryTestHooks { beforeBackupPublish?: (runDir: string, file: string) => void; afterValidateOpen?: (runDir: string, file: string) => void; }
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

function freshDir(outputRoot: string, outputDir: string): { path: string; dev: number; ino: number } {
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
  return { path: made, dev: ms.dev, ino: ms.ino };
}

function unchangedDir(run: { path: string; dev: number; ino: number }): void {
  const current = lstatSync(run.path);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== run.dev || current.ino !== run.ino) throw new Error('fresh output directory was replaced before use');
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

export async function backup(sourceHome: string, installation: string, outputRoot: string, outputDir: string, hooks: RecoveryTestHooks = {}): Promise<RecoveryReport> {
  const start = performance.now(); const db = source(sourceHome, installation);
  try {
    const run = freshDir(outputRoot, outputDir); const file = join(run.path, 'roadmap-backup.db'); const staging = join(run.path, `.roadmap-backup-${randomUUID()}.db`);
    process.umask(0o077); await db.backup(staging, { progress: () => { deadline(start); return 100; } }); ownedRegular(staging);
    if ((statSync(staging).mode & 0o777) !== 0o600) throw new Error('backup was not created mode 0600');
    inspect(staging, installation, start); hooks.beforeBackupPublish?.(run.path, file); unchangedDir(run); linkSync(staging, file);
    const staged = lstatSync(staging); const published = lstatSync(file);
    if (staged.dev !== published.dev || staged.ino !== published.ino) throw new Error('published backup is not the completed staging database');
    return inspect(file, installation, start);
  }
  finally { db.close(); }
}

export function validate(backupFile: string, installation: string, outputRoot: string, outputDir: string, hooks: RecoveryTestHooks = {}): RecoveryReport {
  const start = performance.now(); if (!isAbsolute(backupFile) || !installation.trim()) throw new Error('backup file must be absolute and installation nonempty');
  if (lstatSync(backupFile).isSymbolicLink()) throw new Error('backup file must not be a symlink');
  const original = inspect(realpathSync(backupFile), installation, start); const run = freshDir(outputRoot, outputDir); const copy = join(run.path, 'roadmap-restore-check.db'); process.umask(0o077);
  const sourceFd = openSync(backupFile, constants.O_RDONLY | constants.O_NOFOLLOW); const fd = openSync(copy, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); const opened = fstatSync(fd);
  try {
    hooks.afterValidateOpen?.(run.path, copy); unchangedDir(run);
    const buffer = Buffer.allocUnsafe(64 * 1024); let read = 0;
    while ((read = readSync(sourceFd, buffer, 0, buffer.length, null)) > 0) { deadline(start); let offset = 0; while (offset < read) offset += writeSync(fd, buffer, offset, read - offset); }
  } finally { closeSync(fd); closeSync(sourceFd); }
  const copied = lstatSync(copy);
  if (!copied.isFile() || copied.isSymbolicLink() || copied.dev !== opened.dev || copied.ino !== opened.ino) throw new Error('isolated restore destination was replaced during copy');
  const restored = inspect(copy, installation, start);
  if (original.sha256 !== restored.sha256 || original.bytes !== restored.bytes || JSON.stringify(original.tables) !== JSON.stringify(restored.tables)) throw new Error('isolated restore copy does not match the completed backup');
  return restored;
}
