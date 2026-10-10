/* Autonomous runway: what the team will do next without Arthur, and roughly how
   long it can keep going (R-43, H-3089).

   `forecast()` next door owns the arithmetic and deliberately cannot admit work
   or invent a duration. This file owns both of those judgments, which is where
   every way of lying about a runway lives:

   - **Eligibility.** The exclusions below are the store's own ready predicate
     restated — withheld for the human, held, gated, unserved — plus the two the
     predicate has no opinion about: a workstream whose finite budget is spent,
     and a seat whose loop is in no position to draw work. Anything admitted
     here that the queue would refuse is runway the team cannot actually walk.
   - **Duration.** Every hour comes from recorded claim-to-close elapsed time on
     comparable closed work. Where there is not enough of it the job's duration
     is null and the forecast says so; no hour is derived from a priority, a
     title or a type's reputation.

   What this file will not do is infer a boundary. The one place it says "Arthur
   is needed here" is a ticket's own recorded blast radius: a claim authorises
   work up to `records`, and `sent`/`published` is the step he keeps. That is a
   field somebody set, not a guess about what the work will turn out to need. */
import { forecast, Forecast, ForecastJob, Span } from './forecast.js';
import { Ticket, WorkstreamInfo } from './types.js';

/** A seat's state as the runtime reports it. The states are Team-now's six;
 *  this file only needs to know which of them can draw work. */
export type SeatState = 'working' | 'awaiting' | 'blocked' | 'stopped' | 'failed' | 'unknown';

export interface SeatReading {
  agent: string;
  state: SeatState;
}

/** One closed ticket's measured elapsed time, as `Store.recordedDurations`
 *  returns it. */
export interface DurationSample {
  id: string;
  type: string;
  hours: number;
}

export interface RunwayInput {
  tickets: Ticket[];
  /** Open blockers per ticket id — `Store.blockersFor`, so "open blocker" keeps
   *  the single definition the ready queue uses. */
  blockers: Map<string, string[]>;
  workstreams: WorkstreamInfo[];
  durations: DurationSample[];
  /** The seats the runtime could read. `null` means the roster or state
   *  directory could not be read at all, which is not an empty fleet: the whole
   *  forecast is then unavailable rather than quietly zero. */
  seats: SeatReading[] | null;
  as_of: string;
}

export type ExclusionReason = NonNullable<ForecastJob['excluded']>;

export interface RunwayOutcome {
  id: string;
  title: string;
  owner: string;
  /** Null when nothing can put this job on a clock. The job is still named:
   *  it is what happens next whether or not it can be timed. */
  finishes_after: Span | null;
}

export interface RunwayDocument {
  as_of: string;
  /** Set when no forecast could be taken at all, naming the missing basis.
   *  Every other field is then empty and means nothing. */
  unavailable: string | null;
  /** The complete reading: hours until the admitted work runs out. Null while
   *  anything admitted has no duration — read `floor` instead and say "at
   *  least". */
  range: Span | null;
  floor: Span | null;
  outcomes: RunwayOutcome[];
  first_human_boundary: { id: string; title: string; after: Span | null; reason: string } | null;
  unknown_duration: { id: string; title: string; owner: string; reason: string }[];
  excluded: { id: string; title: string; reason: ExclusionReason; detail: string }[];
  coverage: {
    window_days: number;
    samples: number;
    samples_by_type: Record<string, number>;
    estimated: Record<DurationBasis | 'unknown', number>;
    seats: { available: string[]; unavailable: { agent: string; state: SeatState }[] };
    /** What this forecast is known not to model, in the card's own words. A
     *  limitation named here is cheaper than a number nobody can trust. */
    limitations: string[];
  };
}

/** How much closed history a comparable band needs before it is allowed to
 *  speak. Four samples let one abandoned ticket set the upper quartile. */
const MIN_SAMPLES = 5;

/** How far back closed work is read. Longer would gather more samples and
 *  describe a team that no longer works this way. */
export const DURATION_WINDOW_DAYS = 90;

export type DurationBasis = 'comparable' | 'pooled';

export interface DurationEstimate {
  low: number;
  high: number;
  basis: DurationBasis;
  samples: number;
}

/** Nearest-rank percentile on an ascending array — one definition, so the same
 *  samples give the same band on two machines. */
const percentile = (ascending: number[], p: number): number =>
  ascending[Math.min(ascending.length - 1, Math.max(0, Math.ceil(p * ascending.length) - 1))]!;

const tenths = (n: number) => Math.round(n * 10) / 10;

