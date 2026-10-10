import { describe, expect, it } from 'vitest';
import { forecast, ForecastJob } from '../src/forecast.js';

const job = (id: string, owner: string, low: number, high = low, extra: Partial<ForecastJob> = {}): ForecastJob =>
  ({ id, title: id, owner, duration_hours: { low, high }, ...extra });

describe('bounded autonomous runway', () => {
  it('runs owners in parallel and each owner serially', () => {
    const result = forecast([job('A', 'mason', 2, 3), job('B', 'mason', 1, 2), job('C', 'ward', 4, 5)]);
    expect(result.outcomes.map((x) => [x.id, x.starts_after, x.finishes_after])).toEqual([
      ['A', { low: 0, high: 0 }, { low: 2, high: 3 }],
      ['B', { low: 2, high: 3 }, { low: 3, high: 5 }],
      ['C', { low: 0, high: 0 }, { low: 4, high: 5 }],
    ]);
    expect(result.range).toEqual({ low: 4, high: 5 });
  });

  it('makes a reviewer dependency a wall-clock bottleneck', () => {
    const result = forecast([job('build', 'mason', 2), job('review', 'ward', 1, 2, { blocked_by: ['build'] }), job('release', 'mason', 1, 1, { blocked_by: ['review'] })]);
    expect(result.outcomes.at(-1)?.finishes_after).toEqual({ low: 4, high: 5 });
    expect(result.range).toEqual({ low: 4, high: 5 });
  });

  it('reports the first human boundary while another branch continues', () => {
    const result = forecast([job('decision', 'mason', 1, 2, { human_boundary: 'Choose the release' }), job('other', 'ward', 5, 6)]);
    expect(result.first_human_boundary).toEqual({ id: 'decision', after: { low: 1, high: 2 }, reason: 'Choose the release' });
    expect(result.range).toEqual({ low: 5, high: 6 });
  });

  it('keeps holds, unavailable seats, gates and finite limits out of runway', () => {
    const reasons = ['hold', 'unavailable_seat', 'date_gate', 'finite_limit'] as const;
    const result = forecast(reasons.map((reason, i) => job(`x${i}`, 'mason', 1, 1, { excluded: reason })));
    expect(result.range).toBeNull();
    expect(result.excluded.map((x) => x.reason)).toEqual(reasons);
  });

  it('refuses hours when a duration or prerequisite is unknown', () => {
    const result = forecast([
      { id: 'unknown', title: 'unknown', owner: 'mason', duration_hours: null },
      job('external', 'ward', 1, 1, { blocked_by: ['not-admitted'] }),
    ]);
    expect(result.range).toBeNull();
    expect(result.floor).toBeNull();
    expect(result.unknown_duration).toEqual(['unknown', 'external']);
  });

  it('still names a job it cannot time, and stops that owner\'s clock', () => {
    const result = forecast([
      { id: 'untimed', title: 'untimed', owner: 'mason', duration_hours: null },
      job('after', 'mason', 1),
      job('elsewhere', 'ward', 2),
    ]);
    expect(result.outcomes.map((x) => [x.id, x.finishes_after])).toEqual([
      ['untimed', null],
      // Same owner, behind something untimed: it happens next and no hour can
      // say when, so borrowing the clock would be a schedule with a hole in it.
      ['after', null],
      ['elsewhere', { low: 2, high: 2 }],
    ]);
    expect(result.unknown_duration).toEqual(['untimed', 'after']);
    expect(result.floor).toEqual({ low: 2, high: 2 });
    expect(result.range).toBeNull();
  });

  it('names a boundary it cannot time and sorts it behind one it can', () => {
    const result = forecast([
      { id: 'untimed', title: 'untimed', owner: 'mason', duration_hours: null, human_boundary: 'Publishing needs Arthur' },
      job('timed', 'ward', 1, 2, { human_boundary: 'Sending needs Arthur' }),
    ]);
    expect(result.first_human_boundary).toEqual({ id: 'timed', after: { low: 1, high: 2 }, reason: 'Sending needs Arthur' });
  });

  it('keeps a measured floor when only part of the work is unknown', () => {
    const result = forecast([job('known', 'mason', 2, 3), { id: 'guess', title: 'guess', owner: 'ward', duration_hours: null }]);
    expect(result.range).toBeNull();
    expect(result.floor).toEqual({ low: 2, high: 3 });
    expect(result.unknown_duration).toEqual(['guess']);
  });

  it('reports no runway for no work', () => {
    expect(forecast([])).toEqual({ range: null, floor: null, outcomes: [], first_human_boundary: null, unknown_duration: [], excluded: [] });
  });
});
