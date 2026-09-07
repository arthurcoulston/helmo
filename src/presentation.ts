import { createHash } from 'node:crypto';
import { AVATAR_MARKS } from './estate-avatars.generated.js';
import { ActorKind, Question, Ticket } from './types.js';

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
