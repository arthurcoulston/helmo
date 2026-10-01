// A project is durable where a ticket is disposable: it accumulates and gets
// rewritten over months, and it is never ready work — you claim its tickets,
// never the project itself (PRODUCT.md).

// The ladder (ratified by Arthur 2026-09-02, H-672): parked · shaping · ready
// are The List — refined and ranked, never worked. ship_next is THE work
// phase, entered only through the human's recorded go-ahead (several may hold
// it, with resistance — a growing set is a problem the surfaces must show).
// shipped_watching (newly shipped: monitoring, loose ends) and shipped_stable
// (low maintenance, and a standing decision the maintenance is worth it) are
// post-ship, not terminal. archived is the one terminal state: ran its
// course, surfaces closed — killed-before-shipping ideas land here too.
export const STATUSES = ['parked', 'shaping', 'ready', 'ship_next', 'shipped_watching', 'shipped_stable', 'archived'] as const;
export type Status = (typeof STATUSES)[number];

export const TERMINAL: readonly Status[] = ['archived'];

/** The statuses that count as "has shipped": they release blocks-deps and are
 *  reachable only through ship_next — work no human declared go on cannot
 *  ship. (archived releases blockers too: a vanished prerequisite should not
 *  pin its dependents forever.) */
export const SHIPPED: readonly Status[] = ['shipped_watching', 'shipped_stable'];

export const DEP_TYPES = ['blocks', 'relates'] as const;
export type DepType = (typeof DEP_TYPES)[number];

export const VALUE_LEVELS = ['high', 'medium', 'low'] as const;
export type ValueLevel = (typeof VALUE_LEVELS)[number];

export const EFFORT_SIZES = ['S', 'M', 'L', 'XL'] as const;
export type EffortSize = (typeof EFFORT_SIZES)[number];

export const HORIZONS = ['near', 'long', 'standing'] as const;
export type Horizon = (typeof HORIZONS)[number];

export const ACTOR_KINDS = ['agent', 'orchestrator', 'human'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface Actor {
  name: string;
  kind: ActorKind;
  model?: string;
  version?: string;
  session?: string;
}

/** A judgment is never a naked number: author, date, and a one-line reason
 *  ride with it, or the score decays into decoration (PRODUCT.md). */
export interface Claim {
  kind: 'value' | 'effort';
  level?: ValueLevel; // value claims
  size?: EffortSize; // effort claims
  predicted_usd?: number; // effort claims: the falsifiable dollar prediction
  reason: string;
  author: string;
  ts: string;
}

/** How a project advances an objective — checkable prose, not a weight. */
export interface Citation {
  objective_id: string;
  claim: string;
}

/** Charter projection: derived from the human's own document, never authored
 *  here. Objectives are dials (a project advances one); bets are claims about
 *  the world with a stake and a falsifier. Gates and stances are deliberately
 *  absent from v1 behavior — the shape vocabulary leaves them room. */
export interface Objective {
  id: string; // OBJ-n
  statement: string;
  horizon: Horizon;
  rank: number; // the human's ordering of the few durable things; 1 = top
  source: string; // pointer to the authoritative document
  derived_at: string;
}

export interface Bet {
  id: string; // BET-n
  statement: string;
  stake: string;
  falsifier: string;
  source: string;
  derived_at: string;
}

export interface Project {
  id: string; // R-n
  title: string;
  body: string;
  status: Status;
  parked_reason: string | null;
  unpark_condition: string | null; // parking carries its own exit
  actual_usd: number; // rolled up from Helmo tickets by the sweep, never self-reported
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Dep {
  from_id: string;
  to_id: string;
  type: DepType;
}

export interface Ranked {
  project: Project;
  rank: number; // 1-based position in the derived order
  explanation: string; // every rank explainable in one line
  blocked_by: string[];
  citations: Citation[];
  value: Claim | null; // latest value claim
  effort: Claim | null; // latest effort claim
}

export interface ProjectSnapshot {
  project: Project;
  revision: number; // the project's own record as of this read; see Store.projectSnapshot
  readiness_revision: number; // latest non-verdict event; stable across reviewers of identical state
  blocked_by: string[];
  deps: { outgoing: Dep[]; incoming: Dep[] };
  claims: Claim[];
  citations: Citation[];
  events: RoadmapEvent[];
  readiness: ReadinessReview | null;
}

export interface ReadinessVerdict {
  verdict: 'pass' | 'fail';
  note: string;
  reviewer: string;
  reviewed_revision: number;
  ts: string;
}

export interface ReadinessReview {
  reviewed_revision: number;
  state: 'ready' | 'failed' | 'contested';
  verdicts: ReadinessVerdict[];
}

export type EventType =
  | 'created' | 'updated' | 'claim_recorded' | 'cited' | 'uncited'
  | 'linked' | 'unlinked' | 'ship_next_set' | 'actual_recorded'
  | 'objective_set' | 'bet_set' | 'readiness_verdict_recorded';

export interface RoadmapEvent {
  seq: number;
  ts: string;
  subject_id: string; // R-n, OBJ-n, or BET-n
  event_type: EventType;
  actor: Actor;
  payload: Record<string, unknown>;
}

export class RoadmapError extends Error {}
