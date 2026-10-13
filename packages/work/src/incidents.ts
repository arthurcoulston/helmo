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
