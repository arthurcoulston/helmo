import { describe, expect, it } from 'vitest';
import { quietAccount, QuietInput } from '../src/quiet.js';
import { Ticket } from '../src/types.js';

const SINCE = '2026-10-10T12:00:00.000Z';
const AS_OF = '2026-10-12T12:00:00.000Z';

const ticket = (id: string, status: Ticket['status'] = 'open'): Ticket => ({
  id, title: id, body: '', workstream: 'estate-ui', type: 'build', labels: [], status, priority: 2,
  assignee: null, evidence: [], confidence: null, uncertainty_note: null, blast_radius: 'none', question: null,
  tokens_total: 0, cost_usd_total: 0, created_at: SINCE, updated_at: SINCE, closed_at: null, schedule: null,
  project: null, not_before: null, capacity_hold: null, needs_human: false, sitting: null, sitting_with: null,
  workflow_attempt_id: null, release_handoff: null, lane: null, completion_account: null, action: null,
});

const input = (overrides: Partial<QuietInput> = {}): QuietInput => ({
  tickets: [], exclusions: [], onsets: [], continuations: [], since: SINCE, as_of: AS_OF,
  activity: { tokens: [], completions: [], requests: [], recording_began_at: '2026-10-01T00:00:00.000Z' },
  ...overrides,
});

describe('quietAccount', () => {
  it('classifies completed work with no eligible unexcluded work as finished', () => {
    const completed = { ...ticket('H-1', 'done'), closed_at: AS_OF };
    expect(quietAccount(input({ tickets: [completed], activity: { ...input().activity, completions: [{ id: 'H-1', at: AS_OF }] } }))).toMatchObject({ class: 'finished', completion_ids: ['H-1'] });
  });

  it('classifies fully covered holds and date gates as held', () => {
    const tickets = [ticket('H-1'), ticket('H-2')];
    const exclusions = [
      { id: 'H-1', title: 'H-1', reason: 'hold' as const, detail: 'paused' },
      { id: 'H-2', title: 'H-2', reason: 'date_gate' as const, detail: 'later' },
    ];
    const onsets = [
      { id: 'H-1', cause: 'hold' as const, at: SINCE, source: 'updated' as const },
      { id: 'H-2', cause: 'date_gate' as const, at: '2026-10-09T12:00:00.000Z', source: 'created' as const },
    ];
    expect(quietAccount(input({ tickets, exclusions, onsets }))).toMatchObject({ class: 'held', reasons: [{ covered: 'before_since' }, { covered: 'before_since' }] });
  });

  it('classifies fully covered human input as waiting', () => {
    expect(quietAccount(input({
      tickets: [ticket('H-1')],
      exclusions: [{ id: 'H-1', title: 'H-1', reason: 'missing_human_input', detail: 'answer' }],
      onsets: [{ id: 'H-1', cause: 'missing_human_input', at: SINCE, source: 'returned' }],
    }))).toMatchObject({ class: 'waiting' });
  });

  it('names a selected project with no queued continuation', () => {
    const continuations = [{ id: 'R-44', title: 'Check-ins', updated_at: AS_OF, last_progress_note: 'Selected' }];
    expect(quietAccount(input({ continuations }))).toMatchObject({ class: 'no_continuation', continuations });
  });

  it.each([
    ['before_since', SINCE],
    ['during', '2026-10-11T12:00:00.000Z'],
  ] as const)('marks a dated cause %s', (covered, at) => {
    const result = quietAccount(input({
      tickets: [ticket('H-1')],
      exclusions: [{ id: 'H-1', title: 'H-1', reason: 'hold', detail: 'paused' }],
      onsets: [{ id: 'H-1', cause: 'hold', at, source: 'updated' }],
    }));
    expect(result.reasons[0]).toMatchObject({ at, covered });
  });

  it('keeps a during-interval hold but demotes the headline to unknown', () => {
    expect(quietAccount(input({
      tickets: [ticket('H-1')],
      exclusions: [{ id: 'H-1', title: 'H-1', reason: 'hold', detail: 'paused' }],
      onsets: [{ id: 'H-1', cause: 'hold', at: '2026-10-11T12:00:00.000Z', source: 'updated' }],
    }))).toMatchObject({ class: 'unknown', reasons: [{ covered: 'during', at: '2026-10-11T12:00:00.000Z' }] });
  });

  it('marks live-only limits undatable and returns unknown', () => {
    expect(quietAccount(input({ tickets: [ticket('H-1')], exclusions: [{ id: 'H-1', title: 'H-1', reason: 'finite_limit', detail: 'spent' }] }))).toMatchObject({ class: 'unknown', reasons: [{ covered: 'undatable', at: null }] });
  });

  it('returns unknown rather than lost for eligible work with no interval events', () => {
    expect(quietAccount(input({ tickets: [ticket('H-1')] }))).toMatchObject({ class: 'unknown', reasons: [] });
  });
});
