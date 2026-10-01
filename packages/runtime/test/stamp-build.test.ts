// The build stamp (R-39 Q8, H-2442). `dist` is gitignored and `rev redeploy`
// restarts without building, so until this stamp the supervisor loaded an
// artifact with no provenance at all.
//
// The shapes aimed at here are the quiet ones. A stamp that counts itself as
// evidence of its own freshness passes forever. A stamp written from a dirty
// tree names a sha that did not produce the artifact. Both look perfectly
// healthy to a check that only asks whether the file exists.

import { describe, expect, it } from 'vitest';
import { describeBuild, newestArtifact, verify, STAMP } from '../scripts/stamp-build.mjs';

const stat = (times: Record<string, number>) => (p: string) => ({ mtimeMs: times[p.split('/').pop()!] });

describe('newestArtifact', () => {
  const times = { 'cli.js': 100, 'loop.js': 300, [STAMP]: 900 };
  const list = () => Object.keys(times);

  it('finds the most recently written artifact', () => {
    expect(newestArtifact('/dist', list, stat(times))).toEqual({ at: 300, name: 'loop.js' });
  });

  it('never counts the stamp itself, which would make every stale build look current', () => {
    expect(newestArtifact('/dist', list, stat(times)).name).not.toBe(STAMP);
  });

  it('reports nothing rather than throwing when dist holds only the stamp', () => {
    expect(newestArtifact('/dist', () => [STAMP], stat(times))).toEqual({ at: 0, name: null });
  });
});

describe('verify', () => {
  const newest = { at: 500, name: 'cli.js' };

  it('passes when the stamp is at least as new as the code beside it', () => {
    expect(verify({ hasStamp: true, stampedAt: 500, newest }).ok).toBe(true);
  });

  it('fails when there is no stamp at all', () => {
    const res = verify({ hasStamp: false, stampedAt: 0, newest });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('which commit');
  });

  it('fails on a rebuild nobody stamped, and names the file that gave it away', () => {
    const res = verify({ hasStamp: true, stampedAt: 400, newest });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('cli.js');
  });
});

describe('describeBuild', () => {
  it('records the tree state, because tsc compiles the working tree and not the commit', () => {
    const rec = describeBuild({ repo: '/r', commit: 'abc123', dirty: true, builtAt: 0, node: 'v25' });
    expect(rec).toMatchObject({ repo: '/r', commit: 'abc123', dirty: true, node: 'v25' });
    expect(rec.built_at).toBe('1970-01-01T00:00:00.000Z');
  });

  it('keeps the full sha, so the record resolves in a repo with many short-sha collisions', () => {
    const commit = '61c2c040365f28b74c56765e8ab447038eb650cd';
    expect(describeBuild({ repo: '/r', commit, dirty: false, builtAt: 0 }).commit).toBe(commit);
  });
});
