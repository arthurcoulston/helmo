// What build is this process RUNNING? (H-2490)
//
// H-2474 taught every Helmo surface to say WHICH installation it is talking
// about. The Human and agent visibility row of
// crew:projects/estate/specs/h2435-independent-installs.md asks the second
// half: which VERSION of Helmo is that installation actually running. A
// surface that answers it from the artifact on disk answers it wrongly the
// moment anybody rebuilds —
//
//   H-2432, 2026-09-30. The sync deployment receipt named commit c111bf5
//   while dist/store.js beside it had been rebuilt at 06:40:49 UTC and
//   imported a projection that commit did not contain. Nothing lied; a record
//   simply cannot vouch for a process. The dashboard serving that store had
//   been up since the previous evening and would have reported the new sha.
//
// So a surface never reports the configured or on-disk ref as what is
// running. It reports what it recorded when IT loaded, and where that cannot
// be established it says so. STALE and UNVERIFIABLE are answers; a confident
// wrong sha is not.
//
// WHAT DOES NOT PORT FROM REV. rev:src/build.ts puts the load-time reading in
// the RUNNING marker, because `rev status` is one process answering for
// another and needs somewhere to read it from. Helmo has no supervisor and no
// marker: every Helmo surface answers for ITSELF — the view renders its own
// footer, the CLI prints its own result, each MCP server names its own
// startup — so the reading lives in this module's memory for the lifetime of
// the process, which is exactly the lifetime of the bytes it loaded.
//
// WHAT IS COMPARED IS BYTES, NOT THE SHA. A dirty tree compiles to a stamp
// whose commit did not produce the artifact (scripts/stamp-build.mjs records
// that rather than refusing), and two rebuilds of one commit differ. So the
// identity of "what I loaded" is a digest over the JavaScript in the
// directory this module was loaded from. Its limit, stated plainly: it is the
// bytes on disk when the snapshot was taken, which for a statically imported
// ESM graph is load time, and it does not follow a module imported
// dynamically much later.
//
// Everything is per-directory, because two installations of Helmo on one
// machine run from two checkouts (H-2435) and the directory the process ran
// from is the only thing that tells them apart.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Written by scripts/stamp-build.mjs as npm `postbuild`. Named here too
 *  because a reader must work from the artifact alone — dist can be copied
 *  somewhere the build scripts are not. */
const STAMP = 'BUILD.json';

/** The stamp as a reader needs it. `repo` is deliberately dropped from what
 *  stamp-build.mjs records: where the code is living is `Snapshot.dir`, which
 *  is the honest answer for an artifact that was copied. */
export interface Stamp {
  commit: string;
  dirty: boolean;
  built_at: string;
}

export interface Snapshot {
  /** The directory the code ran from — dist, or src under `tsx`. */
  dir: string;
  /** Identity of the JavaScript there; null when there is none to read. */
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
 * files change on a rebuild without changing a byte any process executes, and
 * a digest that moved for them would report divergence where there is none.
 * The stamp is excluded for the same reason stamp-build's freshness check
 * excludes it — it describes the rest, so it can never be part of what it
 * describes.
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
 * ones that replaced them. Long-lived entry points call it at startup so the
 * held value is a load-time reading and not whatever the first request
 * happened to find.
 */
export function loaded(): Snapshot {
  return (loadedSnapshot ??= snapshot());
}

/** Test seam only: forget the held snapshot. */
export function forgetLoaded(): void {
  loadedSnapshot = null;
}

export type RunningState = 'verified' | 'stale' | 'unstamped' | 'unverifiable';

export interface Running {
  state: RunningState;
  /** The commit of the bytes the process loaded — never the current artifact's. */
  commit: string | null;
  dirty: boolean;
  digest: string | null;
  dir: string;
  detail: string;
}

/**
 * Is what a process loaded still what is on disk? `recorded` is its load-time
 * snapshot; `now` is the same directory read fresh. The commit reported is
 * always the recorded one: on divergence the artifact's sha describes code
 * nobody is executing, which is precisely the mistake H-2432 made, so it
 * appears only as the thing the running build is NOT.
 */
export function compare(recorded: Snapshot | null, now: Snapshot): Running {
  if (!recorded) {
    return {
      state: 'unverifiable', commit: null, dirty: false, digest: null, dir: now.dir,
      detail: 'this process did not record what it loaded — restart it to find out',
    };
  }
  const commit = recorded.stamp?.commit ?? null;
  const dirty = recorded.stamp?.dirty === true;
  if (recorded.digest === null) {
    // No JavaScript was there to digest. Running from source under tsx is the
    // ordinary case, and the honest answer for it is not "stale" — nothing has
    // changed — but that nothing can confirm what these bytes are.
    return {
      state: 'unverifiable', commit, dirty, digest: null, dir: recorded.dir,
      detail: `no compiled JavaScript could be read in ${recorded.dir}, so nothing can confirm what this process is running`
        + ' (a source run under tsx looks exactly like this)',
    };
  }
  if (recorded.digest !== now.digest) {
    return {
      state: 'stale', commit, dirty, digest: recorded.digest, dir: recorded.dir,
      detail: now.digest === null
        ? `${now.dir} cannot be read now, so nothing can confirm it is still what was loaded`
        : `${now.dir} has changed since (now ${short(now.stamp?.commit) ?? 'unstamped'}/${now.digest}) — this process is not running what is there`,
    };
  }
  if (!commit) {
    return {
      state: 'unstamped', commit: null, dirty: false, digest: recorded.digest, dir: recorded.dir,
      detail: `the code it loaded (${recorded.digest}) carries no build stamp, so no commit can be named for it`,
    };
  }
  return {
    state: 'verified', commit, dirty, digest: recorded.digest, dir: recorded.dir,
    detail: dirty
      ? 'running a dirty-tree build, so the commit does not certify these bytes'
      : 'running the build on disk',
  };
}

/**
 * What this process is running, read fresh against what it loaded. Called per
 * render and per result rather than once: the whole point is that the
 * directory can change underneath a process that is still serving.
 */
export function running(): Running {
  const recorded = loaded();
  return compare(recorded, snapshot(recorded.dir));
}

/** The phrase a prose surface prints. Deliberately short — it sits on the end
 *  of a startup line an operator scans, and the detail is one command away. */
export function runningLine(r: Running = running()): string {
  if (r.state === 'verified') return `running: ${short(r.commit)}${r.dirty ? ' (dirty)' : ''}`;
  if (r.state === 'stale') return `running: ${r.commit ? `${short(r.commit)}${r.dirty ? ' (dirty)' : ''} ` : ''}STALE — ${r.detail}`;
  return `running: ${r.state === 'unstamped' ? 'UNSTAMPED' : 'UNVERIFIABLE'} — ${r.detail}`;
}

/** The same answer as a field, for a surface whose output is parsed. `commit`
 *  is absent rather than null when there is none to name, so a caller cannot
 *  read a missing commit as an empty one. */
export function runningRef(r: Running = running()): {
  state: RunningState; dir: string; digest: string | null; commit?: string; dirty?: boolean; detail: string;
} {
  return {
    state: r.state, dir: r.dir, digest: r.digest,
    ...(r.commit ? { commit: r.commit, dirty: r.dirty } : {}),
    detail: r.detail,
  };
}

function short(commit: string | null | undefined): string | null {
  return commit ? commit.slice(0, 7) : null;
}
