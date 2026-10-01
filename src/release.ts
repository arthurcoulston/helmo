// Changing which release an installation runs (H-2493).
//
// H-2454 gave an installation a pinned release: `INSTALLATION_RELEASE` names a
// selection file, and every entry point refuses to start unless all three
// products — rev, helmo, helmo-roadmap — resolve to the one release set it
// names (install.ts, `selectedRelease`). That is the read half. Until now the
// write half was a text editor, which is the same class of defect the pin was
// built to close: an upgrade was an unwitnessed edit, a half-written file
// bricked every command in the installation, and going back meant finding and
// reinstalling old code.
//
// So: two operations, `upgrade` and `rollback`, and three properties.
//
// ATOMIC AND DURABLE. The selection is the one file that decides what the next
// process loads, and it is read by processes that start at arbitrary moments —
// including the ones a crash brings back. A partially written selection is
// therefore not a transient state; it is an installation that cannot run. The
// replacement is written to a temp file in the SAME directory, fsync'd,
// renamed over the old one, and the directory fsync'd after, so a reader sees
// the old selection or the new one and a power cut cannot leave a rename the
// filesystem has not recorded.
//
// VALIDATED BEFORE THE POINTER MOVES, NOT AFTER. The whole set is checked
// first: the manifest names a commit per product, each product's `dist` holds
// JavaScript, and its BUILD.json stamp says it was built from exactly that
// commit on a clean tree. An unverifiable component refuses the upgrade while
// the installation is still running the release it was running — the failure
// mode being avoided is the one where the pointer moves and the next process
// to start is the one that discovers the set is incoherent.
//
// ROLLBACK IS A POINTER, NOT A REINSTALL. The selection retains the whole
// previous selection inside itself, so going back is the same atomic write in
// the other direction and needs nothing fetched or rebuilt. It is retained
// INSIDE the selection rather than beside it because one rename must move both
// or neither: a sidecar could survive a crash describing a release the pointer
// no longer names.
//
// AND SOME RELEASES CANNOT BE ROLLED BACK. A release that migrates data one
// way leaves a store the older code cannot read, so restoring the old pointer
// restores a broken installation. `MIGRATION.json` in the release directory is
// where a release says which it is, and it is REQUIRED: a release that has not
// declared its data compatibility and its rollback limit cannot be selected at
// all, because the moment to find out is before the upgrade. The declaration
// is copied into the selection when it is made, so a rollback can be refused
// with the limit's own words even if the release directory is long gone.
//
// This module changes one file. Restarting the processes that would load the
// new code is deliberately not part of it: what a release change may touch is
// bounded by the independent-installations contract
// (crew:projects/estate/specs/h2435-independent-installs.md), and an upgrade
// that also operated a service would be operating one this command has not
// established it owns.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { digestOf, readStamp } from './build.js';
import { deploymentFile, describeDeployment, recordSelection } from './deployment.js';

/** The products that make up one release set — the same three `install.ts`
 *  verifies, because a set with two of them coherent is not a set. */
export const RELEASE_REPOS = ['rev', 'helmo', 'helmo-roadmap'] as const;

/** The manifest a build leaves beside the products it built. */
const MANIFEST = 'RELEASE.json';
/** What the release says about the data it migrates. Authored, not generated:
 *  it is a claim about consequences, which no build step can compute. */
const MIGRATION = 'MIGRATION.json';

/** Refusals an operator is meant to read, not stack traces. */
export class ReleaseError extends Error {}

export interface Migration {
  /** `compatible`: older code in the set can still read the data this release
   *  writes. `one_way`: it cannot, and `rollback.limit` says what that costs. */
  data_compatibility: 'compatible' | 'one_way';
  rollback: { supported: true } | { supported: false; limit: string };
  notes?: string;
}

export interface Component {
  release: string;
  commit: string;
}

export interface ReleaseSet {
  id: string;
  dir: string;
  commits: Record<string, string>;
  migration: Migration;
}

/** A selection that was replaced, kept whole so restoring it is one write. */
export interface PreviousSelection {
  release: string;
  directory: string;
  components: Record<string, Component>;
  migration: Migration | null;
  selected_at: string;
}

export interface Selection {
  install?: string;
  release: string;
  directory: string;
  components: Record<string, Component>;
  /** The selected release's own declaration, copied in when it was selected:
   *  a rollback must be answerable without the release directory. */
  migration?: Migration;
  selected_at: string;
  previous?: PreviousSelection | null;
}

