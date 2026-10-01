import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backup, backupObserved, identity, validate } from '../src/recovery-lib.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'roadmap-recovery-')); const home = join(root, 'home'); const output = join(root, 'out');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(output, { mode: 0o700 });
  const db = new Database(join(home, 'roadmap.db'));
  db.exec("CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE projects(id TEXT); CREATE TABLE deps(id TEXT); CREATE TABLE claims(id TEXT); CREATE TABLE citations(id TEXT); CREATE TABLE objectives(id TEXT); CREATE TABLE bets(id TEXT); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES ('installation_name','gp');");
  db.pragma('journal_mode = WAL'); db.prepare('INSERT INTO projects VALUES (?)').run('R-1'); db.close(); return { root, home, output };
}

function inventory(path: string) {
  return readdirSync(path).sort().map(name => ({ name, bytes: readFileSync(join(path, name)), mode: statSync(join(path, name)).mode }));
}

describe('operator recovery CLI', () => {
  it('reports only the stored identity without changing the source or creating output', () => {
    const f = fixture(); const before = inventory(f.home);
    expect(identity(f.home)).toBe('gp');
    expect(inventory(f.home)).toEqual(before); expect(readdirSync(f.output)).toEqual([]);
  });
  it('refuses a writer-active WAL database without changing its source home', () => {
    const f = fixture(); const writer = new Database(join(f.home, 'roadmap.db'));
    try {
      writer.prepare('INSERT INTO projects VALUES (?)').run('R-live'); const before = inventory(f.home);
      expect(before.map(entry => entry.name)).toEqual(expect.arrayContaining(['roadmap.db-wal', 'roadmap.db-shm']));
      expect(() => identity(f.home)).toThrow('while SQLite sidecars exist'); expect(inventory(f.home)).toEqual(before); expect(readdirSync(f.output)).toEqual([]);
    } finally { writer.close(); }
  });
  it('exposes the identity-only result through the operator CLI', () => {
    const f = fixture(); const result = execFileSync(process.execPath, ['--import', 'tsx', 'src/recovery.ts', 'identity', '--source-home', f.home], { encoding: 'utf8' });
    expect(JSON.parse(result)).toEqual({ installation: 'gp' }); expect(readdirSync(f.output)).toEqual([]);
  });
  it('reports a missing stored identity distinctly', () => {
    const f = fixture(); const db = new Database(join(f.home, 'roadmap.db')); db.prepare("DELETE FROM meta WHERE key = 'installation_name'").run(); db.close();
    expect(() => identity(f.home)).toThrow('stored installation identity is missing'); expect(readdirSync(f.output)).toEqual([]);
  });
  it('makes an owner-only backup and validates an unchanged isolated copy', async () => {
    const f = fixture(); const backed = await backup(f.home, 'gp', f.output, join(f.output, 'backup'));
    expect(backed.tables.projects).toBe(1); expect(statSync(backed.file).mode & 0o777).toBe(0o600); const before = readFileSync(backed.file);
    const restored = await validate(backed.file, 'gp', f.output, join(f.output, 'restore')); expect(restored.sha256).toBe(backed.sha256); expect(readFileSync(backed.file)).toEqual(before);
  });
  it('observes the stored identity and backs up an active WAL database through one connection', async () => {
    const f = fixture(); const writer = new Database(join(f.home, 'roadmap.db'));
    try {
      writer.prepare('INSERT INTO projects VALUES (?)').run('R-live');
      expect(readdirSync(f.home)).toEqual(expect.arrayContaining(['roadmap.db-wal', 'roadmap.db-shm']));
      const backed = await backupObserved(f.home, f.output, join(f.output, 'backup'));
      expect(backed.installation).toBe('gp'); expect(backed.tables.projects).toBe(2);
      const restored = await validate(backed.file, backed.installation, f.output, join(f.output, 'restore'));
      expect(restored.sha256).toBe(backed.sha256); expect(restored.tables.projects).toBe(2);
    } finally { writer.close(); }
  });
  it('exposes the observed online backup through the operator CLI', () => {
    const f = fixture(); const writer = new Database(join(f.home, 'roadmap.db'));
    try {
      writer.prepare('INSERT INTO projects VALUES (?)').run('R-live');
      const result = execFileSync(process.execPath, ['--import', 'tsx', 'src/recovery.ts', 'backup-observed', '--source-home', f.home, '--output-root', f.output, '--output-dir', join(f.output, 'backup')], { encoding: 'utf8' });
      const report = JSON.parse(result);
      expect(report.installation).toBe('gp'); expect(report.tables.projects).toBe(2); expect(statSync(report.file).mode & 0o777).toBe(0o600);
    } finally { writer.close(); }
  });
  it('refuses identity mismatch before creating a destination', async () => {
    const f = fixture(); const destination = join(f.output, 'never'); await expect(backup(f.home, 'wrong', f.output, destination)).rejects.toThrow('identity'); expect(() => statSync(destination)).toThrow();
  });
  it('still refuses validation identity mismatch before creating a destination', async () => {
    const f = fixture(); const backed = await backup(f.home, 'gp', f.output, join(f.output, 'backup')); const destination = join(f.output, 'never-restore');
    await expect(validate(backed.file, 'wrong', f.output, destination)).rejects.toThrow('identity'); expect(() => statSync(destination)).toThrow();
  });
  it('refuses existing destinations and corrupt backups', async () => {
    const f = fixture(); mkdirSync(join(f.output, 'existing'), { mode: 0o700 }); await expect(backup(f.home, 'gp', f.output, join(f.output, 'existing'))).rejects.toThrow();
    const corrupt = join(f.root, 'corrupt.db'); writeFileSync(corrupt, 'not sqlite', { mode: 0o600 }); await expect(validate(corrupt, 'gp', f.output, join(f.output, 'bad'))).rejects.toThrow();
  });
  it('refuses unsafe and symlinked output roots before creating a run directory', async () => {
    const f = fixture(); const unsafe = join(f.root, 'unsafe'); mkdirSync(unsafe, { mode: 0o700 }); chmodSync(unsafe, 0o777);
    await expect(backup(f.home, 'gp', unsafe, join(unsafe, 'run'))).rejects.toThrow('0700');
    const linked = join(f.root, 'linked-output'); symlinkSync(f.output, linked);
    await expect(backup(f.home, 'gp', linked, join(linked, 'run'))).rejects.toThrow('symlink');
  });
  it('does not overwrite a leaf installed before backup publication', async () => {
    const f = fixture(); const victim = join(f.root, 'victim'); writeFileSync(victim, 'keep', { mode: 0o600 });
    await expect(backup(f.home, 'gp', f.output, join(f.output, 'backup'), { beforeBackupPublish: (_run, file) => symlinkSync(victim, file) })).rejects.toThrow();
    expect(readFileSync(victim, 'utf8')).toBe('keep');
  });
  it('refuses a replaced backup run directory before publishing', async () => {
    const f = fixture(); const destination = join(f.output, 'backup'); const moved = join(f.output, 'moved');
    await expect(backup(f.home, 'gp', f.output, destination, { beforeBackupPublish: run => { renameSync(run, moved); mkdirSync(run, { mode: 0o700 }); } })).rejects.toThrow('replaced');
    expect(() => statSync(join(destination, 'roadmap-backup.db'))).toThrow();
  });
  it('copies through the exclusive descriptor and rejects a replaced validation leaf', async () => {
    const f = fixture(); const backed = await backup(f.home, 'gp', f.output, join(f.output, 'backup')); const victim = join(f.root, 'victim'); writeFileSync(victim, 'keep', { mode: 0o600 });
    await expect(validate(backed.file, 'gp', f.output, join(f.output, 'restore'), { afterValidateOpen: (_run, file) => { unlinkSync(file); symlinkSync(victim, file); } })).rejects.toThrow('replaced');
    expect(readFileSync(victim, 'utf8')).toBe('keep');
  });
  it('refuses a replaced validation run directory before copying', async () => {
    const f = fixture(); const backed = await backup(f.home, 'gp', f.output, join(f.output, 'backup')); const destination = join(f.output, 'restore'); const moved = join(f.output, 'moved');
    await expect(validate(backed.file, 'gp', f.output, destination, { afterValidateOpen: run => { renameSync(run, moved); mkdirSync(run, { mode: 0o700 }); } })).rejects.toThrow('replaced');
    expect(() => statSync(join(destination, 'roadmap-restore-check.db'))).toThrow();
  });
  it('interrupts inspection work when the operation ceiling expires', async () => {
    const f = fixture();
    await expect(backup(f.home, 'gp', f.output, join(f.output, 'timeout'), { limitMs: 25, inspectDelayMs: 250 })).rejects.toThrow('exceeded 30 seconds');
  });
});