/** The interquartile band of comparable recorded durations.
 *
 *  p25–p75 rather than the full spread on purpose: both ends are measured, and
 *  both are resistant to the one record that was claimed and then left for
 *  three weeks. That record's elapsed time is true and is not how long the work
 *  took, and letting it set the high end would hand Arthur a longer runway than
 *  the team has — the error that matters here, because it is the one that reads
 *  as "no need to check in". */
export function durationBands(samples: DurationSample[]): {
  byType: Map<string, DurationEstimate>;
  pooled: DurationEstimate | null;
  samples_by_type: Record<string, number>;
} {
  const groups = new Map<string, number[]>();
  for (const s of samples) {
    const into = groups.get(s.type);
    if (into) into.push(s.hours);
    else groups.set(s.type, [s.hours]);
  }
  const band = (hours: number[], basis: DurationBasis): DurationEstimate => {
    const ascending = [...hours].sort((a, b) => a - b);
    return { low: tenths(percentile(ascending, 0.25)), high: tenths(percentile(ascending, 0.75)), basis, samples: ascending.length };
  };
  const byType = new Map<string, DurationEstimate>();
  const samples_by_type: Record<string, number> = {};
  for (const [type, hours] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    samples_by_type[type] = hours.length;
    if (hours.length >= MIN_SAMPLES) byType.set(type, band(hours, 'comparable'));
  }
  const all = samples.map((s) => s.hours);
  return { byType, pooled: all.length >= MIN_SAMPLES ? band(all, 'pooled') : null, samples_by_type };
}

/** A seat that can draw work next. `working` counts: the question is whether
 *  the seat continues, and a seat mid-ticket plainly does. */
const CAN_DRAW: Set<SeatState> = new Set(['working', 'awaiting']);

/** Why the ready queue, or the authority it enforces, would refuse this ticket
 *  right now — the first matching reason, most decisive first. A ticket can be
 *  both held and gated; reporting both would make the card argue with itself
 *  about which one Arthur has to lift. */
function exclusion(t: Ticket, stream: WorkstreamInfo | undefined, owner: string | null, seats: SeatReading[], asOf: string): { reason: ExclusionReason; detail: string } | null {
  if (t.status === 'awaiting_human') return { reason: 'missing_human_input', detail: 'Sitting with Arthur for an answer' };
  if (t.action) return { reason: 'missing_human_input', detail: 'Waiting on an action only Arthur can take' };
  if (t.needs_human) return { reason: 'missing_human_input', detail: t.sitting ?? 'Needs a sitting with Arthur' };
  const hold = t.capacity_hold;
  if (hold && (!hold.release || hold.release.until <= asOf)) return { reason: 'hold', detail: hold.reason };
  if (t.not_before && t.not_before > asOf) return { reason: 'date_gate', detail: `Gated until ${t.not_before}` };
  if (stream && stream.remaining_usd !== null && stream.remaining_usd <= 0) {
    return { reason: 'finite_limit', detail: `Workstream ${stream.name} has spent its $${stream.budget_usd} budget` };
  }
  if (!owner) return { reason: 'unavailable_seat', detail: `No seat serves workstream ${t.workstream}` };
  const seat = seats.find((s) => s.agent === owner);
  if (!seat) return { reason: 'unavailable_seat', detail: `${owner} serves no running loop` };
  if (seat.state === 'unknown') return { reason: 'unreadable_seat', detail: `${owner}'s state could not be read` };
  if (!CAN_DRAW.has(seat.state)) return { reason: 'unavailable_seat', detail: `${owner} is ${seat.state}` };
  return null;
}

/** The seat accountable for a ticket: its own assignee, else the seat its
 *  workstream routes unassigned filings to. Never a guess — an unseated pool
 *  ticket has no owner and is excluded as such. */
function ownerOf(t: Ticket, stream: WorkstreamInfo | undefined): string | null {
  return t.assignee ?? stream?.seat ?? null;
}

/** A recorded step Arthur keeps. A claim covers work up to `records`; sending
 *  and publishing are his, so a branch that ends in one has a boundary whatever
 *  else is true of it. */
function boundaryOf(t: Ticket): string | undefined {
  if (t.blast_radius === 'sent') return 'Sending needs Arthur';
  if (t.blast_radius === 'published') return 'Publishing needs Arthur';
  return undefined;
}

/** Live and remaining work, in the order the queue would offer it. A recurring
 *  TEMPLATE is standing work and never runway: counting the instances it will
 *  spawn forever is how a forecast reads as infinite. The instances it has
 *  already spawned are ordinary tickets and are counted. */
