// The R-46 vocabulary migration: every row's stored status word rewritten to
// the reading it always had (R46-ROADMAP-CLARITY.md, counted 2026-10-20).
//
// It is a rename, not a re-decision. Nothing here judges whether an
// initiative should ship, and nothing rewrites an event: the plan reads each
// row's own history, says in one sentence why its word maps where it does,
// and writes that sentence into the `updated` event it appends. A reader who
// disagrees with a row can see which rule produced it and redline that row.
import { Readiness, Status, StoredStatus } from './types.js';

/** What the migration decides about one row. `readiness` is written only
 *  where the field is a reading — Proposed, Paused, and the authorized rows
 *  whose gate required it — because readiness is the refinement of an idea,
 *  not a property of something already delivered. */
export interface R46Decision {
  id: string;
  title: string;
  from: StoredStatus;
  status: Status;
  readiness?: Readiness;
  archive: boolean;
  reason: string;
}

/** A row the migration will not touch, and why a human has to look. */
export interface R46Undecided {
  id: string;
  title: string;
  reason: string;
}

export interface R46Plan {
  decisions: R46Decision[];
  /** Rows already carrying a new-vocabulary word: a second run writes nothing. */
  already: string[];
  undecided: R46Undecided[];
  /** Every stored word seen, with how many rows of it go where — the
   *  denominator for each line of the report. */
  counts: { from: StoredStatus; to: string; rows: number }[];
  total: number;
  applied: boolean;
}

/** What the planner needs to know about a row. `ever_authorized` is the one
 *  historical fact the status word cannot carry: whether this initiative's
 *  history holds the human's go. It separates an idea nobody started from a
 *  delivery deliberately stood down, and both are stored as `parked`. */
export interface R46Facts {
  id: string;
  title: string;
  status: StoredStatus;
  readiness: Readiness;
  archived: boolean;
  ever_authorized: boolean;
}

/** The three shelved rows are the migration's only judgment calls, decided
 *  in R46-ROADMAP-CLARITY.md against each row's own history and record. An
 *  archived row not named here is reported for a human call rather than
 *  guessed: its stored word still reads as Canceled on every surface until
 *  someone decides what became of it, so leaving it costs nothing. */
export const R46_SHELVED: Readonly<Record<string, { status: Status; reason: string }>> = {
  'R-39': { status: 'Completed', reason: 'delivered through its successor initiatives' },
  'R-4': { status: 'Canceled', reason: 'superseded by R-47, with no remaining deliverable' },
  'R-18': { status: 'Canceled', reason: "closed on Arthur's instruction; its own body records that no outcome was supplied" },
};

const NEW_VOCABULARY = new Set<string>(['Proposed', 'Planned', 'Active', 'Monitoring', 'Completed', 'Paused', 'Canceled']);

function decide(f: R46Facts): R46Decision | R46Undecided {
  // A row refined by hand, or one the human once authorized, is shaped: the
  // go gate required `ready` before readiness was a field, so a recorded go
  // is itself the evidence. Everything else is a raw idea until reviewed.
  const shaped: Readiness =
    f.readiness === 'shaped' || f.status === 'shaping' || f.status === 'ready' || f.ever_authorized ? 'shaped' : 'raw idea';
  const row = (status: Status, reason: string, readiness?: Readiness): R46Decision => ({
    id: f.id, title: f.title, from: f.status, status, readiness, archive: false, reason,
  });

  switch (f.status) {
    case 'parked':
      return f.ever_authorized
        ? row('Paused', 'the go is on the record and the delivery was stood down — a pause, not an idea', shaped)
        : row('Proposed', 'no go on the record: an idea on The List, never authorized', shaped);
    case 'shaping':
    case 'ready':
      return row('Proposed', 'described and refined, never authorized — refinement is the readiness field now, not a status', shaped);
    case 'ship_next':
    case 'shipping':
      // ship_next is the word R-46 names first: it said both "the human
      // declared go" and "work is underway". Only the work store can tell
      // the two apart, and the stores do not read each other (R-47 C1), so
      // the migration writes the reading the word already had and says so.
      // Readiness IS written here, unlike the delivered rows below, and it is
      // the word itself that writes it: `ship_next` was reachable only through
      // the go gate, which required `ready`. An Active row reading "raw idea"
      // — the column's stored default — therefore contradicts the gate that
      // put it there, and is a state the live store can no longer produce. On
      // a delivered row readiness is simply not a reading and the default says
      // nothing; on this one it would say something false.
      return row('Active', 'the go is on the record and work was in flight at the rename; a go with nothing underway is Planned, which only the work store can tell apart', 'shaped');
    case 'shipped_watching':
    case 'shipped':
      return row('Monitoring', 'delivered and being watched');
    case 'shipped_stable':
      return row('Completed', 'the outcome was verified');
    case 'abandoned':
      return row('Canceled', 'abandoned before shipping');
    case 'archived': {
      const call = R46_SHELVED[f.id];
      if (!call) {
        return {
          id: f.id, title: f.title,
          reason: 'archived with no recorded judgment — say whether it was Completed or Canceled, then archive it again to hide the row',
        };
      }
      return { ...row(call.status, call.reason), archive: true };
    }
    default:
      return { id: f.id, title: f.title, reason: `stored status "${f.status}" is not a word this migration knows` };
  }
}

