import { describe, expect, it } from 'vitest';
import { DurationSample, durationBands, runway, RunwayInput, SeatReading } from '../src/runway.js';
import { Ticket, WorkstreamInfo } from '../src/types.js';

const AS_OF = '2026-10-10T18:00:00.000Z';

const ticket = (id: string, over: Partial<Ticket> = {}): Ticket => ({
  id, title: id, body: '', workstream: 'build', project: null, type: 'build', labels: [],
  status: 'open', priority: 2, assignee: 'mason', evidence: [], confidence: null, uncertainty_note: null,
  blast_radius: 'records', question: null, action: null, tokens_total: 0, cost_usd_total: 0,
  schedule: null, not_before: null, needs_human: false, sitting: null, sitting_with: null,
  release_handoff: null, lane: null, capacity_hold: null, completion_account: null,
  workflow_attempt_id: null, created_at: '2026-10-01T00:00:00.000Z', updated_at: AS_OF, closed_at: null,
  ...over,
});

const stream = (name: string, over: Partial<WorkstreamInfo> = {}): WorkstreamInfo => ({
  name, seat: 'mason', budget_usd: null, updated_at: AS_OF, spent_usd: 0, remaining_usd: null, ...over,
});

/** Ten `build` closes whose quarter and three-quarter points are exactly 2 and
 *  4 hours, so every expected band below is hand-calculable: nearest-rank p25
 *  of ten samples is the 3rd and p75 is the 8th. */
const BUILD_HOURS = [1, 1, 2, 2, 3, 3, 3, 4, 9, 40];
const builds: DurationSample[] = BUILD_HOURS.map((hours, i) => ({ id: `d${i}`, type: 'build', hours }));

const input = (over: Partial<RunwayInput> = {}): RunwayInput => ({
  tickets: [], blockers: new Map(), workstreams: [stream('build')], durations: builds,
  seats: [{ agent: 'mason', state: 'awaiting' }, { agent: 'ward', state: 'awaiting' }], as_of: AS_OF, ...over,
});

describe('duration bands', () => {
  it('takes the interquartile band of comparable closes by nearest rank', () => {
    const { byType, samples_by_type } = durationBands(builds);
    expect(byType.get('build')).toEqual({ low: 2, high: 4, basis: 'comparable', samples: 10 });
    expect(samples_by_type).toEqual({ build: 10 });
  });

  it('leaves a thin type to the pool rather than letting four samples speak', () => {
    const thin: DurationSample[] = [1, 2, 3, 100].map((hours, i) => ({ id: `t${i}`, type: 'ops', hours }));
    const { byType, pooled, samples_by_type } = durationBands([...builds, ...thin]);
    expect(byType.has('ops')).toBe(false);
    expect(samples_by_type['ops']).toBe(4);
    expect(pooled?.basis).toBe('pooled');
  });

  it('has nothing to say below the sample floor', () => {
    const { byType, pooled } = durationBands([{ id: 'one', type: 'build', hours: 3 }]);
    expect(byType.size).toBe(0);
    expect(pooled).toBeNull();
  });
});