/** The selection file this installation is pinned to, or null when it is not
 *  pinned at all. An unpinned installation is the pre-H-2454 arrangement and
 *  still supported: it runs whatever code its entry points were started from. */
export function selectionFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env['INSTALLATION_RELEASE']?.trim();
  return named ? resolve(named) : null;
}

export function readSelection(file: string): Selection | null {
  if (!existsSync(file)) return null;
  let parsed: Partial<Selection>;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Selection>;
  } catch (e) {
    throw new ReleaseError(`${file} is not readable as a selection: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed.release || !parsed.directory) {
    throw new ReleaseError(`${file} names no release (it needs 'release' and 'directory'). Select one with: rev release upgrade <release directory>`);
  }
  return {
    ...parsed,
    release: parsed.release,
    directory: resolve(dirname(file), parsed.directory),
    components: parsed.components ?? {},
    selected_at: parsed.selected_at ?? 'unrecorded',
    previous: parsed.previous ?? null,
  };
}

// ---- reading a release set -----------------------------------------------

/**
 * Everything that would stop `dir` being selected, all of it, in one list.
 * All of it because an operator fixing a release set one refusal at a time
 * rebuilds three times to learn three things one read could have told them.
 */
export function releaseProblems(dir: string): string[] {
  const problems: string[] = [];
  if (!existsSync(dir)) return [`${dir} does not exist`];
  if (!statSync(dir).isDirectory()) return [`${dir} is not a directory`];

  let commits: Record<string, string> = {};
  try {
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as { commits?: Record<string, string> };
    commits = manifest.commits ?? {};
    if (!Object.keys(commits).length) problems.push(`${join(dir, MANIFEST)} names no commits`);
  } catch (e) {
    problems.push(`${join(dir, MANIFEST)} is missing or unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    migrationOf(dir);
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }

  for (const repo of RELEASE_REPOS) {
    const dist = join(dir, repo, 'dist');
    const want = commits[repo];
    if (!want) {
      problems.push(`the manifest names no commit for ${repo}, so nothing can say which build this set's ${repo} is`);
      continue;
    }
    if (digestOf(dist) === null) {
      problems.push(`${dist} holds no JavaScript — ${repo} is not built in this release`);
      continue;
    }
    const stamp = readStamp(dist);
    if (!stamp) {
      problems.push(`${join(dist, 'BUILD.json')} is missing, so ${repo}'s build cannot be identified (build it with npm run build, which stamps it)`);
    } else if (stamp.commit !== want) {
      problems.push(`${repo} is built from ${short(stamp.commit)} but the manifest names ${short(want)} — this set is mixed`);
    } else if (stamp.dirty) {
      problems.push(`${repo} was built from a dirty tree, so commit ${short(want)} does not identify the bytes in ${dist} — rebuild it from a clean checkout`);
    }
  }
  return problems;
}

/** The release set at `dir`, or a refusal naming everything wrong with it. */
export function readRelease(dir: string): ReleaseSet {
  const resolved = resolve(dir);
  const problems = releaseProblems(resolved);
  if (problems.length) {
    throw new ReleaseError(`${resolved} is not a release set this installation can run:\n  - ${problems.join('\n  - ')}`);
  }
  const manifest = JSON.parse(readFileSync(join(resolved, MANIFEST), 'utf8')) as { commits: Record<string, string> };
  return { id: releaseId(resolved), dir: resolved, commits: manifest.commits, migration: migrationOf(resolved) };
}

/** A release's id is its directory's name: the selection records both, and a
 *  set that carried an id of its own could disagree with where it is. */
function releaseId(dir: string): string {
  return basename(dir);
}

