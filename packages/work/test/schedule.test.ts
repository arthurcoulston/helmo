import { describe, it, expect } from 'vitest';
import { parseSchedule } from '../src/schedule.js';

describe('parseSchedule', () => {
  it("'every N<unit>' advances by the interval from the given base", () => {
    const s = parseSchedule('every 30m');
    expect(s.next(new Date('2026-08-04T12:00:00Z')).toISOString()).toBe('2026-08-04T12:30:00.000Z');
    expect(parseSchedule('every 2h').next(new Date('2026-08-04T12:00:00Z')).toISOString()).toBe('2026-08-04T14:00:00.000Z');
    expect(parseSchedule('every 1d').next(new Date('2026-08-04T12:00:00Z')).toISOString()).toBe('2026-08-05T12:00:00.000Z');
  });
  it('5-field cron finds the next matching minute in UTC', () => {
    const midnight = parseSchedule('0 0 * * *');
    expect(midnight.next(new Date('2026-08-04T12:34:56Z')).toISOString()).toBe('2026-08-05T00:00:00.000Z');
    // strictly after: a match at the base time is not returned again
    expect(midnight.next(new Date('2026-08-05T00:00:00Z')).toISOString()).toBe('2026-08-06T00:00:00.000Z');
    const weekly = parseSchedule('0 9 * * 1'); // Mondays 09:00
    expect(weekly.next(new Date('2026-08-04T12:00:00Z')).toISOString()).toBe('2026-08-10T09:00:00.000Z');
    const steps = parseSchedule('*/15 * * * *');
    expect(steps.next(new Date('2026-08-04T12:01:00Z')).toISOString()).toBe('2026-08-04T12:15:00.000Z');
  });
  it('rejects malformed expressions with teaching errors', () => {
    expect(() => parseSchedule('sometimes')).toThrow(/neither/);
    expect(() => parseSchedule('every 0m')).toThrow(/positive/);
    expect(() => parseSchedule('61 * * * *')).toThrow(/out of range/);
    expect(() => parseSchedule('* * * *')).toThrow(/5-field/);
  });
});