function candidates(tickets: Ticket[]): Ticket[] {
  return tickets
    .filter((t) => !['done', 'cancelled'].includes(t.status) && !t.schedule)
    .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
}

const LIMITATIONS = [
  'Hours come from comparable closed work, not from any estimate of this work.',
  'Work an agent filed for itself is counted, though its own queue withholds it until someone else judges it.',
  'Work the team has not discovered yet is never counted, so a long runway is a floor and not a ceiling.',
];

export function runway(input: RunwayInput): RunwayDocument {
  const empty: RunwayDocument['coverage'] = {
    window_days: DURATION_WINDOW_DAYS,
    samples: input.durations.length,
    samples_by_type: {},
    estimated: { comparable: 0, pooled: 0, unknown: 0 },
    seats: { available: [], unavailable: [] },
    limitations: LIMITATIONS,
  };
  if (!input.seats) {
    return {
      as_of: input.as_of,
      unavailable: 'The runtime roster could not be read, so no seat is known to be able to continue.',
      range: null, floor: null, outcomes: [], first_human_boundary: null, unknown_duration: [], excluded: [],
      coverage: empty,
    };
  }
  const seats = input.seats;
  const streams = new Map(input.workstreams.map((w) => [w.name, w]));
  const { byType, pooled, samples_by_type } = durationBands(input.durations);
  const estimated: RunwayDocument['coverage']['estimated'] = { comparable: 0, pooled: 0, unknown: 0 };
  const titles = new Map<string, string>();
  const details = new Map<string, { reason: ExclusionReason; detail: string }>();

  const jobs: ForecastJob[] = candidates(input.tickets).map((t) => {
    titles.set(t.id, t.title);
    const stream = streams.get(t.workstream);
    const owner = ownerOf(t, stream);
    const excluded = exclusion(t, stream, owner, seats, input.as_of);
    if (excluded) details.set(t.id, excluded);
    const estimate = excluded ? null : byType.get(t.type) ?? pooled;
    if (!excluded) estimated[estimate?.basis ?? 'unknown'] += 1;
    return {
      id: t.id,
      title: t.title,
      owner: owner ?? `unseated:${t.workstream}`,
      duration_hours: estimate ? { low: estimate.low, high: estimate.high } : null,
      blocked_by: input.blockers.get(t.id) ?? [],
      human_boundary: boundaryOf(t),
      excluded: excluded?.reason,
    };
  });

  const result: Forecast = forecast(jobs);
  const owners = new Map(jobs.map((j) => [j.id, j.owner]));
  const unknownReason = (id: string): string => {
    const job = jobs.find((j) => j.id === id);
    const external = (job?.blocked_by ?? []).filter((b) => !jobs.some((j) => j.id === b && !j.excluded));
    if (external.length) return `Waits on ${external.join(', ')}, which is not itself runway`;
    // Everything it waits on IS runway and it still could not be placed: the
    // prerequisites run in a circle, which no amount of waiting resolves.
    if (job?.duration_hours && job.blocked_by?.length) return `Prerequisites form a cycle with ${job.blocked_by.join(', ')}`;
    const type = input.tickets.find((t) => t.id === id)?.type ?? 'this work';
    return `No comparable closed ${type} work to measure (${samples_by_type[type] ?? 0} of ${MIN_SAMPLES} needed)`;
  };

  return {
    as_of: input.as_of,
    unavailable: null,
    range: result.range,
    floor: result.floor,
    outcomes: result.outcomes.map((o) => ({ id: o.id, title: o.title, owner: o.owner, finishes_after: o.finishes_after })),
    first_human_boundary: result.first_human_boundary
      ? { ...result.first_human_boundary, title: titles.get(result.first_human_boundary.id) ?? result.first_human_boundary.id }
      : null,
    unknown_duration: result.unknown_duration.map((id) => ({
      id, title: titles.get(id) ?? id, owner: owners.get(id) ?? '', reason: unknownReason(id),
    })),
    excluded: result.excluded.map((x) => ({
      id: x.id, title: titles.get(x.id) ?? x.id, reason: x.reason, detail: details.get(x.id)?.detail ?? '',
    })),
    coverage: {
      ...empty,
      samples_by_type,
      estimated,
      seats: {
        available: seats.filter((s) => CAN_DRAW.has(s.state)).map((s) => s.agent),
        unavailable: seats.filter((s) => !CAN_DRAW.has(s.state)).map((s) => ({ agent: s.agent, state: s.state })),
      },
    },
  };
}
