// What build is this installation RUNNING? (H-2489)
//
// H-2442 gave the artifact provenance: `npm run build` stamps dist/BUILD.json
// with the commit it compiled. That answers "what is on disk". It does not
// answer the question the Human and agent visibility row of
// crew:projects/estate/specs/h2435-independent-installs.md actually asks,
// because the two come apart the moment anybody rebuilds:
//
//   H-2432, 2026-09-30. dist/store.js was built at 06:40 UTC. The process
//   serving it had started at 18:01 the previous evening. Every surface that
//   could have been asked would have read the stamp beside the code and
//   reported the NEW commit as the running version — the one answer that was
//   certainly wrong.
//
// So a surface may never report the configured or on-disk ref as what is
// running. It reports what the process recorded when it loaded, and when that
// cannot be established it says so. Stale and unverifiable are answers; a
// confident wrong sha is not.
//
// THE RECORD RIDES IN THE MARKER IT ALREADY WRITES. A long-lived rev process
// writes `RUNNING` at startup and clears it on exit (sentinels.ts), which is
// exactly the lifetime of "bytes this process has loaded" — so the loaded
// build goes in there rather than in a new file with a new lifecycle to get
// wrong. Markers written before this existed simply lack the lines, and a
// reader calls that unverifiable instead of guessing.
//
// WHAT IS COMPARED IS BYTES, NOT THE SHA. A dirty tree compiles to a stamp
// whose sha did not produce the artifact (stamp-build.mjs records that rather
// than refusing), and two rebuilds of one commit differ. So the identity used
// for "is this still what you loaded" is a digest over the JavaScript in the
// directory the process ran from. Its limit, stated plainly: it is the bytes
// on disk at the moment the snapshot was taken, which for a statically
// imported ESM graph is load time, and it does not follow a module imported
// dynamically much later.
//
// Everything here is per-directory, because two installations of rev on one
// machine run from two checkouts (H-2435) and the directory the process ran
// from is the only thing that can tell them apart.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Written by scripts/stamp-build.mjs as npm `postbuild`. Named here too
 *  because a reader must work from the artifact alone — dist can be copied
 *  somewhere the build scripts are not. */
const STAMP = 'BUILD.json';

// The stamp as a reader needs it. `repo` is deliberately dropped from
// scripts/stamp-build.mjs's record: the marker cannot carry it, and a field
// that survives one path and not the other is the kind of half-truth that
// makes two snapshots of the same build compare unequal. Where the code is
// living is `Snapshot.dir`, which every path does carry.
export interface Stamp {
  commit: string;
  dirty: boolean;
  built_at: string;
}

export interface Snapshot {
  /** The directory the code ran from — dist, or src under `tsx`. */
  dir: string;
  /** Identity of the JavaScript there; null when it could not be read. */
  digest: string | null;
  /** The build stamp beside it, when the build left one. */
  stamp: Stamp | null;
}

/** The directory this module was loaded from. */
export function codeDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Identity of the loadable code in a directory. Only JavaScript counts: .d.ts
 * files change on a rebuild without changing a single byte any process
 * executes, and a digest that moved for them would report divergence where
 * there is none. The stamp is excluded for the same reason stamp-build's
 * freshness check excludes it — it describes the rest, so it can never be part
 * of what it describes.
 */
export function digestOf(dir: string): string | null {
  const h = createHash('sha256');
  let files = 0;
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d).sort()) {
      if (prefix === '' && name === STAMP) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p, `${prefix}${name}/`);
      } else if (/\.[cm]?js$/.test(name)) {
        h.update(`${prefix}${name}\0${st.size}\0`);
        h.update(readFileSync(p));
        files++;
      }
    }
  };
  try {
    walk(dir, '');
  } catch {
    return null; // no such directory, or unreadable: unverifiable, never fatal
  }
  return files === 0 ? null : h.digest('hex').slice(0, 12);
}

export function readStamp(dir: string): Stamp | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, STAMP), 'utf8')) as Partial<Stamp>;
    if (!raw.commit || !raw.built_at) return null;
    return { commit: raw.commit, dirty: raw.dirty === true, built_at: raw.built_at };
  } catch {
    return null;
  }
}

/** The state of a directory as it is right now — the artifact question. */
export function snapshot(dir = codeDir()): Snapshot {
  return { dir, digest: digestOf(dir), stamp: readStamp(dir) };
}

let loadedSnapshot: Snapshot | null = null;

/**
 * What THIS process loaded. Computed once and held, so a process that outlives
 * a rebuild keeps answering with the bytes it is executing rather than the
 * ones that replaced them. Long-lived entry points call it at startup
 * (supervisor via the RUNNING marker, view before it serves) so the held value
 * is a load-time reading and not whatever the first caller happened to find.
 */
export function loaded(): Snapshot {
  return (loadedSnapshot ??= snapshot());
}

