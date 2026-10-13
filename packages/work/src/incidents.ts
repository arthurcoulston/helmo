import type { RecordedValue } from './issues.js';

export type IncidentStage = 'investigating' | 'mitigated' | 'resolved';
export type IncidentEvidence = RecordedValue<unknown>;
export interface IncidentRecord {
  ticket_id: string;
  stage: RecordedValue<IncidentStage>;
  owner: RecordedValue<string | null>;
  detection: RecordedValue<{ by: 'agent' | 'automated_check' | 'human'; happened_at: string }>;
  affected: RecordedValue<string>;
  happening_now: RecordedValue<boolean>;
  cause: RecordedValue<{ account: string; confidence: 'known' | 'suspected' | 'unknown' }>;
  containment: RecordedValue<string>;
  fix: RecordedValue<string>;
  recovery_evidence: IncidentEvidence[];
  recurrence_evidence: IncidentEvidence[];
  human_report_acknowledgement: RecordedValue<{ acknowledged_at: string }>;
  remaining_work: RecordedValue<{ account: string; owner: string }>[];
}

export type IncidentPatch = Partial<Omit<IncidentRecord, 'ticket_id'>>;
export interface IncidentEvent { seq: number; ts: string; ticket_id: string; payload: { patch: IncidentPatch } }

/** Every field explicitly not yet recorded. An incident is opened onto this,
 *  so no field is ever absent: Unknown is a statement the view can render and
 *  the guards can read, while a missing key is neither. */
export function blankIncident(ticketId: string): IncidentRecord {
  const unknown = { state: 'unknown', reason: 'not_recorded' } as const;
  return {
    ticket_id: ticketId, stage: unknown, owner: unknown, detection: unknown, affected: unknown,
    happening_now: unknown, cause: unknown, containment: unknown, fix: unknown,
    recovery_evidence: [], recurrence_evidence: [], human_report_acknowledgement: unknown, remaining_work: [],
  };
}

export function replayIncidents(events: IncidentEvent[], asOf: string): IncidentRecord[] {
  const incidents = new Map<string, IncidentRecord>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.ts > asOf) continue;
    const old = incidents.get(event.ticket_id);
    if (!old && !event.payload.patch.stage) throw new Error(`Incident ${event.ticket_id} has no opening stage.`);
    incidents.set(event.ticket_id, { ...(old ?? blankIncident(event.ticket_id)), ...event.payload.patch });
  }
  return [...incidents.values()].sort((a, b) => {
    const rank = (row: IncidentRecord) => row.stage.state === 'known' && row.stage.value === 'resolved' ? 1 : 0;
    return rank(a) - rank(b) || a.ticket_id.localeCompare(b.ticket_id, undefined, { numeric: true });
  });
}

export function assertIncident(record: IncidentRecord): void {
  if (record.stage.state !== 'known') throw new Error('Incident stage must be known.');
  if (record.stage.value === 'mitigated' && record.containment.state !== 'known') throw new Error('Mitigation requires known containment.');
  if (record.stage.value !== 'resolved') return;
  if (record.cause.state !== 'known' || !record.cause.value.account.trim()) throw new Error('Resolution requires a recorded cause account.');
  if (record.fix.state !== 'known') throw new Error('Resolution requires a known fix.');
  if (!record.recovery_evidence.some((item) => item.state === 'known')) throw new Error('Resolution requires known recovery evidence.');
  if (record.remaining_work.some((item) => item.state !== 'known' || !item.value.owner.trim())) throw new Error('Resolution requires every remaining-work item to have an owner.');
}

/* ---------- notices: the incident as the operator hears about it ---------- */

/** The fields whose change is Arthur's business (H-3216).
 *
 *  Deliberately a fixed list, and deliberately not every field. Recovery and
 *  recurrence proof accumulate on an open incident without changing what he
 *  would do about it, and the stage move that makes that proof matter is
 *  itself on this list. A notice names these CODES and never free text, so no
 *  writer can put an unreviewed sentence on his dashboard. */
