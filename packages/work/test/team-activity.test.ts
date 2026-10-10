// The activity reading, case by case against
// `crew:projects/r39/TEAM-ACTIVITY-CONTRACT.md`.
//
// Two halves, for the reason `recent-results.test.ts` has two. The buckets,
// the local clock and the counting rules are proved against hand-built items,
// because every interesting case needs an instant at an exact offset from a
// fixed `as_of` — including two instants a real clock repeats and one it skips,
// which no store could be persuaded to write. The SOURCES are then proved
// through the real write paths, because a series read off an event shape
// nothing writes is a series the widget cannot rely on.
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_RANGES, activityWindowStart, teamActivity } from '../src/presentation.js';
import { Store } from '../src/store.js';
import { ActivityEvents, Actor } from '../src/types.js';

/** One fixed reading instant; every offset below is from it, so a failure
 *  names a boundary rather than a date. A Friday, 21:31:48.371 UTC. */
const AS_OF = '2026-10-09T21:31:48.371Z';
const before = (ms: number) => new Date(Date.parse(AS_OF) - ms).toISOString();
const HOUR = 3_600_000;

const EMPTY: ActivityEvents = { tokens: [], completions: [], requests: [], recording_began_at: null };
const events = (partial: Partial<ActivityEvents>): ActivityEvents => ({ ...EMPTY, ...partial });
const read = (partial: Partial<ActivityEvents>, zone = 'UTC', asOf = AS_OF) => teamActivity(events(partial), asOf, zone);
const seriesOf = (range: { series: { key: string }[] }, key: string) => range.series.find((s) => s.key === key)!;

