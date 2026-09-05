// The read feed (R-11 H-832): the state of the work as JSON, beside the page
// that renders it as HTML.
//
// WHY THIS EXISTS AT ALL. The estate shell composes the other product views by
// proxying their HTML untouched, and that is the whole design (R-11 spec,
// decision 3) — except for this one. Arthur's Meeting B decisions put Helmo's
// phone landing on a filter rather than the whole record, and replace the
// answer control with a line of prose, and neither is something you can do to
// someone else's HTML from outside it. So Helmo hands over the data and lets
// the shell draw it. The alternative was the shell opening this store itself,
// which would give a second process a hand on the record and cost it the
// zero-dependency bargain it keeps for exactly the reasons this file does.
// Same shape as health at :4600 reading rev's loop state at :4500 rather than
// re-deriving it: the service that owns the truth serves it.
//
// It needs no new route in the shell. `/s/helmo-view/` is already proxied,
// GET-only, so the shell fetches `/s/helmo-view/tickets.json` same-origin
// through the prefix it already has, and this port stays as unexposed as it
// was — nothing here is reachable that the page beside it did not already
// render to the same reader.
//
// WHAT IT IS NOT. Not an API for agents: they have the MCP tools, which write
// as well as read and enforce the actor identity this cannot. Not a mirror of
// the record: it carries no body, no evidence, no event history and not the
// answer nonce. It is a QUEUE READING — what is live, plus a short tail of what
// just closed — and the full record of any ticket in it is one tap away on the
// page it is served beside.
import { AVATAR_MARKS } from './estate-avatars.generated.js';
import { ActorKind, ProductAcceptance, Question, Ticket, TicketProgress } from './types.js';

const MARKS = new Set<string>(AVATAR_MARKS);

/** The mark for a name, or null — the rule the page's `actor()` draws by, in
 *  one place so the JSON and the HTML cannot disagree about who has a face.
 *  Nothing here maps a member to a kind or invents a mark from a name: the
 *  mark IS the name when the sprite carries it, and a human with no mark of
 *  their own falls back to `person`. An unknown name gets none, which is what
 *  a newly opened seat should look like rather than an error. */
export function markFor(name: string, kind: ActorKind | undefined): string | null {
  if (MARKS.has(name)) return name;
  return kind === 'human' && MARKS.has('person') ? 'person' : null;
}

/** How many closed tickets ride along. Closed work is history, not state, and
 *  the record of it is this page — but a queue with no recently-finished work
 *  in it reads as though nothing has been done, so the reading carries a tail.
 *  Twenty is the top of the band Arthur asked for (Meeting B decision 5: "the
 *  active, the ready, and the last 10–20"); a consumer wanting fewer can take
 *  fewer, and one wanting more wants the page. */
export const CLOSED_TAIL = 20;

const TERMINAL = new Set(['done', 'cancelled']);

/** The letter an option answers to. Assigned here, once, because Arthur says
 *  "b" in a meeting and the agent relaying it reads a different surface than
 *  the one he was looking at — the phone queue, Helmo's own card, the ticket
 *  itself. Two surfaces lettering independently is two answers to what "b" was.
 *  Past 'c' this keeps counting rather than throwing: the contract caps a new
 *  return at three, but a question stored before that cap still has to draw. */
export const letterFor = (i: number): string => String.fromCharCode(97 + i);

/** The ask a reader draws, from the question the agent wrote. */
export function ask(q: Question): FeedAsk {
  return {
    situation: q.situation,
    question: q.question,
    recommendation: q.recommendation,
    ...(q.options?.length
      ? { options: q.options.map((o, i) => ({ letter: letterFor(i), label: o.label, consequence: o.consequence })) }
      : {}),
    ...(q.if_unanswered ? { if_unanswered: q.if_unanswered } : {}),
  };
}

/** One decision as a reader draws it: the issue, then either the
 *  recommendation on its own or the lettered choices. Same order as the
 *  Question the agent wrote — this adds the letters and nothing else. */
export interface FeedAsk {
  situation: string;
  question: string;
  recommendation: string;
  /** Absent when the recommendation stands alone, which is the common shape.
   *  Never an empty array: a reader testing `asks.options` should be testing
   *  whether there is a choice, not whether the list happens to be long. */
  options?: { letter: string; label: string; consequence: string }[];
  if_unanswered?: string;
}

