import { createHash } from 'node:crypto';
import { AVATAR_MARKS } from './estate-avatars.generated.js';
import { ActionRequest, ActivityEvents, ActorKind, CompletionCategory, Evidence, HumanRequest, Question, Ticket } from './types.js';

const MARKS = new Set<string>(AVATAR_MARKS);

export function markFor(name: string, kind: ActorKind | undefined): string | null {
  if (MARKS.has(name)) return name;
  return kind === 'human' && MARKS.has('person') ? 'person' : null;
}

export const CLOSED_TAIL = 20;

const TERMINAL = new Set(['done', 'cancelled']);

export const letterFor = (i: number): string => String.fromCharCode(97 + i);

/** Bind a dashboard ratification to the exact question that was drawn. */
export function questionFingerprint(q: Question): string {
  const canonical = JSON.stringify([
    q.situation,
    q.question,
    q.recommendation,
    q.if_unanswered ?? '',
    (q.options ?? []).map((o) => [o.label, o.consequence]),
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** The same binding for an action request. Kept separate from
 *  `questionFingerprint` rather than generalised into it, because that
 *  function's output IS the consent token on every card currently drawn
 *  (H-1053) and a shared canonical form would change it for decisions. */
export function actionFingerprint(a: ActionRequest): string {
  const canonical = JSON.stringify(['action', a.situation, a.action, a.why_human, a.if_unanswered ?? '']);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** The fingerprint of whichever kind of request is pending. A decision's is
 *  byte-identical to what `questionFingerprint` has always returned. */
export function requestFingerprint(r: HumanRequest): string {
  return r.kind === 'action' ? actionFingerprint(r) : questionFingerprint(r);
}

export interface PresentedAsk {
  fingerprint: string;
  situation: string;
  question: string;
  recommendation: string;
  options?: { letter: string; label: string; consequence: string }[];
  if_unanswered?: string;
}

export function ask(q: Question): PresentedAsk {
  return {
    fingerprint: questionFingerprint(q),
    situation: q.situation,
    question: q.question,
    recommendation: q.recommendation,
    ...(q.options?.length
      ? { options: q.options.map((o, i) => ({ letter: letterFor(i), label: o.label, consequence: o.consequence })) }
      : {}),
    ...(q.if_unanswered ? { if_unanswered: q.if_unanswered } : {}),
  };
}

const when = (t: Ticket) => t.closed_at ?? t.updated_at;
const seq = (t: Ticket) => Number.parseInt(t.id.replace(/^\D+/, ''), 10) || 0;

/** The bounded default record for the HTML view; `whole` is the explicit
 *  escape hatch for terminal history. */
export function recordTickets(all: Ticket[], whole = false): Ticket[] {
  const live = all.filter((t) => !TERMINAL.has(t.status));
  const closed = all
    .filter((t) => TERMINAL.has(t.status))
    .sort((a, b) => when(b).localeCompare(when(a)) || seq(b) - seq(a));
  return [...live, ...(whole ? closed : closed.slice(0, CLOSED_TAIL))];
}

// ---------- what the work produced (R-42 / H-2969) ----------

/** The three roles an evidence item may state. A set, not a union switch:
 *  `kind` already taught this file that a JSON column outlives the enum
 *  guarding it — the personal store holds a `kind: "test"` written around the
 *  tool boundary (H-884) — and `role` is written into that same column. An
 *  exhaustive switch would throw, or worse default, on the first one. */
const ROLES = new Set(['result', 'supporting', 'review']);

/** One evidence item's place in the result display, as an index into the
 *  ticket's own `evidence` array.
 *
 *  The item is deliberately NOT copied. The heaviest evidence list the real
 *  record holds is 118 items (`floor.ts`), the whole-record document already
 *  sits at 2.7MB against a 4.2MB ceiling, and the client reading this has the
 *  array in the same row. A second copy of every item would buy nothing and
 *  spend the document budget on it. */
export interface ResultRole {
  at: number;
  /** The frozen fallback placed this item, because no purpose was recorded for
   *  it (contract §2.4). The display says so; it never presents a guess as a
   *  record. */
  inferred?: true;
  /** A later append restated this ref's role (contract §2.3). */
  corrected?: true;
}

/** What one ticket's evidence says it produced. Reachability is absent on
 *  purpose: whether a ref opens is a property of the device doing the looking,
 *  so the client decides it (contract §2.5) and this projection stays the same
 *  answer for every reader. */
export interface ResultDisplay {
  /** The result the surface offers as the action, or null when none is
   *  recorded and none can be inferred. */
  primary: ResultRole | null;
  /** Every other result, in append order. Never hidden: when a ticket records
   *  two results the surface says so and shows both. */
  others: ResultRole[];
  supporting: ResultRole[];
  review: ResultRole[];
  /** Items whose purpose is not recorded and which the fallback cannot place.
   *  These are the 2,153 closed personal-estate tickets that read as having
   *  produced nothing: they have evidence, and nobody wrote down what it was
   *  for. */
  unstated: ResultRole[];
}

/** Read a ticket's evidence as a result display, per
 *  `crew:projects/r39/RESULT-ROLE-CONTRACT.md`.
 *
 *  The defect this replaces decided what the result WAS from how the ref was
 *  SPELLED: `Results()` promoted every `kind: "url"` item to the result and
 *  demoted a commit or a file to review evidence. On the personal store that
 *  described 2,153 closed tickets as having produced nothing. Purpose is now
 *  read from `role` where an agent recorded it, and only guessed — labelled —
 *  where nobody did. */
export function resultDisplay(evidence: Evidence[]): ResultDisplay {
  // Pass one: the recorded roles, deduped by exact ref. Evidence is
  // append-only, so a mis-stated role is corrected by appending the same ref
  // with the intended role; the latest explicitly-roled item for a ref decides
  // that ref's role and is the one shown. "Corrected" means an earlier item
  // stated a DIFFERENT role for this ref — re-appending the same role corrects
  // nothing and is not labelled as though it had.
  const stated = new Map<string, ResultRole & { role: string }>();
  const statedItems = new Set<number>();
  evidence.forEach((item, at) => {
    if (item.role === undefined) return;
    statedItems.add(at);
    const previous = stated.get(item.ref);
    const corrected = previous ? previous.corrected ?? previous.role !== item.role : false;
    stated.set(item.ref, { at, role: item.role, ...(corrected ? { corrected: true as const } : {}) });
  });

  const recorded: ResultRole[] = [];
  const supporting: ResultRole[] = [];
  const review: ResultRole[] = [];
  const unstated: ResultRole[] = [];
  const bucket = (role: string) =>
    role === 'result' ? recorded : role === 'supporting' ? supporting : role === 'review' ? review : unstated;
  for (const { role, ...place } of stated.values()) bucket(ROLES.has(role) ? role : 'unknown').push(place);

  // Pass two: the frozen fallback for items that predate the field — the same
  // `kind === "url"` guess the UI used to apply to everything, kept only so
  // that no existing record's display regresses on the day `role` ships. It is
  // never applied to an item that carries a role, and never to a ref another
  // item has already stated a role for: a guess must not shadow a record.
  const inferred: ResultRole[] = [];
  evidence.forEach((item, at) => {
    if (statedItems.has(at) || stated.has(item.ref)) return;
    if (item.kind === 'url') inferred.push({ at, inferred: true });
    else unstated.push({ at });
  });

  // The action goes to the latest-appended result, and a recorded result
  // outranks an inferred one however late the guess arrived. This is not the
  // `.at(-1)` the verdict-set contract removed: nothing is erased from view —
  // every result stays on screen under `others`, and there is no severity
  // order among results for a quiet overwrite to defeat.
  const sort = (items: ResultRole[]) => items.sort((a, b) => a.at - b.at);
  const primary = (recorded.length ? sort(recorded) : inferred).at(-1) ?? null;
  const others = sort([...recorded, ...inferred]).filter((item) => item !== primary);
  return { primary, others, supporting: sort(supporting), review: sort(review), unstated: sort(unstated) };
}

// ---------- what got done in the past 24 hours (R-44) ----------

/** The only types that supply a category for a ticket closed before the
 *  account existed, per `crew:projects/r39/RECENT-RESULTS-CONTRACT.md`. The
 *  map is deliberately partial: `build` is absent because a build is Feature,
 *  Improvement or Bug fix depending on what it did, and only its author knows
 *  which. Guessing one of the three would put words in their mouth on 2,000+
 *  closed records at once. */
const COMPATIBILITY_CATEGORY: Record<string, CompletionCategory> = {
  research: 'research',
  planning: 'planning_design',
  writing: 'documentation_content',
  ops: 'operations',
  review: 'review',
};

/** How many rows the card draws. The rest are counted and linked, never
 *  dropped silently. */
export const RECENT_RESULTS_LIMIT = 6;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One completed ticket as the results reading presents it. Everything a
 *  reader needs to judge whether the work landed, and nothing invented:
 *  a null `summary` or `category` is the record saying nobody wrote one. */
export interface ResultRow {
  id: string;
  title: string;
  workstream: string;
  project: string | null;
  closed_at: string;
  /** The author's own one paragraph, or null when no account was recorded. */
  summary: string | null;
  category: CompletionCategory | null;
  /** Where the category came from: `recorded` is the author's choice, `type`
   *  is the frozen compatibility map above, and null is Uncategorised. The
   *  display says which, so a mapped category is never read as a judgment
   *  someone made. */
  category_source: 'recorded' | 'type' | null;
  author: string | null;
  recorded_at: string | null;
  /** Every explicitly recorded result, the primary first, then any others in
   *  append order. Nothing is hidden: a ticket that records two results says
   *  so and shows both.
   *
   *  Copies rather than the places `ResultDisplay` carries, and that is the
   *  opposite call to the one the whole-record document makes — deliberately.
   *  There, the client already has the row's `evidence` array and a second
   *  copy would buy nothing. Here the rows are a separate bounded section, and
   *  carrying each one's whole array to reach two items would put the heaviest
   *  evidence list the real record holds (118 items) into a six-row card. The
   *  non-result roles are absent for the same reason: this card never draws
   *  them, and an index into an array it does not carry is a trap. */
  results: ResultItem[];
  acceptance: { state: string; reason: string };
  blast_radius: string;
}

/** One recorded result, as the card draws it. `inferred` and `corrected` carry
 *  the same meaning they do in `ResultDisplay`: the purpose was guessed by the
 *  frozen legacy fallback, and a later append restated this ref's role. */
export interface ResultItem {
  kind: string;
  ref: string;
  note?: string;
  inferred?: true;
  corrected?: true;
}

export interface RecentResults {
  /** The instant the server windowed on. The browser must not use its own
   *  clock: two readers on different machines would otherwise disagree about
   *  what "the past 24 hours" contained. */
  as_of: string;
  window_started_at: string;
  /** Every eligible record, not just the ones drawn. */
  total: number;
  limit: number;
  rows: ResultRow[];
}

/** What each agent is holding right now, keyed by assignee.
 *
 *  A claim is the only thing in this record that says an agent is working on
 *  something: `in_progress` with their name on it. Nothing else counts — a
 *  reserved ticket is work handed to them that they have not started, and an
 *  open one in their workstream is work they MIGHT take next. Reading either as
 *  current work is how a condensed roster starts saying an idle agent is busy
 *  (H-3091).
 *
 *  Title and id only: this is the link out of a glance view, and the Work
 *  record is where the rest of a ticket lives. The map is prototype-free, so a
 *  seat named `constructor` cannot answer for one that does not exist
 *  (H-3004). */
export function seatWork(tickets: Ticket[]): Record<string, { id: string; title: string }[]> {
  const held: Record<string, { id: string; title: string }[]> = Object.create(null);
  for (const t of tickets) {
    if (t.status !== 'in_progress' || !t.assignee) continue;
    (held[t.assignee] ??= []).push({ id: t.id, title: t.title });
  }
  return held;
}

/** Completed work inside the rolling 24-hour window ending at `as_of`.
 *
 *  Only a ticket's CURRENT state is read: a reopened ticket is absent while it
 *  is open and returns at its later close, and a verdict or a late evidence
 *  append changes a selected row's decorations without ever moving a record
 *  into the window. The window is half-open at the bottom — a ticket closed
 *  exactly 24 hours ago has already been read — and closed at the top, so the
 *  instant the reading was taken is included.
 *
 *  `acceptance` is passed in rather than read here, because this file has no
 *  store: the projection is the same answer for every caller, and who supplies
 *  the verdict state is the caller's business. */
export function recentResults(
  tickets: Ticket[],
  asOf: string,
  acceptance: (id: string) => { state: string; reason: string },
): RecentResults {
  const asOfMs = new Date(asOf).getTime();
  if (Number.isNaN(asOfMs)) throw new Error(`recentResults needs an instant for as_of; got "${asOf}".`);
  const startedMs = asOfMs - DAY_MS;
  // Compared as instants, not strings: `closed_at` is written by
  // `toISOString()` today, but the column is text and an imported record can
  // carry another spelling of the same moment, which a lexicographic compare
  // would place in the wrong window.
  const eligible = tickets.filter((t) => {
    if (t.status !== 'done' || !t.closed_at) return false;
    const closed = new Date(t.closed_at).getTime();
    return !Number.isNaN(closed) && closed > startedMs && closed <= asOfMs;
  });
  const ordered = eligible.sort(
    (a, b) => new Date(b.closed_at!).getTime() - new Date(a.closed_at!).getTime() || seq(b) - seq(a),
  );
  return {
    as_of: asOf,
    window_started_at: new Date(startedMs).toISOString(),
    total: ordered.length,
    limit: RECENT_RESULTS_LIMIT,
    rows: ordered.slice(0, RECENT_RESULTS_LIMIT).map((t) => {
      const account = t.completion_account;
      const mapped = account ? null : COMPATIBILITY_CATEGORY[t.type] ?? null;
      const display = resultDisplay(t.evidence);
      return {
        id: t.id,
        title: t.title,
        workstream: t.workstream,
        project: t.project ?? null,
        closed_at: t.closed_at!,
        summary: account?.summary ?? null,
        category: account?.category ?? mapped,
        category_source: account ? ('recorded' as const) : mapped ? ('type' as const) : null,
        author: account?.author ?? null,
        recorded_at: account?.recorded_at ?? null,
        results: [...(display.primary ? [display.primary] : []), ...display.others].flatMap((place) => {
          const item = t.evidence[place.at];
          // A place the ticket's own array cannot answer is dropped rather
          // than drawn empty: it only happens if the projection disagrees
          // with the array it indexes, and one item short beats a blank line.
          if (!item) return [];
          return [{
            kind: item.kind, ref: item.ref,
            ...(item.note ? { note: item.note } : {}),
            ...(place.inferred ? { inferred: true as const } : {}),
            ...(place.corrected ? { corrected: true as const } : {}),
          }];
        }),
        acceptance: acceptance(t.id),
        blast_radius: t.blast_radius,
      };
    }),
  };
}

// ---------- what the team did over the day and the week (R-44 H-3090) ----------

/** One bucket on the time axis, as a local clock reads it.
 *
 *  Both instants travel with it. The label is the server's, because a browser
 *  relabelling these against its own clock is the same defect `as_of` exists to
 *  prevent — and the instants are what make the label checkable. */
export interface ActivityBucket {
  starts_at: string;
  ends_at: string;
  /** The local clock's own words for this bucket: an hour, or a weekday. */
  label: string;
  /** How long the bucket really is. An hour is an hour, but a local DAY is 23
   *  or 25 hours across a daylight-saving change, and the newest bucket of
   *  either kind is cut short at `as_of`. A reader comparing two bars is
   *  entitled to know one of them covers less time. */
  length_ms: number;
  /** Cut short at `as_of`: it is still filling. */
  partial?: true;
  /** The whole bucket precedes the first event this store holds, so its zero
   *  is an absence of RECORDING rather than an absence of work. Drawn as a gap,
   *  never as a bar of height zero. */
  before_record?: true;
  tokens: number;
  completions: number;
  requests: number;
}

export type ActivitySeriesKey = 'tokens' | 'completions' | 'requests';

/** One series over one range: what it counts, what it is counted in, and the
 *  two numbers that make a relatively-scaled bar readable — the period total
 *  and the peak bucket the scale is set by. */
export interface ActivitySeries {
  key: ActivitySeriesKey;
  label: string;
  unit: string;
  /** What instant each item is counted AT, in the operator's words. */
  basis: string;
  /** What the count does not include. */
  coverage: string;
  total: number;
  /** The largest bucket in absolute terms — the scale's own ceiling. Zero when
   *  nothing was counted, which the card draws as a flat line rather than
   *  dividing by it. */
  peak: number;
  /** The lowest bucket, which is below zero only for tokens, and only when a
   *  metered correction landed in it (see `basis`). */
  floor: number;
}

export interface ActivityRange {
  unit: 'hour' | 'day';
  window_started_at: string;
  buckets: ActivityBucket[];
  series: ActivitySeries[];
}

export interface TeamActivity {
  /** The instant both ranges were windowed on, fixed once by the server. */
  as_of: string;
  /** The zone whose clock the buckets are cut on, named so the reader knows
   *  whose midnight they are looking at. */
  time_zone: string;
  recording_began_at: string | null;
  day: ActivityRange;
  week: ActivityRange;
}

/** How each series is accounted for. Frozen prose rather than a sentence the
 *  card writes, because every one of these lines is a statement about the
 *  record's limits and none of them is the component's to soften. */
const SERIES: Record<ActivitySeriesKey, Omit<ActivitySeries, 'total' | 'peak' | 'floor' | 'key'>> = {
  tokens: {
    label: 'Tokens reported',
    unit: 'tokens',
    basis: 'counted when the figure was REPORTED, not when the work ran: nothing in the record says that',
    coverage: 'reported or harness-metered events only; unmetered work is excluded, and a metered correction nets out where it was reported',
  },
  completions: {
    label: 'Tickets completed',
    unit: 'tickets',
    basis: 'counted once per ticket, at the completion that currently stands',
    coverage: 'cancelled work is not a completion; a reopened ticket leaves the chart until it closes again',
  },
  requests: {
    label: 'New requests for you',
    unit: 'requests',
    basis: 'counted once when a decision, an action or a sitting was issued',
    coverage: 'a request still pending is not recounted in later buckets, and your own answers are not counted at all',
  },
};

const HOUR_MS = 3_600_000;

interface WallClock { y: number; m: number; d: number; h: number; min: number; s: number }

/** An instant's local parts, in one zone. `formatToParts` rather than a
 *  locale-formatted string, so nothing here depends on how a locale happens to
 *  order or punctuate a date. */
function wallClock(ms: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const field: Record<string, number> = {};
  for (const part of parts) if (part.type !== 'literal') field[part.type] = Number(part.value);
  return { y: field['year']!, m: field['month']!, d: field['day']!, h: field['hour']!, min: field['minute']!, s: field['second']! };
}

const asIfUTC = (w: WallClock): number => Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s);
const offsetAt = (ms: number, timeZone: string): number => asIfUTC(wallClock(ms, timeZone)) - ms;
const DAY_PROBE = 86_400_000;

/** Every instant a local wall-clock time names, in order.
 *
 *  Usually exactly one. Twice a year it is two or none, and both cases are real
 *  bucket boundaries rather than edge cases to wave at: the hour a clock
 *  repeats names two instants, and the hour a clock skips names none. The
 *  candidates come from the offsets in force a day either side of the target
 *  and at the target itself; each is kept only if it really reads back as the
 *  wall clock asked for, which is what rejects a skipped hour.
 *
 *  Out-of-range fields are deliberately allowed: `Date.UTC` rolls hour 24 into
 *  the next day and day 32 into the next month, which is how the following
 *  boundary is named without any calendar arithmetic of our own. */
function instantsOf(w: WallClock, timeZone: string): number[] {
  const target = asIfUTC(w);
  const candidates = [target - DAY_PROBE, target, target + DAY_PROBE].map((probe) => target - offsetAt(probe, timeZone));
  return [...new Set(candidates)]
    .filter((candidate) => asIfUTC(wallClock(candidate, timeZone)) === target)
    .sort((a, b) => a - b);
}

/** The start of the local hour or day that `ms` falls in.
 *
 *  The LAST instant naming that boundary which is not after `ms` — not the
 *  first, and not a wall-clock inversion taken on trust. On the night a clock
 *  falls back, "01:00" names two instants an hour apart: both are real hour
 *  buckets, and an instant in the second of them belongs to the second. Taking
 *  the earlier one would merge the two into one two-hour bucket, and taking
 *  whichever a single-pass inversion happened to answer with made the backward
 *  walk below stall on the transition and repeat a boundary. */
function alignedStart(ms: number, timeZone: string, unit: 'hour' | 'day'): number {
  const w = wallClock(ms, timeZone);
  const boundary = unit === 'hour' ? { ...w, min: 0, s: 0 } : { ...w, h: 0, min: 0, s: 0 };
  const options = instantsOf(boundary, timeZone).filter((instant) => instant <= ms);
  // An instant always falls inside some local hour and some local day, so the
  // only way this is empty is a zone whose data disagrees with itself; the
  // offset in force at `ms` is then the best answer available.
  return options.at(-1) ?? asIfUTC(boundary) - offsetAt(ms, timeZone);
}

/** The boundary the local clock puts after a bucket that starts at `ms`. */
function naturalEnd(ms: number, timeZone: string, unit: 'hour' | 'day'): number {
  const w = wallClock(ms, timeZone);
  const next = unit === 'hour' ? { ...w, h: w.h + 1, min: 0, s: 0 } : { ...w, d: w.d + 1, h: 0, min: 0, s: 0 };
  const options = instantsOf(next, timeZone);
  // A boundary the clock SKIPPED names no instant: the bucket ends when the
  // clock jumped, which is where the pre-transition offset puts it.
  return options[0] ?? asIfUTC(next) - offsetAt(asIfUTC(next) - DAY_PROBE, timeZone);
}

function labelOf(ms: number, timeZone: string, unit: 'hour' | 'day'): string {
  return unit === 'hour'
    ? new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))
    : new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric' }).format(new Date(ms));
}

/** The bucket boundaries of one range, oldest first.
 *
 *  Each older boundary is found by aligning the millisecond BEFORE the newer
 *  one, which is the only step that cannot drift: whatever an offset change did
 *  in between, the local unit immediately preceding a boundary is the unit that
 *  millisecond falls in. Stepping back by a fixed 3,600,000 ms would walk off
 *  the local clock in any zone whose offset moves by half an hour. */
function boundaries(asOfMs: number, timeZone: string, unit: 'hour' | 'day', count: number): number[] {
  const starts = [alignedStart(asOfMs, timeZone, unit)];
  while (starts.length < count) starts.push(alignedStart(starts[starts.length - 1]! - 1, timeZone, unit));
  return starts.reverse();
}

/** The two ranges Arthur asked for: a day in hours, a week in days. Named here
 *  because the store read has to be bounded by the same arithmetic the buckets
 *  are cut by, and a second copy of "24" is a second thing to keep true. */
export const ACTIVITY_RANGES = { day: { unit: 'hour', count: 24 }, week: { unit: 'day', count: 7 } } as const;

/** The oldest instant either range can reach, so a caller can bound its read
 *  of the record without guessing. Not a fixed 7×86,400,000 ms: the oldest
 *  bucket starts at a local midnight, which is up to an hour further back than
 *  arithmetic on the clock would suggest, and a read bounded by the arithmetic
 *  would leave the first bucket short of the events it should hold. */
export function activityWindowStart(asOf: string, timeZone: string): string {
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(asOfMs)) throw new Error(`activityWindowStart needs an instant for as_of; got "${asOf}".`);
  const earliest = Object.values(ACTIVITY_RANGES)
    .map((r) => boundaries(asOfMs, timeZone, r.unit, r.count)[0]!)
    .reduce((oldest, start) => Math.min(oldest, start));
  return new Date(earliest).toISOString();
}