function migrationOf(dir: string): Migration {
  const file = join(dir, MIGRATION);
  let raw: Partial<Migration> & { release?: string };
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Migration> & { release?: string };
  } catch (e) {
    throw new ReleaseError(
      `${file} is missing or unreadable (${e instanceof Error ? e.message : String(e)}). `
      + 'A release states its data compatibility and its rollback limit before it can be selected, because after the upgrade is too late: '
      + '{"data_compatibility":"compatible","rollback":{"supported":true}}, or "one_way" with {"supported":false,"limit":"<what cannot be recovered, and how to>"}',
    );
  }
  if (raw.release !== undefined && raw.release !== releaseId(dir)) {
    throw new ReleaseError(`${file} declares release '${raw.release}' but sits in '${releaseId(dir)}' — it describes some other release's migration`);
  }
  if (raw.data_compatibility !== 'compatible' && raw.data_compatibility !== 'one_way') {
    throw new ReleaseError(`${file} must set data_compatibility to "compatible" or "one_way" (it has ${JSON.stringify(raw.data_compatibility)})`);
  }
  const rollback = raw.rollback;
  if (!rollback || typeof rollback.supported !== 'boolean') {
    throw new ReleaseError(`${file} must set rollback.supported to true or false`);
  }
  if (rollback.supported === false && !String((rollback as { limit?: string }).limit ?? '').trim()) {
    throw new ReleaseError(`${file} says rollback is not supported but states no limit — rollback.limit must say exactly what cannot be recovered and how to recover from a backup instead`);
  }
  if (raw.data_compatibility === 'one_way' && rollback.supported === true) {
    throw new ReleaseError(`${file} declares a one-way data migration and also says rollback is supported — one of those is wrong, and an operator would find out which by losing data`);
  }
  return { data_compatibility: raw.data_compatibility, rollback, ...(raw.notes ? { notes: raw.notes } : {}) };
}

// ---- changing the selection ----------------------------------------------

export interface Change {
  from: string | null;
  to: string;
  directory: string;
  migration: Migration;
  /** True when the selection already named this release and nothing was
   *  written — an upgrade run twice is not an error. */
  unchanged: boolean;
  /** Set when the selection being replaced could not be read, and so could not
   *  be retained: the upgrade is the repair, and there is now nothing to roll
   *  back to. Silence here would be the worse answer. */
  discarded?: string;
}

/**
 * Point this installation at `dir`.
 *
 * The whole set is read and verified first; only then is the pointer replaced,
 * and the replacement retains the selection it replaced so `rollback` needs
 * nothing else.
 */
export function upgrade(file: string, dir: string): Change {
  const next = readRelease(dir);
  // An unreadable current selection does not stop the upgrade: this command IS
  // the repair for one, and refusing here would leave the installation stuck on
  // a selection nothing can start from. It cannot be retained, though, and the
  // caller is told rather than left to notice rollback has nothing to go to.
  let current: Selection | null = null;
  let discarded: string | undefined;
  try {
    current = readSelection(file);
  } catch (e) {
    discarded = e instanceof Error ? e.message : String(e);
  }
  if (current && current.release === next.id && resolve(current.directory) === next.dir) {
    return { from: current.release, to: next.id, directory: next.dir, migration: next.migration, unchanged: true };
  }
  writeSelection(file, selectionFor(next, current ? retained(current) : null, current?.install));
  recordSelection(deploymentFile(file), readSelection(file)!, 'selected');
  return {
    from: current?.release ?? null, to: next.id, directory: next.dir, migration: next.migration, unchanged: false,
    ...(discarded ? { discarded } : {}),
  };
}

/**
 * Put back the selection the last upgrade replaced.
 *
 * Every refusal here is a refusal to leave the installation worse than it is:
 * a release that declared a one-way migration, a retained release whose
 * directory has since gone or been rebuilt into something else, or a selection
 * made before a declaration was recorded and so unable to say which it was.
 */
export function rollback(file: string): Change {
  const current = readSelection(file);
  if (!current) {
    throw new ReleaseError(`${file} names no selection, so there is nothing to roll back. Select a release with: rev release upgrade <release directory>`);
  }
  const previous = current.previous;
  if (!previous) {
    throw new ReleaseError(
      `selection ${current.release} retains no previous release, so there is nothing to roll back to. `
      + 'A release this installation upgraded INTO retains the one it replaced; this one was selected directly. '
      + 'Point at the release you want with: rev release upgrade <release directory>',
    );
  }
  if (!current.migration) {
    throw new ReleaseError(
      `selection ${current.release} was made before its migration declaration was recorded, so nothing here can say whether rolling back out of it is safe. `
      + `Re-select it with 'rev release upgrade ${current.directory}', which records the declaration, and the rollback will then be answerable.`,
    );
  }
  if (current.migration.rollback.supported === false) {
    throw new ReleaseError(
      `refusing to roll back out of ${current.release}: it declares a one-way data migration.\n`
      + `  ${current.migration.rollback.limit}\n`
      + `Rolling the pointer back to ${previous.release} would leave ${current.release}'s data in front of code that cannot read it. `
      + 'Recover from a pre-upgrade backup as above, then select the older release.',
    );
  }
  // The retained release has to still BE that release: a directory rebuilt
  // under the same name is a different set wearing the old one's label.
  const restored = readRelease(previous.directory);
  if (restored.id !== previous.release) {
    throw new ReleaseError(`${previous.directory} is now release '${restored.id}', not the '${previous.release}' this selection retained`);
  }
  for (const repo of RELEASE_REPOS) {
    const was = previous.components[repo]?.commit;
    if (was && restored.commits[repo] !== was) {
      throw new ReleaseError(
        `refusing to roll back to ${previous.release}: its ${repo} was ${short(was)} when this installation left it and is ${short(restored.commits[repo])} now. `
        + 'The directory has been rebuilt, so rolling back would not restore what was running.',
      );
    }
  }
  writeSelection(file, selectionFor(restored, retained(current), current.install));
  recordSelection(deploymentFile(file), readSelection(file)!, 'rolled_back');
  return { from: current.release, to: restored.id, directory: restored.dir, migration: restored.migration, unchanged: false };
}

