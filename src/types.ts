export const STATUSES = ['open', 'in_progress', 'awaiting_human', 'done', 'cancelled'] as const;
export type Status = (typeof STATUSES)[number];

export const DEP_TYPES = ['blocks', 'parent', 'discovered_from', 'relates'] as const;
export type DepType = (typeof DEP_TYPES)[number];

export const BLAST_RADII = ['none', 'draft', 'records', 'sent', 'published'] as const;
export type BlastRadius = (typeof BLAST_RADII)[number];

export const CONFIDENCES = ['routine', 'spot_check', 'needs_review'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const ACTOR_KINDS = ['agent', 'orchestrator', 'human'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface Actor {
  name: string;
  kind: ActorKind;
  model?: string;
  version?: string;
  session?: string;
}

/** Who to record as the writer, given what the caller passed and what the
 *  server environment holds. Identity — name, kind, model, version — is the
 *  caller's to state. The `session` stamp is not: it says WHICH live process
 *  is writing, rev injects it into a loop server's HELMO_ACTOR as the seat id
 *  ("rev:mason"), and an agent inside that loop has no way to know its own.
 *  So an explicit actor, which the tool guidance asks interactive sessions to
 *  send on every write, must not silently strip it. One that did left a
 *  stampless claim, and rev's same-seat guard (H-558) then read the loop's own
 *  finished work as another live session and stood the seat down for 24 hours
 *  (H-687). A caller that states its own session keeps it. */
export function writingActor(override: Actor | undefined, env: Actor | null): Actor {
  if (!override) return env ?? ({} as Actor);
  if (override.session || !env?.session) return override;
  return { ...override, session: env.session };
}

export interface Evidence {
  kind: 'commit' | 'file' | 'url' | 'draft' | 'other';
  ref: string;
  note?: string;
}

export interface ProductArtifact {
  /** Immutable source snapshot. Full commit hashes are required so an
   *  acceptance remains tied to one unambiguous tree. */
  ref: string;
  author: string;
}

export interface ProductCompletion {
  seq: number;
  ts: string;
  actor: Actor;
  artifacts: ProductArtifact[];
  note: string;
}

export interface AcceptanceVerdict {
  seq: number;
  ts: string;
  actor: Actor;
  refs: string[];
  verdict: 'pass' | 'fail';
  note: string;
}

export interface ProductAcceptance {
  state: 'not_requested' | 'pending' | 'failed' | 'accepted';
  /** `contested` is deliberately distinct from `review_failed`: the release
   *  path treats them identically — neither ships — but a human reading the
   *  dashboard needs to know whether the reviewers agree it failed or whether
   *  they disagree. Agreement between agents is cheap; disagreement is the
   *  expensive signal, and collapsing the two would lose it (R-34 §0.4). */
  reason: 'no_completion' | 'missing_verdict' | 'stale_verdict' | 'self_authored_verdict' | 'review_failed' | 'contested' | 'independently_accepted';
  completion: ProductCompletion | null;
  /** The verdict that GOVERNS: the earliest standing FAIL if one exists, and
   *  otherwise the newest PASS. Readers that predate the verdict set keep
   *  working unchanged. */
  verdict: AcceptanceVerdict | null;
  /** Every qualifying verdict on the current completion, in `seq` order,
   *  including a reviewer's superseded earlier opinions. Disagreement is
   *  reported here, never resolved away. */
  verdicts: AcceptanceVerdict[];
}

export interface TicketProgress {
  at: string;
  note: string;
  actor: Pick<Actor, 'name' | 'kind'>;
}

/** What one return asks the human, in the order it is read (H-939). The issue
 *  first — `situation` then `question` — and then EITHER the recommendation on
 *  its own OR two or three genuinely equal choices. Options are optional
 *  because requiring them made every asker invent alternatives to satisfy the
 *  schema, and a manufactured choice costs the reader the same attention as a
 *  real one. Stored normalised: an asker who sends none gets `[]`, never
 *  undefined, so no reader has two shapes to handle. */
export interface Question {
  situation: string;
  question: string;
  options: { label: string; consequence: string }[];
  recommendation: string;
  if_unanswered?: string;
}

/** What an asker may send: `options` omitted entirely when the recommendation
 *  stands on its own. The stored Question always carries the array. */
export type QuestionInput = Omit<Question, 'options'> & { options?: Question['options'] };

/** What one request asks the human to DO (R-42 I13). Arthur's complaint was
 *  that agents used the question path for two different things — "decide this"
 *  and "please go and do this" — and he could not tell which, so an action
 *  came back through Ratify as though it were permission.
 *
 *  `why_human` is the field that keeps them apart. If the honest answer is
 *  "an agent could do this, I just want it approved first", there is no action
 *  to request and the asker owes a decision instead. Requiring the reason is
 *  the only place that distinction cannot be skipped. */
export interface ActionRequest {
  situation: string;
  /** What the human does, concretely enough to act on without opening the
   *  ticket, and roughly what it costs them. */
  action: string;
  /** Why this needs the human's own hands rather than an agent's. */
  why_human: string;
  if_unanswered?: string;
}

/** The stored pending request, discriminated. A request written before the
 *  kind existed carries no `kind` and reads as a decision, which is what it
 *  was: R-42's migration rule is that no new meaning is inferred from an old
 *  record, and every kind is explicit from its first write. */
export type HumanRequest =
  | ({ kind: 'decision' } & Question)
  | ({ kind: 'action' } & ActionRequest);

export const REQUEST_KINDS = ['decision', 'action'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** The human reporting that they did it. Deliberately NOT an `Answer`: there
 *  is no `resolution` and no `chosen_option`, so this cannot close a ticket
 *  and cannot record a choice. A completed action is not permission, and it is
 *  not the agent's later verification that the action worked; those are three
 *  separate records and the shape is what holds them apart. */
export interface ActionReport {
  /** What they actually did, in their own words. */
  did: string;
}

/** One recorded action report, as the sweep and any auditor read it back. */
export interface ActedEvent {
  seq: number;
  ts: string;
  ticket_id: string;
  actor: Pick<Actor, 'name' | 'kind'> & { session?: string };
  did: string;
}

export interface Answer {
  answer: string;
  chosen_option?: string;
  resolution: 'resume' | 'done' | 'cancelled';
}

/** One recorded answer, as the sweep and any auditor read it back: who
 *  wrote it, on what, and what they said. The actor's session is carried
 *  because it is the channel — 'dashboard' answers arrive without a meeting. */
export interface AnswerEvent {
  seq: number;
  ts: string;
  ticket_id: string;
  actor: Pick<Actor, 'name' | 'kind'> & { session?: string };
  resolution: Answer['resolution'];
  chosen_option?: string;
  answer: string;
}

/** One recorded acceptance verdict, as the sweep and any auditor read it
 *  back. Helmo's actor is caller-supplied and the store file is
 *  user-writable, so a verdict in a reviewer's name is only as trustworthy as
 *  the daily replay that shows it to them (H-1830). The ticket's current
 *  workstream rides along because that is how the sweep scopes its read. */
export interface VerdictEvent {
  seq: number;
  ts: string;
  ticket_id: string;
  workstream: string;
  actor: Pick<Actor, 'name' | 'kind'> & { session?: string };
  refs: string[];
  verdict: 'pass' | 'fail';
  note: string;
}

export interface Ticket {
  id: string;
  title: string;
  body: string;
  workstream: string;
  project: string | null; // optional grouping tag, e.g. a roadmap project id — the join key for rollups
  type: string;
  labels: string[];
  status: Status;
  priority: number;
  assignee: string | null;
  evidence: Evidence[];
  confidence: Confidence | null;
  uncertainty_note: string | null;
  blast_radius: BlastRadius;
  /** The pending DECISION, unchanged in type and meaning. An action-pending
   *  ticket leaves this null, so a reader that knows only about questions
   *  cannot mistake an action for one. */
  question: Question | null;
  action: ActionRequest | null; // the pending ACTION for the human (R-42 I13)
  tokens_total: number;
  cost_usd_total: number;
  schedule: string | null; // set = recurring template (spawns instances, never ready itself)
  not_before: string | null; // ISO instant before which the ticket is withheld from ready queues (H-732)
  needs_human: boolean; // open work requiring a sitting with the operator; withheld from agent queues
  sitting: string | null; // what that sitting needs from the operator, in one line (H-1761)
  sitting_with: string | null; // the agent to sit with; a prose line cannot be asked which one (R-42 I13)
  capacity_hold: CapacityHold | null; // deliberate spending hold; visible, never ready or directly claimable
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface CapacityHold {
  reason: string;
  provenance: string;
  reconsider_when: string;
  release?: CapacityRelease;
}

export interface CapacityRelease {
  batch_id: string;
  until: string;
  stop_conditions: string;
  shared_reserve: string;
}

export interface Dep {
  from_id: string;
  to_id: string;
  type: DepType;
}

export type EventType = 'created' | 'updated' | 'returned' | 'answered' | 'linked' | 'unlinked' | 'spend' | 'workstream_set' | 'workstream_renamed' | 'hygiene_disposed' | 'notice_set' | 'product_completed' | 'acceptance_verdict' | 'acted';

/** The standing notice: a one-line current priority with its provenance,
 *  riding along on every ticket-queue response the way workstream steering
 *  does. Helmo knows nothing about what writes it (a roadmap tool, a meeting,
 *  a script); it is disclosure to the fleet, not tasking. */
export interface Notice {
  text: string;
  provenance: string;
  updated_at: string;
}

/** Operator steering for a stream of work (H-55): numbers and names only.
 *  `budget_usd` is a disclosed plan, not a kill switch. There is no `goal`:
 *  standing prose in a store field is agent context outside caps and review
 *  (retired H-1186); the column persists for replay only. */
export interface Workstream {
  name: string;
  budget_usd: number | null;
  seat: string | null; // the agent unassigned filings here are reserved to at creation (H-1026)
  updated_at: string;
}

export interface WorkstreamInfo extends Workstream {
  spent_usd: number;
  remaining_usd: number | null; // null when no finite cap is set (budget null or zero)
}

export interface HelmoEvent {
  seq: number;
  ts: string;
  ticket_id: string;
  event_type: EventType;
  actor: Actor;
  payload: Record<string, unknown>;
}

export class HelmoError extends Error {}