/** Both ranges of the activity reading, from the raw timestamped record.
 *
 *  Buckets are cut on the local clock of `timeZone` — Arthur asked for a day
 *  and a week, and a day is a thing a clock says, not 86,400,000 ms counted
 *  back from now. The newest bucket of each range is therefore partial, and the
 *  window starts at the start of the oldest bucket rather than exactly 24 hours
 *  or 7 days back; `window_started_at` says where it really starts.
 *
 *  Each series keeps its own units and its own scale. Nothing here normalizes:
 *  the raw counts travel with the peak and the total, and a bar's height is the
 *  reading's own business, so no invented number can be mistaken for a measured
 *  one. Three series that cannot share an axis must not share one. */
export function teamActivity(events: ActivityEvents, asOf: string, timeZone: string): TeamActivity {
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(asOfMs)) throw new Error(`teamActivity needs an instant for as_of; got "${asOf}".`);
  const began = events.recording_began_at ? Date.parse(events.recording_began_at) : NaN;

  const range = (unit: 'hour' | 'day', count: number): ActivityRange => {
    const starts = boundaries(asOfMs, timeZone, unit, count);
    const buckets: ActivityBucket[] = starts.map((start, i) => {
      const next = starts[i + 1];
      const natural = naturalEnd(start, timeZone, unit);
      const end = next ?? Math.min(natural, asOfMs);
      const bucket: ActivityBucket = {
        starts_at: new Date(start).toISOString(),
        ends_at: new Date(end).toISOString(),
        label: labelOf(start, timeZone, unit),
        length_ms: end - start,
        tokens: 0, completions: 0, requests: 0,
      };
      if (!next && end < natural) bucket.partial = true;
      return bucket;
    });

    // One pass per source over the buckets it belongs in. A bucket is
    // half-open — [starts_at, ends_at) — so an instant exactly on a boundary
    // is counted once, in the bucket it opens, and the newest bucket's closed
    // top is `as_of` itself, which the store's own window already included.
    const place = (at: string): ActivityBucket | undefined => {
      const ms = Date.parse(at);
      if (Number.isNaN(ms)) return undefined;
      for (let i = buckets.length - 1; i >= 0; i -= 1) {
        const bucket = buckets[i]!;
        if (ms >= Date.parse(bucket.starts_at) && (ms < Date.parse(bucket.ends_at) || (i === buckets.length - 1 && ms <= asOfMs))) {
          return bucket;
        }
      }
      return undefined;
    };
    for (const item of events.tokens) { const b = place(item.at); if (b) b.tokens += item.tokens; }
    for (const item of events.completions) { const b = place(item.at); if (b) b.completions += 1; }
    for (const item of events.requests) { const b = place(item.at); if (b) b.requests += 1; }

    // Marked after the counting, not before, and only on a bucket that is
    // EMPTY: a bucket ending at or before the first event this store holds
    // cannot be speaking for anything, but the newest bucket's top is `as_of`
    // itself — and on an installation minutes old that is the same instant as
    // its first event, which flagged a bucket with real counts in it as
    // unrecorded. The invariant is the readable one: a bucket drawn as unknown
    // holds nothing.
    for (const bucket of buckets) {
      if (Number.isNaN(began) || bucket.tokens || bucket.completions || bucket.requests) continue;
      if (Date.parse(bucket.ends_at) <= began) bucket.before_record = true;
    }

    const series = (Object.keys(SERIES) as ActivitySeriesKey[]).map((key) => {
      const values = buckets.filter((b) => !b.before_record).map((b) => b[key]);
      return {
        key, ...SERIES[key],
        total: values.reduce((sum, v) => sum + v, 0),
        peak: values.reduce((most, v) => Math.max(most, Math.abs(v)), 0),
        floor: values.reduce((least, v) => Math.min(least, v), 0),
      };
    });
    return { unit, window_started_at: buckets[0]!.starts_at, buckets, series };
  };

  return {
    as_of: asOf,
    time_zone: timeZone,
    recording_began_at: events.recording_began_at,
    day: range(ACTIVITY_RANGES.day.unit, ACTIVITY_RANGES.day.count),
    week: range(ACTIVITY_RANGES.week.unit, ACTIVITY_RANGES.week.count),
  };
}
