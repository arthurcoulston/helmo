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

/** What became of one shelved row. `archived` said the row was put away and
 *  never whether it was finished or dropped, so it is the migration's only
 *  judgment call — and only the installation's own record can make it. These
 *  arrive as an input the operator supplies, never as a table in the product:
 *  row ids are minted per installation, so ids compiled in here would apply
 *  one estate's reasons to another installation's unrelated rows by id
 *  collision. An archived row with no judgment supplied is reported for a
 *  human to decide and left alone, which costs nothing — its stored word
 *  still reads as Canceled on every surface until someone says otherwise. */
export interface R46Judgment {
  status: Extract<Status, 'Completed' | 'Canceled'>;
  reason: string;
}

/** Judgments by row id, as the operator supplied them. */
export type R46Judgments = Readonly<Record<string, R46Judgment>>;

const TERMINAL: readonly string[] = ['Completed', 'Canceled'];

/** Read judgments from whatever an operator's file parsed to. Every refusal
 *  names the row and what was wrong with it, because the author of the file
 *  is the only person who can fix it. */
export function parseR46Judgments(raw: unknown): R46Judgments {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('judgments must be a JSON object keyed by row id, e.g. {"R-4": {"status": "Canceled", "reason": "..."}}');
  }
  const out: Record<string, R46Judgment> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^R-\d+$/.test(id)) throw new Error(`judgments: ${JSON.stringify(id)} is not a row id of the form R-<n>`);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`judgments: ${id} must be an object with a status and a reason`);
    }
    const { status, reason } = value as { status?: unknown; reason?: unknown };
    if (typeof status !== 'string' || !TERMINAL.includes(status)) {
      throw new Error(`judgments: ${id} status must be ${TERMINAL.join(' or ')} — an archived row is finished or dropped, nothing else`);
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new Error(`judgments: ${id} needs a reason saying what became of it; it is written into the row's own event`);
    }
    out[id] = { status: status as R46Judgment['status'], reason: reason.trim() };
  }
  return out;
}

const NEW_VOCABULARY = new Set<string>(['Proposed', 'Planned', 'Active', 'Monitoring', 'Completed', 'Paused', 'Canceled']);

function decide(f: R46Facts, shelved: R46Judgments): R46Decision | R46Undecided {
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
      const call = shelved[f.id];
      if (!call) {
        return {
          id: f.id, title: f.title,
          reason: 'archived with no judgment supplied — say whether it was Completed or Canceled in the judgments file, then archive it again to hide the row',
        };
      }
      return { ...row(call.status, call.reason), archive: true };
    }
    default:
      return { id: f.id, title: f.title, reason: `stored status "${f.status}" is not a word this migration knows` };
  }
}

/** Read every row's stored word and produce the per-row plan. Pure: the
 *  caller writes nothing until it chooses to.
 *
 *  A judgment naming a row this store cannot apply it to is refused rather
 *  than ignored: a mistyped id would otherwise leave the row it meant sitting
 *  undecided while the report looked complete. A judgment naming a row that
 *  already carries a new word is accepted silently, because that is exactly
 *  what the same file looks like on a second run. */
export function planR46(facts: R46Facts[], shelved: R46Judgments = {}): R46Plan {
  const decisions: R46Decision[] = [];
  const already: string[] = [];
  const undecided: R46Undecided[] = [];
  const tally = new Map<string, number>();
  const byId = new Map(facts.map((f) => [f.id, f]));

  for (const id of Object.keys(shelved)) {
    const f = byId.get(id);
    if (!f) throw new Error(`judgments: ${id} is not a row in this installation's roadmap`);
    if (f.status !== 'archived' && !NEW_VOCABULARY.has(f.status)) {
      throw new Error(`judgments: ${id} is stored as "${f.status}", not archived — this migration judges shelved rows only, and every other word maps by rule`);
    }
  }

  for (const f of facts) {
    if (NEW_VOCABULARY.has(f.status)) {
      already.push(f.id);
      continue;
    }
    const outcome = decide(f, shelved);
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
