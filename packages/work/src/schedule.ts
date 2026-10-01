// Schedule expressions for recurring-ticket templates (H-22). Two forms:
//   'every <N><m|h|d>'        — interval from the last instance's due time
//   '<min> <hour> <dom> <mon> <dow>' — 5-field cron: *, */n, lists, ranges
// Zero-dependency by design, like the rest of the store.
import { HelmoError } from './types.js';

const EVERY = /^every\s+(\d+)\s*(m|h|d)$/i;

interface CronField {
  matches(v: number): boolean;
}

function parseCronField(spec: string, min: number, max: number, label: string): CronField {
  const values = new Set<number>();
  for (const part of spec.split(',')) {
    const step = /^(\*|\d+-\d+)\/(\d+)$/.exec(part);
    const range = step ? step[1]! : part;
    const by = step ? parseInt(step[2]!, 10) : 1;
    let lo: number, hi: number;
    if (range === '*') { lo = min; hi = max; }
    else if (/^\d+$/.test(range)) { lo = hi = parseInt(range, 10); }
    else {
      const m = /^(\d+)-(\d+)$/.exec(range);
      if (!m) throw new HelmoError(`Bad ${label} field '${spec}' in schedule. Use *, n, n-m, */k, or comma lists.`);
      lo = parseInt(m[1]!, 10); hi = parseInt(m[2]!, 10);
    }
    if (lo < min || hi > max || lo > hi || by < 1) {
      throw new HelmoError(`${label} field '${spec}' out of range (${min}-${max}).`);
    }
    for (let v = lo; v <= hi; v += by) values.add(v);
  }
  return { matches: (v) => values.has(v) };
}

export interface Schedule {
  /** First occurrence strictly after `after`. */
  next(after: Date): Date;
}

class Interval implements Schedule {
  constructor(private ms: number) {}
  next(after: Date): Date {
    return new Date(after.getTime() + this.ms);
  }
}

class Cron implements Schedule {
  constructor(
    private minute: CronField, private hour: CronField, private dom: CronField,
    private month: CronField, private dow: CronField,
  ) {}
  // Minute-scan is plenty: schedules that match nothing within 400 days are a
  // configuration error, not a use case.
  next(after: Date): Date {
    const t = new Date(after.getTime());
    t.setUTCSeconds(0, 0);
    for (let i = 0; i < 400 * 24 * 60; i++) {
      t.setUTCMinutes(t.getUTCMinutes() + 1);
      if (
        this.minute.matches(t.getUTCMinutes()) && this.hour.matches(t.getUTCHours()) &&
        this.dom.matches(t.getUTCDate()) && this.month.matches(t.getUTCMonth() + 1) &&
        this.dow.matches(t.getUTCDay())
      ) return new Date(t.getTime());
    }
    throw new HelmoError('Schedule never matches within 400 days — check the cron expression.');
  }
}

/** Parse or throw a teaching HelmoError. All times are UTC. */
export function parseSchedule(expr: string): Schedule {
  const every = EVERY.exec(expr.trim());
  if (every) {
    const n = parseInt(every[1]!, 10);
    if (n < 1) throw new HelmoError("Schedule 'every 0x' never fires. Use a positive interval.");
    const unit = every[2]!.toLowerCase();
    return new Interval(n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000));
  }
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new HelmoError(
      `Schedule '${expr}' is neither 'every <N><m|h|d>' nor 5-field cron '<min> <hour> <dom> <mon> <dow>' (UTC).`,
    );
  }
  return new Cron(
    parseCronField(fields[0]!, 0, 59, 'minute'),
    parseCronField(fields[1]!, 0, 23, 'hour'),
    parseCronField(fields[2]!, 1, 31, 'day-of-month'),
    parseCronField(fields[3]!, 1, 12, 'month'),
    parseCronField(fields[4]!, 0, 6, 'day-of-week'),
  );
}
