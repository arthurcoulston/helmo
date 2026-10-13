// What a reader sees when the issue log is empty (H-3216). Two different
// facts used to render as one sentence: "No issues were detected by the checks
// run at <the instant you loaded the page>" was printed whether a sweep had
// ever recorded or not — and until this packet nothing could record, so the
// reassurance was never once earned.
//
// Server-rendered from the REAL projection into the REAL component, for the
// same reason as its siblings: a fixture restating the projection's output
// would pass while the two drifted apart.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { renderToStaticMarkup } = await import('react-dom/server');
const React = await import('react');
const { replayIssues } = await import('../../work/src/issues.ts');
const { IssuesCard, IssuesView } = await import('../src/IssuesView.tsx');

const AS_OF = '2026-10-12T12:00:00.000Z';
const OBSERVED = '2026-10-12T09:00:00.000Z';

const observation = (at) => ({
  seq: 1, ts: at, type: 'issue_observed',
  payload: {
    key: 'done_without_evidence|ticket|H-9', check: 'done_without_evidence',
    subject_kind: 'ticket', subject_ref: 'H-9',
    detail: { state: 'known', value: 'closed with no evidence link', source_ref: 'work:hygiene:done_without_evidence', recorded_at: at },
    owner: { state: 'known', value: 'mason', source_ref: 'work:H-9', recorded_at: at },
    next_action: { state: 'known', value: 'Add the evidence', source_ref: 'check:done_without_evidence', recorded_at: at },
  },
});

const render = (node) => renderToStaticMarkup(node);

describe('an empty issue log', () => {
  it('says nothing has been recorded rather than that the checks found nothing', () => {
    const data = replayIssues([], AS_OF);
    assert.equal(data.coverage.state, 'missing');
    assert.equal(data.coverage.last_recorded_at, null);

    for (const markup of [render(React.createElement(IssuesCard, { data })), render(React.createElement(IssuesView, { data }))]) {
      assert.match(markup, /No check has recorded into this log yet/);
      assert.doesNotMatch(markup, /No issues were detected/);
    }
  });

  it('dates a clean bill of health by the sweep, not by when the page was read', () => {
    // One observation, resolved: the log has been written to, and right now
    // there is nothing active in it.
    const data = replayIssues([
      observation(OBSERVED),
      { seq: 2, ts: OBSERVED, type: 'issue_disposed', payload: { key: 'done_without_evidence|ticket|H-9', disposition: { state: 'resolved', owner: { state: 'known', value: 'mason', source_ref: 'work:H-9', recorded_at: OBSERVED }, evidence: [{ state: 'known', value: { ref: 'helmo@abc1234' }, source_ref: 'work:issue', recorded_at: OBSERVED }] } } },
    ], AS_OF);
    assert.equal(data.coverage.last_recorded_at, OBSERVED);

    const markup = render(React.createElement(IssuesCard, { data }));
    assert.match(markup, /No issues were detected by the checks recorded at/);
    // The hour the sweep ran, never the hour the reader arrived.
    assert.match(markup, new RegExp(new Date(OBSERVED).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(markup, new RegExp(new Date(AS_OF).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
