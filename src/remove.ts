// Removing an installation's data (H-2512).
//
// Every other removal this product has keeps the data. `rev service uninstall`
// takes the service definition and leaves the store, the controls and the
// selection byte-for-byte where they were — which is right, and which left the
// independent-installations contract with a line nothing could satisfy: the
// spec asks a release to prove that "uninstall of A, deleting only A's data,
// leaves B's store and controls untouched", and the only removal an operator
// had was `rm -rf` in a shell. A hand `rm -rf` carrying the other
// installation's REV_HOME is the H-2431 shape exactly, and no product refusal
// stood between it and the wrong store.
//
// So this is the one product operation with no undo, and it is built like it:
//
//   Named.     `requireTarget` first, so the installation is asserted and a
//              disagreeing environment is refused before anything is read.
//   Ordered.   A live supervisor or an installed service definition blocks it.
//              A removal under a supervisor that is still running is a half
//              removal, and a definition naming a home that no longer exists is
//              a job a service manager keeps trying to bring back.
//   Bounded.   Nothing outside the installation's own home goes, whatever the
//              environment says. A store path pointing into a sibling
//              installation is reported as left alone, never followed.
//   Spoken.    The plan is printed before anything is deleted, and `--confirm`
//              is a separate act. Without it this command writes nothing.
//
// It is deliberately NOT a flag on `rev service uninstall`: the two removals
// have to stay distinguishable at the command line rather than by a word
// someone can miss.
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { revHome } from './config.js';
import { GlobalConfig } from './types.js';
import { occupiedPid } from './sentinels.js';
import { serviceFile } from './service.js';

/** One path the removal has an opinion about, and what it is in plain terms. */
export interface Item {
  path: string;
  what: string;
  /** Set when this path is named by the installation but is not ours to take. */
  why?: string;
}

export interface Removal {
  /** The installation this removal is about, as every other surface names it. */
  label: string;
  /** Its home: the directory Rev's own home sits in, and the boundary. */
  home: string;
  taking: Item[];
  leaving: Item[];
  /** Why this cannot run at all, with the command that clears it. */
  blocked: string | null;
}

/** Is `path` inside `root` (or `root` itself)? Compared on resolved paths, and
 *  anchored with a separator so `/a/bc` is never inside `/a/b`. */
