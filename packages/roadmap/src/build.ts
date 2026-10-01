import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Snapshot { dir: string; digest: string | null; stamp: { commit: string; dirty: boolean } | null }
export type RunningState = 'verified' | 'stale' | 'unstamped' | 'unverifiable';

export function codeDir(): string { return dirname(fileURLToPath(import.meta.url)); }
export function digestOf(dir: string): string | null {
  const hash = createHash('sha256'); let count = 0;
  const walk = (path: string, prefix = ''): void => {
    for (const name of readdirSync(path).sort()) {
      if (!prefix && name === 'BUILD.json') continue;
      const file = join(path, name); const stat = statSync(file);
      if (stat.isDirectory()) walk(file, `${prefix}${name}/`);
      else if (/\.[cm]?js$/.test(name)) { hash.update(`${prefix}${name}\0${stat.size}\0`); hash.update(readFileSync(file)); count++; }
    }
  };
  try { walk(dir); } catch { return null; }
  return count ? hash.digest('hex').slice(0, 12) : null;
}
export function snapshot(dir = codeDir()): Snapshot {
  let stamp: Snapshot['stamp'] = null;
  try { const value = JSON.parse(readFileSync(join(dir, 'BUILD.json'), 'utf8')); if (value.commit) stamp = { commit: value.commit, dirty: value.dirty === true }; } catch { /* unstamped */ }
  return { dir, digest: digestOf(dir), stamp };
}
let held: Snapshot | null = null;
export function loaded(): Snapshot { return (held ??= snapshot()); }
export function forgetLoaded(): void { held = null; }
export function running() {
  const was = loaded(); const now = snapshot(was.dir); const commit = was.stamp?.commit;
  if (!was.digest) return { state: 'unverifiable' as RunningState, dir: was.dir, digest: null, detail: 'no compiled JavaScript was available to identify this process' };
  if (was.digest !== now.digest) return { state: 'stale' as RunningState, dir: was.dir, digest: was.digest, ...(commit ? { commit, dirty: was.stamp?.dirty === true } : {}), detail: `code on disk changed after this process loaded (${now.digest ?? 'unreadable'} now)` };
  if (!commit) return { state: 'unstamped' as RunningState, dir: was.dir, digest: was.digest, detail: 'the loaded code has no build stamp' };
  return { state: 'verified' as RunningState, dir: was.dir, digest: was.digest, commit, dirty: was.stamp?.dirty === true, detail: was.stamp?.dirty ? 'loaded from a dirty-tree build' : 'running the build on disk' };
}
export function runningLine(): string {
  const r = running();
  const commit = 'commit' in r && r.commit ? `${r.commit.slice(0, 7)}${r.dirty ? ' (dirty)' : ''} ` : '';
  return `running: ${commit}${r.state === 'verified' ? '' : r.state.toUpperCase()}`.trim();
}