/** Test seam only: forget the held snapshot. */
export function forgetLoaded(): void {
  loadedSnapshot = null;
}

/** The lines a process adds to its RUNNING marker to say what it loaded. */
export function markerLines(s: Snapshot = loaded()): string {
  const build = s.stamp
    ? `build ${s.stamp.commit} ${s.stamp.dirty ? 'dirty' : 'clean'} ${s.stamp.built_at}\n`
    : '';
  return `loaded ${s.digest ?? 'unreadable'} ${s.dir}\n${build}`;
}

/** The other half: what a reader can recover from another process's marker. */
export function parseMarker(marker: string | null): Snapshot | null {
  const loadedLine = marker?.split('\n').find((l) => l.startsWith('loaded '));
  if (!loadedLine) return null; // a marker from before this was recorded
  const [, digest, ...dirParts] = loadedLine.split(' ');
  const build = marker?.split('\n').find((l) => l.startsWith('build '))?.split(' ');
  return {
    dir: dirParts.join(' '),
    digest: digest && digest !== 'unreadable' ? digest : null,
    stamp: build?.[1] && build[3]
      ? { commit: build[1], dirty: build[2] === 'dirty', built_at: build[3] }
      : null,
  };
}

export type RunningState = 'verified' | 'stale' | 'unstamped' | 'unverifiable';

export interface Running {
  state: RunningState;
  /** The commit of the bytes the process loaded — never the current artifact's. */
  commit: string | null;
  dirty: boolean;
  digest: string | null;
  detail: string;
}

/**
 * Is what a process loaded still what is on disk? `recorded` is that process's
 * load-time snapshot; `now` is the same directory read fresh. The commit
 * reported is always the recorded one: on divergence the artifact's sha
 * describes code nobody is executing, which is precisely the mistake H-2432
 * made, so it appears only as the thing the running build is NOT.
 */
export function compare(recorded: Snapshot | null, now: Snapshot): Running {
  if (!recorded) {
    return {
      state: 'unverifiable', commit: null, dirty: false, digest: null,
      detail: 'the process did not record what it loaded (it started before rev recorded that) — restart it to find out',
    };
  }
  const commit = recorded.stamp?.commit ?? null;
  const dirty = recorded.stamp?.dirty === true;
  const same = recorded.digest !== null && recorded.digest === now.digest;
  if (!same) {
    const changed = recorded.digest === null
      ? 'the code it loaded could not be read, so nothing can confirm what it is running'
      : now.digest === null
        ? `${now.dir} cannot be read now, so nothing can confirm it is still what was loaded`
        : `${now.dir} has changed since (now ${short(now.stamp?.commit) ?? 'unstamped'}/${now.digest}) — this process is not running what is there`;
    return { state: 'stale', commit, dirty, digest: recorded.digest, detail: changed };
  }
  if (!commit) {
    return {
      state: 'unstamped', commit: null, dirty: false, digest: recorded.digest,
      detail: `the code it loaded (${recorded.digest}) carries no build stamp, so no commit can be named for it`,
    };
  }
  return {
    state: 'verified', commit, dirty, digest: recorded.digest,
    detail: dirty
      ? 'loaded a dirty-tree build, so the commit does not certify these bytes'
      : 'is running the build on disk',
  };
}

function short(commit: string | null | undefined): string | null {
  return commit ? commit.slice(0, 7) : null;
}

/** The artifact line: what is in the code directory now, whoever is running it. */
export function buildLine(s: Snapshot = snapshot()): string {
  if (!s.stamp) {
    return `build:        unstamped (${s.dir}${s.digest ? `, ${s.digest}` : ''}) — built without npm run build, or running from source`;
  }
  return `build:        ${short(s.stamp.commit)}${s.stamp.dirty ? ' (dirty)' : ''} built ${s.stamp.built_at}`
    + `${s.digest ? ` — ${s.digest}` : ''}`;
}

/** The running line: what the named process actually loaded, or why we cannot say. */
export function runningLine(who: string, r: Running | null): string {
  if (!r) return `running:      — (${who} is not running)`;
  if (r.state === 'verified') return `running:      ${short(r.commit)}${r.dirty ? ' (dirty)' : ''} — ${who} ${r.detail}`;
  if (r.state === 'stale') {
    return `running:      ${r.commit ? `${short(r.commit)}${r.dirty ? ' (dirty)' : ''}` : 'unknown'} STALE — ${who}: ${r.detail}`;
  }
  return `running:      UNVERIFIABLE — ${who}: ${r.detail}`;
}

/** Machine-readable form for /health.json, same values as the lines above. */
export function buildReport(s: Snapshot): { dir: string; digest: string | null; commit: string | null; dirty: boolean; built_at: string | null } {
  return { dir: s.dir, digest: s.digest, commit: s.stamp?.commit ?? null, dirty: s.stamp?.dirty === true, built_at: s.stamp?.built_at ?? null };
}
