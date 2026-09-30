// Which installation of Helmo is this process? (H-2472)
//
// Helmo's four entry points — cli, MCP server, remote server, view — each
// resolved `HELMO_DB` on their own, and an installation had no name at all:
// the only thing that said which Helmo you were talking to was a database
// path, and nothing printed it back. That is the H-2431 shape at one remove.
// The act was right; the target was assumed.
//
// The identity is not a new registry. Rev is the supervisor that spawns every
// session and installs the services, and it already names an installation:
// `REV_LABEL`, derived from the resolved Rev home and written into the service
// environment (rev:src/service.ts, H-2452). Everything Rev starts inherits it,
// so a session's MCP server, the helmo-cli it shells out to and the dashboard
// installed beside them all answer with one name for free. `HELMO_LABEL`
// overrides it for a Helmo installed without Rev; failing both, the identity
// is derived from Helmo's own home by the same rule Rev uses for its own.
//
// H-2474 adds the discipline of naming it. Every entry point says which
// installation it is about — in the CLI's case inside the JSON, because its
// contract is that a caller can parse anything it prints — and
// `--installation <name|home|db>` ASSERTS that target rather than choosing it.
// A disagreement with the environment is refused before the store is opened
// (opening it migrates, H-134), naming both candidates: a flag that silently
// redirected, and an inherited value that silently beat an explicit one, are
// the same defect from two sides. `HELMO_HOME`/`HELMO_DB` move the target; the
// flag says you meant it.
//
// The single-install experience is unchanged: no variables set at all still
// means ~/.helmo/helmo.db, now under the name `dev.helmo`, and no flag to pass.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HelmoError } from './types.js';

/** Refused before any store is opened. */
export class InstallationError extends HelmoError {}

export type IdentitySource = 'HELMO_LABEL' | 'REV_LABEL' | 'derived';

export interface Installation {
  /** The installation's name — what a surface prints to say which Helmo it read. */
  label: string;
  /** Resolved installation home: the directory this installation's files live in. */
  home: string;
  /** Resolved store path. */
  db: string;
  /** Where `label` came from, so a surface can say so rather than implying a registry. */
  source: IdentitySource;
  release: string | null;
}

const LABEL_VARS: readonly IdentitySource[] = ['HELMO_LABEL', 'REV_LABEL'];

/**
 * Resolve this process's installation, or throw `InstallationError` if the
 * environment names two.
 *
 * `HELMO_HOME` names the installation; `HELMO_DB` names its store. Either one
 * alone determines the other — a bare `HELMO_DB` (how Rev's roster has always
 * pointed a fleet at its store) puts the home at the store's directory, which
 * is why no existing caller has anything new to set. Both set and disagreeing
 * is the refusal: one entry point would have honoured the home and another the
 * store, and the winner would be whichever line of whichever file you read.
 */
export function installation(env: NodeJS.ProcessEnv = process.env): Installation {
  const homeVar = env['HELMO_HOME']?.trim();
  const dbVar = env['HELMO_DB']?.trim();

  const home = homeVar ? resolve(homeVar) : dbVar ? dirname(resolve(dbVar)) : join(homedir(), '.helmo');
  const db = dbVar ? resolve(dbVar) : join(home, 'helmo.db');

  if (homeVar && dbVar && !within(home, db)) {
    throw new InstallationError(
      `HELMO_HOME and HELMO_DB name different installations — HELMO_HOME=${home} but HELMO_DB=${db}, `
      + `which is not inside it. Unset one: HELMO_HOME alone uses ${join(home, 'helmo.db')}, `
      + `HELMO_DB alone treats ${dirname(db)} as the installation home.`,
    );
  }

  // One lookup for both fields: a label and a source resolved separately can
  // disagree, and then the name a surface prints and the reason it gives for it
  // come from different rules.
  const named = LABEL_VARS.find((v) => env[v]?.trim());
  return {
    label: named ? (env[named] as string).trim() : derivedLabel(home),
    home,
    db,
    source: named ?? 'derived',
    release: selectedRelease('helmo', env),
  };
}

/**
 * For entry points: resolve and check the assertion, or report and exit before
 * opening anything.
 *
 * `report` exists because the CLI's contract is that every failure it prints is
 * one JSON object; the long-running surfaces print a line of prose. `requested`
 * is the `--installation` assertion, checked here rather than by each caller so
 * that no entry point can resolve a target and forget to verify it.
 */
export function requireInstallation(
  env: NodeJS.ProcessEnv = process.env,
  report: (message: string) => never = plainExit,
  requested?: string,
): Installation {
  try {
    const resolved = installation(env);
    const problem = mismatch(resolved, requested);
    if (problem) throw new InstallationError(problem);
    return resolved;
  } catch (e) {
    return report(e instanceof Error ? e.message : String(e));
  }
}

/**
 * `--installation` takes any of the three spellings an operator has in front of
 * them: the label a status line printed, the installation home, or the store
 * path a Rev roster points at. It asserts and cannot redirect — a value that
 * disagrees with the environment refuses the command rather than winning it.
 */
