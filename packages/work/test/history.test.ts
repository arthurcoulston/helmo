import { describe, expect, it } from 'vitest';
import { history, type HistoryInput } from '../src/history.js';

const asOf = '2026-10-13T00:00:00.000Z';
const base = (): HistoryInput => ({
  tokens: [], acceptance_failures: [], test_results: [], incidents: [],
  recording_began_at: {
    tokens: '2026-09-01T00:00:00.000Z', acceptance_failures: '2026-09-01T00:00:00.000Z',
    test_results: '2026-09-01T00:00:00.000Z', incidents: '2026-09-01T00:00:00.000Z',
  },
});

describe('failure history', () => {
  it('keeps equal rates at different volumes while retaining raw counts', () => {
    const input = base();
    input.tokens.push(
      { at: '2026-10-11T12:00:00Z', value: 1_000_000, ref: 'spend:one' },
      { at: '2026-10-12T12:00:00Z', value: 2_000_000, ref: 'spend:two' },
    );
    input.acceptance_failures.push(
      { at: '2026-10-11T12:01:00Z', ref: 'H-1' },
      { at: '2026-10-12T12:01:00Z', ref: 'H-2' }, { at: '2026-10-12T12:02:00Z', ref: 'H-3' },
    );
    const rows = history(input, 'week', asOf).slice(-2);
    expect(rows.map((row) => row.acceptance_failures.count)).toEqual([1, 2]);
    expect(rows.map((row) => row.acceptance_failures.per_million_tokens)).toEqual([1, 1]);
  });

  it('shows a spike as counts and evidence without inventing a verdict', () => {
    const input = base();
    input.tokens.push({ at: '2026-10-12T12:00:00Z', value: 500_000, ref: 'spend:one' });
    input.incidents.push({ at: '2026-10-12T12:01:00Z', ref: 'H-8' }, { at: '2026-10-12T12:02:00Z', ref: 'H-9' });
    const row = history(input, 'week', asOf).at(-1)!;
    expect(row.incidents).toMatchObject({ count: 2, per_million_tokens: 4, evidence: ['H-8', 'H-9'] });
    expect(row).not.toHaveProperty('status');
  });

  it('uses null for a zero denominator and marks late sources missing', () => {
    const input = base();
    input.recording_began_at.test_results = '2026-10-12T18:00:00Z';
    input.test_results.push({ at: '2026-10-12T19:00:00Z', failed: 1, total: 4, ref: 'run:four' });
    const row = history(input, 'week', asOf).at(-1)!;
    expect(row.test_failures).toMatchObject({ count: 1, measured_tests: 4, per_million_tokens: null, coverage: 'missing' });
  });

  it('filters every source by actor and provides day, week and month resolution', () => {
    const input = base();
    input.tokens.push(
      { at: '2026-10-12T23:30:00Z', actor: 'mason', value: 10, ref: 'spend:mason' },
      { at: '2026-10-12T23:30:00Z', actor: 'proof', value: 90, ref: 'spend:proof' },
    );
    input.acceptance_failures.push({ at: '2026-10-12T23:31:00Z', actor: 'proof', ref: 'H-2' });
    expect(history(input, 'day', asOf, 'mason')).toHaveLength(24);
    expect(history(input, 'week', asOf, 'mason')).toHaveLength(7);
    expect(history(input, 'month', asOf, 'mason')).toHaveLength(30);
    expect(history(input, 'day', asOf, 'mason').at(-1)).toMatchObject({ tokens: 10, acceptance_failures: { count: 0 } });
  });
});
