import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Migration, ReleaseError, describe as describeRelease, readSelection, releaseProblems, rollback, upgrade, writeSelection } from '../src/release.js';
import { beginActivation, completeActivation, deploymentFile, failActivation, loadedFromRelease, readDeployment, recordRestart, writeDeployment } from '../src/deployment.js';
import { markerLines, snapshot } from '../src/build.js';
import { runCommand } from '../src/command-name.js';

const REV_CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const ROOT = join(import.meta.dirname, '..');
const REPOS = ['rev', 'helmo', 'helmo-roadmap'] as const;

const COMPATIBLE: Migration = { data_compatibility: 'compatible', rollback: { supported: true } };
const ONE_WAY: Migration = {
  data_compatibility: 'one_way',
  rollback: { supported: false, limit: 'Helmo store schema 12 rewrites ticket refs in place; code before it reads them as null. Restore a pre-upgrade copy of helmo.db.' },
};

function root(): string {
  return mkdtempSync(join(tmpdir(), 'rev-release-'));
}

const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');

/**
 * A release set on disk, as a build would leave it: a manifest, a declaration,
 * and each product's `dist` with JavaScript and the stamp its build wrote.
 * Every way it can be wrong is a parameter, because the refusals are the
 * point — a helper that could only build a good one would test nothing.
 */
function makeRelease(dir: string, id: string, opts: {
  commits?: Record<string, string>;
  stamped?: Record<string, string>;
  dirty?: boolean;
  migration?: unknown;
  stamp?: boolean;
} = {}): string {
  const commits = opts.commits ?? Object.fromEntries(REPOS.map((r) => [r, sha(`${id}:${r}`)]));
  const stamped = opts.stamped ?? commits;
  const release = join(dir, 'release', id);
  for (const repo of REPOS) {
    const dist = join(release, repo, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), `export const release = ${JSON.stringify(id)};\n`);
    if (opts.stamp !== false) {
      writeFileSync(join(dist, 'BUILD.json'), JSON.stringify({ commit: stamped[repo], dirty: opts.dirty === true, built_at: '2026-09-30T00:00:00.000Z' }));
    }
  }
  writeFileSync(join(release, 'RELEASE.json'), JSON.stringify({ ref: id, commits, built_at: '2026-09-30T00:00:00.000Z' }));
  const migration = 'migration' in opts ? opts.migration : COMPATIBLE;
  if (migration !== null) writeFileSync(join(release, 'MIGRATION.json'), JSON.stringify(migration));
  return release;
}

function makeUnifiedRelease(dir: string, id: string, opts: {
  commit?: string;
  stamped?: string;
  dirty?: boolean;
  migration?: unknown;
  stamp?: boolean;
} = {}): string {
  const commit = opts.commit ?? sha(`${id}:helmo`);
  const stamped = opts.stamped ?? commit;
  const release = join(dir, 'release', id);
  for (const path of ['packages/work', 'packages/roadmap', 'packages/runtime']) {
    const dist = join(release, 'helmo', path, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), `export const release = ${JSON.stringify(id)};\n`);
    if (opts.stamp !== false) {
      writeFileSync(join(dist, 'BUILD.json'), JSON.stringify({ commit: stamped, dirty: opts.dirty === true, built_at: '2026-10-01T00:00:00.000Z' }));
    }
  }
  writeFileSync(join(release, 'RELEASE.json'), JSON.stringify({ ref: id, commits: { helmo: commit }, built_at: '2026-10-01T00:00:00.000Z' }));
  const migration = 'migration' in opts ? opts.migration : COMPATIBLE;
  if (migration !== null) writeFileSync(join(release, 'MIGRATION.json'), JSON.stringify(migration));
  return release;
}

const selectionAt = (dir: string) => join(dir, 'ADOPTED.json');

describe('reading a release set (H-2493)', () => {
  it('accepts one Helmo component only when all three shipped packages carry its exact clean stamp', () => {
    const dir = root();
    const release = makeUnifiedRelease(dir, 'next');
    expect(releaseProblems(release)).toEqual([]);

    writeFileSync(join(release, 'helmo', 'packages/roadmap', 'dist', 'BUILD.json'), JSON.stringify({ commit: sha('other'), dirty: false, built_at: '2026-10-01T00:00:00.000Z' }));
    expect(releaseProblems(release).join('\n')).toContain('Roadmap is built from');
  });

  it('refuses a partial or mixed component manifest instead of interpreting it as a legacy set', () => {
    const dir = root();
    const release = makeRelease(dir, 'mixed');
    const manifest = JSON.parse(readFileSync(join(release, 'RELEASE.json'), 'utf8')) as { commits: Record<string, string> };
    writeFileSync(join(release, 'RELEASE.json'), JSON.stringify({ commits: { helmo: manifest.commits.helmo, rev: manifest.commits.rev } }));
    expect(releaseProblems(release).join('\n')).toContain('must name either the one helmo component or exactly the legacy');
  });

  it('accepts a set whose manifest, stamps and artifacts agree', () => {
    const dir = root();
    expect(releaseProblems(makeRelease(dir, 'next'))).toEqual([]);
  });

  it('names every problem at once, so a set is fixed in one pass rather than three', () => {
    const dir = root();
    const commits = Object.fromEntries(REPOS.map((r) => [r, sha(`next:${r}`)]));
    const release = makeRelease(dir, 'next', {
      commits,
      stamped: { ...commits, helmo: sha('somebody elses build') },
      migration: null,
    });
    writeFileSync(join(release, 'helmo-roadmap', 'dist', 'BUILD.json'), 'not json');

    const problems = releaseProblems(release);
    expect(problems.join('\n')).toContain('MIGRATION.json is missing');
    expect(problems.join('\n')).toContain('helmo is built from');
    expect(problems.join('\n')).toContain('this set is mixed');
    expect(problems.join('\n')).toContain("helmo-roadmap's build cannot be identified");
  });

  it('refuses a component built from a dirty tree, whose commit does not identify its bytes', () => {
    const dir = root();
    const problems = releaseProblems(makeRelease(dir, 'next', { dirty: true }));
    expect(problems).toHaveLength(REPOS.length);
    expect(problems[0]).toContain('dirty tree');
  });

  it('refuses a component whose dist holds no JavaScript to load', () => {
    const dir = root();
    const release = makeRelease(dir, 'next');
    unlinkSync(join(release, 'helmo', 'dist', 'index.js'));
    expect(releaseProblems(release).join('\n')).toContain('holds no JavaScript');
  });

  it('refuses a declaration that contradicts itself, or that belongs to another release', () => {
    const dir = root();
    const both = makeRelease(dir, 'both', { migration: { data_compatibility: 'one_way', rollback: { supported: true } } });
    expect(releaseProblems(both).join('\n')).toContain('one of those is wrong');

    const silent = makeRelease(dir, 'silent', { migration: { data_compatibility: 'one_way', rollback: { supported: false } } });
    expect(releaseProblems(silent).join('\n')).toContain('states no limit');

    const borrowed = makeRelease(dir, 'borrowed', { migration: { ...COMPATIBLE, release: 'somewhere-else' } });
    expect(releaseProblems(borrowed).join('\n')).toContain("describes some other release's migration");
  });
});

