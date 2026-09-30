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
// The single-install experience is unchanged: no variables set at all still
// means ~/.helmo/helmo.db, now under the name `dev.helmo`.
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
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
  };
}

/**
 * For entry points: resolve, or report and exit before opening anything.
 *
 * `report` exists because the CLI's contract is that every failure it prints is
 * one JSON object; the long-running surfaces print a line of prose.
 */
export function requireInstallation(
  env: NodeJS.ProcessEnv = process.env,
  report: (message: string) => never = plainExit,
): Installation {
  try {
    return installation(env);
  } catch (e) {
    return report(e instanceof Error ? e.message : String(e));
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
