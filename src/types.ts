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
  reason: 'no_completion' | 'missing_verdict' | 'stale_verdict' | 'self_authored_verdict' | 'review_failed' | 'independently_accepted';
  completion: ProductCompletion | null;
  verdict: AcceptanceVerdict | null;
}

export interface TicketProgress {
  at: string;
  note: string;
  actor: Pick<Actor, 'name' | 'kind'>;
}

export interface Question {
  situation: string;
  question: string;
  options: { label: string; consequence: string }[];
  recommendation: string;
  if_unanswered?: string;
}

export interface Answer {
  answer: string;
  chosen_option?: string;
  resolution: 'resume' | 'done' | 'cancelled';
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
  question: Question | null;
  tokens_total: number;
  cost_usd_total: number;
  schedule: string | null; // set = recurring template (spawns instances, never ready itself)
  not_before: string | null; // ISO instant before which the ticket is withheld from ready queues (H-732)
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Dep {
  from_id: string;
  to_id: string;
  type: DepType;
}

export type EventType = 'created' | 'updated' | 'returned' | 'answered' | 'linked' | 'unlinked' | 'spend' | 'workstream_set' | 'workstream_renamed' | 'hygiene_disposed' | 'notice_set' | 'product_completed' | 'acceptance_verdict';

/** The standing notice: a one-line current priority with its provenance,
 *  riding along on every ticket-queue response the way workstream steering
 *  does. Helmo knows nothing about what writes it (a roadmap tool, a meeting,
 *  a script); it is disclosure to the fleet, not tasking. */
export interface Notice {
  text: string;
  provenance: string;
  updated_at: string;
}

/** Operator steering for a stream of work (H-55). `goal` is what "done" means
 *  for the whole stream — the thing that makes "is this still worth doing?"
 *  answerable. `budget_usd` is a disclosed plan, not a kill switch. */
export interface Workstream {
  name: string;
  goal: string | null;
  budget_usd: number | null;
  updated_at: string;
}

export interface WorkstreamInfo extends Workstream {
  spent_usd: number;
  remaining_usd: number | null; // null when no budget is set
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