export interface FeedTicket {
  id: string;
  title: string;
  workstream: string;
  status: Ticket['status'];
  priority: number;
  assignee: string | null;
  /** The assignee drawn: the sprite symbol and the frame, both read from the
   *  record. Absent when there is no assignee or no mark for their name. */
  actor?: { mark: string; kind: ActorKind };
  /** The whole ask, on the tickets that are STILL asking (H-939).
   *
   *  It used to be the question string alone, on the reasoning that a queue row
   *  is a reason to open something. It is not: Arthur answers these out loud in
   *  a meeting, and a row that carried the question without the context or the
   *  choices made him open the ticket to answer any of them. So the reading
   *  carries what he decides on — and nothing beyond it. No body, no evidence,
   *  no history; the record of all that is still one tap away.
   *
   *  Keyed on the status rather than on the column: `answerTicket` clears the
   *  question, but a ticket closed straight out of `awaiting_human` by an
   *  update keeps it, and a queue that says "asks you" about settled work is
   *  worse than one that says nothing. */
  asks?: FeedAsk;
  /** Present only when this ticket explicitly entered the product acceptance
   *  contract. This is a recorded gate state, never a claim about a live
   *  reviewer process. */
  acceptance?: Pick<ProductAcceptance, 'state' | 'reason'>;
  /** Latest recorded update, bounded to one note. It says what the record
   *  last heard; it makes no claim that an actor is currently active. */
  progress?: TicketProgress;
  updated_at: string;
  closed_at: string | null;
}

export interface Feed {
  generated_at: string;
  tickets: FeedTicket[];
}

const when = (t: Ticket) => t.closed_at ?? t.updated_at;

/** H-n, as a number. Ids are minted sequentially and never reused, so this is
 *  the record's own answer to "which of these is newer" when two timestamps
 *  are equal — and they are equal more often than they look: a meeting closes
 *  a handful of tickets inside the same millisecond, and a stable sort would
 *  then hand them back oldest-first, which is the opposite of what was asked
 *  for. A malformed id sorts oldest rather than throwing; the feed is not the
 *  place a bad row takes the phone down. */
const seq = (t: Ticket) => Number.parseInt(t.id.replace(/^\D+/, ''), 10) || 0;

/**
 * The reading, from tickets the caller has already listed.
 *
 * Pure, and takes its clock, because everything worth checking here is an
 * ordering or an omission and neither is testable through a live server.
 *
 * ORDER IS PART OF THE CONTRACT: live tickets first in the order they were
 * listed — the store's own priority-then-age order, which is what every other
 * Helmo reader sees — then the closed tail, newest first. A consumer that
 * re-sorts is free to; one that does not still gets the two groups it asked
 * for in the order Arthur asked for them.
 */
export function feed(
  all: Ticket[],
  kinds: Map<string, ActorKind>,
  now: Date = new Date(),
  acceptanceFor?: (ticketId: string) => ProductAcceptance,
  progressFor?: (ticketId: string) => TicketProgress | undefined,
): Feed {
  const live = all.filter((t) => !TERMINAL.has(t.status));
  const closed = all
    .filter((t) => TERMINAL.has(t.status))
    .sort((a, b) => when(b).localeCompare(when(a)) || seq(b) - seq(a))
    .slice(0, CLOSED_TAIL);

  return {
    generated_at: now.toISOString(),
    tickets: [...live, ...closed].map((t) => {
      const kind = t.assignee ? kinds.get(t.assignee) : undefined;
      const mark = t.assignee ? markFor(t.assignee, kind) : null;
      const acceptance = acceptanceFor?.(t.id);
      const progress = progressFor?.(t.id);
      return {
        id: t.id,
        title: t.title,
        workstream: t.workstream,
        status: t.status,
        priority: t.priority,
        assignee: t.assignee,
        ...(mark && kind ? { actor: { mark, kind } } : {}),
        ...(t.status === 'awaiting_human' && t.question ? { asks: ask(t.question) } : {}),
        ...(acceptance && acceptance.state !== 'not_requested'
          ? { acceptance: { state: acceptance.state, reason: acceptance.reason } }
          : {}),
        ...(progress ? { progress } : {}),
        updated_at: t.updated_at,
        closed_at: t.closed_at,
      };
    }),
  };
}