const MATERIAL: (keyof IncidentPatch)[] = [
  'stage', 'happening_now', 'affected', 'owner', 'cause', 'containment', 'fix',
  'human_report_acknowledgement', 'remaining_work',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** A recorded field reduced to what it MEANS — its state and value, without
 *  the source and instant it was stamped with.
 *
 *  Re-recording a field with the value it already held is not news, and
 *  through the real write path that is exactly what happens: every recording
 *  stamps a fresh `recorded_at` and its own `source_ref`, so comparing whole
 *  recorded values announced an owner "change" from mason to mason. The stamp
 *  stays on the record, where a reader can see it; what reaches the dashboard
 *  is a change in what is known. */
function meaning(field: unknown): string {
  const strip = (item: unknown) => {
    const row = item as { state?: string; value?: unknown; reason?: unknown };
    if (!row || typeof row !== 'object' || typeof row.state !== 'string') return item;
    return row.state === 'known' ? { state: 'known', value: row.value } : { state: 'unknown', reason: row.reason };
  };
  return JSON.stringify(Array.isArray(field) ? field.map(strip) : strip(field));
}

export type IncidentMoment = 'identified' | 'material_change' | 'resolved';

export interface IncidentNotice {
  ticket_id: string;
  moment: IncidentMoment;
  /** When the change was RECORDED, which is when he could first have heard. */
  at: string;
  changed: (keyof IncidentPatch)[];
  /** The incident as it stood after this event, so a notice read late still
   *  says what the incident is rather than only what changed. */
  stage: IncidentStage | null;
  happening_now: boolean | null;
}

/** Every moment on an incident's record that is worth the operator's
 *  attention, newest first.
 *
 *  Derived, never stored: recording the incident IS the notification, so there
 *  is no second act an agent can forget and no channel that can disagree with
 *  the record. The retired standing notice (H-1126) is the warning here — a
 *  stored line someone has to maintain goes stale and then lies. */
export function incidentNotices(events: IncidentEvent[], asOf: string): IncidentNotice[] {
  const records = new Map<string, IncidentRecord>();
  const notices: IncidentNotice[] = [];
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.ts > asOf) continue;
    const old = records.get(event.ticket_id) ?? null;
    const next = { ...(old ?? blankIncident(event.ticket_id)), ...event.payload.patch } as IncidentRecord;
    records.set(event.ticket_id, next);
    // Compared by what the fields MEAN, not as patch keys and not as whole
    // stamped values: re-recording a field with what it already said is not
    // news, and a reader who is told an incident changed when it did not
    // learns to ignore the next one.
    const changed = old ? MATERIAL.filter((field) => meaning(old[field]) !== meaning(next[field])) : [];
    const resolved = next.stage.state === 'known' && next.stage.value === 'resolved';
    const moment: IncidentMoment | null = !old
      ? 'identified'
      : resolved && changed.includes('stage')
        ? 'resolved'
        : changed.length
          ? 'material_change'
          : null;
    if (!moment) continue;
    notices.push({
      ticket_id: event.ticket_id,
      moment,
      at: event.ts,
      changed,
      stage: next.stage.state === 'known' ? next.stage.value : null,
      happening_now: next.happening_now.state === 'known' ? next.happening_now.value : null,
    });
  }
  // Built in sequence order, so reversing is newest-first without comparing
  // two spellings of one instant.
  return notices.reverse();
}

export interface IncidentNoticeBoard {
  as_of: string;
  window_started_at: string;
  /** Said here rather than at the server, so the one assembler of this board
   *  is also what tells a reader where it came from. */
  coverage: { state: 'available'; source: string };
  rows: IncidentNotice[];
  /** Notices recorded at all, so a short board cannot read as a quiet record. */
  total: number;
  /** Incidents whose stage is anything but resolved, right now. */
  unresolved: string[];
}

/** The notices the dashboard shows: everything recorded in the rolling day,
 *  plus the LATEST notice of every incident that is still unresolved however
 *  long ago that was.
 *
 *  A day, because nothing on this page can be marked read — the view carries no
 *  record data-entry by constitution — so an expiry is the only thing that can
 *  clear a notice, and the day is the window Overview's other readings already
 *  use. The unresolved exception is the part that matters: an incident nobody
 *  has closed must not age off the surface that is supposed to be telling him
 *  about it.
 *
 *  Its LATEST notice and not its identification, because a notice carries the
 *  incident as it stood when it was recorded: an incident opened as ongoing
 *  nine days ago and contained eight days ago would otherwise have kept
 *  saying "still happening" from the one row old enough to survive the
 *  window. */
export function incidentNoticeBoard(events: IncidentEvent[], asOf: string): IncidentNoticeBoard {
  const notices = incidentNotices(events, asOf);
  const records = replayIncidents(events, asOf);
  const unresolved = records
    .filter((row) => !(row.stage.state === 'known' && row.stage.value === 'resolved'))
    .map((row) => row.ticket_id);
  const since = new Date(new Date(asOf).getTime() - DAY_MS).toISOString();
  const sinceMs = Date.parse(since);
  // Newest first, so the first notice seen for an incident is its latest.
  const latest = new Map<string, IncidentNotice>();
  for (const notice of notices) if (!latest.has(notice.ticket_id)) latest.set(notice.ticket_id, notice);
  return {
    as_of: asOf,
    window_started_at: since,
    coverage: { state: 'available', source: 'work:event-log' },
    total: notices.length,
    unresolved,
    rows: notices.filter(
      (notice) =>
        Date.parse(notice.at) > sinceMs ||
        (unresolved.includes(notice.ticket_id) && latest.get(notice.ticket_id) === notice),
    ),
  };
}