/** Read every row's stored word and produce the per-row plan. Pure: the
 *  caller writes nothing until it chooses to. */
export function planR46(facts: R46Facts[]): R46Plan {
  const decisions: R46Decision[] = [];
  const already: string[] = [];
  const undecided: R46Undecided[] = [];
  const tally = new Map<string, number>();

  for (const f of facts) {
    if (NEW_VOCABULARY.has(f.status)) {
      already.push(f.id);
      continue;
    }
    const outcome = decide(f);
    if ('status' in outcome) {
      decisions.push(outcome);
      const key = `${f.status}\u0000${outcome.status}${outcome.archive ? ' + hidden' : ''}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    } else {
      undecided.push(outcome);
      const key = `${f.status}\u0000awaiting a human call`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }

  const counts = [...tally.entries()]
    .map(([key, rows]) => {
      const [from, to] = key.split('\u0000') as [StoredStatus, string];
      return { from, to, rows };
    })
    .sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));

  return { decisions, already, undecided, counts, total: facts.length, applied: false };
}

/** The per-row report Arthur reads and redlines. Every count states its
 *  denominator in the same sentence, like every other R-46 reading. */
export function formatR46Plan(plan: R46Plan): string {
  const lines: string[] = [];
  // Nothing to migrate is the expected state of a store that has already run
  // the one-shot, so it says that and nothing else — a report full of
  // denominators with no rows under them reads like a failure.
  if (!plan.decisions.length) {
    lines.push(`R-46 vocabulary migration — nothing to migrate: ${plan.already.length} of ${plan.total} rows already carry a word from the seven.`);
    if (plan.undecided.length) {
      lines.push('', '  Still awaiting a human call — reading as Canceled until someone decides:');
      for (const u of plan.undecided) lines.push(`  ${u.id.padEnd(6)} ${u.reason}`);
    }
    return lines.join('\n');
  }

  const headline = plan.applied
    ? `R-46 vocabulary migration — written: ${plan.decisions.length} of ${plan.total} rows`
    : `R-46 vocabulary migration — plan only, nothing written: ${plan.decisions.length} of ${plan.total} rows`;
  lines.push(headline, '');

  for (const d of plan.decisions) {
    const flags = [d.readiness ? `readiness ${d.readiness}` : '', d.archive ? 'hidden' : ''].filter(Boolean).join(', ');
    lines.push(`  ${d.id.padEnd(6)} ${d.from.padEnd(16)} → ${d.status.padEnd(10)} ${flags.padEnd(22)} ${d.reason}`);
  }

  if (plan.undecided.length) {
    lines.push('', '  Awaiting a human call — not migrated, and still reading as Canceled:');
    for (const u of plan.undecided) lines.push(`  ${u.id.padEnd(6)} ${u.reason}`);
  }

  lines.push('');
  for (const c of plan.counts) lines.push(`  ${c.from} → ${c.to}: ${c.rows}`);
  lines.push(
    '',
    `  ${plan.decisions.length} of ${plan.total} rows migrate; ${plan.already.length} already carry a new word; ${plan.undecided.length} await a human call.`,
    '  No event was rewritten: each row above gets one new `updated` event carrying its reason.',
  );
  if (!plan.applied) lines.push('', '  Re-run with --apply to write it.');
  return lines.join('\n');
}
