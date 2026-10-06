import { createHash } from 'node:crypto';
import { AVATAR_MARKS } from './estate-avatars.generated.js';
import { ActionRequest, ActorKind, Evidence, HumanRequest, Question, Ticket } from './types.js';

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
