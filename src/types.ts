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

export interface Evidence {
  kind: 'commit' | 'file' | 'url' | 'draft' | 'other';
  ref: string;
  note?: string;
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
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Dep {
  from_id: string;
  to_id: string;
  type: DepType;
}

export type EventType = 'created' | 'updated' | 'returned' | 'answered' | 'linked' | 'unlinked' | 'spend' | 'workstream_set';

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
