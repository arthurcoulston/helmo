// What the running process actually loaded (H-2489).
//
// The failure being guarded is H-2432's, and it is quiet by construction: at
// 06:40 a rebuild replaced dist under a process that had started at 18:01 the
// evening before, and every surface that could have named a running version
// would have read the stamp beside the NEW code. It would have looked healthy,
// been precise, and been wrong. So the assertions that matter are the negative
// ones — on divergence the current artifact's sha must not appear as what is
// running, and an absent record must read as unverifiable rather than as the
// artifact's sha.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLine, compare, digestOf, forgetLoaded, loaded, markerLines, parseMarker, readStamp, runningLine, snapshot,
} from '../src/build.js';

/** A code directory as a build would leave it. */
function dist(files: Record<string, string>, stamp?: { commit: string; dirty?: boolean; built_at?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'rev-build-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  if (stamp) {
    writeFileSync(join(dir, 'BUILD.json'), JSON.stringify({
      repo: '/repo', commit: stamp.commit, dirty: stamp.dirty === true,
      built_at: stamp.built_at ?? '2026-09-29T19:46:00.000Z', node: 'v25.4.0',
    }));
  }
  return dir;
}

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('digestOf', () => {
  it('identifies the code, so the same bytes in two checkouts agree', () => {
    const a = dist({ 'cli.js': 'one();' }, { commit: OLD });
    const b = dist({ 'cli.js': 'one();' }, { commit: NEW });
    expect(digestOf(a)).toBe(digestOf(b));
  });

  it('moves when a loaded file changes — a dirty rebuild of one commit is not the same bytes', () => {
    const before = digestOf(dist({ 'cli.js': 'one();' }, { commit: OLD }));
    const after = digestOf(dist({ 'cli.js': 'two();' }, { commit: OLD }));
    expect(after).not.toBe(before);
  });

  it('ignores the stamp and the type declarations, which no process executes', () => {
    const plain = digestOf(dist({ 'cli.js': 'one();' }));
    const dressed = digestOf(dist({ 'cli.js': 'one();', 'cli.d.ts': 'export {};' }, { commit: NEW }));
    expect(dressed).toBe(plain);
  });

  it('reports nothing rather than throwing when the directory is gone', () => {
    const dir = dist({ 'cli.js': 'one();' });
    rmSync(dir, { recursive: true });
    expect(digestOf(dir)).toBe(null);
    expect(snapshot(dir)).toEqual({ dir, digest: null, stamp: null });
  });

  it('reports nothing for a directory holding no JavaScript at all', () => {
    expect(digestOf(dist({ 'cli.d.ts': 'export {};' }))).toBe(null);
  });
});

describe('readStamp', () => {
  it('reads what the build wrote, dirty flag included', () => {
    expect(readStamp(dist({ 'cli.js': 'x' }, { commit: OLD, dirty: true }))?.dirty).toBe(true);
  });

  it('treats an unstamped or unparseable build as no stamp, not an error', () => {
    expect(readStamp(dist({ 'cli.js': 'x' }))).toBe(null);
    const broken = dist({ 'cli.js': 'x' });
    writeFileSync(join(broken, 'BUILD.json'), '{ not json');
    expect(readStamp(broken)).toBe(null);
  });
});

describe('the marker a process writes about what it loaded', () => {
  it('round-trips through the RUNNING marker', () => {
    const s = snapshot(dist({ 'cli.js': 'one();' }, { commit: OLD, dirty: true }));
    const recovered = parseMarker(`${process.pid}\nstarted 2026-09-30T00:00:00.000Z\ncmd dist/cli.js run\n${markerLines(s)}`);
    expect(recovered).toEqual(s);
  });

  it('survives a path with spaces in it, because a home may have one', () => {
    const s: Parameters<typeof markerLines>[0] = { dir: '/Users/a b/rev/dist', digest: 'abc123abc123', stamp: null };
    expect(parseMarker(markerLines(s))?.dir).toBe('/Users/a b/rev/dist');
  });

  it('carries no build line when the build left no stamp', () => {
    const s = snapshot(dist({ 'cli.js': 'one();' }));
    expect(markerLines(s)).not.toContain('build ');
    expect(parseMarker(markerLines(s))?.stamp).toBe(null);
  });

  it('recovers nothing from a marker written before this was recorded', () => {
    expect(parseMarker(`4242\nstarted 2026-09-27T18:01:00.000Z\ncmd dist/cli.js run\n`)).toBe(null);
  });
});

