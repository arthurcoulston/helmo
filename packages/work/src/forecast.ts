/** A bounded forecast input. The caller owns eligibility and estimates; this
 * module owns only dependency/concurrency arithmetic, so it cannot quietly
 * turn a backlog row into authorised work or invent a duration. */
export interface ForecastJob {
  id: string;
  title: string;
  owner: string;
  duration_hours: { low: number; high: number } | null;
  blocked_by?: string[];
  human_boundary?: string;
  excluded?: 'hold' | 'date_gate' | 'finite_limit' | 'unavailable_seat' | 'missing_human_input';
}

export interface Forecast {
  range: { low: number; high: number } | null;
  outcomes: { id: string; title: string; owner: string; starts_after: { low: number; high: number }; finishes_after: { low: number; high: number } }[];
  first_human_boundary: { id: string; after: { low: number; high: number }; reason: string } | null;
  unknown_duration: string[];
  excluded: { id: string; reason: NonNullable<ForecastJob['excluded']> }[];
}

const sum = (a: { low: number; high: number }, b: { low: number; high: number }) => ({ low: a.low + b.low, high: a.high + b.high });
const max = (...xs: { low: number; high: number }[]) => ({ low: Math.max(0, ...xs.map((x) => x.low)), high: Math.max(0, ...xs.map((x) => x.high)) });

/** Schedule one worker at a time per owner, while independent owners run in
 * parallel. Input order is priority order. A dependency not present in the
 * admitted set is an external boundary and excludes its dependent branch. */
export function forecast(jobs: ForecastJob[]): Forecast {
  const excluded = jobs.flatMap((j) => j.excluded ? [{ id: j.id, reason: j.excluded }] : []);
  const admitted = jobs.filter((j) => !j.excluded);
  const ids = new Set(admitted.map((j) => j.id));
  const scheduled = new Map<string, { low: number; high: number }>();
  const ownerAt = new Map<string, { low: number; high: number }>();
  const outcomes: Forecast['outcomes'] = [];
  const unknown = new Set<string>();
  const pending = [...admitted];

  while (pending.length) {
    const at = pending.findIndex((j) => (j.blocked_by ?? []).every((id) => !ids.has(id) || scheduled.has(id)));
    if (at < 0) { for (const j of pending) unknown.add(j.id); break; }
    const job = pending.splice(at, 1)[0]!;
    const external = (job.blocked_by ?? []).some((id) => !ids.has(id));
    if (external || !job.duration_hours) { unknown.add(job.id); continue; }
    const start = max(ownerAt.get(job.owner) ?? { low: 0, high: 0 }, ...(job.blocked_by ?? []).flatMap((id) => scheduled.get(id) ?? []));
    const finish = sum(start, job.duration_hours);
    scheduled.set(job.id, finish);
    ownerAt.set(job.owner, finish);
    outcomes.push({ id: job.id, title: job.title, owner: job.owner, starts_after: start, finishes_after: finish });
  }

  const boundaries = admitted.flatMap((j) => {
    if (!j.human_boundary) return [];
    const finish = scheduled.get(j.id);
    return finish ? [{ id: j.id, after: finish, reason: j.human_boundary }] : [];
  }).sort((a, b) => a.after.low - b.after.low || a.after.high - b.after.high);
  return {
    range: unknown.size || !outcomes.length ? null : max(...outcomes.map((o) => o.finishes_after)),
    outcomes,
    first_human_boundary: boundaries[0] ?? null,
    unknown_duration: [...unknown],
    excluded,
  };
}
