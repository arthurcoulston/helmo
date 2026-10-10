// What a reader actually sees in the What happens next card, rendered from the
// real component against the real projection (H-3089).
//
// Server-rendered rather than driven in a browser, for the reason
// `team-now.test.mjs` gives: this checkout may not be built, and the browser
// proof of the same card in both themes and at three widths is
// `scripts/verify-ui.mjs`. What is proved here is the READING — which of the
// three headlines a given record earns, and that a floor is never presented as
// a total.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { renderToStaticMarkup } = await import('react-dom/server');
const React = await import('react');
// The REAL projection feeding the REAL component. A fixture restating the
// projection's output would pass while the two drifted apart.
const { runway } = await import('../../work/src/runway.ts');
const { Runway, RunwayBasis } = await import('../src/Runway.tsx');

const AS_OF = '2026-10-10T18:00:00.000Z';

const ticket = (id, over = {}) => ({
  id, title: id, body: '', workstream: 'build', project: null, type: 'build', labels: [],
  status: 'open', priority: 2, assignee: 'mason', evidence: [], confidence: null, uncertainty_note: null,
  blast_radius: 'records', question: null, action: null, tokens_total: 0, cost_usd_total: 0,
  schedule: null, not_before: null, needs_human: false, sitting: null, sitting_with: null,
  release_handoff: null, lane: null, capacity_hold: null, completion_account: null,
  workflow_attempt_id: null, created_at: '2026-10-01T00:00:00.000Z', updated_at: AS_OF, closed_at: null,
  ...over,
});

/** Ten closes whose nearest-rank p25 and p75 are 2 and 4 hours exactly, so
 *  every expected reading below is hand-calculable. */
const builds = [1, 1, 2, 2, 3, 3, 3, 4, 9, 40].map((hours, i) => ({ id: `d${i}`, type: 'build', hours }));

function project({ tickets = [], blockers = new Map(), durations = builds, seats, workstreams } = {}) {
  return runway({
    tickets,
    blockers,
    workstreams: workstreams ?? [{ name: 'build', seat: 'mason', budget_usd: null, updated_at: AS_OF, spent_usd: 0, remaining_usd: null }],
    durations,
    seats: seats === undefined ? [{ agent: 'mason', state: 'awaiting' }, { agent: 'ward', state: 'awaiting' }] : seats,
    as_of: AS_OF,
  });
}

function strip(html) {
  return { html, text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    roles: [...html.matchAll(/data-status-role="([^"]*)"/g)].map((m) => m[1]),
    links: [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]) };
}

const reading = (options) => strip(renderToStaticMarkup(React.createElement(Runway, { data: project(options) })));

/** The disclosure's own content. A closed `Collapsible` renders nothing, so the
 *  card's markup cannot carry this — it is rendered directly, and the browser
 *  run is what proves the control opens it. */
const basis = (options) => strip(renderToStaticMarkup(React.createElement(RunwayBasis, { data: project(options) })));

