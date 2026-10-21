// A project is durable where a ticket is disposable: it accumulates and gets
// rewritten over months, and it is never ready work — you claim its tickets,
// never the project itself (PRODUCT.md).

// The seven statuses (decided by Arthur 2026-10-14, recorded in H-2953;
// R46-ROADMAP-CLARITY.md carries the mapping). One value answers one
// question. Proposed is an idea on The List — refined and ranked, never
// worked; how refined is `readiness`, not a status. Planned is the human's
// recorded go with nothing underway yet; Active is the go with work in
// flight — the pair the old `ship_next` conflated, which is the defect R-46
// names first. Monitoring is newly delivered and watched; Completed is the
// outcome verified. Paused is a delivery deliberately on hold — a different
// fact from its health, which says whether it is in trouble. Canceled is the
// one terminal state: ran its course or killed before shipping. Whether a
// row is HIDDEN is the `archived` flag, not a status.
export const STATUSES = ['Proposed', 'Planned', 'Active', 'Monitoring', 'Completed', 'Paused', 'Canceled'] as const;
export type Status = (typeof STATUSES)[number];

/** Every status value a store written before R-46 may still hold, and the
 *  reading it always meant. Events are never rewritten, so these words
 *  outlive the rename: a row reads correctly through every gate below before
 *  the migration writes the new word, and old events replay unchanged.
 *  `parked` and `archived` are the two the migration judges per row — a
 *  parked row is Paused only where a go is on its record, and an archive is
 *  Completed or Canceled by what happened — so these defaults are what an
 *  unmigrated row reads AS, never what the migration writes. */
export const LEGACY_STATUSES = [
  'parked', 'shaping', 'ready', 'ship_next', 'shipping', 'shipped', 'shipped_watching', 'shipped_stable', 'archived', 'abandoned',
] as const;
export type LegacyStatus = (typeof LEGACY_STATUSES)[number];

/** What the status column may hold: today's word, or the one a row was last
 *  written with before R-46. */
export type StoredStatus = Status | LegacyStatus;

export const LEGACY_STATUS_READING: Readonly<Record<LegacyStatus, Status>> = {
  parked: 'Proposed',
  shaping: 'Proposed',
  ready: 'Proposed',
  ship_next: 'Active',
  shipping: 'Active',
  shipped_watching: 'Monitoring',
  shipped: 'Monitoring',
  shipped_stable: 'Completed',
  archived: 'Canceled',
  abandoned: 'Canceled',
};

/** What a stored status means in today's vocabulary. Read gates and tiers
 *  through this, never off the raw column: half the estate's rows carry the
 *  old word until the migration runs, and some events carry it forever. */
export function statusReading(status: string): Status {
  if ((STATUSES as readonly string[]).includes(status)) return status as Status;
  return LEGACY_STATUS_READING[status as LegacyStatus] ?? 'Proposed';
}

export const READINESS = ['raw idea', 'shaped'] as const;
export type Readiness = (typeof READINESS)[number];

export const HEALTH = ['On track', 'At risk', 'Off track'] as const;
export type Health = (typeof HEALTH)[number];

export const TERMINAL: readonly Status[] = ['Canceled'];

/** The statuses that count as "has shipped": they release blocks-deps and are
 *  reachable only through Active — work no human declared go on cannot ship.
 *  (Canceled releases blockers too: a vanished prerequisite should not pin its
 *  dependents forever.) */
export const SHIPPED: readonly Status[] = ['Monitoring', 'Completed'];

/** The human's go is recorded: Planned has it with nothing underway, Active
 *  has it with work in flight. Both are the work phase the surfaces show. */
export const AUTHORIZED: readonly Status[] = ['Planned', 'Active'];

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
  status: StoredStatus; // the stored word; read its meaning with statusReading
  readiness: Readiness;
  health: Health | null;
  health_reason: string | null;
  archived: number; // a hide flag, not a status: the row is Completed or Canceled
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
  | 'objective_set' | 'bet_set' | 'readiness_verdict_recorded' | 'health_recorded';

export interface RoadmapEvent {
  seq: number;
  ts: string;
  subject_id: string; // R-n, OBJ-n, or BET-n
  event_type: EventType;
  actor: Actor;
  payload: Record<string, unknown>;
}

export class RoadmapError extends Error {}