function mismatch(i: Installation, requested?: string): string | null {
  if (requested === undefined) return null;
  const want = requested.trim();
  if (!want) return '--installation was given no value (name the installation, or drop the flag).';
  if (want === i.label || resolve(want) === i.home || resolve(want) === i.db) return null;
  return `--installation named '${want}', but this process resolves installation '${i.label}' (home ${i.home}, store ${i.db}) `
    + 'from the environment. Nothing was opened or written. --installation asserts the target and cannot move it: '
    + 'point HELMO_HOME or HELMO_DB at the installation you meant.';
}

/**
 * The assertion as it arrives on an entry point's argv. The CLI reads it
 * through its own flag parser (which refuses an unknown flag before any write);
 * the long-running surfaces are started by a service definition and have no
 * parser, so they read it here.
 *
 * A bare `--installation` returns '' rather than undefined: a flag written with
 * no value must refuse, not read as never passed (H-1782).
 */
export function requestedInstallation(argv: readonly string[]): string | undefined {
  const i = argv.findIndex((a) => a === '--installation' || a.startsWith('--installation='));
  if (i === -1) return undefined;
  const arg = argv[i] as string;
  if (arg.startsWith('--installation=')) return arg.slice('--installation='.length);
  const next = argv[i + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
}

/** The phrase a prose surface prints to say which installation it served. */
export function installationLine(i: Installation): string {
  return `install: ${i.label} (${i.home}) — db: ${i.db}${i.release ? ` — release: ${i.release}` : ''}`;
}

/** The same answer as a field, for a surface whose output is parsed. */
export function installationRef(i: Installation): Pick<Installation, 'label' | 'home' | 'db' | 'source'> & { release?: string } {
  return { label: i.label, home: i.home, db: i.db, source: i.source, ...(i.release ? { release: i.release } : {}) };
}

function selectedRelease(product: 'rev' | 'helmo' | 'helmo-roadmap', env: NodeJS.ProcessEnv): string | null {
  const named = env['INSTALLATION_RELEASE']?.trim();
  if (!named) return null;
  const selectionFile = resolve(named);
  try {
    const selection = JSON.parse(readFileSync(selectionFile, 'utf8')) as { release?: string; directory?: string; components?: Record<string, { release?: string; commit?: string }> };
    if (!selection.release || !selection.directory) throw new Error('selection lacks release or directory');
    const releaseDir = resolve(dirname(selectionFile), selection.directory);
    const manifest = JSON.parse(readFileSync(join(releaseDir, 'RELEASE.json'), 'utf8')) as { commits?: Record<string, string> };
    for (const repo of ['rev', 'helmo', 'helmo-roadmap']) {
      const component = selection.components?.[repo];
      if (!component || component.release !== selection.release || component.commit !== manifest.commits?.[repo]) throw new Error(`${repo} does not match selected release ${selection.release}`);
    }
    const runningRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    if (realpathSync(runningRoot) !== realpathSync(resolve(releaseDir, product))) throw new Error(`${product} is running from ${runningRoot}, not ${join(releaseDir, product)}`);
    return selection.release;
  } catch (e) {
    throw new InstallationError(`incoherent release set: ${product}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function plainExit(message: string): never {
  console.error(message);
  process.exit(1);
}

// The same rule as rev's `serviceLabel()`, on Helmo's own prefix: a direct
// child of the ACCOUNT's home called `.helmo` or `.helmo-<suffix>` keeps the
// readable name its siblings guarantee is unique, and anywhere else the label
// carries a digest of the resolved path — because two installations can have
// homes with the same basename (/tmp/customer-a/.helmo and
// /tmp/customer-b/.helmo), which is what made one label cover many installs.
//
// The account's home comes from the password database, not from `$HOME`: a
// service manager hands a daemon an environment the software under test can
// itself have written, so an identity keyed on `$HOME` is keyed on something a
// second installation can set. `$HOME` still decides where the default home IS
// — that is `installation()` above, and it must stay that way.
function derivedLabel(home: string): string {
  const suffix = labelSuffix(basename(home));
  if (dirname(home) === accountHome() && /^\.helmo([-_.]|$)/.test(basename(home))) {
    return suffix ? `dev.helmo.${suffix}` : 'dev.helmo';
  }
  const descriptive = suffix || labelSuffix(basename(dirname(home)));
  return `dev.helmo.${descriptive ? `${descriptive}.` : ''}${homeDigest(home)}`;
}

function labelSuffix(name: string): string {
  return name
    .replace(/^\.?helmo(?=[-_.]|$)/, '')
    .replace(/^[-_.]+/, '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function accountHome(): string {
  try {
    return resolve(userInfo().homedir);
  } catch {
    // No password entry (some containers). $HOME is then all there is, and a
    // wrong answer here only means a home gets a digest it did not need.
    return resolve(homedir());
  }
}

// Eight hex characters of the resolved path: long enough that two installs on
// one machine will not collide, short enough to read back off a label. Not
// `realpath`ed, so a home reached through a symlink is a second identity —
// HELMO_LABEL is the override when that is not what you meant.
function homeDigest(home: string): string {
  return createHash('sha256').update(home).digest('hex').slice(0, 8);
}

function within(home: string, path: string): boolean {
  return path === home || path.startsWith(home.endsWith(sep) ? home : home + sep);
}
