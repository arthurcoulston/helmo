// What the fleet is TOLD when the release set moves out from under it (H-3530).
// Helmo's coherence check is correct and keeps refusing; the defect was that
// Rev reported that refusal as a generic failure — an uncaught stack trace at
// the head of a loop's log, and a per-feature `*-check-failed` line in the
// supervisor's — which reads exactly like a fleet running stale code. These
// cases drive the real work CLI, so the predicate cannot keep passing against a
// message the CLI no longer emits.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseSetMoved } from '../src/helm.js';
import { HELMO_CLI, HELMO_ROOT } from './helmo.js';

/**
 * A selection naming a release directory this checkout does not live in, which
 * is what an activation leaves behind for every process that read its paths
 * before it. The expected tree has to exist: the check compares real paths, so
 * a missing directory would refuse for an unrelated reason.
 */
function selectionElsewhere(commit = 'c'.repeat(40)): { file: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), 'rev-moved-'));
  const release = join(root, '2026.10-99');
  const work = join(release, 'helmo', 'packages', 'work');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(release, 'RELEASE.json'), JSON.stringify({ commits: { helmo: 'c'.repeat(40) } }));
  const file = join(root, 'selected.json');
  writeFileSync(file, JSON.stringify({
    release: '2026.10-99',
    directory: release,
    components: { helmo: { release: '2026.10-99', commit } },
  }));
  return { file, work: realpathSync(work) };
}

/** The error a Helmo read throws, in the shape helm.ts's `run` hands callers. */
function refusal(selection: string): unknown {
  try {
    execFileSync('node', [HELMO_CLI, 'actor-activity', '--name', 'mason', '--session', 'rev:mason', '--since-seq', '0'], {
      env: { ...process.env, INSTALLATION_RELEASE: selection },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return null;
  } catch (e) {
    return e;
  }
}

describe('a release set that moved under a running process', () => {
  it('is read out of the work CLI\'s own refusal, naming the tree it ran from and the one now selected', () => {
    const { file, work } = selectionElsewhere();
    const moved = releaseSetMoved(refusal(file));
    expect(moved).not.toBeNull();
    expect(moved!.product).toBe('helmo');
    expect(realpathSync(moved!.running)).toBe(realpathSync(HELMO_ROOT));
    expect(realpathSync(moved!.selected)).toBe(work);
  });

  // The two failures arrive under the same `incoherent release set:` prefix and
  // mean opposite things: a tree that moved is expected during an activation,
  // and a selection that disagrees with its own manifest is a broken
  // installation nobody should be quiet about.
  it('is not confused with a selection that disagrees with its manifest', () => {
    const { file } = selectionElsewhere('d'.repeat(40));
    const e = refusal(file);
    expect(e).not.toBeNull();
    expect(String((e as { stderr?: string }).stderr)).toContain('does not match selected release');
    expect(releaseSetMoved(e)).toBeNull();
  });

  it('is not read into an ordinary failure', () => {
    expect(releaseSetMoved(new Error('store is locked'))).toBeNull();
    expect(releaseSetMoved(undefined)).toBeNull();
  });
});
