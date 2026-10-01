import Database from 'better-sqlite3';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backup, validate } from '../src/recovery-lib.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'roadmap-recovery-')); const home = join(root, 'home'); const output = join(root, 'out');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(output, { mode: 0o700 });
  const db = new Database(join(home, 'roadmap.db'));
  db.exec("CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE projects(id TEXT); CREATE TABLE deps(id TEXT); CREATE TABLE claims(id TEXT); CREATE TABLE citations(id TEXT); CREATE TABLE objectives(id TEXT); CREATE TABLE bets(id TEXT); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES ('installation_name','gp');");
  db.pragma('journal_mode = WAL'); db.prepare('INSERT INTO projects VALUES (?)').run('R-1'); db.close(); return { root, home, output };
}

describe('operator recovery CLI', () => {
  it('makes an owner-only backup and validates an unchanged isolated copy', async () => {
    const f = fixture(); const backed = await backup(f.home, 'gp', f.output, join(f.output, 'backup'));
    expect(backed.tables.projects).toBe(1); expect(statSync(backed.file).mode & 0o777).toBe(0o600); const before = readFileSync(backed.file);
    const restored = await validate(backed.file, 'gp', f.output, join(f.output, 'restore')); expect(restored.sha256).toBe(backed.sha256); expect(readFileSync(backed.file)).toEqual(before);
  });
  it('refuses identity mismatch before creating a destination', async () => {
    const f = fixture(); const destination = join(f.output, 'never'); await expect(backup(f.home, 'wrong', f.output, destination)).rejects.toThrow('identity'); expect(() => statSync(destination)).toThrow();
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