function retained(s: Selection): PreviousSelection {
  return {
    release: s.release,
    directory: s.directory,
    components: s.components,
    migration: s.migration ?? null,
    selected_at: s.selected_at,
  };
}

function selectionFor(set: ReleaseSet, previous: PreviousSelection | null, install?: string): Selection {
  return {
    ...(install ? { install } : {}),
    release: set.id,
    directory: set.dir,
    components: Object.fromEntries(RELEASE_REPOS.map((repo) => [repo, { release: set.id, commit: set.commits[repo] }])),
    migration: set.migration,
    selected_at: new Date().toISOString(),
    previous,
  };
}

/**
 * Replace the selection file in one step that a reader can never catch
 * half-done, and that survives the machine losing power immediately after.
 *
 * The temp file is in the same directory because a rename is only atomic
 * within a filesystem; fsync on the file commits the bytes before the rename
 * makes them the selection, and fsync on the directory commits the rename
 * itself — without it the file's contents are durable and the name pointing at
 * them is not.
 */
export function writeSelection(file: string, selection: Selection): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.tmp`);
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, `${JSON.stringify(selection, null, 1)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing was left behind */ }
    throw e;
  }
  const dfd = openSync(dir, 'r');
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

// ---- describing it -------------------------------------------------------

/**
 * What `rev release status` prints: the selection, whether the set behind it
 * is still sound, and whether there is anything to roll back to.
 *
 * This is the one release surface that must answer while the selection is
 * broken — it is what an operator runs to find out what broke — so every read
 * here reports its failure as a line rather than throwing.
 */
export function describe(file: string | null): string[] {
  if (!file) {
    return [
      'release: this installation is not pinned (INSTALLATION_RELEASE is unset).',
      '  It runs whatever code each entry point was started from. To pin it, set INSTALLATION_RELEASE to the',
      '  selection file this installation should use, then: rev release upgrade <release directory>',
    ];
  }
  let selection: Selection | null;
  let selectionProblem: string | null = null;
  try {
    selection = readSelection(file);
  } catch (e) {
    selection = null;
    selectionProblem = e instanceof Error ? e.message : String(e);
  }
  if (!selection) {
    const lines = selectionProblem
      ? [`release: UNREADABLE — ${selectionProblem}`, `  selection file: ${file}`]
      : [`release: none selected yet (${file} does not exist).`, '  Select one with: rev release upgrade <release directory>'];
    lines.push(...describeDeployment(deploymentFile(file), null));
    return lines;
  }

  const lines = [`release: ${selection.release} (${selection.directory}), selected ${selection.selected_at}`];
  const problems = releaseProblems(selection.directory);
  if (problems.length) {
    lines.push('  INCOHERENT — every entry point in this installation refuses to start until this is resolved:');
    for (const p of problems) lines.push(`    - ${p}`);
  } else {
    const set = readRelease(selection.directory);
    for (const repo of RELEASE_REPOS) lines.push(`  ${repo.padEnd(14)} ${short(set.commits[repo])}`);
  }
  lines.push(`  data compatibility: ${selection.migration ? migrationLine(selection.migration) : 'undeclared (selected before it was recorded)'}`);
  lines.push(selection.previous
    ? `  previous: ${selection.previous.release} (${selection.previous.directory}) — go back with: rev release rollback`
    : '  previous: none retained — nothing to roll back to');
  lines.push(...describeDeployment(deploymentFile(file), selection));
  return lines;
}

export function migrationLine(m: Migration): string {
  return m.rollback.supported
    ? `${m.data_compatibility} — rollback supported`
    : `${m.data_compatibility} — ROLLBACK REFUSED: ${m.rollback.limit}`;
}

function short(commit: string | undefined): string {
  return commit ? commit.slice(0, 12) : 'unknown';
}
