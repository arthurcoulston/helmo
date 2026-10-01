import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, readdirSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

const LIMIT_MS = 30_000;
export interface RecoveryReport { installation: string; file: string; sha256: string; bytes: number; tables: Record<string, number>; }
export interface RecoveryTestHooks { beforeBackupPublish?: (runDir: string, file: string) => void; afterValidateOpen?: (runDir: string, file: string) => void; limitMs?: number; inspectDelayMs?: number; }
function deadline(start: number, limit = LIMIT_MS): void { if (performance.now() - start > limit) throw new Error('recovery operation exceeded 30 seconds'); }
function effectiveUid(): number { if (!process.geteuid) throw new Error('roadmap-recovery requires a platform with effective-user ownership checks'); return process.geteuid(); }
function ownedRegular(path: string): void { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || s.uid !== effectiveUid()) throw new Error(`${path} must be an owner-owned regular file`); }

function sourcePath(sourceHome: string): string {
  if (!sourceHome || !isAbsolute(sourceHome)) throw new Error('--source-home must be an explicit absolute path');
  const stated = resolve(sourceHome); const parent = realpathSync(dirname(stated)); const home = join(parent, stated.slice(dirname(stated).length + 1));
  const hs = lstatSync(home); if (!hs.isDirectory() || hs.isSymbolicLink() || hs.uid !== effectiveUid()) throw new Error('source home must be an owner-owned real directory');
  const path = join(realpathSync(home), 'roadmap.db'); ownedRegular(path);
  return path;
}

function source(sourceHome: string): Database.Database {
  return new Database(sourcePath(sourceHome), { readonly: true, fileMustExist: true });
}

function identitySource(sourceHome: string): Database.Database {
  const path = sourcePath(sourceHome); const home = dirname(path); const database = basename(path);
  const assertStandalone = () => {
    const sidecars = new Set([`${database}-wal`, `${database}-shm`, `${database}-journal`]);
    if (readdirSync(home).some(entry => sidecars.has(entry))) throw new Error('stored installation identity cannot be read safely while SQLite sidecars exist');
  };
  assertStandalone();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); let bytes: Buffer;
  try {
    const before = fstatSync(fd); if (!before.isFile() || before.uid !== effectiveUid()) throw new Error(`${path} must be an owner-owned regular file`);
    bytes = readFileSync(fd); const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('source database changed during identity inspection');
  } finally { closeSync(fd); }
  assertStandalone();
  // A closed WAL database keeps WAL mode in bytes 18-19 even after its sidecars
  // disappear. Normalize only the detached image so SQLite never seeks sidecars.
  if (bytes[18] === 2 && bytes[19] === 2) { bytes[18] = 1; bytes[19] = 1; }
  return new Database(bytes);
}

function storedIdentity(db: Database.Database): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'installation_name'").get() as { value?: string } | undefined;
  if (!row?.value) throw new Error('stored installation identity is missing');
  return row.value;
}

export function identity(sourceHome: string): string {
  const db = identitySource(sourceHome);
  try { return storedIdentity(db); }
  finally { db.close(); }
}

function matchingSource(sourceHome: string, installation: string): Database.Database {
  if (!installation.trim()) throw new Error('--installation must be nonempty');
  const db = source(sourceHome);
  try { if (storedIdentity(db) !== installation) throw new Error(`stored installation identity does not match '${installation}'`); return db; }
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

async function inspect(path: string, installation: string, start: number, hooks: RecoveryTestHooks): Promise<RecoveryReport> {
  const limit = hooks.limitMs ?? LIMIT_MS; deadline(start, limit); ownedRegular(path);
  const remaining = Math.max(1, limit - (performance.now() - start));
  return await new Promise((resolve, reject) => {
    const workerModule = import.meta.url.endsWith('.ts') ? './recovery-inspect-worker.ts' : './recovery-inspect-worker.js';
    const worker = new Worker(new URL(workerModule, import.meta.url), { workerData: { path, installation, delayMs: hooks.inspectDelayMs ?? 0 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('recovery operation exceeded 30 seconds')); }, remaining);
    worker.once('message', (message: { report?: RecoveryReport; error?: string }) => { clearTimeout(timer); void worker.terminate(); message.report ? resolve(message.report) : reject(new Error(message.error ?? 'recovery inspection failed')); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

export async function backup(sourceHome: string, installation: string, outputRoot: string, outputDir: string, hooks: RecoveryTestHooks = {}): Promise<RecoveryReport> {
  const start = performance.now(); const db = matchingSource(sourceHome, installation);
  try {
    const run = freshDir(outputRoot, outputDir); const file = join(run.path, 'roadmap-backup.db'); const staging = join(run.path, `.roadmap-backup-${randomUUID()}.db`);
    process.umask(0o077); await db.backup(staging, { progress: () => { deadline(start, hooks.limitMs); return 100; } }); ownedRegular(staging);
    if ((statSync(staging).mode & 0o777) !== 0o600) throw new Error('backup was not created mode 0600');
    await inspect(staging, installation, start, hooks); hooks.beforeBackupPublish?.(run.path, file); unchangedDir(run); linkSync(staging, file);
    const staged = lstatSync(staging); const published = lstatSync(file);
    if (staged.dev !== published.dev || staged.ino !== published.ino) throw new Error('published backup is not the completed staging database');
    return await inspect(file, installation, start, hooks);
  }
  finally { db.close(); }
}

export async function validate(backupFile: string, installation: string, outputRoot: string, outputDir: string, hooks: RecoveryTestHooks = {}): Promise<RecoveryReport> {
  const start = performance.now(); if (!isAbsolute(backupFile) || !installation.trim()) throw new Error('backup file must be absolute and installation nonempty');
  if (lstatSync(backupFile).isSymbolicLink()) throw new Error('backup file must not be a symlink');
  const original = await inspect(realpathSync(backupFile), installation, start, hooks); const run = freshDir(outputRoot, outputDir); const copy = join(run.path, 'roadmap-restore-check.db'); process.umask(0o077);
  const sourceFd = openSync(backupFile, constants.O_RDONLY | constants.O_NOFOLLOW); const fd = openSync(copy, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); const opened = fstatSync(fd);
  try {
    hooks.afterValidateOpen?.(run.path, copy); unchangedDir(run);
    const buffer = Buffer.allocUnsafe(64 * 1024); let read = 0;
    while ((read = readSync(sourceFd, buffer, 0, buffer.length, null)) > 0) { deadline(start, hooks.limitMs); let offset = 0; while (offset < read) offset += writeSync(fd, buffer, offset, read - offset); }
  } finally { closeSync(fd); closeSync(sourceFd); }
  const copied = lstatSync(copy);
  if (!copied.isFile() || copied.isSymbolicLink() || copied.dev !== opened.dev || copied.ino !== opened.ino) throw new Error('isolated restore destination was replaced during copy');
  const restored = await inspect(copy, installation, start, hooks);
  if (original.sha256 !== restored.sha256 || original.bytes !== restored.bytes || JSON.stringify(original.tables) !== JSON.stringify(restored.tables)) throw new Error('isolated restore copy does not match the completed backup');
  return restored;
}