function within(root: string, path: string): boolean {
  const [r, p] = [resolve(root), resolve(path)];
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** A SQLite store is three files. Removing the database and leaving its
 *  write-ahead log behind is not removing the records. */
function storeFiles(db: string): string[] {
  return [db, `${db}-wal`, `${db}-shm`].filter((f) => existsSync(f));
}

/**
 * What a removal of this installation would take, and what it would not.
 *
 * `label` is passed in rather than derived here so that the caller prints and
 * acts on ONE resolved target — `requireTarget` has already refused a shell
 * that names two, and re-deriving the name behind that check is how the printed
 * installation and the deleted one come to differ.
 */
export function removalPlan(
  label: string,
  g: Pick<GlobalConfig, 'helmo_db'>,
  env: NodeJS.ProcessEnv = process.env,
): Removal {
  const rev = resolve(revHome());
  const home = dirname(rev);
  const plan: Removal = { label, home, taking: [], leaving: [], blocked: null };

  /**
   * Is a path the installation names ours to take? Answered BEFORE the file is
   * looked for, because the two are different questions: whether a path belongs
   * to this installation is a fact about the path, and it has to be reported
   * even when nothing is there yet. A shell aimed at a neighbour whose store has
   * never been opened is the same misaiming as one aimed at a neighbour with a
   * year of records in it, and the operator should see it either way.
   */
  const ours = (path: string, what: string): boolean => {
    if (within(home, path)) return true;
    plan.leaving.push({ path, what, why: `it is outside installation ${label}'s home ${home}, so it is not this installation's to remove` });
    return false;
  };

  /** One product's store, named the way that product resolves its own — with the
   *  SQLite sidecars beside it, since a database without its write-ahead log is
   *  not the records. */
  const store = (db: string | undefined, what: string, unnamed: { path: string; why: string }) => {
    if (!db) return void plan.leaving.push({ path: unnamed.path, what, why: unnamed.why });
    const p = resolve(db);
    if (!ours(p, what)) return;
    for (const f of storeFiles(p)) plan.taking.push({ path: f, what });
  };

  plan.taking.push({ path: rev, what: "this installation's controls, roster, state and service launcher" });

  // The stores, each named the way the product that owns it resolves its own:
  // Helmo's from the roster this installation loaded, falling back to the
  // variable its entry points read; the roadmap's from its own variables, since
  // Rev's roster has never named it. A store this installation does not name at
  // all is reported below rather than guessed at.
  store(g.helmo_db?.trim() || env['HELMO_DB']?.trim(), "this installation's Helmo records", {
    path: join(homedir(), '.helmo', 'helmo.db'),
    why: 'this installation names no Helmo store, so the default is the shared one and cannot be assumed to be its',
  });

  const roadmapHome = env['ROADMAP_HOME']?.trim();
  store(env['ROADMAP_DB']?.trim() || (roadmapHome ? join(resolve(roadmapHome), 'roadmap.db') : undefined), "this installation's roadmap records", {
    path: join(homedir(), '.helmo-roadmap', 'roadmap.db'),
    why: 'this installation names no roadmap store (ROADMAP_DB/ROADMAP_HOME are unset), so the default is the shared one and cannot be assumed to be its',
  });

  const selection = env['INSTALLATION_RELEASE']?.trim();
  const what = "this installation's release selection";
  if (selection && ours(resolve(selection), what) && existsSync(resolve(selection))) {
    plan.taking.push({ path: resolve(selection), what });
  }

  plan.blocked = blockage(plan, rev);
  return plan;
}

/**
 * The preconditions, in the order an operator meets them. Each names the exact
 * command that clears it, because a refusal that does not is a dead end and the
 * way around a dead end here is a hand `rm -rf`.
 */
function blockage(plan: Removal, rev: string): string | null {
  // A home whose removal would take the account's own home directory with it is
  // never what anyone meant, whatever REV_HOME says.
  const account = resolve(homedir());
  if (within(rev, account)) {
    return `refusing outright: REV_HOME resolves ${rev}, which contains this account's home directory ${account}. `
      + 'Nothing here is removable — point REV_HOME at the installation you meant.';
  }

  const { file } = serviceFile();
  if (existsSync(file)) {
    return `installation ${plan.label} still has a service definition at ${file}, so a service manager would keep bringing back a supervisor whose home this removes. `
      + 'Take it first with: rev service uninstall  (that stops the job and keeps every record; this command is the one that deletes them).';
  }

  // Only when there is a home to read it in. `occupiedPid` reads the marker
  // through `stateDir`, which CREATES the directory it looks in — so asking this
  // of an installation already removed rebuilt its Rev home, and the next plan
  // had something to take again. A removed installation has no supervisor.
  const pid = existsSync(rev) ? occupiedPid('supervisor') : null;
  if (pid) {
    return `installation ${plan.label}'s supervisor is running (pid ${pid}), and a removal under a live supervisor is a half removal: `
      + 'it writes state back into a home being deleted. Drain it first with: rev stop';
  }
  return null;
}

/** The lines that say what this would take, printed before anything goes. */
export function planLines(plan: Removal): string[] {
  const lines = [`installation ${plan.label} — removing every record it names inside ${plan.home}:`];
  for (const i of plan.taking) lines.push(`  ${i.path}  — ${i.what}`);
  if (plan.leaving.length) {
    lines.push('Left in place:');
    for (const i of plan.leaving) lines.push(`  ${i.path}  — ${i.what}: ${i.why}`);
  }
  return lines;
}

/** Delete the planned paths. Returns what actually went, in plan order. */
export function removeInstallation(plan: Removal): string[] {
  if (plan.blocked) throw new Error(plan.blocked);
  const gone: string[] = [];
  for (const i of plan.taking) {
    if (!existsSync(i.path)) continue;
    rmSync(i.path, { recursive: true, force: true });
    gone.push(i.path);
  }
  return gone;
}