describe('compare — the artifact question against the process question', () => {
  it('confirms a process still running the code beside it', () => {
    const dir = dist({ 'cli.js': 'one();' }, { commit: OLD });
    const r = compare(snapshot(dir), snapshot(dir));
    expect(r.state).toBe('verified');
    expect(r.commit).toBe(OLD);
  });

  it('says a dirty build does not certify its own sha', () => {
    const dir = dist({ 'cli.js': 'one();' }, { commit: OLD, dirty: true });
    const r = compare(snapshot(dir), snapshot(dir));
    expect(r.state).toBe('verified');
    expect(r.dirty).toBe(true);
    expect(r.detail).toContain('does not certify');
  });

  // H-2432 itself: rebuild at 06:40 under a process started at 18:01.
  it('calls a rebuild under a live process STALE and reports the commit it LOADED', () => {
    const dir = dist({ 'cli.js': 'one();' }, { commit: OLD });
    const atLoad = snapshot(dir);
    writeFileSync(join(dir, 'cli.js'), 'two();');
    writeFileSync(join(dir, 'BUILD.json'), JSON.stringify({ repo: '/repo', commit: NEW, dirty: false, built_at: '2026-09-30T06:40:49.000Z' }));

    const r = compare(atLoad, snapshot(dir));
    expect(r.state).toBe('stale');
    expect(r.commit).toBe(OLD);
    // The new sha may appear — naming what is on disk is half of what makes the
    // divergence actionable — but only ever as the thing NOT being run. The
    // running position belongs to the loaded commit.
    const line = runningLine('the supervisor', r);
    expect(line).toContain('STALE');
    expect(line).toMatch(new RegExp(`^running:\\s+${OLD.slice(0, 7)} STALE`));
    expect(line).toContain('is not running what is there');
  });

  it('catches a rebuild of the same commit, where only the bytes moved', () => {
    const dir = dist({ 'cli.js': 'one();' }, { commit: OLD, dirty: true });
    const atLoad = snapshot(dir);
    writeFileSync(join(dir, 'cli.js'), 'one(); // a fix that was never committed');
    expect(compare(atLoad, snapshot(dir)).state).toBe('stale');
  });

  it('names no commit when the loaded code carried no stamp', () => {
    const dir = dist({ 'cli.js': 'one();' });
    const r = compare(snapshot(dir), snapshot(dir));
    expect(r.state).toBe('unstamped');
    expect(r.commit).toBe(null);
    expect(runningLine('the supervisor', r)).toContain('UNVERIFIABLE');
  });

  it('is unverifiable, never the artifact sha, when the process recorded nothing', () => {
    const dir = dist({ 'cli.js': 'one();' }, { commit: NEW });
    const r = compare(parseMarker('4242\nstarted x\ncmd y\n'), snapshot(dir));
    expect(r.state).toBe('unverifiable');
    expect(r.commit).toBe(null);
    expect(runningLine('the supervisor', r)).not.toContain(NEW.slice(0, 7));
  });

  it('is stale rather than verified when the code directory has vanished under it', () => {
    const dir = dist({ 'cli.js': 'one();' }, { commit: OLD });
    const atLoad = snapshot(dir);
    rmSync(dir, { recursive: true });
    expect(compare(atLoad, snapshot(dir)).state).toBe('stale');
  });

  it('reports a supervisor that is not running as running nothing', () => {
    expect(runningLine('the supervisor', null)).toContain('not running');
  });
});

describe('loaded()', () => {
  it('holds one reading, so a process outliving a rebuild answers with its own bytes', () => {
    forgetLoaded();
    const first = loaded();
    // Identity, not equality: the held object is never re-read, which is the
    // whole mechanism — a rebuild cannot reach a value nobody looks up again.
    expect(loaded()).toBe(first);
    forgetLoaded();
    expect(loaded()).not.toBe(first);
  });

  it('reads the directory the running code came from', () => {
    forgetLoaded();
    expect(loaded().dir).toBe(snapshot().dir);
  });
});

describe('buildLine', () => {
  it('names the commit, the build time and the bytes', () => {
    const line = buildLine(snapshot(dist({ 'cli.js': 'one();' }, { commit: OLD })));
    expect(line).toContain(OLD.slice(0, 7));
    expect(line).toContain('2026-09-29T19:46:00.000Z');
  });

  it('says so plainly when there is nothing to name', () => {
    expect(buildLine(snapshot(dist({ 'cli.js': 'one();' })))).toContain('unstamped');
  });
});
