/** A bounded forecast input. The caller owns eligibility and estimates; this
 * module owns only dependency/concurrency arithmetic, so it cannot quietly
 * turn a backlog row into authorised work or invent a duration. */
export interface ForecastJob {
  id: string;
  title: string;
  owner: string;
  duration_hours: { low: number; high: number } | null;
  blocked_by?: string[];
  human_boundary?: string;
  /** Why this job is not runway. `unavailable_seat` is a seat that cannot draw
   *  work; `unreadable_seat` is a seat whose state could not be read at all,
   *  kept apart because a failed reading is not a known stoppage. */
  excluded?: 'hold' | 'date_gate' | 'finite_limit' | 'unavailable_seat' | 'unreadable_seat' | 'missing_human_input';
}

export type Span = { low: number; high: number };

export interface Forecast {
  /** The complete reading, and null the moment any admitted job's duration or
   *  prerequisite is unknown: a total that silently omits part of the admitted
   *  work is not the runway anyone asked about. */
  range: Span | null;
  /** The hours the jobs this forecast COULD schedule already account for — a
   *  measured lower bound that survives an unknown elsewhere. Without it a live
   *  estate holding one unestimated ticket would have no honest number at all,
   *  and the card would fall back to listing ready tickets. Read it as "at
   *  least", never as the total. */
  floor: Span | null;
  /** Every admitted job in the order it would happen, including the ones whose
   *  timing is unknown — those carry null spans. Dropping them was wrong: the
   *  question is "what happens next", and a job nobody can put hours on is
   *  still the next thing that happens. It does advance nothing, so everything
   *  after it on the same owner is unknown too. */
  outcomes: { id: string; title: string; owner: string; starts_after: Span | null; finishes_after: Span | null }[];
  first_human_boundary: { id: string; after: Span | null; reason: string } | null;
  unknown_duration: string[];
  excluded: { id: string; reason: NonNullable<ForecastJob['excluded']> }[];
}

// Hours arrive in tenths and are added along a chain, so the sums are rounded
// back to tenths: a reader shown "0.1 to 1.4999999999999998 hours" learns
// something true about floating point and nothing about the runway.
const tenths = (n: number) => Math.round(n * 10) / 10;
const sum = (a: Span, b: Span): Span => ({ low: tenths(a.low + b.low), high: tenths(a.high + b.high) });
const max = (...xs: Span[]): Span => ({ low: Math.max(0, ...xs.map((x) => x.low)), high: Math.max(0, ...xs.map((x) => x.high)) });

/** Schedule one worker at a time per owner, while independent owners run in
 * parallel. Input order is priority order. A dependency not present in the
 * admitted set is an external boundary and excludes its dependent branch. */
export function forecast(jobs: ForecastJob[]): Forecast {
  const excluded = jobs.flatMap((j) => j.excluded ? [{ id: j.id, reason: j.excluded }] : []);
  const admitted = jobs.filter((j) => !j.excluded);
  const ids = new Set(admitted.map((j) => j.id));
  const scheduled = new Map<string, Span | null>();
  const ownerAt = new Map<string, Span>();
  // An owner whose queue already holds something untimed. Its later jobs still
  // happen in order and still cannot be put on a clock: an hour count that
  // skipped the untimed job and carried on would be a schedule with a gap in it
  // presented as a total.
  const untimedOwners = new Set<string>();
  const outcomes: Forecast['outcomes'] = [];
  const unknown = new Set<string>();
  const pending = [...admitted];

  while (pending.length) {
    const at = pending.findIndex((j) => (j.blocked_by ?? []).every((id) => !ids.has(id) || scheduled.has(id)));
    if (at < 0) { for (const j of pending) { unknown.add(j.id); outcomes.push({ id: j.id, title: j.title, owner: j.owner, starts_after: null, finishes_after: null }); } break; }
    const job = pending.splice(at, 1)[0]!;
    const waits = job.blocked_by ?? [];
    const untimed = waits.some((id) => !ids.has(id) || scheduled.get(id) === null) || !job.duration_hours || untimedOwners.has(job.owner);
    if (untimed) {
      unknown.add(job.id);
      untimedOwners.add(job.owner);
      scheduled.set(job.id, null);
      outcomes.push({ id: job.id, title: job.title, owner: job.owner, starts_after: null, finishes_after: null });
      continue;
    }
    const start = max(ownerAt.get(job.owner) ?? { low: 0, high: 0 }, ...waits.flatMap((id) => scheduled.get(id) ?? []));
    const finish = sum(start, job.duration_hours!);
    scheduled.set(job.id, finish);
    ownerAt.set(job.owner, finish);
    outcomes.push({ id: job.id, title: job.title, owner: job.owner, starts_after: start, finishes_after: finish });
  }

  // A boundary whose timing is unknown is still named, and sorts last: Arthur
  // needs to know the step is coming even when nothing can say when.
  const boundaries = admitted.flatMap((j) => (j.human_boundary && scheduled.has(j.id)
    ? [{ id: j.id, after: scheduled.get(j.id) ?? null, reason: j.human_boundary }]
    : []))
    .sort((a, b) => (a.after ? a.after.low : Infinity) - (b.after ? b.after.low : Infinity)
      || (a.after ? a.after.high : Infinity) - (b.after ? b.after.high : Infinity));
  const timed = outcomes.flatMap((o) => (o.finishes_after ? [o.finishes_after] : []));
  const floor = timed.length ? max(...timed) : null;
  return {
    range: unknown.size ? null : floor,
    floor,
    outcomes,
    first_human_boundary: boundaries[0] ?? null,
    unknown_duration: [...unknown],
    excluded,
  };
}
