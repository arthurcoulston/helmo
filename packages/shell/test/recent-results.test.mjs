// What a reader actually sees in the past-24-hours results card, rendered from
// the real component against the real projection
// (`crew:projects/r39/RECENT-RESULTS-CONTRACT.md` §3–§4).
//
// Server-rendered rather than driven in a browser, for the same two reasons as
// `work-result.test.mjs`: the reachability rule is a property of the device
// doing the looking, and this checkout may not be built. The browser proof of
// the same card, in both themes, is `scripts/verify-ui.mjs`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const VIEWING = 'dash.example.com';
globalThis.location = { hostname: VIEWING };
const { renderToStaticMarkup } = await import('react-dom/server');
const React = await import('react');
// The REAL projection feeding the REAL component. A fixture restating the
// projection's output would pass while the two drifted apart.
const { recentResults } = await import('../../work/src/presentation.ts');
const { RecentResults } = await import('../src/RecentResults.tsx');

const AS_OF = '2026-10-09T21:31:48.371Z';
const hoursBefore = (hours) => new Date(new Date(AS_OF).getTime() - hours * 3_600_000).toISOString();
const NOT_REQUESTED = { state: 'not_requested', reason: 'no_completion' };

function ticket(partial) {
  return {
    title: 'The work', body: '', workstream: 'estate-ui', project: null, type: 'build', labels: [],
    status: 'done', priority: 2, assignee: null, evidence: [], confidence: null, uncertainty_note: null,
    blast_radius: 'none', question: null, action: null, tokens_total: 0, cost_usd_total: 0, schedule: null,
    not_before: null, needs_human: false, sitting: null, sitting_with: null, release_handoff: null, lane: null,
    capacity_hold: null, workflow_attempt_id: null, completion_account: null,
    created_at: hoursBefore(48), updated_at: hoursBefore(1), closed_at: hoursBefore(1),
    ...partial,
  };
}

const account = (category, summary) => ({ category, summary, author: 'mason', recorded_at: hoursBefore(1) });

/** The card as the plain text a person sees, plus its one prominent control
 *  per row and its overflow link. */
function reading(tickets, { acceptance = () => NOT_REQUESTED } = {}) {
  const data = recentResults(tickets, AS_OF, acceptance);
  const html = renderToStaticMarkup(React.createElement(RecentResults, { data }));
  return {
    html,
    text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    actions: [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>View result<\/a>/g)].map((m) => m[1]),
    links: [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
  };
}

const BOOK = 'https://goodplumb.co.uk/book';

