import { ExclusionReason, RunwayDocument } from './runway.js';
import { ActivityEvents, CauseOnset, Ticket } from './types.js';

export type QuietClass = 'finished' | 'held' | 'waiting' | 'no_continuation' | 'unknown';
export type CauseCoverage = 'before_since' | 'during' | 'undatable';

export interface ContinuationGap {
  id: string;
  title: string;
  updated_at: string;
  last_progress_note: string | null;
}

export interface QuietReason {
  id: string;
  title: string;
  reason: ExclusionReason;
  detail: string;
  at: string | null;
  covered: CauseCoverage;
}

export interface QuietAccount {
  as_of: string;
  since: string;
  class: QuietClass;
  completion_ids: string[];
  reasons: QuietReason[];
  continuations: ContinuationGap[];
  activity: ActivityEvents;
}

export interface QuietInput {
  tickets: Ticket[];
  exclusions: RunwayDocument['excluded'];
  activity: ActivityEvents;
  /** `ship_next` projects with no open Work ticket carrying their project id. */
  continuations: ContinuationGap[];
  onsets: CauseOnset[];
  since: string;
  as_of: string;
}

const datable = (reason: ExclusionReason): CauseOnset['cause'] | null =>
  reason === 'hold' || reason === 'date_gate' || reason === 'missing_human_input' ? reason : null;

const live = (ticket: Ticket): boolean => !['done', 'cancelled'].includes(ticket.status) && !ticket.schedule;

/** Why a check-in interval was quiet, using only retained records.
 *
 * Current exclusions remain useful evidence even when they cannot speak for
 * the interval. The `covered` field makes that boundary explicit instead of
 * discarding the reason or silently turning a present fact into past tense. */
export function quietAccount(input: QuietInput): QuietAccount {
  const sinceMs = new Date(input.since).getTime();
  const asOfMs = new Date(input.as_of).getTime();
  if (Number.isNaN(sinceMs) || Number.isNaN(asOfMs) || sinceMs > asOfMs) {
    throw new Error(`quietAccount needs an interval at or before as_of; got since="${input.since}", as_of="${input.as_of}".`);
  }

  const onsetByCause = new Map(input.onsets.map((onset) => [`${onset.id}:${onset.cause}`, onset]));
  const reasons = input.exclusions.map((excluded): QuietReason => {
    const cause = datable(excluded.reason);
    const onset = cause ? onsetByCause.get(`${excluded.id}:${cause}`) : undefined;
    return {
      ...excluded,
      at: onset?.at ?? null,
      covered: !onset
        ? 'undatable'
        : new Date(onset.at).getTime() <= sinceMs
          ? 'before_since'
          : 'during',
    };
  });

  const eligible = input.tickets.filter(live);
  const excludedIds = new Set(reasons.map((reason) => reason.id));
  const unexcluded = eligible.some((ticket) => !excludedIds.has(ticket.id));
  const allCovered = reasons.every((reason) => reason.covered === 'before_since');
  const allReasons = (...allowed: ExclusionReason[]) =>
    eligible.length > 0 && reasons.length === eligible.length && reasons.every((reason) => allowed.includes(reason.reason));

  let classification: QuietClass = 'unknown';
  if (input.activity.completions.length > 0 && !unexcluded) classification = 'finished';
  else if (allReasons('hold', 'date_gate') && allCovered) classification = 'held';
  else if (allReasons('missing_human_input') && allCovered) classification = 'waiting';
  else if (input.continuations.length > 0) classification = 'no_continuation';

  return {
    as_of: input.as_of,
    since: input.since,
    class: classification,
    completion_ids: input.activity.completions.map((event) => event.id),
    reasons,
    continuations: input.continuations,
    activity: input.activity,
  };
}