describe('autonomous runway', () => {
  it('runs seats in parallel and each seat serially', () => {
    const result = runway(input({
      tickets: [ticket('H-1'), ticket('H-2'), ticket('H-3', { assignee: 'ward' })],
    }));
    // mason: 2-4 then 2-4 = 4-8. ward: 2-4. Whole-team exhaustion is the later.
    expect(result.outcomes.map((o) => [o.id, o.owner, o.finishes_after])).toEqual([
      ['H-1', 'mason', { low: 2, high: 4 }],
      ['H-2', 'mason', { low: 4, high: 8 }],
      ['H-3', 'ward', { low: 2, high: 4 }],
    ]);
    expect(result.range).toEqual({ low: 4, high: 8 });
    expect(result.coverage.estimated).toEqual({ comparable: 3, pooled: 0, unknown: 0 });
  });

  it('makes a reviewer on another seat a wall-clock bottleneck', () => {
    const result = runway(input({
      tickets: [ticket('H-1'), ticket('H-2', { assignee: 'ward' }), ticket('H-3')],
      blockers: new Map([['H-2', ['H-1']], ['H-3', ['H-2']]]),
    }));
    // H-1 2-4; review waits for it, 4-8; H-3 waits for the review, 6-12.
    expect(result.outcomes.at(-1)?.finishes_after).toEqual({ low: 6, high: 12 });
    expect(result.range).toEqual({ low: 6, high: 12 });
  });

  it('keeps one branch running while another sits with Arthur', () => {
    const result = runway(input({
      tickets: [ticket('H-1', { status: 'awaiting_human' }), ticket('H-2', { assignee: 'ward' })],
    }));
    expect(result.excluded).toEqual([{ id: 'H-1', title: 'H-1', reason: 'missing_human_input', detail: 'Sitting with Arthur for an answer' }]);
    expect(result.range).toEqual({ low: 2, high: 4 });
  });

  it('names the first step Arthur keeps without stopping the forecast there', () => {
    const result = runway(input({
      tickets: [ticket('H-1', { blast_radius: 'published' }), ticket('H-2', { assignee: 'ward' })],
    }));
    expect(result.first_human_boundary).toEqual({ id: 'H-1', title: 'H-1', after: { low: 2, high: 4 }, reason: 'Publishing needs Arthur' });
    expect(result.range).toEqual({ low: 2, high: 4 });
  });

  it('leaves a deliberate hold, a date gate and a spent budget out of the runway', () => {
    const result = runway(input({
      workstreams: [stream('build'), stream('spent', { budget_usd: 10, spent_usd: 10, remaining_usd: 0 })],
      tickets: [
        ticket('held', { capacity_hold: { reason: 'R-44 is a later phase', provenance: 'p', reconsider_when: 'w' } }),
        ticket('gated', { not_before: '2026-11-01' }),
        ticket('skint', { workstream: 'spent' }),
        ticket('live'),
      ],
    }));
    expect(result.excluded.map((x) => [x.id, x.reason])).toEqual([
      ['held', 'hold'], ['gated', 'date_gate'], ['skint', 'finite_limit'],
    ]);
    expect(result.excluded[0]?.detail).toBe('R-44 is a later phase');
    expect(result.range).toEqual({ low: 2, high: 4 });
  });

  it('honours a hold whose bounded release has not expired', () => {
    const released = { reason: 'r', provenance: 'p', reconsider_when: 'w', release: { batch_id: 'b', until: '2026-10-11T00:00:00.000Z', stop_conditions: 's', shared_reserve: 'x' } };
    const result = runway(input({ tickets: [ticket('H-1', { capacity_hold: released })] }));
    expect(result.excluded).toEqual([]);
    expect(result.range).toEqual({ low: 2, high: 4 });
  });

  it('excludes a stopped seat and an unseated workstream, and keeps an unreadable one apart', () => {
    const seats: SeatReading[] = [{ agent: 'mason', state: 'stopped' }, { agent: 'ward', state: 'unknown' }, { agent: 'bosun', state: 'awaiting' }];
    const result = runway(input({
      seats,
      workstreams: [stream('build'), stream('orphan', { seat: null })],
      tickets: [ticket('stopped'), ticket('unread', { assignee: 'ward' }), ticket('nobody', { workstream: 'orphan', assignee: null })],
    }));
    expect(result.excluded.map((x) => [x.id, x.reason, x.detail])).toEqual([
      ['stopped', 'unavailable_seat', 'mason is stopped'],
      ['unread', 'unreadable_seat', "ward's state could not be read"],
      ['nobody', 'unavailable_seat', 'No seat serves workstream orphan'],
    ]);
    expect(result.range).toBeNull();
    expect(result.floor).toBeNull();
    expect(result.coverage.seats).toEqual({ available: ['bosun'], unavailable: [{ agent: 'mason', state: 'stopped' }, { agent: 'ward', state: 'unknown' }] });
  });

  it('measures work of an unseen type from the pool and discloses which basis it used', () => {
    const result = runway(input({
      tickets: [ticket('known'), ticket('guess', { type: 'research', assignee: 'ward' })],
    }));
    expect(result.coverage.estimated).toEqual({ comparable: 1, pooled: 1, unknown: 0 });
    expect(result.range).toEqual({ low: 2, high: 4 });
  });

  it('keeps a measured floor when a branch waits on work that is not runway', () => {
    const result = runway(input({
      tickets: [
        ticket('live'),
        ticket('waiting', { assignee: 'ward' }),
        ticket('held', { capacity_hold: { reason: 'later phase', provenance: 'p', reconsider_when: 'w' } }),
      ],
      blockers: new Map([['waiting', ['held']]]),
    }));
    expect(result.range).toBeNull();
    expect(result.floor).toEqual({ low: 2, high: 4 });
    expect(result.unknown_duration).toEqual([
      { id: 'waiting', title: 'waiting', owner: 'ward', reason: 'Waits on held, which is not itself runway' },
    ]);
    expect(result.outcomes.map((o) => [o.id, o.finishes_after])).toEqual([
      ['live', { low: 2, high: 4 }],
      ['waiting', null],
    ]);
  });

  it('says what measurement is missing rather than inventing hours', () => {
    const result = runway(input({
      tickets: [ticket('H-1')],
      durations: builds.slice(0, 3),
    }));
    expect(result.range).toBeNull();
    expect(result.floor).toBeNull();
    // Named anyway: an installation with no closed history still has a next
    // thing that happens, and this is the state a fresh install reads in.
    expect(result.outcomes).toEqual([{ id: 'H-1', title: 'H-1', owner: 'mason', finishes_after: null }]);
    expect(result.unknown_duration).toEqual([
      { id: 'H-1', title: 'H-1', owner: 'mason', reason: 'No comparable closed build work to measure (3 of 5 needed)' },
    ]);
    expect(result.coverage.estimated).toEqual({ comparable: 0, pooled: 0, unknown: 1 });
  });

  it('will not count the instances a recurring template has yet to spawn', () => {
    const result = runway(input({
      tickets: [ticket('template', { schedule: 'every 1d' }), ticket('instance')],
    }));
    expect(result.outcomes.map((o) => o.id)).toEqual(['instance']);
    expect(result.range).toEqual({ low: 2, high: 4 });
  });

  it('refuses the whole forecast when no seat could be read at all', () => {
    const result = runway(input({ tickets: [ticket('H-1')], seats: null }));
    expect(result.unavailable).toMatch(/roster could not be read/);
    expect(result.range).toBeNull();
    expect(result.outcomes).toEqual([]);
  });

  it('reports no runway for an empty queue without calling it unavailable', () => {
    const result = runway(input());
    expect(result.unavailable).toBeNull();
    expect(result.range).toBeNull();
    expect(result.outcomes).toEqual([]);
    expect(result.coverage.samples).toBe(10);
  });
});
