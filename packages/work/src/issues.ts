export type UnknownReason = 'not_recorded' | 'source_unavailable';
export type RecordedValue<T> =
  | { state: 'known'; value: T; source_ref: string; recorded_at: string }
  | { state: 'unknown'; reason: UnknownReason };

export type IssueSubjectKind = 'ticket' | 'workstream' | 'runtime';
export type IssueDisposition =
  | { state: 'active'; owner: RecordedValue<string | null>; next_action: RecordedValue<string> }
  | { state: 'accepted'; owner: RecordedValue<string | null>; reason: RecordedValue<string> }
  | { state: 'resolved'; owner: RecordedValue<string | null>; evidence: RecordedValue<unknown>[] };

export interface IssueRow {
  key: string;
  check: string;
  subject_kind: IssueSubjectKind;
  subject_ref: string;
  detail: RecordedValue<string>;
  first_observed_at: string;
  latest_observed_at: string;
  observation_count: number;
  recurrence_count: number;
  disposition: IssueDisposition;
  incident_id?: string;
}

export type IssueEvent =
  | { seq: number; ts: string; type: 'issue_observed'; payload: { key: string; check: string; subject_kind: IssueSubjectKind; subject_ref: string; detail: RecordedValue<string>; owner: RecordedValue<string | null>; next_action: RecordedValue<string>; incident_id?: string } }
  | { seq: number; ts: string; type: 'issue_disposed'; payload: { key: string; disposition: IssueDisposition } };

export interface IssuesSnapshot {
  as_of: string;
  coverage: { state: 'available' | 'missing'; source: string };
  active: IssueRow[];
  history: IssueRow[];
}

export function issueKey(check: string, subjectKind: IssueSubjectKind, subjectRef: string): string {
  return [check, subjectKind, subjectRef].map(encodeURIComponent).join('|');
}

export function replayIssues(events: IssueEvent[], asOf: string, historyDays = 30): IssuesSnapshot {
  const rows = new Map<string, IssueRow>();
  const resolvedAt = new Map<string, string>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.ts > asOf) continue;
    if (event.type === 'issue_observed') {
      const p = event.payload;
      const old = rows.get(p.key);
      rows.set(p.key, {
        key: p.key, check: p.check, subject_kind: p.subject_kind, subject_ref: p.subject_ref,
        detail: p.detail, first_observed_at: old?.first_observed_at ?? event.ts,
        latest_observed_at: event.ts, observation_count: (old?.observation_count ?? 0) + 1,
        recurrence_count: (old?.recurrence_count ?? 0) + (old && old.disposition.state !== 'active' ? 1 : 0),
        disposition: { state: 'active', owner: p.owner, next_action: p.next_action },
        ...(p.incident_id ? { incident_id: p.incident_id } : old?.incident_id ? { incident_id: old.incident_id } : {}),
      });
      resolvedAt.delete(p.key);
    } else {
      const old = rows.get(event.payload.key);
      if (!old) throw new Error(`Issue ${event.payload.key} has no observation.`);
      rows.set(old.key, { ...old, disposition: event.payload.disposition });
      if (event.payload.disposition.state !== 'active') resolvedAt.set(old.key, event.ts);
    }
  }
  const cutoff = Date.parse(asOf) - historyDays * 86_400_000;
  const active: IssueRow[] = [], history: IssueRow[] = [];
  for (const row of rows.values()) {
    const at = resolvedAt.get(row.key);
    if (row.disposition.state === 'active' || !at || Date.parse(at) >= cutoff) active.push(row);
    else history.push(row);
  }
  const newest = (a: IssueRow, b: IssueRow) => b.latest_observed_at.localeCompare(a.latest_observed_at);
  return { as_of: asOf, coverage: { state: 'available', source: 'work:event-log' }, active: active.sort(newest), history: history.sort(newest) };
}