describe('the activity reading: buckets on a local clock', () => {
  it('cuts a day into 24 local hours and a week into 7 local days, newest partial', () => {
    const a = read({});
    expect(a.as_of).toBe(AS_OF);
    expect(a.time_zone).toBe('UTC');

    expect(a.day.unit).toBe('hour');
    expect(a.day.buckets).toHaveLength(ACTIVITY_RANGES.day.count);
    // The window starts at the start of the OLDEST bucket, which is why a
    // "past 24 hours" range reaches back 23h31m and not exactly 24h.
    expect(a.day.window_started_at).toBe('2026-10-08T22:00:00.000Z');
    expect(a.day.buckets[0]).toMatchObject({ starts_at: '2026-10-08T22:00:00.000Z', ends_at: '2026-10-08T23:00:00.000Z', label: '22:00', length_ms: HOUR });
    expect(a.day.buckets.at(-1)).toMatchObject({ starts_at: '2026-10-09T21:00:00.000Z', ends_at: AS_OF, label: '21:00', partial: true, length_ms: 1_908_371 });
    // Contiguous and non-overlapping, which is what makes a count-per-bucket
    // a partition of the window rather than three overlapping readings.
    for (let i = 1; i < a.day.buckets.length; i += 1) {
      expect(a.day.buckets[i]!.starts_at).toBe(a.day.buckets[i - 1]!.ends_at);
    }

    expect(a.week.unit).toBe('day');
    expect(a.week.buckets).toHaveLength(ACTIVITY_RANGES.week.count);
    expect(a.week.buckets.map((b) => b.label)).toEqual(['Sat 3', 'Sun 4', 'Mon 5', 'Tue 6', 'Wed 7', 'Thu 8', 'Fri 9']);
    expect(a.week.window_started_at).toBe('2026-10-03T00:00:00.000Z');
    expect(a.week.buckets[0]!.length_ms).toBe(24 * HOUR);
    expect(a.week.buckets.at(-1)).toMatchObject({ starts_at: '2026-10-09T00:00:00.000Z', ends_at: AS_OF, partial: true });
  });

  it('bounds a caller’s read at the oldest bucket either range can reach', () => {
    expect(activityWindowStart(AS_OF, 'UTC')).toBe('2026-10-03T00:00:00.000Z');
    // A zone east of UTC starts its local day earlier in absolute terms.
    expect(activityWindowStart(AS_OF, 'Asia/Kolkata')).toBe('2026-10-03T18:30:00.000Z');
    expect(() => activityWindowStart('not an instant', 'UTC')).toThrow(/needs an instant/);
  });

  it('cuts the same instants differently in a zone with a half-hour offset', () => {
    // 21:31:48Z is 03:01 the NEXT day in Kolkata, so the newest hour bucket
    // opens at 21:30Z and the newest day bucket is the 10th, not the 9th.
    const a = read({}, 'Asia/Kolkata');
    expect(a.day.buckets.at(-1)).toMatchObject({ starts_at: '2026-10-09T21:30:00.000Z', label: '03:00' });
    expect(a.week.buckets.at(-1)).toMatchObject({ starts_at: '2026-10-09T18:30:00.000Z', label: 'Sat 10' });
    expect(a.week.buckets[0]!.starts_at).toBe('2026-10-03T18:30:00.000Z');
  });

  it('carries a 25-hour local day and the hour its clock repeats', () => {
    // British Summer Time ends at 02:00 BST on Sunday 26 October 2026 — the
    // local day 25 October runs 23:00Z to 00:00Z, twenty-five hours, and local
    // 01:00 happens twice.
    const a = read({}, 'Europe/London', '2026-10-26T12:00:00.000Z');
    const sunday = a.week.buckets.find((b) => b.label === 'Sun 25')!;
    expect(sunday).toMatchObject({ starts_at: '2026-10-24T23:00:00.000Z', ends_at: '2026-10-26T00:00:00.000Z', length_ms: 25 * HOUR });

    const night = read({}, 'Europe/London', '2026-10-25T03:00:00.000Z').day.buckets;
    const repeated = night.filter((b) => b.label === '01:00');
    expect(repeated.map((b) => b.starts_at)).toEqual(['2026-10-25T00:00:00.000Z', '2026-10-25T01:00:00.000Z']);
    // Both are real one-hour buckets: the label repeats, the instants do not,
    // and nothing is merged or dropped.
    expect(repeated.map((b) => b.length_ms)).toEqual([HOUR, HOUR]);
    expect(new Set(night.map((b) => b.starts_at)).size).toBe(ACTIVITY_RANGES.day.count);
    for (let i = 1; i < night.length; i += 1) expect(night[i]!.starts_at).toBe(night[i - 1]!.ends_at);
  });

  it('carries a 23-hour local day and skips the hour its clock deletes', () => {
    // Eastern Time springs forward at 02:00 on Sunday 8 March 2026: local
    // 02:00 never happens, and the local day is twenty-three hours.
    const a = read({}, 'America/New_York', '2026-03-09T12:00:00.000Z');
    const sunday = a.week.buckets.find((b) => b.label === 'Sun 8')!;
    expect(sunday).toMatchObject({ starts_at: '2026-03-08T05:00:00.000Z', ends_at: '2026-03-09T04:00:00.000Z', length_ms: 23 * HOUR });

    const morning = read({}, 'America/New_York', '2026-03-08T08:20:00.000Z').day;
    const labels = morning.buckets.map((b) => b.label);
    expect(labels).toContain('01:00');
    // The hour the clock deleted is not a bucket, because it is not an hour.
    expect(labels).not.toContain('02:00');
    expect(labels.slice(-3)).toEqual(['01:00', '03:00', '04:00']);
    expect(morning.buckets.find((b) => b.label === '01:00')).toMatchObject({
      starts_at: '2026-03-08T06:00:00.000Z', ends_at: '2026-03-08T07:00:00.000Z', length_ms: HOUR,
    });
    // Still twenty-four buckets, and they still partition the window exactly:
    // it is the LABELS that skip, which is what the clock did.
    expect(morning.buckets).toHaveLength(ACTIVITY_RANGES.day.count);
    expect(morning.buckets.reduce((sum, b) => sum + b.length_ms, 0))
      .toBe(Date.parse('2026-03-08T08:20:00.000Z') - Date.parse(morning.window_started_at));
  });
});

