// A release write must say what it is for (H-3376).
//
// `rev release upgrade|rollback|activate` moves the code an installation will
// run next. On 2026-10-21 two stray words inside a doctrine sentence became
// shell command substitutions in an autonomous loop iteration, and
// `rev release rollback` ran twice against the live selection (H-3374). The
// harness guard that closed that quoting hole is config a session can be
// launched without; this is the product's own layer, and it asks the one
// question the accident could never answer: WHY.
//
// An attended run answers it by being attended — someone typed it and is
// reading the output. Every other run must name a ticket. "Attended" is
// measured twice, because either measurement alone is wrong:
//
//   stdin is a terminal — the only thing that separates a person at a prompt
//     from a spawned child. Every harness tool call, script and launchd job
//     is handed a pipe.
//   REV_LOOP is unset — a supervised loop session is unattended BY
//     DEFINITION whatever its stdio is, and a loop is the population the
//     incident came from. It is also not settable from a prompt: the shim
//     writes it into the session environment (src/shim.ts).
//
// This refuses the accident and the unnamed act; it is not a fence against an
// adversary, because a session with shell access can clear REV_LOOP or
// allocate a pty. Both of those are deliberate and name themselves in a
// transcript, which is the whole point — what happened here was named nowhere.
//
// The ticket is checked for SHAPE and nothing else. Verifying it against a
// store would put the repair behind the fault (H-2493): these three verbs are
// the only way out of a broken selection, so the gate has to hold when every
// other thing in the installation is down.
import { commandName } from './command-name.js';

/**
 * The verbs that move the selection; `status` reads and is untouched.
 *
 * One list, read by both the dispatch in cli.ts and the guard below, so a
 * verb added later cannot be dispatched without being gated. The guard it
 * replaces lived as an argument each handler passed, and held only on the
 * handlers whose author remembered (H-2526).
 */
export const RELEASE_WRITE_VERBS = ['upgrade', 'rollback', 'activate'] as const;

export type ReleaseWriteVerb = (typeof RELEASE_WRITE_VERBS)[number];

export const isReleaseWriteVerb = (verb: string): verb is ReleaseWriteVerb =>
  (RELEASE_WRITE_VERBS as readonly string[]).includes(verb);

/** `H-1234`, or `H-1234@dev.rev` naming the installation it was filed in. */
const TICKET = /^[A-Z][A-Z0-9]*-\d+(@[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

export interface IntentRun {
  verb: string;
  /** `--ticket`'s value: undefined when absent, '' when given last with
   *  nothing after it — refused rather than guessed at, as takeFlag's other
   *  callers do. */
  ticket: string | undefined;
  /** Whether stdin is a terminal, measured by the caller. */
  tty: boolean;
  env: NodeJS.ProcessEnv;
}

/**
 * Why this run counts as unattended, in words a refusal can use, or null when
 * someone is there.
 */
function unattendedBecause(run: IntentRun): string | null {
  const loop = run.env['REV_LOOP']?.trim();
  if (loop) return `REV_LOOP names the loop session '${loop}', which runs with nobody reading its output`;
  if (!run.tty) return 'stdin is not a terminal, so nothing is reading this';
  return null;
}

/**
 * The refusal this run has earned, or null when it may proceed.
 *
 * A malformed `--ticket` is refused even from a terminal: a flag spelling that
 * is absorbed rather than refused is how an assertion goes silent.
 */
export function intentRefusal(run: IntentRun, command: string = commandName): string | null {
  if (!isReleaseWriteVerb(run.verb)) return null;
  const how = `${command} release ${run.verb}${run.verb === 'upgrade' ? ' <release directory>' : ''} --ticket <id>`;
  if (run.ticket !== undefined) {
    if (run.ticket.trim() === '') {
      return `Refusing to ${run.verb}: --ticket was given with no value.\n  Name the ticket this is for:  ${how}`;
    }
    if (!TICKET.test(run.ticket.trim())) {
      return `Refusing to ${run.verb}: --ticket '${run.ticket}' is not a ticket id — expected H-1234, `
        + `or H-1234@dev.rev to name the installation it was filed in.\n  ${how}`;
    }
    return null;
  }
  const because = unattendedBecause(run);
  if (!because) return null;
  return `Refusing to ${run.verb}: this run names no intent, and ${because}.\n`
    + `  '${command} release ${run.verb}' writes the selection this installation runs next — a live change on the serving `
    + `host, carrying every credential this session holds.\n`
    + `  Say what it is for and run it again:\n    ${how}\n`
    + `  The id's shape is the whole requirement; it is checked against no store, so this still works while the `
    + `installation is broken.`;
}