describe('the what-happens-next card', () => {
  it('titles itself and says when the forecast was taken', () => {
    const r = reading({ tickets: [ticket('H-1')] });
    assert.match(r.text, /What happens next/);
    assert.match(r.text, /without your intervention/);
    // The machine-readable instant, not the formatted words: the card is read
    // in whatever timezone the browser is in, and the reading is the server's.
    assert.ok(r.html.includes(`dateTime="${AS_OF}"`), 'the card states the instant it was taken at');
  });

  it('says "about" when every admitted item was measurable', () => {
    const r = reading({ tickets: [ticket('H-1'), ticket('H-2', { assignee: 'ward' })] });
    assert.match(r.text, /About 2–4 hours/);
    assert.doesNotMatch(r.text, /At least/);
    assert.doesNotMatch(r.text, /floor/);
  });

  it('says "at least" and calls the number a floor when part could not be measured', () => {
    const r = reading({
      tickets: [ticket('H-1'), ticket('H-2', { assignee: 'ward' }), ticket('H-3', { capacity_hold: { reason: 'later phase', provenance: 'p', reconsider_when: 'w' } })],
      blockers: new Map([['H-2', ['H-3']]]),
    });
    assert.match(r.text, /At least 2–4 hours/);
    assert.match(r.text, /The floor, not the total: one item could not be measured/);
    assert.match(r.text, /may continue longer/);
  });

  it('refuses to draw a zero when nothing could be measured', () => {
    const r = reading({ tickets: [ticket('H-1')], durations: builds.slice(0, 3) });
    assert.match(r.text, /Hours unavailable/);
    assert.match(r.text, /no comparable closed build work to measure/i);
    assert.doesNotMatch(r.text, /About/);
  });

  it('still names the work when nothing can time it, rather than showing a list of nothing', () => {
    const r = reading({ tickets: [ticket('H-1'), ticket('H-2')], durations: [] });
    assert.match(r.text, /Hours unavailable/);
    assert.match(r.text, /H-1 H-1 mason timing unknown/);
    assert.match(r.text, /H-2 H-2 mason timing unknown/);
    assert.ok(r.links.includes('/#H-2'), 'an untimed outcome still links to its record');
  });

  it('reads sub-hour work in minutes rather than showing the arithmetic', () => {
    const quick = [0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.3, 0.4, 0.5, 0.9].map((hours, i) => ({ id: `q${i}`, type: 'build', hours }));
    const r = reading({ tickets: [ticket('H-1')], durations: quick });
    assert.match(r.text, /About 12–24 minutes/);
    assert.doesNotMatch(r.text, /0\.2/);
  });

  it('names three outcomes with their owner and counts the rest', () => {
    const r = reading({ tickets: ['H-1', 'H-2', 'H-3', 'H-4', 'H-5'].map((id) => ticket(id)) });
    assert.match(r.text, /H-1 H-1 mason by 2–4 hours/);
    assert.match(r.text, /H-3 H-3 mason by 6–12 hours/);
    assert.match(r.text, /\+2 more in the forecast/);
    assert.ok(r.links.includes('/#H-1'), 'each outcome links to its record');
    assert.ok(!r.text.includes('H-5'), 'the glance view stops at three');
  });

  it('names the first step Arthur keeps, with how far off it is', () => {
    const r = reading({ tickets: [ticket('H-1', { blast_radius: 'published' })] });
    assert.match(r.text, /Needs you/);
    assert.match(r.text, /Publishing needs Arthur, about 2–4 hours in/);
    assert.deepEqual(r.roles, ['attention']);
  });

  it('keeps a deliberate hold and a date gate out of the colours', () => {
    const r = reading({
      tickets: [
        ticket('H-1'),
        ticket('H-2', { capacity_hold: { reason: 'later phase', provenance: 'p', reconsider_when: 'w' } }),
        ticket('H-3', { not_before: '2026-11-01' }),
      ],
    });
    assert.deepEqual(r.roles, [], 'queued work, a hold and a gate are the system working');
  });

  it('says so when every startable item is waiting on him', () => {
    const r = reading({ tickets: [ticket('H-1', { status: 'awaiting_human' }), ticket('H-2', { needs_human: true, sitting: 'Two clicks in Cloudflare' })] });
    assert.match(r.text, /The team has run out of work it can do alone/);
    assert.match(r.text, /2 items are waiting on you/);
    assert.deepEqual(r.roles, ['attention']);
  });

  it('reads an unreadable roster as a failure, not as an empty fleet', () => {
    const r = reading({ tickets: [ticket('H-1')], seats: null });
    assert.match(r.text, /No forecast could be taken/);
    assert.match(r.text, /roster could not be read/);
    assert.doesNotMatch(r.text, /Hours unavailable/);
    assert.deepEqual(r.roles, ['failure']);
    assert.ok(!r.text.includes('How this was estimated'), 'there is no basis to disclose');
  });

  it('puts the whole basis for the number behind the disclosure', () => {
    const b = basis({
      tickets: [
        ticket('H-1'),
        ticket('H-2', { capacity_hold: { reason: 'R-44 is a later phase', provenance: 'p', reconsider_when: 'w' } }),
      ],
      seats: [{ agent: 'mason', state: 'awaiting' }, { agent: 'ward', state: 'stopped' }],
    });
    assert.match(b.text, /25th to 75th percentile.*claim-to-close.*last 90 days — 10 records/);
    assert.match(b.text, /never a guarantee/);
    assert.match(b.text, /Not runway at all H-2 H-2 · Deliberately held: R-44 is a later phase/);
    assert.match(b.text, /Seats counted as able to continue mason/);
    assert.match(b.text, /Not counted: ward \(stopped\)/);
    assert.match(b.text, /does not model/);
    assert.match(b.text, /not from any estimate of this work/);
  });
});