describe('the activity reading: what lands where', () => {
  it('counts each item once, in the bucket it belongs to', () => {
    const a = read({
      tokens: [
        { at: before(30 * 60_000), tokens: 120_000 },
        { at: before(30 * 60_000 + 1), tokens: 4_000 },
        { at: before(5 * HOUR), tokens: 60_000 },
      ],
      completions: [
        { at: before(10 * 60_000), id: 'H-1' },
        { at: before(5 * HOUR), id: 'H-2' },
        { at: before(50 * HOUR), id: 'H-3' },
      ],
      requests: [
        { at: before(10 * 60_000), id: 'H-1', kind: 'decision' },
        { at: before(11 * 60_000), id: 'H-4', kind: 'action' },
        { at: before(12 * 60_000), id: 'H-5', kind: 'sitting' },
      ],
    });
    const newest = a.day.buckets.at(-1)!;
    expect(newest).toMatchObject({ tokens: 124_000, completions: 1, requests: 3 });
    const fiveBack = a.day.buckets.find((b) => b.starts_at === '2026-10-09T16:00:00.000Z')!;
    expect(fiveBack).toMatchObject({ tokens: 60_000, completions: 1, requests: 0 });

    // Out of both windows: 50 hours back is inside the week's seven days, so
    // it lands in the week and not in the day.
    expect(seriesOf(a.day, 'completions').total).toBe(2);
    expect(seriesOf(a.week, 'completions').total).toBe(3);
    expect(a.week.buckets.find((b) => b.label === 'Wed 7')!.completions).toBe(1);

    // The three series keep their own units, and neither total is the other's.
    expect(seriesOf(a.day, 'tokens')).toMatchObject({ unit: 'tokens', total: 184_000, peak: 124_000, floor: 0 });
    expect(seriesOf(a.day, 'requests')).toMatchObject({ unit: 'requests', total: 3, peak: 3 });
  });

  it('counts a boundary instant once, in the bucket it opens', () => {
    const boundary = '2026-10-09T16:00:00.000Z';
    const a = read({
      completions: [
        { at: boundary, id: 'H-on' },
        { at: '2026-10-09T15:59:59.999Z', id: 'H-before' },
        { at: AS_OF, id: 'H-at-as-of' },
      ],
    });
    expect(a.day.buckets.find((b) => b.starts_at === boundary)!.completions).toBe(1);
    expect(a.day.buckets.find((b) => b.starts_at === '2026-10-09T15:00:00.000Z')!.completions).toBe(1);
    // The newest bucket is closed at the top, because `as_of` is the instant
    // the reading was taken and the store's own window included it.
    expect(a.day.buckets.at(-1)!.completions).toBe(1);
    expect(seriesOf(a.day, 'completions').total).toBe(3);
  });

  it('nets a metered correction where it was reported, and never clamps it', () => {
    // A harness meters a finished session and cancels the agent's own guess
    // (H-57): the delta is negative, and it belongs to the bucket the
    // correction was REPORTED in, because nothing says when the work ran.
    const a = read({
      tokens: [
        { at: before(5 * HOUR), tokens: 80_000 },
        { at: before(30 * 60_000), tokens: -80_000 },
        { at: before(30 * 60_000), tokens: 62_000 },
      ],
    });
    expect(a.day.buckets.find((b) => b.starts_at === '2026-10-09T16:00:00.000Z')!.tokens).toBe(80_000);
    expect(a.day.buckets.at(-1)!.tokens).toBe(-18_000);
    const tokens = seriesOf(a.day, 'tokens');
    expect(tokens.total).toBe(62_000);
    expect(tokens.floor).toBe(-18_000);
    // The scale has to hold the negative bucket too, so the peak is the
    // largest bucket in ABSOLUTE terms.
    expect(tokens.peak).toBe(80_000);
  });

  it('counts a request left pending for hours in one bucket, not in every one since', () => {
    // The reading counts ISSUANCE. A decision issued seven hours ago and still
    // waiting is one request, in the hour it was issued — not a request in
    // every hour it has been waiting, which is the reading that would make an
    // unanswered ask look like a flood of them.
    const a = read({ requests: [{ at: before(7 * HOUR), id: 'H-1', kind: 'decision' }] });
    const carrying = a.day.buckets.filter((bucket) => bucket.requests > 0);
    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.starts_at).toBe('2026-10-09T14:00:00.000Z');
    expect(seriesOf(a.day, 'requests')).toMatchObject({ total: 1, peak: 1 });
    // And the same one request in the week, in the day it was issued.
    expect(a.week.buckets.filter((bucket) => bucket.requests > 0)).toHaveLength(1);
    expect(seriesOf(a.week, 'requests').total).toBe(1);
  });

  it('says what each series counts and what it leaves out', () => {
    const series = read({}).day.series.map((s) => s.key);
    expect(series).toEqual(['tokens', 'completions', 'requests']);
    expect(seriesOf(read({}).day, 'tokens')).toMatchObject({
      label: 'Tokens reported',
      basis: expect.stringContaining('REPORTED'),
      coverage: expect.stringContaining('unmetered work is excluded'),
    });
    expect(seriesOf(read({}).day, 'completions').coverage).toMatch(/reopened ticket leaves the chart/);
    expect(seriesOf(read({}).day, 'requests').coverage).toMatch(/not recounted/);
  });

  it('distinguishes a zero bucket from a bucket the record cannot speak for', () => {
    const began = '2026-10-09T18:20:00.000Z';
    const a = read({ recording_began_at: began, completions: [{ at: before(60_000), id: 'H-1' }] });
    expect(a.recording_began_at).toBe(began);

    const unknown = a.day.buckets.filter((b) => b.before_record);
    // Every bucket that ENDS at or before the first event, and no other: the
    // 18:00 bucket straddles it and is a real, if partly covered, zero.
    expect(unknown.map((b) => b.starts_at).at(-1)).toBe('2026-10-09T17:00:00.000Z');
    const straddling = a.day.buckets.find((b) => b.starts_at === '2026-10-09T18:00:00.000Z')!;
    expect(straddling.before_record).toBeUndefined();
    expect(straddling.completions).toBe(0);
    const zero = a.day.buckets.find((b) => b.starts_at === '2026-10-09T19:00:00.000Z')!;
    expect(zero.completions).toBe(0);
    expect(zero.before_record).toBeUndefined();

    // A series' peak and total are taken over the buckets the record covers,
    // so an unrecorded stretch never reads as a run of zeroes.
    expect(seriesOf(a.day, 'completions').total).toBe(1);
    expect(a.week.buckets.filter((b) => b.before_record).map((b) => b.label)).toEqual(['Sat 3', 'Sun 4', 'Mon 5', 'Tue 6', 'Wed 7', 'Thu 8']);
  });

  it('draws a flat line rather than dividing by an empty scale', () => {
    const a = read({});
    for (const s of a.day.series) expect(s).toMatchObject({ total: 0, peak: 0, floor: 0 });
  });

  it('refuses a reading instant it cannot place', () => {
    expect(() => teamActivity(EMPTY, 'yesterday', 'UTC')).toThrow(/needs an instant/);
  });
});

