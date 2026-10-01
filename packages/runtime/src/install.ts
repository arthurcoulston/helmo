// Which installation is this command about? (H-2473)
//
// H-2452 gave an installation an identity — `serviceLabel()`, bound to the
// resolved Rev home and exported as REV_LABEL into the service environment —
// and H-2472 taught Helmo and the roadmap to read that same name. What was
// still missing is the discipline of naming it: every command's target came
// from whatever REV_HOME/REV_LABEL happened to be in the ambient environment,
// and nothing printed it back. That is the H-2431 shape at one remove — the
// act was right, and the target was assumed.
//
// Two behaviours, both required by the Target selection row of
// crew:projects/estate/specs/h2435-independent-installs.md:
//
//   Say it.    A command's output names the installation it read or wrote.
//   Refuse it. A command stops BEFORE doing anything when the target it was
//              given disagrees with the one the environment resolves, naming
//              both. Every command, not only the ones that write: a read is
//              where a script puts the assertion (H-2526).
//
// The refusal is never a precedence rule. `--installation` cannot redirect a
// command to another installation: it ASSERTS which one this is, and a
// disagreement is an error rather than a winner, because an inherited value
// quietly beating an explicit one is the case that must be impossible.
//
// Single-install use is untouched: one installation, no flags, and the only
// difference is a line saying which one.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectedRelease as selectedCoreRelease } from '@helmo/core/release';
import { revHome } from './config.js';
import { definedHome, serviceFile, serviceLabel } from './service.js';

export interface Target {
  /** The installation's name — what a surface prints to say which Rev it is. */
  label: string;
  /** Resolved Rev home: where this installation's roster and state live. */
  home: string;
  /** Set when the environment cannot be trusted to name one installation. */
  conflict: string | null;
  /** Immutable release selected for this installation, when pinned. */
  release: string | null;
}

/**
 * `release: 'unchecked'` skips the pinned-release verification, and only
 * `rev release` uses it: those commands are how a broken selection is
 * repaired, so gating them on the selection being sound would make the repair
 * unreachable (H-2493). They report the selection's state themselves.
 */
export function target(release: 'verify' | 'unchecked' = 'verify'): Target {
  const home = resolve(revHome());
  return {
    label: serviceLabel(),
    home,
    conflict: inheritedConflict(home),
    release: release === 'verify' ? selectedRelease('rev') : null,
  };
}

/**
 * The label alone cannot say which installation it belongs to: REV_LABEL is a
 * string any process can set, and every session Rev spawns inherits the
 * supervisor's copy of it. The service definition installed under that label
 * can say, because it carries the REV_HOME it was installed for (H-2452). A
 * label whose definition names another home is one this command inherited from
 * an installation it is not operating — `assertOwnService`'s question, asked
 * for every mutation rather than only for the `service` verbs.
 */
function inheritedConflict(home: string): string | null {
  const { kind, file } = serviceFile();
  if (!existsSync(file)) return null;
  const owner = definedHome(kind, readFileSync(file, 'utf8'));
  if (!owner || resolve(owner) === home) return null;
  return `the environment names installation '${serviceLabel()}', whose service definition ${file} belongs to ${resolve(owner)}, `
    + `but this command resolves ${home}. Unset REV_LABEL to take the name this home derives, `
    + `or set REV_HOME to the installation you meant`;
}

/** The line every command prints to say which installation it is about. */
export function targetLine(t: Target = target()): string {
  return t.conflict ? `installation: UNCLEAR — ${t.conflict}` : `installation: ${t.label} (${t.home})${t.release ? ` — release: ${t.release}` : ''}`;
}

function selectedRelease(product: 'rev' | 'helmo' | 'helmo-roadmap'): string | null {
  try {
    return selectedCoreRelease(product, dirname(dirname(fileURLToPath(import.meta.url))));
  } catch (e) {
    throw new Error(`incoherent release set: ${product}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The `--installation` assertion, made once at the door for EVERY command —
 * reads included (H-2526).
 *
 * It used to be a parameter of `requireTarget`, which only mutations call, so
 * `rev status --installation <wrong>` exited 0 and printed its normal output.
 * That is the surface a consumer scripts an assertion ON: a check of which
 * installation this is, made before doing something else. Silence there is the
 * worst of the three possible answers, and it made "the three products behave
 * the same" false in the one direction that misleads — Helmo and the roadmap
 * refuse on every entry point.
 *
 * Asserting identity is not the same as verifying the release selection, so
 * this reads the target `unchecked` and the two exempt families (`release`,
 * `install`) stay reachable on a broken selection while still being held to
 * the name they were given.
 */
export function assertInstallation(command: string, requested?: string): void {
  const problem = mismatch(target('unchecked'), requested);
  if (problem) {
    console.error(`refusing to run '${command}': ${problem}.`);
    process.exit(1);
  }
}

/**
 * The gate a mutating command passes before it writes anything. Prints the
 * refusal and exits 1, so nothing downstream has to remember to check. The
 * `--installation` disagreement is already gone by here (`assertInstallation`,
 * at the door); what remains is the inherited-label conflict, which reads are
 * deliberately allowed through with an UNCLEAR line rather than refused.
 */
export function requireTarget(action: string, release: 'verify' | 'unchecked' = 'verify'): Target {
  const t = target(release);
  if (t.conflict) {
    console.error(`refusing to ${action}: ${t.conflict}.`);
    process.exit(1);
  }
  return t;
}

/**
 * `--installation` takes either spelling of an installation, because those are
 * the two an operator has in front of them: the label a status line printed,
 * or the home path a roster or plist points at. Both are given as
 * `--installation <value>` or `--installation=<value>`; the CLI accepts either,
 * as Helmo and the roadmap do.
 */
function mismatch(t: Target, requested?: string): string | null {
  if (requested === undefined) return null;
  const want = requested.trim();
  if (!want) return '--installation was given no value (name the installation, or drop the flag)';
  if (want === t.label || resolve(want) === t.home) return null;
  return `--installation named '${want}', but this command resolves installation '${t.label}' (${t.home}) `
    + 'from the environment. Nothing was written. Point REV_HOME at the installation you meant';
}