describe('the past-24-hours results card', () => {
  it('titles itself and says which window the rows describe', () => {
    const r = reading([ticket({ id: 'H-1', completion_account: account('improvement', 'Faster.') })]);
    assert.match(r.text, /Results · Past 24 hours/);
    // The machine-readable instants, not the formatted words: the card is read
    // in whatever timezone the browser is in, and the window it names must be
    // the server's.
    assert.ok(r.html.includes(`dateTime="${AS_OF}"`), 'the card states the as_of it was windowed at');
    assert.ok(r.html.includes(`dateTime="${hoursBefore(24)}"`), 'and where that window started');
  });

  it('shows the author’s own account, its category and who recorded it', () => {
    const summary = 'The operator can read what got done in the past day without opening a ticket.';
    const r = reading([ticket({ id: 'H-1', completion_account: account('improvement', summary) })]);
    assert.match(r.text, /H-1 Improvement/);
    assert.match(r.text, new RegExp(summary));
    assert.match(r.text, /mason/);
    assert.doesNotMatch(r.text, /from its type/);
  });

  it('says an account is missing rather than writing one from the title', () => {
    const r = reading([ticket({ id: 'H-5', title: 'Shipped the thing' })]);
    assert.match(r.text, /Uncategorised/);
    assert.match(r.text, /Completion account missing/);
    assert.doesNotMatch(r.text, /Shipped the thing/);
  });

  it('marks a category it read from an old ticket’s type as exactly that', () => {
    const r = reading([ticket({ id: 'H-4', type: 'writing' })]);
    assert.match(r.text, /Documentation \/ content from its type/);
    assert.match(r.text, /Completion account missing/);
  });

  it('offers a recorded result as the one action, and a file as readily as a URL', () => {
    const url = reading([ticket({ id: 'H-1', evidence: [{ kind: 'url', ref: BOOK, role: 'result' }], completion_account: account('feature', 'Deposits.') })]);
    assert.deepEqual(url.actions, [BOOK]);
    const file = reading([ticket({ id: 'H-4', evidence: [{ kind: 'file', ref: 'crew:projects/r39/RECENT-RESULTS-CONTRACT.md', role: 'result' }], completion_account: account('documentation_content', 'Written down.') })]);
    assert.match(file.text, /file crew:projects\/r39\/RECENT-RESULTS-CONTRACT\.md/);
    assert.doesNotMatch(file.text, /No result recorded/);
  });

  it('keeps a review-only link out of the result position and invents no result', () => {
    const r = reading([ticket({
      id: 'H-3', type: 'review', evidence: [{ kind: 'url', ref: 'https://x.example/REVIEW.md', role: 'review' }],
      completion_account: account('review', 'Checked the candidate; one gap found.'),
    })]);
    assert.match(r.text, /No result recorded/);
    assert.deepEqual(r.actions, []);
    assert.ok(!r.links.includes('https://x.example/REVIEW.md'), 'a review link is not the deliverable');
  });

  it('says no result is recorded for an accounted ticket with no evidence', () => {
    const r = reading([ticket({ id: 'H-2', completion_account: account('maintenance', 'The obsolete importer is gone.') })]);
    assert.match(r.text, /The obsolete importer is gone\. No result recorded/);
  });

  it('writes the review and delivery states as words', () => {
    const rows = [
      ticket({ id: 'H-1', blast_radius: 'published', completion_account: account('feature', 'Shipped.') }),
      ticket({ id: 'H-2', closed_at: hoursBefore(2), blast_radius: 'records', completion_account: account('operations', 'Changed.') }),
    ];
    const r = reading(rows, { acceptance: (id) => (id === 'H-1' ? { state: 'accepted', reason: 'independently_accepted' } : { state: 'pending', reason: 'missing_verdict' }) });
    assert.match(r.text, /Accepted Delivery: Published/);
    assert.match(r.text, /Awaiting review Delivery: Recorded/);
    assert.match(r.html, /data-status-role="success"/);
  });

  it('reads every pending reason as awaiting review, and a failure as a failure', () => {
    const row = [ticket({ id: 'H-1', completion_account: account('feature', 'Shipped.') })];
    for (const reason of ['missing_verdict', 'stale_verdict', 'self_authored_verdict']) {
      assert.match(reading(row, { acceptance: () => ({ state: 'pending', reason }) }).text, /Awaiting review/);
    }
    const failed = reading(row, { acceptance: () => ({ state: 'failed', reason: 'review_failed' }) });
    assert.match(failed.text, /Review failed/);
    assert.match(failed.html, /data-status-role="failure"/);
  });

  it('draws six rows and links the remainder to Work', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ticket({ id: `H-${10 + i}`, closed_at: hoursBefore(i + 1), completion_account: account('maintenance', `Outcome ${i}.`) }));
    const r = reading(seven);
    assert.equal(r.text.match(/Outcome \d\./g).length, 6);
    assert.match(r.text, /1 more completed result in Work/);
    assert.ok(r.links.includes('/work'));
    assert.doesNotMatch(r.text, /Outcome 6\./, 'the seventh is counted and linked, not drawn');
  });

  it('counts the remainder in the plural when there is more than one', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ticket({ id: `H-${10 + i}`, closed_at: hoursBefore(i + 1) }));
    assert.match(reading(nine).text, /3 more completed results in Work/);
  });

  it('offers no overflow link when every result is drawn', () => {
    const r = reading([ticket({ id: 'H-1', completion_account: account('feature', 'Shipped.') })]);
    assert.doesNotMatch(r.text, /more completed result/);
    assert.ok(!r.links.includes('/work'));
  });

  it('says the window was empty rather than drawing nothing', () => {
    const r = reading([]);
    assert.match(r.text, /No completed work was recorded in the past 24 hours/);
    assert.doesNotMatch(r.text, /Completion account missing/);
  });

  it('links each row to its own record', () => {
    const r = reading([ticket({ id: 'H-1', completion_account: account('feature', 'Shipped.') })]);
    assert.ok(r.links.includes('/#H-1'));
  });
});