/* ---------- the sources, through the real write paths ---------- */

const mason: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1', session: 'rev:mason' };
const proof: Actor = { name: 'proof', kind: 'agent', model: 'test', version: '1', session: 'rev:proof' };
const ward: Actor = { name: 'ward', kind: 'agent', model: 'test', version: '1', session: 'rev:ward' };
const operator: Actor = { name: 'Arthur', kind: 'human' };
const ref = (n: string) => `helmo@${n.repeat(40)}`;
const digest = (n: string) => n.repeat(64);

const open = (s: Store, title: string, extra = {}) =>
  s.createTicket(mason, { title, body: 'Body.', workstream: 'estate-ui', type: 'build', labels: ['acct:direction'], ...extra });
const close = (s: Store, id: string, summary: string) =>
  s.updateTicket(mason, { ticket_id: id, status: 'done', note: 'Finished.', completion_account: { category: 'feature', summary } });
const wide = (s: Store) => s.activityEvents(new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 1000).toISOString());

describe('the activity sources, as the store reads them', () => {
  it('takes tokens off an agent’s own write AND off a meter’s later one', () => {
    const s = new Store(':memory:');
    const t = open(s, 'Work that reports its own usage');
    s.updateTicket(mason, { ticket_id: t.id, note: 'Reporting my own figure.', tokens: 90_000 });
    s.recordSpend(mason, t.id, { tokens: -90_000, note: 'Netting out the self-report.' });
    s.recordSpend(mason, t.id, { tokens: 112_000, cost_usd: 1.5, cost_basis: 'provider_reported_metered', note: 'The metered figure.' });
    const deltas = wide(s).tokens.map((item) => item.tokens);
    // All three, in order, signs intact: reading only `spend` events would
    // miss the first and reading only `updated` events would miss the rest.
    expect(deltas).toEqual([90_000, -90_000, 112_000]);
    expect(deltas.reduce((sum, d) => sum + d, 0)).toBe(112_000);
    expect(s.getTicket(t.id).tokens_total).toBe(112_000);
  });

  it('counts a completion once per ticket, and not at all for a cancellation', () => {
    const s = new Store(':memory:');
    const done = open(s, 'Work that finished');
    close(s, done.id, 'The thing exists and a reader can open it.');
    const cancelled = open(s, 'Work that was abandoned');
    s.updateTicket(mason, { ticket_id: cancelled.id, status: 'cancelled', note: 'Overtaken.' });
    const unfinished = open(s, 'Work still in motion', { status: 'in_progress' });

    const ids = wide(s).completions.map((c) => c.id);
    expect(ids).toEqual([done.id]);
    expect(ids).not.toContain(cancelled.id);
    expect(ids).not.toContain(unfinished.id);
    // The instant is the close itself, read off the ticket.
    expect(wide(s).completions[0]!.at).toBe(s.getTicket(done.id).closed_at);

    // And the reopen the contract's selection rule allows for cannot happen
    // through the front door at all: `done` is terminal, and the store refuses
    // a status change on it. So a counted bucket does not change behind a
    // reader's back — the rule covers a record arriving by replay or import,
    // not an agent reopening its own work.
    expect(() => s.updateTicket(mason, { ticket_id: done.id, status: 'open', note: 'Not finished after all.' }))
      .toThrow(/terminal/);
  });

  it('counts a decision, an action, a marked sitting and a release sitting, once each', () => {
    const s = new Store(':memory:');
    const decision = open(s, 'A decision for the operator');
    s.returnToHuman(mason, decision.id, { situation: 'Where it stands.', question: 'Which way?', recommendation: 'This way.' });
    const action = open(s, 'An action for the operator');
    s.requestAction(mason, action.id, { situation: 'Where it stands.', action: 'Two clicks in the dashboard.', why_human: 'Only his account can do it.' });
    const atFiling = open(s, 'A sitting named when it was filed', { needs_human: 'Twenty minutes going through the shortlist.', sitting_with: 'mason' });
    const later = open(s, 'A sitting named later');
    s.updateTicket(mason, { ticket_id: later.id, needs_human: 'Ten minutes agreeing the wording.', sitting_with: 'mason', note: 'This needs him.' });

    const requests = wide(s).requests;
    expect(requests.filter((r) => r.id === decision.id)).toEqual([{ at: expect.any(String), id: decision.id, kind: 'decision' }]);
    expect(requests.filter((r) => r.id === action.id)).toEqual([{ at: expect.any(String), id: action.id, kind: 'action' }]);
    expect(requests.filter((r) => r.id === atFiling.id)).toHaveLength(1);
    expect(requests.find((r) => r.id === atFiling.id)!.kind).toBe('sitting');
    expect(requests.filter((r) => r.id === later.id)).toHaveLength(1);

    // Clearing a marker is not issuing a request, and neither is the operator's
    // own answer.
    s.updateTicket(mason, { ticket_id: later.id, needs_human: false, note: 'Settled without a sitting.' });
    s.answerTicket(operator, decision.id, { answer: 'That way, because it is reversible.', resolution: 'resume' });
    const after = wide(s).requests;
    expect(after.filter((r) => r.id === later.id)).toHaveLength(1);
    expect(after.filter((r) => r.id === decision.id)).toHaveLength(1);
  });

  it('counts the sitting a release handoff creates without a diff of its own', () => {
    // `recordReleaseHandoff` sets needs_human in the same transaction and
    // writes no needs_human diff, so the three obvious issuance paths all miss
    // it. This is the fourth.
    const s = new Store(':memory:');
    const accepted = (title: string, reviewer: Actor) => {
      const ticket = s.createTicket(mason, { title, body: 'Release evidence.', workstream: 'publishing', type: 'review', assignee: 'mason' });
      const completion = s.recordProductCompletion(mason, { ticket_id: ticket.id, artifacts: [{ ref: ref('a'), author: 'mason' }], note: 'Candidate ready.' });
      const verdict = s.recordAcceptanceVerdict(reviewer, { ticket_id: ticket.id, refs: [ref('a')], verdict: 'pass', note: 'Exact refs pass.' });
      return { ticket, completion: completion.completion!, verdict: verdict.verdict! };
    };
    const technical = accepted('Release Helmo', proof);
    const clearance = accepted('Clear the Helmo release', ward);
    s.recordReleaseHandoff(mason, {
      ticket_id: technical.ticket.id,
      manifest_sha256: digest('a'),
      manifest: { refs: [ref('a')], branch: 'main' },
      technical_ticket: technical.ticket.id,
      technical_completion_seq: technical.completion.seq,
      technical_verdict_seq: technical.verdict.seq,
      technical_reviewer: 'proof',
      clearance_ticket: clearance.ticket.id,
      clearance_completion_seq: clearance.completion.seq,
      clearance_verdict_seq: clearance.verdict.seq,
      clearance_reviewer: 'ward',
      gate_receipt: { path: '/tmp/gate.json', sha256: digest('b') },
      publisher_receipt: { path: '/tmp/publisher.json', sha256: digest('c') },
      decision: 'Ten minutes deciding whether to make this repository public.',
      why_human: 'first_publication: First public exposure is outside standing publication authority.',
      sitting_with: 'mason',
    });
    const requests = wide(s).requests.filter((r) => r.id === technical.ticket.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.kind).toBe('sitting');
    expect(s.getTicket(technical.ticket.id).needs_human).toBe(true);
  });

  it('finds an imported row whose instant is spelled with an offset', () => {
    // These are text columns. A record imported from another installation can
    // spell the same moment with any UTC offset, and a lexicographic bound ON
    // the window drops it: `2026-10-10T07:00:00-04:00` sorts before
    // `2026-10-10T11:00:00Z` and is the same instant. The read is bounded a day
    // wider at each end for exactly this, and decides by instant.
    //
    // The event is the product's own; only its SPELLING is changed, on a second
    // connection, because an imported row is the one thing no write path here
    // can produce.
    const dir = mkdtempSync(join(tmpdir(), 'helmo-activity-'));
    const path = join(dir, 'helmo.db');
    try {
      const s = new Store(path);
      const east = open(s, 'Work whose spend was imported from the east');
      const west = open(s, 'Work whose spend was imported from the west');
      s.recordSpend(mason, east.id, { tokens: 7_000, note: 'Imported figure.' });
      const eastSeq = s.getEvents(east.id).at(-1)!.seq;
      s.recordSpend(mason, west.id, { tokens: 3_000, note: 'Imported figure.' });
      const westSeq = s.getEvents(west.id).at(-1)!.seq;

      const asOf = new Date();
      const from = new Date(asOf.getTime() - 6 * HOUR);
      const to = new Date(asOf.getTime() + 1000);
      // Two spellings of instants INSIDE that window which fall OUTSIDE it as
      // text: one sorting above the top, one below the bottom.
      const spell = (instant: number, hours: number) => {
        const sign = hours < 0 ? '-' : '+';
        const pad = `${Math.abs(hours)}`.padStart(2, '0');
        return `${new Date(instant + hours * HOUR).toISOString().replace('Z', '')}${sign}${pad}:00`;
      };
      const ahead = spell(asOf.getTime() - HOUR, 10);
      const behind = spell(asOf.getTime() - HOUR, -11);
      expect(ahead > to.toISOString()).toBe(true);
      expect(behind < from.toISOString()).toBe(true);
      expect(Date.parse(ahead)).toBe(asOf.getTime() - HOUR);
      expect(Date.parse(behind)).toBe(asOf.getTime() - HOUR);

      const side = new Database(path);
      side.prepare('UPDATE events SET ts = ? WHERE seq = ?').run(ahead, eastSeq);
      side.prepare('UPDATE events SET ts = ? WHERE seq = ?').run(behind, westSeq);
      side.close();

      const found = s.activityEvents(from.toISOString(), to.toISOString()).tokens;
      expect(found.map((item) => item.tokens).sort((a, b) => a - b)).toEqual([3_000, 7_000]);
      // And the projection places them by instant, not by how they are written:
      // both belong to the hour before the reading.
      const placed = teamActivity({ ...EMPTY, tokens: found }, asOf.toISOString(), 'UTC');
      expect(placed.day.series.find((item) => item.key === 'tokens')!.total).toBe(10_000);
      expect(placed.day.buckets.filter((b) => b.tokens !== 0)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the instant the oldest bucket opens, and nothing before it', () => {
    // The window a caller bounds its read with is a BUCKET BOUNDARY, and a
    // bucket owns the instant it opens. One millisecond earlier belongs to a
    // bucket this reading does not draw. (`recentResults` is half-open at the
    // bottom for the opposite reason: its bottom is exactly 24 hours ago.)
    const dir = mkdtempSync(join(tmpdir(), 'helmo-activity-'));
    const path = join(dir, 'helmo.db');
    try {
      const s = new Store(path);
      const t = open(s, 'Work whose spend lands on the boundary');
      s.recordSpend(mason, t.id, { tokens: 4_000, note: 'On the boundary.' });
      const seq = s.getEvents(t.id).at(-1)!.seq;
      const asOf = new Date().toISOString();
      const start = activityWindowStart(asOf, 'UTC');
      const side = new Database(path);
      const move = (at: string) => side.prepare('UPDATE events SET ts = ? WHERE seq = ?').run(at, seq);

      move(start);
      const onIt = s.activityEvents(start, asOf);
      expect(onIt.tokens).toEqual([{ at: start, tokens: 4_000 }]);
      expect(teamActivity(onIt, asOf, 'UTC').week.buckets[0]!.tokens).toBe(4_000);

      move(new Date(Date.parse(start) - 1).toISOString());
      expect(s.activityEvents(start, asOf).tokens).toEqual([]);
      side.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports when this store began recording, and reads it end to end', () => {
    const s = new Store(':memory:');
    const t = open(s, 'The first thing this installation recorded');
    close(s, t.id, 'A completion the reading can count.');
    s.recordSpend(mason, t.id, { tokens: 5_000, note: 'Metered.' });
    const asOf = new Date().toISOString();
    const source = s.activityEvents(activityWindowStart(asOf, 'UTC'), asOf);
    expect(source.recording_began_at).toBe(s.getEvents(t.id)[0]!.ts);

    const reading = teamActivity(source, asOf, 'UTC');
    const newest = reading.day.buckets.at(-1)!;
    expect(newest).toMatchObject({ tokens: 5_000, completions: 1, partial: true });
    expect(reading.recording_began_at).toBe(source.recording_began_at);
    // Everything just written is in the newest bucket of both ranges, and
    // nowhere else.
    expect(reading.day.series.find((x) => x.key === 'completions')!.total).toBe(1);
    expect(reading.week.buckets.at(-1)!.completions).toBe(1);
  });
});
