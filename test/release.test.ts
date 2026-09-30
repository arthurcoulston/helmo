import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Migration, ReleaseError, describe as describeRelease, readSelection, releaseProblems, rollback, upgrade, writeSelection } from '../src/release.js';

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

const selectionAt = (dir: string) => join(dir, 'ADOPTED.json');

describe('reading a release set (H-2493)', () => {
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
});

describe('the release commands (H-2493)', () => {
  function rev(home: string, args: string[], env: Record<string, string> = {}) {
    writeFileSync(join(home, 'roster.toml'), '[global]\nhelmo_cli = "/tmp/helmo-cli.js"\nhelmo_mcp_server = "/tmp/helmo-server.js"\n');
    return spawnSync('npx', ['tsx', REV_CLI, ...args], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, REV_HOME: home, ...env },
    });
  }

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
  });

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
});