describe('upgrading (H-2493)', () => {
  it('maintains a bound installation deed through upgrade, repeat repair, and rollback', () => {
    const dir = root();
    const file = selectionAt(dir);
    const binding = join(dir, 'installation.json');
    writeFileSync(binding, JSON.stringify({ version: 1, id: 'fixture', installation: 'fixture', release: 'current', control: { home: dir, service: 'fixture' } }));
    upgrade(file, makeRelease(dir, 'current'), { HELMO_BINDING: binding });
    upgrade(file, makeRelease(dir, 'next'), { HELMO_BINDING: binding });
    expect(JSON.parse(readFileSync(binding, 'utf8')).release).toBe('next');

    writeFileSync(binding, JSON.stringify({ ...JSON.parse(readFileSync(binding, 'utf8')), release: 'interrupted-old' }));
    expect(upgrade(file, join(dir, 'release', 'next'), { HELMO_BINDING: binding }).unchanged).toBe(true);
    expect(JSON.parse(readFileSync(binding, 'utf8')).release).toBe('next');

    rollback(file, { HELMO_BINDING: binding });
    expect(JSON.parse(readFileSync(binding, 'utf8')).release).toBe('current');
  });

  it('writes one component for a unified release, which all three products consume', () => {
    const dir = root();
    const release = makeUnifiedRelease(dir, 'next');
    const file = selectionAt(dir);

    upgrade(file, release);
    const manifest = JSON.parse(readFileSync(join(release, 'RELEASE.json'), 'utf8')) as { commits: { helmo: string } };
    expect(readSelection(file)!.components).toEqual({ helmo: { release: 'next', commit: manifest.commits.helmo } });
  });

  it('writes a coherent selection that install.ts can verify, and leaves no temp file behind', () => {
    const dir = root();
    const release = makeRelease(dir, 'next');
    const file = selectionAt(dir);

    const change = upgrade(file, release);
    expect(change).toMatchObject({ from: null, to: 'next', unchanged: false });

    const selection = readSelection(file)!;
    expect(selection.directory).toBe(release);
    const manifest = JSON.parse(readFileSync(join(release, 'RELEASE.json'), 'utf8')) as { commits: Record<string, string> };
    for (const repo of REPOS) {
      expect(selection.components[repo]).toEqual({ release: 'next', commit: manifest.commits[repo] });
    }
    expect(selection.migration).toEqual(COMPATIBLE);
    expect(selection.previous).toBeNull();
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    const activation = JSON.parse(readFileSync(deploymentFile(file), 'utf8')) as { phase: string; release: string; recovery: string };
    expect(activation).toMatchObject({ phase: 'selected', release: 'next' });
    expect(activation.recovery).toContain('not completed');
  });

  it('refuses an unverifiable set without touching the selection', () => {
    const dir = root();
    const file = selectionAt(dir);
    upgrade(file, makeRelease(dir, 'current'));
    const before = readFileSync(file, 'utf8');

    expect(() => upgrade(file, makeRelease(dir, 'broken', { migration: null }))).toThrow(ReleaseError);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('retains the whole selection it replaces, inside the file it replaces it in', () => {
    const dir = root();
    const file = selectionAt(dir);
    const current = makeRelease(dir, 'current');
    upgrade(file, current);
    const change = upgrade(file, makeRelease(dir, 'next'));

    expect(change).toMatchObject({ from: 'current', to: 'next' });
    const selection = readSelection(file)!;
    expect(selection.previous?.release).toBe('current');
    expect(selection.previous?.directory).toBe(current);
    expect(selection.previous?.migration).toEqual(COMPATIBLE);
  });

  it('run twice, writes nothing the second time', () => {
    const dir = root();
    const file = selectionAt(dir);
    const release = makeRelease(dir, 'next');
    upgrade(file, release);
    const written = readFileSync(file, 'utf8');

    const again = upgrade(file, release);
    expect(again.unchanged).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(written);
  });
});

describe('activating a selected release (H-2571)', () => {
  it('moves through activating to running only on replacement-supervisor evidence', () => {
    const dir = root();
    const file = selectionAt(dir);
    upgrade(file, makeRelease(dir, 'next'));
    const selection = readSelection(file)!;
    const activation = deploymentFile(file);

    const started = beginActivation(activation, selection, 'fixture-a', 'attempt-1');
    expect(started).toMatchObject({ phase: 'activating', attempt: 'attempt-1', installation: 'fixture-a' });
    const running = completeActivation(activation, selection, 'fixture-a', '/release/rev/dist/cli.js run', 4242);
    expect(running).toMatchObject({ phase: 'running', required_processes: ['supervisor'] });
    expect(running?.processes?.[0]).toMatchObject({ pid: 4242, installation: 'fixture-a', release: 'next' });
    expect(readDeployment(activation)?.phase).toBe('running');
  });

  it('records a bounded restart failure with an exact recovery path', () => {
    const dir = root();
    const file = selectionAt(dir);
    upgrade(file, makeRelease(dir, 'next'));
    beginActivation(deploymentFile(file), readSelection(file)!, 'fixture-a', 'attempt-2');
    const failed = failActivation(deploymentFile(file), 'no supervisor returned within 3s');
    expect(failed).toMatchObject({ phase: 'failed', detail: 'no supervisor returned within 3s' });
    expect(failed?.recovery).toContain('rev service start');
  });

  it('does not let a stale replacement complete another selection\'s attempt', () => {
    const dir = root();
    const file = selectionAt(dir);
    upgrade(file, makeRelease(dir, 'first'));
    beginActivation(deploymentFile(file), readSelection(file)!, 'fixture-a', 'attempt-3');
    upgrade(file, makeRelease(dir, 'second'));
    expect(completeActivation(deploymentFile(file), readSelection(file)!, 'fixture-a', 'cmd', 1)).toBeNull();
    expect(readDeployment(deploymentFile(file))?.phase).toBe('selected');
  });
});

describe('rolling back (H-2493)', () => {
  const twoReleases = (migration?: unknown) => {
    const dir = root();
    const file = selectionAt(dir);
    const current = makeRelease(dir, 'current');
    const next = makeRelease(dir, 'next', migration === undefined ? {} : { migration });
    upgrade(file, current);
    upgrade(file, next);
    return { dir, file, current, next };
  };

  it('restores the retained selection and retains the one it left, so it can be rolled forward again', () => {
    const { file, current, next } = twoReleases();
    const back = rollback(file);
    expect(back).toMatchObject({ from: 'next', to: 'current', directory: current });

    const selection = readSelection(file)!;
    expect(selection.release).toBe('current');
    expect(selection.previous?.release).toBe('next');
    expect(selection.previous?.directory).toBe(next);
    expect(rollback(file).to).toBe('next');
  });

  it('refuses to roll back out of a one-way migration, in the limit\'s own words', () => {
    const { file } = twoReleases(ONE_WAY);
    expect(() => rollback(file)).toThrow(/one-way data migration/);
    expect(() => rollback(file)).toThrow(/Helmo store schema 12/);
    expect(readSelection(file)!.release).toBe('next');
  });

  it('refuses when nothing was retained, rather than guessing a release to go to', () => {
    const dir = root();
    const file = selectionAt(dir);
    upgrade(file, makeRelease(dir, 'only'));
    expect(() => rollback(file)).toThrow(/retains no previous release/);
  });

  it('refuses when the retained directory has been rebuilt into something else', () => {
    const { file, current } = twoReleases();
    makeRelease(join(current, '..', '..'), 'current', { commits: Object.fromEntries(REPOS.map((r) => [r, sha(`rebuilt:${r}`)])) });
    expect(() => rollback(file)).toThrow(/has been rebuilt/);
    expect(readSelection(file)!.release).toBe('next');
  });

  it('refuses when the retained directory is gone', () => {
    const { file, next } = twoReleases();
    writeSelection(file, { ...readSelection(file)!, previous: { release: 'ghost', directory: join(next, '..', 'ghost'), components: {}, migration: COMPATIBLE, selected_at: 'then' } });
    expect(() => rollback(file)).toThrow(/does not exist/);
  });

  it('refuses out of a selection made before a declaration was recorded, rather than assuming it was safe', () => {
    const dir = root();
    const file = selectionAt(dir);
    const current = makeRelease(dir, 'current');
    const next = makeRelease(dir, 'next');
    // The shape a selection written by hand or by an older tool has: a
    // pointer and a retained pointer, and nothing saying what it migrated.
    writeFileSync(file, JSON.stringify({
      release: 'next',
      directory: next,
      components: Object.fromEntries(REPOS.map((r) => [r, { release: 'next', commit: sha(`next:${r}`) }])),
      selected_at: '2026-09-30T00:00:00.000Z',
      previous: { release: 'current', directory: current, components: {}, migration: null, selected_at: 'then' },
    }));
    expect(() => rollback(file)).toThrow(/before its migration declaration was recorded/);
    expect(rollback.bind(null, file)).toThrow(/rev release upgrade/);
  });
});

describe('describing a selection (H-2493)', () => {
  it('reports an incoherent selection as lines rather than throwing, because it is what an operator runs to find out', () => {
    const dir = root();
    const file = selectionAt(dir);
    const release = makeRelease(dir, 'next');
    upgrade(file, release);
    writeFileSync(join(release, 'helmo', 'dist', 'BUILD.json'), JSON.stringify({ commit: sha('rebuilt by someone else'), dirty: false, built_at: 'x' }));

    const lines = describeRelease(file).join('\n');
    expect(lines).toContain('INCOHERENT');
    expect(lines).toContain('this set is mixed');
  });

  it('says an unpinned installation is unpinned, and how to pin it', () => {
    expect(describeRelease(null).join('\n')).toMatch(/not pinned[\s\S]*INSTALLATION_RELEASE/);
  });

  it('keeps selected and running distinct and exposes stale live evidence with its recovery', () => {
    const dir = root();
    const file = selectionAt(dir);
    const current = makeRelease(dir, 'current');
    upgrade(file, current);
    writeDeployment(deploymentFile(file), {
      format: 1, installation: 'dev.rev', phase: 'running', release: 'current', directory: current,
      components: Object.fromEntries(REPOS.map((repo) => [repo, sha(`current:${repo}`)])),
      updated_at: '2026-10-01T00:00:00.000Z', recovery: 'Restart the down service, then repeat its live probe.',
      required_processes: ['supervisor'],
      processes: [{ process: 'supervisor', pid: 42, command: 'rev service', installation: 'dev.rev', release: 'current',
        components: Object.fromEntries(REPOS.map((repo) => [repo, sha(`current:${repo}`)])),
        observed_at: '2026-10-01T00:00:00.000Z', identity_verified_at: '2026-10-01T00:00:00.000Z' }],
    });
    upgrade(file, makeRelease(dir, 'next'));
    // Simulate interruption after selection but before activation: the durable
    // old live observation must be called stale, never silently upgraded.
    writeDeployment(deploymentFile(file), {
      format: 1, installation: 'dev.rev', phase: 'running', release: 'current', directory: current,
      components: Object.fromEntries(REPOS.map((repo) => [repo, sha(`current:${repo}`)])),
      updated_at: '2026-10-01T00:00:00.000Z', recovery: 'Restart the down service, then repeat its live probe.',
    });
    const shown = describeRelease(file).join('\n');
    expect(shown).toContain('deployment: UNVERIFIED — record says running');
    expect(shown).toContain('the record describes another selection');
    expect(shown).toContain('selected now: next');
    expect(shown).toContain('Restart the down service');
  });

  it('reports a partial deployment record without losing release status', () => {
    const dir = root();
    const file = selectionAt(dir);
    upgrade(file, makeRelease(dir, 'next'));
    writeFileSync(deploymentFile(file), '{"format":1,"phase":"activating"}');
    const shown = describeRelease(file).join('\n');
    expect(shown).toContain('release: next');
    expect(shown).toContain('deployment: UNREADABLE');
    expect(shown).toContain('do not infer running state');
  });

  it('does not call a saved running phase live when coverage, identity, refs, or the process disagree', () => {
    const dir = root();
    const file = selectionAt(dir);
    const release = makeRelease(dir, 'next');
    upgrade(file, release);
    const selected = readSelection(file)!;
    selected.install = 'dev.rev';
    writeSelection(file, selected);
    writeDeployment(deploymentFile(file), {
      format: 1, installation: 'dev.rev', phase: 'running', release: 'next', directory: release,
      components: Object.fromEntries(REPOS.map((repo) => [repo, sha(`next:${repo}`)])),
      updated_at: new Date().toISOString(), recovery: 'Restart and repeat every probe.',
      required_processes: ['supervisor', 'health'],
      processes: [{ process: 'supervisor', pid: 2147483647, command: 'rev service', installation: 'dev.helmo', release: 'old',
        components: { rev: sha('wrong') }, observed_at: '2000-01-01T00:00:00.000Z', identity_verified_at: '2000-01-01T00:00:00.000Z' }],
    });
    const shown = describeRelease(file).join('\n');
    expect(shown).toContain('deployment: UNVERIFIED — record says running');
    expect(shown).toContain('required process health has no evidence');
    expect(shown).toContain('reports installation dev.helmo');
    expect(shown).toContain('reports release old');
    expect(shown).toContain('pid 2147483647 is not live');
  });

  it('compares every recorded running component with the selected release', () => {
    const dir = root();
    const file = selectionAt(dir);
    const release = makeRelease(dir, 'next');
    upgrade(file, release);
    const selected = readSelection(file)!;
    selected.install = 'dev.rev';
    writeSelection(file, selected);
    const components = Object.fromEntries(REPOS.map((repo) => [repo, sha(`next:${repo}`)]));
    const process = (recorded: Record<string, string>) => ({
      process: 'supervisor', pid: 2147483647, command: 'rev service', installation: 'dev.rev', release: 'next', components: recorded,
      observed_at: new Date().toISOString(), identity_verified_at: new Date().toISOString(),
    });

    for (const [recorded, problem] of [
      [{ ...components, rev: sha('old:rev') }, 'record rev ref does not match selected'],
      [{}, 'record has no selected rev ref'],
      [{ ...components, elsewhere: sha('elsewhere') }, 'record has unselected component elsewhere'],
    ] as const) {
      writeDeployment(deploymentFile(file), {
        format: 1, installation: 'dev.rev', phase: 'running', release: 'next', directory: release,
        components: recorded, updated_at: new Date().toISOString(), recovery: 'Restore matching release evidence.',
        required_processes: ['supervisor'], processes: [process(recorded)],
      });
      const shown = describeRelease(file).join('\n');
      expect(shown).toContain('deployment: UNVERIFIED — record says running');
      expect(shown).toContain(problem);
    }
  });

  it('rejects duplicate process names instead of hiding one observation in a map', () => {
    const dir = root();
    const file = selectionAt(dir);
    const release = makeRelease(dir, 'next');
    upgrade(file, release);
    const components = Object.fromEntries(REPOS.map((repo) => [repo, sha(`next:${repo}`)]));
    const evidence = { process: 'supervisor', pid: 2147483647, command: 'rev service', installation: 'dev.rev', release: 'next', components,
      observed_at: new Date().toISOString(), identity_verified_at: new Date().toISOString() };
    writeDeployment(deploymentFile(file), {
      format: 1, installation: 'dev.rev', phase: 'running', release: 'next', directory: release, components,
      updated_at: new Date().toISOString(), recovery: 'Replace duplicate evidence.', required_processes: ['supervisor'],
      processes: [evidence, { ...evidence, pid: 42 }],
    });
    expect(describeRelease(file).join('\n')).toContain('deployment: UNREADABLE');
  });

  it('keeps malformed evidence diagnostic and keeps recovery visible when selection is broken', () => {
    const dir = root();
    const file = selectionAt(dir);
    upgrade(file, makeRelease(dir, 'next'));
    writeFileSync(deploymentFile(file), JSON.stringify({
      format: 1, installation: 'dev.rev', phase: 'failed', release: 'next', directory: '/release/next', components: {},
      updated_at: new Date().toISOString(), recovery: 'Restore the previous selection and restart the failed service.', processes: { length: 1 },
    }));
    expect(describeRelease(file).join('\n')).toContain('deployment: UNREADABLE');

    writeDeployment(deploymentFile(file), {
      format: 1, installation: 'dev.rev', phase: 'failed', release: 'next', directory: '/release/next', components: {},
      updated_at: new Date().toISOString(), recovery: 'Restore the previous selection and restart the failed service.',
    });
    writeFileSync(file, '{broken');
    const shown = describeRelease(file).join('\n');
    expect(shown).toContain('release: UNREADABLE');
    expect(shown).toContain('deployment: failed');
    expect(shown).toContain('Restore the previous selection');
  });
});

// A supervisor that launchd or systemd restarts comes back under a new pid on
// the same release, and before H-2985 nothing reconciled the activation
// receipt: `release status` read the dead recorded pid as NOT RUNNING and
// printed a recovery line telling the operator to roll back and activate —
// which, followed on a correctly running release, abandons it to recover from
// nothing. The rescue may only fire for the selection's OWN bytes, so every
// way a returning supervisor can be on something else is a refusal here.
describe('a restarted supervisor is not a failed deployment (H-2985)', () => {
  /** The marker a live supervisor leaves, written by the product's own writer:
   *  pid, start stamp, its command, and the build it loaded (runningStamp). */
  function liveMarker(home: string, dist: string, pid = process.pid, started = '2026-10-07T04:14:44.115Z'): void {
    const state = join(home, 'state', 'supervisor');
    mkdirSync(state, { recursive: true });
    const command = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
    writeFileSync(join(state, 'RUNNING'), `${pid}\nstarted ${started}\ncmd ${command}\n${markerLines(snapshot(dist))}`);
  }

  /** A record left by an activation whose supervisor has since been replaced:
   *  everything agrees with the selection except that the pid is long dead. */
  function recordWithDeadSupervisor(file: string, release: string, id: string): void {
    const components = Object.fromEntries(REPOS.map((repo) => [repo, sha(`${id}:${repo}`)]));
    writeDeployment(deploymentFile(file), {
      format: 1, installation: 'dev.rev', phase: 'running', release: id, directory: release, components,
      updated_at: '2026-10-06T21:34:42.046Z', attempt: 'attempt-9',
      recovery: `This release is running. To recover, select the retained release with ${runCommand} release rollback, then run ${runCommand} release activate.`,
      required_processes: ['supervisor'],
      processes: [{ process: 'supervisor', pid: 2147483647, command: 'node /home/.rev/service/launch.mjs run', installation: 'dev.rev', release: id,
        components, observed_at: '2026-10-06T21:34:42.046Z', identity_verified_at: '2026-10-06T21:34:42.046Z' }],
    });
  }

  function installation(id = 'current') {
    const dir = root();
    const file = selectionAt(dir);
    const release = makeRelease(dir, id);
    upgrade(file, release);
    const selected = readSelection(file)!;
    selected.install = 'dev.rev';
    writeSelection(file, selected);
    recordWithDeadSupervisor(file, release, id);
    return { dir, file, release, id, dist: join(release, 'rev', 'dist') };
  }

  it('reads verified, says what restarted, and offers no recovery advice', () => {
    const i = installation();
    liveMarker(i.dir, i.dist);
    const shown = describeRelease(i.file).join('\n');
    expect(shown).toContain('deployment: running — current');
    expect(shown).not.toContain('NOT RUNNING');
    expect(shown).not.toContain('recovery:');
    expect(shown).not.toContain('release rollback, then');
    expect(shown).toContain(`RESTARTED: supervisor pid ${process.pid} since 2026-10-07T04:14:44.115Z`);
    expect(shown).toContain(`loaded rev ${sha('current:rev').slice(0, 12)} from this release`);
  });

  it('still reports a down fleet when there is no live supervisor at all', () => {
    const i = installation();
    const shown = describeRelease(i.file).join('\n');
    expect(shown).toContain('deployment: UNVERIFIED — record says running');
    expect(shown).toContain('supervisor pid 2147483647 is not live');
    expect(shown).toContain('release rollback');
  });

  it('reads two spellings of one release directory as one release', () => {
    const i = installation();
    const link = join(i.dir, 'linked');
    symlinkSync(i.release, link);
    // A process records the directory Node resolved for it, which is the real
    // path; the operator's selection holds whatever was written. One symlink
    // above the release — /tmp is one on macOS, which is how this was found —
    // made the same directory read as two different ones.
    liveMarker(i.dir, join(link, 'rev', 'dist'));
    const shown = describeRelease(i.file).join('\n');
    expect(shown).toContain('deployment: running — current');
    expect(shown).toContain('RESTARTED: supervisor');
    expect(shown).not.toContain('NOT RUNNING');
  });

  it('refuses the rescue when the live supervisor loaded another commit', () => {
    const i = installation();
    const elsewhere = makeRelease(i.dir, 'elsewhere');
    liveMarker(i.dir, join(elsewhere, 'rev', 'dist'));
    const shown = describeRelease(i.file).join('\n');
    expect(shown).toContain('deployment: UNVERIFIED — record says running');
    expect(shown).toContain('supervisor pid 2147483647 is not live');
    expect(shown).not.toContain('RESTARTED');
  });

  it('refuses the rescue for a marker whose pid is dead', () => {
    const i = installation();
    liveMarker(i.dir, i.dist, process.pid);
    const marker = join(i.dir, 'state', 'supervisor', 'RUNNING');
    writeFileSync(marker, readFileSync(marker, 'utf8').replace(String(process.pid), '2147483646'));
    const shown = describeRelease(i.file).join('\n');
    expect(shown).toContain('deployment: UNVERIFIED — record says running');
    expect(shown).not.toContain('RESTARTED');
  });

  it('refuses the rescue while the record describes another selection', () => {
    const i = installation();
    const next = makeRelease(i.dir, 'next');
    upgrade(i.file, next);
    // The upgrade rewrote the record as 'selected'; this is the interrupted
    // case, where the old activation's running record survives the new choice.
    recordWithDeadSupervisor(i.file, i.release, i.id);
    liveMarker(i.dir, join(next, 'rev', 'dist'));
    const shown = describeRelease(i.file).join('\n');
    expect(shown).toContain('deployment: UNVERIFIED — record says running');
    expect(shown).toContain('the record describes another selection');
    expect(shown).not.toContain('RESTARTED');
    expect(shown).toContain('release rollback');
  });

  it('judges loaded bytes against the selection, not against a configured ref', () => {
    const commits = { helmo: sha('a'), other: sha('b') };
    const at = (dir: string, commit: string, dirty = false) =>
      ({ dir, digest: 'd', stamp: { commit, dirty, built_at: 'x' } });
    expect(loadedFromRelease(at('/r/12/helmo/packages/runtime/dist', sha('a')), '/r/12', commits)).toEqual({ component: 'helmo', commit: sha('a') });
    // Same commit, but bytes from outside the release the installation selected.
    expect(loadedFromRelease(at('/r/11/helmo/packages/runtime/dist', sha('a')), '/r/12', commits)).toBeNull();
    // A sibling directory whose name merely starts with the selection's.
    expect(loadedFromRelease(at('/r/12-old/helmo/dist', sha('a')), '/r/12', commits)).toBeNull();
    // The right place, the wrong component's commit.
    expect(loadedFromRelease(at('/r/12/helmo/dist', sha('b')), '/r/12', commits)).toBeNull();
    // A dirty build's commit did not produce its bytes, so it answers nothing.
    expect(loadedFromRelease(at('/r/12/helmo/dist', sha('a'), true), '/r/12', commits)).toBeNull();
    // No stamp, no marker, and the release directory itself names no component.
    expect(loadedFromRelease({ dir: '/r/12/helmo/dist', digest: 'd', stamp: null }, '/r/12', commits)).toBeNull();
    expect(loadedFromRelease(null, '/r/12', commits)).toBeNull();
    expect(loadedFromRelease(at('/r/12', sha('a')), '/r/12', commits)).toBeNull();
  });

  it('re-attests the record itself when the supervisor comes back, and only then', () => {
    const i = installation();
    const selection = readSelection(i.file)!;
    const loadedHere = snapshot(i.dist);
    const activation = deploymentFile(i.file);
    // This process stands in for the returning supervisor, so the evidence it
    // writes names a pid that is really live running really that command.
    const pid = process.pid;
    const command = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();

    // Another installation's label, and bytes from outside the selection, both
    // leave the record exactly as the activation wrote it.
    expect(recordRestart(activation, selection, 'other.rev', loadedHere, pid, command)).toBeNull();
    expect(recordRestart(activation, selection, 'dev.rev', snapshot(join(makeRelease(i.dir, 'elsewhere'), 'rev', 'dist')), pid, command)).toBeNull();
    expect(readDeployment(activation)?.processes?.[0]?.pid).toBe(2147483647);

    const restarted = recordRestart(activation, selection, 'dev.rev', loadedHere, pid, command);
    expect(restarted?.phase).toBe('running');
    expect(restarted?.attempt).toBe('attempt-9');
    expect(restarted?.processes).toHaveLength(1);
    expect(restarted?.processes?.[0]).toMatchObject({ process: 'supervisor', pid, command, release: i.id });
    expect(readDeployment(activation)?.processes?.[0]?.pid).toBe(pid);
    // With the record true again, status reads verified with no marker to ask.
    const shown = describeRelease(i.file).join('\n');
    expect(shown).toContain('deployment: running — current');
    expect(shown).not.toContain('NOT RUNNING');
    expect(shown).not.toContain('RESTARTED');
    // And a second restart over a record it has already corrected is a no-op.
    expect(recordRestart(activation, selection, 'dev.rev', loadedHere, pid, command)).toBeNull();
  });

  it('leaves a record describing another selection for a human to read as stale', () => {
    const i = installation();
    const next = makeRelease(i.dir, 'next');
    upgrade(i.file, next);
    recordWithDeadSupervisor(i.file, i.release, i.id);
    const selection = readSelection(i.file)!;
    expect(recordRestart(deploymentFile(i.file), selection, 'dev.rev', snapshot(join(next, 'rev', 'dist')), 4242, 'cmd')).toBeNull();
    expect(readDeployment(deploymentFile(i.file))).toMatchObject({ release: i.id, processes: [{ pid: 2147483647 }] });
  });
});

describe('the release commands (H-2493)', () => {
  function rev(home: string, args: string[], env: Record<string, string> = {}) {
    // usage_poll_seconds = 0: `run` would otherwise read the operator's real
    // keychain credential and hold the process on a live usage call (H-740).
    writeFileSync(join(home, 'roster.toml'), '[global]\nhelmo_cli = "/tmp/helmo-cli.js"\nhelmo_mcp_server = "/tmp/helmo-server.js"\nusage_poll_seconds = 0\n');
    const inherited = { ...process.env };
    // A loop's absolute selection overrides REV_HOME, even in an unpinned test.
    for (const key of ['INSTALLATION_RELEASE', 'HELMO_INSTALLATION', 'REV_LABEL', 'HELMO_HOME', 'HELMO_DB', 'HELMO_LABEL', 'ROADMAP_HOME', 'ROADMAP_DB', 'ROADMAP_LABEL']) {
      delete inherited[key];
    }
    return spawnSync(process.execPath, ['--import', 'tsx', REV_CLI, ...args], {
      cwd: ROOT, encoding: 'utf8', env: { ...inherited, HOME: dirname(home), REV_HOME: home, ...env },
    });
  }

  function activatableInstallation(id: string) {
    const dir = root();
    const home = join(dir, '.rev');
    mkdirSync(home, { recursive: true });
    const file = selectionAt(dir);
    const built = JSON.parse(readFileSync(join(ROOT, 'dist', 'BUILD.json'), 'utf8')) as { commit: string };
    const commits = { rev: built.commit, helmo: sha(`${id}:helmo`), 'helmo-roadmap': sha(`${id}:helmo-roadmap`) };
    const release = makeRelease(dir, id, { commits, stamped: commits });
    rmSync(join(release, 'rev'), { recursive: true });
    symlinkSync(ROOT, join(release, 'rev'), 'dir');
    upgrade(file, release);

    const label = `dev.rev.${id}`;
    const agents = join(dir, 'Library', 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, `${label}.plist`), [
      '<plist><dict>',
      '<key>ProgramArguments</key><array>',
      `<string>${process.execPath}</string><string>${join(home, 'service', 'launch.mjs')}</string><string>run</string>`,
      '</array>',
      `<key>REV_HOME</key><string>${home}</string>`,
      '</dict></plist>',
    ].join('\n'));
    const supervisor = join(home, 'state', 'supervisor');
    mkdirSync(supervisor, { recursive: true });
    const env = { INSTALLATION_RELEASE: file, REV_LABEL: label };
    const markOldSupervisor = () => writeFileSync(join(supervisor, 'RUNNING'), `${process.pid}\n`);
    markOldSupervisor();
    return { dir, home, file, env, supervisor, markOldSupervisor };
  }

  it('drives activate through the CLI, bounded drain, and replacement supervisor readback', () => {
    const i = activatableInstallation('activation-success');
    const activated = rev(i.home, ['release', 'activate'], i.env);
    expect(activated.status, activated.stderr).toBe(0);
    expect(readDeployment(deploymentFile(i.file))).toMatchObject({ phase: 'activating', installation: i.env.REV_LABEL });
    expect(readFileSync(join(i.supervisor, 'REDEPLOY'), 'utf8')).toContain('activate selected release activation-success');

    unlinkSync(join(i.supervisor, 'RUNNING'));
    const replacement = rev(i.home, ['run'], i.env);
    expect(replacement.status, `${replacement.stdout}${replacement.stderr}`).toBe(0);
    expect(readDeployment(deploymentFile(i.file))).toMatchObject({
      phase: 'running', installation: i.env.REV_LABEL, release: 'activation-success', required_processes: ['supervisor'],
    });
    expect(readDeployment(deploymentFile(i.file))?.processes?.[0]).toMatchObject({
      process: 'supervisor', installation: i.env.REV_LABEL, release: 'activation-success',
    });
    expect(existsSync(join(i.supervisor, 'REDEPLOY'))).toBe(false);
  });

  it('records watch expiry and recovers only through a fresh activation attempt', () => {
    const i = activatableInstallation('activation-recovery');
    expect(rev(i.home, ['release', 'activate'], i.env).status).toBe(0);

    const bin = join(i.dir, 'bin');
    mkdirSync(bin);
    const osascript = join(bin, 'osascript');
    writeFileSync(osascript, '#!/bin/sh\nexit 0\n');
    chmodSync(osascript, 0o755);
    const expired = rev(i.home, ['redeploy-watch', '--deadline', '0'], { ...i.env, PATH: `${bin}:${process.env.PATH ?? ''}` });
    expect(expired.status).toBe(1);
    expect(readDeployment(deploymentFile(i.file))).toMatchObject({ phase: 'failed', release: 'activation-recovery' });
    expect(readDeployment(deploymentFile(i.file))?.recovery).toContain('rev service start');

    unlinkSync(join(i.supervisor, 'RUNNING'));
    expect(rev(i.home, ['run'], i.env).status).toBe(0);
    expect(readDeployment(deploymentFile(i.file))?.phase).toBe('failed');

    i.markOldSupervisor();
    expect(rev(i.home, ['release', 'activate'], i.env).status).toBe(0);
    unlinkSync(join(i.supervisor, 'RUNNING'));
    expect(rev(i.home, ['run'], i.env).status).toBe(0);
    expect(readDeployment(deploymentFile(i.file))).toMatchObject({ phase: 'running', release: 'activation-recovery' });
  });

  it('upgrades, rolls back, and says what a running process still has', () => {
    const dir = root();
    const home = join(dir, '.rev');
    mkdirSync(home, { recursive: true });
    const file = selectionAt(dir);
    const current = makeRelease(dir, 'current');
    const next = makeRelease(dir, 'next');

    const first = rev(home, ['release', 'upgrade', current], { INSTALLATION_RELEASE: file });
    expect(first.status, first.stderr).toBe(0);
    const up = rev(home, ['release', 'upgrade', next], { INSTALLATION_RELEASE: file });
    expect(up.status, up.stderr).toBe(0);
    expect(up.stdout).toContain('release: current -> next');
    expect(up.stdout).toContain('rollback supported');
    expect(up.stdout).toContain('Nothing was restarted');
    expect(readSelection(file)!.release).toBe('next');

    const back = rev(home, ['release', 'rollback'], { INSTALLATION_RELEASE: file });
    expect(back.status, back.stderr).toBe(0);
    expect(back.stdout).toContain('release: next -> current');
    expect(readSelection(file)!.release).toBe('current');
  });

  // The property the whole command family exists for: a selection bad enough
  // to stop every other command must not stop the commands that get OUT of it.
  // There are two, and this case only checked one until H-2522 — `install
  // remove` passed 'unchecked' downstream but the module-level gate in cli.ts
  // exempted the `release` family alone, so it threw before reaching its own
  // argument. Asserting the escapes as a set is what keeps the next one honest.
  it('runs while the selection is broken, which is exactly when every other command refuses', () => {
    const dir = root();
    const home = join(dir, '.rev');
    mkdirSync(home, { recursive: true });
    const file = selectionAt(dir);
    upgrade(file, makeRelease(dir, 'next'));
    writeFileSync(file, `${readFileSync(file, 'utf8').slice(0, 40)}`); // an interrupted write

    const status = rev(home, ['status'], { INSTALLATION_RELEASE: file });
    expect(status.status).not.toBe(0);
    expect(status.stderr).toContain('incoherent release set');
    // The refusal is lines, not a throw from inside the check: an operator
    // reading a stack trace is told nothing about either way out, and the way
    // around a dead end here is a hand `rm -rf` (H-2431).
    expect(status.stderr).not.toMatch(/^\s+at /m);
    expect(status.stderr).toContain('rev release status');
    expect(status.stderr).toContain('rev install remove');

    const shown = rev(home, ['release', 'status'], { INSTALLATION_RELEASE: file });
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('UNREADABLE');

    // The escape still has to answer for the name it is given (H-2526), and
    // still has to work: identity is not selection coherence, so the assertion
    // at the door reads the target unchecked. Gating it on `verify` instead
    // would put this way out behind the fault it is the way out of.
    const named = rev(home, ['release', 'status', '--installation', home], { INSTALLATION_RELEASE: file });
    expect(named.status, named.stderr).toBe(0);
    expect(named.stdout).toContain('UNREADABLE');

    const misnamed = rev(home, ['release', 'status', '--installation', 'dev.rev.elsewhere'], { INSTALLATION_RELEASE: file });
    expect(misnamed.status).toBe(1);
    expect(misnamed.stderr).toContain('--installation named');
    expect(misnamed.stderr).not.toContain('incoherent release set');

    // The other escape. Only the plan is run here — it is the act that proves
    // the command got past the gate, and it writes nothing, so the rest of this
    // case still has an installation to repair.
    const removal = rev(home, ['install', 'remove'], { INSTALLATION_RELEASE: file });
    expect(removal.status, `${removal.stdout}${removal.stderr}`).toBe(0);
    expect(removal.stdout).toContain(home);
    expect(removal.stdout).toContain(file);
    expect(removal.stdout).toContain('Nothing was removed');
    expect(existsSync(file)).toBe(true);

    const repaired = rev(home, ['release', 'upgrade', makeRelease(dir, 'good')], { INSTALLATION_RELEASE: file });
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(readSelection(file)!.release).toBe('good');
  }, 15_000);

  it('refuses a cross-installation assertion before it writes', () => {
    const dir = root();
    const home = join(dir, '.rev');
    mkdirSync(home, { recursive: true });
    const file = selectionAt(dir);

    const res = rev(home, ['release', 'upgrade', makeRelease(dir, 'next'), '--installation', join(dir, 'somewhere-else')], { INSTALLATION_RELEASE: file });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--installation named');
    expect(existsSync(file)).toBe(false);
  });

  it('says so, rather than writing a selection nothing reads, when the installation is not pinned', () => {
    const dir = root();
    const home = join(dir, '.rev');
    mkdirSync(home, { recursive: true });
    const res = rev(home, ['release', 'upgrade', makeRelease(dir, 'next')]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('not pinned');
    expect(readdirSync(dir)).not.toContain('ADOPTED.json');
  });

  it('leaves the parent installation untouched when a pinned loop runs an unpinned test', () => {
    const parent = root();
    const file = selectionAt(parent);
    upgrade(file, makeRelease(parent, 'current'));
    const before = readFileSync(file, 'utf8');
    const dir = root();
    const home = join(dir, '.rev');
    mkdirSync(home, { recursive: true });
    vi.stubEnv('INSTALLATION_RELEASE', file);
    vi.stubEnv('REV_LABEL', 'dev.rev.parent');
    try {
      const res = rev(home, ['release', 'upgrade', makeRelease(dir, 'next')]);
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('not pinned');
      expect(readdirSync(home)).toEqual(['roster.toml']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// The declaration this repo ships is a data file no compiler checks, and it is
// copied into a release directory whose name the consumer chooses (H-2459).
describe("the declaration this release ships (H-2459)", () => {
  const shipped = () => JSON.parse(readFileSync(join(ROOT, 'MIGRATION.json'), 'utf8')) as Migration;

  it('is a declaration a release directory built from it can be selected with', () => {
    const dir = root();
    expect(releaseProblems(makeRelease(dir, '2026.09-1', { migration: shipped() }))).toEqual([]);
  });

  it('names no release, because the id is the directory name the consumer picks', () => {
    const dir = root();
    const named = { ...shipped(), release: 'v0.1.0' };
    expect(releaseProblems(makeRelease(dir, '2026.09-1', { migration: named }))).toEqual([
      expect.stringContaining("declares release 'v0.1.0' but sits in '2026.09-1'"),
    ]);
    expect('release' in shipped()).toBe(false);
  });
});
