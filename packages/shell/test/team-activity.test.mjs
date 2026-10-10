// What a reader actually sees in the activity card, rendered from the real
// component against the real projection
// (`crew:projects/r39/TEAM-ACTIVITY-CONTRACT.md`).
//
// Server-rendered, like the other card proofs here: this checkout may not be
// built, and what matters at this level is the WORDS — which series, which
// window, which basis, and the exact figures in the numbers table. The bars
// themselves are drawn by a charting library inside a measured container, so
// the browser is the only honest place to prove they appear at all: that is
// `scripts/verify-ui.mjs`, which walks Overview in both themes at three widths.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { renderToStaticMarkup } = await import('react-dom/server');
const React = await import('react');
// The REAL projection feeding the REAL component.
const { teamActivity } = await import('../../work/src/presentation.ts');
const { TeamActivity, TeamActivityNumbers } = await import('../src/TeamActivity.tsx');

const AS_OF = '2026-10-09T21:31:48.371Z';
const before = (ms) => new Date(Date.parse(AS_OF) - ms).toISOString();
const HOUR = 3_600_000;

const EVENTS = {
  tokens: [
    { at: before(20 * 60_000), tokens: 412_000 },
    { at: before(3 * HOUR), tokens: 180_000 },
    { at: before(26 * HOUR), tokens: 95_000 },
  ],
  completions: [
    { at: before(20 * 60_000), id: 'H-3090' },
    { at: before(3 * HOUR), id: 'H-3091' },
    { at: before(26 * HOUR), id: 'H-3088' },
  ],
  requests: [
    { at: before(10 * 60_000), id: 'H-3092', kind: 'decision' },
    { at: before(3 * HOUR), id: 'H-3104', kind: 'sitting' },
  ],
  recording_began_at: before(30 * HOUR),
};

const data = (events = EVENTS, zone = 'UTC') => teamActivity(events, AS_OF, zone);

function reading(element) {
  const html = renderToStaticMarkup(element);
  return { html, text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() };
}

const card = (events, zone) => reading(React.createElement(TeamActivity, { data: data(events, zone) }));

describe('the activity card', () => {
  it('names the three series, each with its own total and its own scale', () => {
    const r = card();
    assert.match(r.text, /Team activity/);
    assert.match(r.text, /Tokens reported 592,000 tokens in this period · scaled to its own peak of 412,000 tokens/);
    assert.match(r.text, /Tickets completed 2 tickets in this period · scaled to its own peak of 1 tickets/);
    assert.match(r.text, /New requests for you 2 requests in this period/);
    // The one thing a reader could get wrong from the drawing alone is said in
    // words, not left to the axis.
    assert.match(r.text, /scaled to its own peak: heights compare along a row and never between rows/);
  });

  it('says which window the bars describe, and whose clock cut them', () => {
    const r = card();
    // The machine-readable instants, not the formatted words: the card is read
    // in whatever zone the browser is in and the window it names is the
    // server's.
    assert.ok(r.html.includes(`dateTime="${AS_OF}"`), 'the card states the as_of it was windowed at');
    assert.ok(r.html.includes('dateTime="2026-10-08T22:00:00.000Z"'), 'and where that window started');
    assert.match(r.text, /the past 24 hours, in hours/);
    assert.match(r.text, /on the UTC clock/);
  });

  it('offers the week as the other range, and the day as the one it opens on', () => {
    const r = card();
    assert.match(r.html, /aria-pressed="true"[^>]*>Day</);
    assert.match(r.html, /aria-pressed="false"[^>]*>Week</);
    // The numbers are one disclosure away, never a second page.
    assert.match(r.text, /Show the numbers/);
  });

  it('draws nothing but a flat line when nothing was reported', () => {
    const r = card({ tokens: [], completions: [], requests: [], recording_began_at: null });
    assert.match(r.text, /Tokens reported 0 tokens in this period · nothing reported, so this line is flat/);
    assert.match(r.text, /New requests for you 0 requests in this period · nothing reported/);
  });
});

describe('the activity numbers', () => {
  const numbers = (range, zone = 'UTC') => reading(React.createElement(TeamActivityNumbers, { range, timeZone: zone }));

  it('states every series’ basis and coverage in full', () => {
    const r = numbers(data().day);
    assert.match(r.text, /Tokens reported \(tokens\) — counted when the figure was REPORTED, not when the work ran/);
    assert.match(r.text, /unmetered work is excluded/);
    assert.match(r.text, /Tickets completed \(tickets\) — counted once per ticket/);
    assert.match(r.text, /a reopened ticket leaves the chart until it closes again/);
    assert.match(r.text, /New requests for you \(requests\) — counted once when a decision, an action or a sitting was issued/);
    assert.match(r.text, /your own answers are not counted at all/);
    assert.match(r.text, /Buckets are cut on the UTC clock/);
  });

  it('gives every bucket’s exact figures, its local label and its real length', () => {
    const r = numbers(data().day);
    const rows = [...r.html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((m) => m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
    assert.equal(rows.length, 25, 'a header and twenty-four hourly rows');
    // The newest hour: both figures exactly as the record holds them, and the
    // bucket saying it is not a whole hour yet.
    assert.match(rows.at(-1), /21:00 · still filling 412,000 1 1 32 min/);
    // A bucket with nothing in it reads as zero.
    assert.ok(rows.some((row) => /^1[0-9]:00 0 0 0 60 min$/.test(row)), 'a recorded empty bucket reads as zero');

    // And a bucket from before this installation was recording reads as
    // unknown, never as zero — the two are different statements.
    const young = numbers(data({ ...EVENTS, recording_began_at: before(10 * HOUR) }).day);
    const unknown = [...young.html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)]
      .map((m) => m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
      .filter((row) => /no record/.test(row));
    assert.equal(unknown.length, 13, 'every hour before the first event, and no other');
    assert.match(unknown[0], /no record no record no record/);
  });

  it('carries a daylight-saving day at its real length', () => {
    // The local day British Summer Time ends on is twenty-five hours long, and
    // the table says so rather than implying twenty-four.
    const london = teamActivity(
      { tokens: [], completions: [], requests: [], recording_began_at: null },
      '2026-10-26T12:00:00.000Z',
      'Europe/London',
    );
    const r = numbers(london.week, 'Europe/London');
    assert.match(r.text, /Sun 25 0 0 0 25 h/);
    assert.match(r.text, /Buckets are cut on the Europe\/London clock/);
  });
});
