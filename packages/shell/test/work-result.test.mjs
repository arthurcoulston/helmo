// What a reader actually sees for each row of §3 of
// `crew:projects/r39/RESULT-ROLE-CONTRACT.md`, rendered from the real
// component against the real projection.
//
// Server-rendered rather than driven in a browser for two reasons. The
// reachability rule in §2.5 is a property of the DEVICE doing the looking, and
// `verify-ui.mjs` always looks from loopback, where every ref is reachable and
// case 6(b) cannot happen. And this checkout may not be built: building a
// shared installation deploys it to every consumer loading its `dist`, so the
// proof that may run here is the one that runs from source.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const VIEWING = 'dash.example.com';
globalThis.location = { hostname: VIEWING };
const { renderToStaticMarkup } = await import('react-dom/server');
const React = await import('react');
// Reached for by path rather than through a declared dependency on purpose:
// the whole point of this proof is the REAL projection feeding the REAL
// component, and a fixture restating the projection's output would pass while
// the two drifted apart.
const { resultDisplay } = await import('../../work/src/presentation.ts');
// `TicketRecordContent` rather than `WorkRecord`: since H-2974 the result
// section is in the Sheet the compact table opens, and a Sheet is a Radix
// portal into `document.body`, which server rendering has none of. This is
// the same component the Sheet draws, fed the same row; that the Sheet draws
// it is proved in the browser by `scripts/verify-ui.mjs`.
const { TicketRecordContent } = await import('../src/WorkRecord.tsx');

/** The record as one closed row, read as the plain text a person sees. */
function reading(evidence, { from = VIEWING } = {}) {
  globalThis.location = { hostname: from };
  const row = {
    id: 'H-1', title: 'The work', status: 'done', workstream: 'estate-ui', type: 'build', priority: 2,
    updated_at: '2026-10-06T12:00:00Z', closed_at: '2026-10-06T12:00:00Z', tokens_total: 0, cost_usd_total: 0,
    evidence,
    display: {
      group: 'done', waits_on: [], gated: false, held: false, chain: [], progress: null,
      acceptance: { state: 'not_requested', reason: 'no_completion' },
      result: resultDisplay(evidence),
    },
  };
  const html = renderToStaticMarkup(React.createElement(TicketRecordContent, { row }));
  return {
    html,
    text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    /** Every prominent control the row offers. A result is the ONE action. */
    actions: [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>View result<\/a>/g)].map((m) => m[1]),
  };
}

const CONTRACT = 'crew:projects/r39/RESULT-ROLE-CONTRACT.md';
const BOOK = 'https://goodplumb.co.uk/book';

describe('the result a ticket produced, as a reader sees it', () => {
  it('§3.1 shows a file as the result, as prominently as a URL', () => {
    const r = reading([{ kind: 'file', ref: CONTRACT, role: 'result' }]);
    assert.match(r.text, /Result file crew:projects\/r39\/RESULT-ROLE-CONTRACT\.md/);
    assert.doesNotMatch(r.text, /No result recorded/);
    assert.doesNotMatch(r.text, /No product result linked/);
  });

  it('§3.2 offers a URL result as the one action', () => {
    const r = reading([{ kind: 'url', ref: BOOK, role: 'result' }]);
    assert.deepEqual(r.actions, [BOOK]);
  });

  it('§3.3 does not give a supporting URL a second identical button', () => {
    const r = reading([
      { kind: 'file', ref: CONTRACT, role: 'result' },
      { kind: 'url', ref: 'https://ci.example.com/run/1234', note: 'The CI run', role: 'supporting' },
    ]);
    assert.deepEqual(r.actions, [], 'the result here is a file, so nothing is a View result link');
    assert.match(r.text, /Supporting url https:\/\/ci\.example\.com\/run\/1234 The CI run/);
    assert.ok(r.text.indexOf('Result') < r.text.indexOf('Supporting'));
  });

  it('§3.4 heads a review of the result separately from supporting', () => {
    const r = reading([
      { kind: 'url', ref: BOOK, role: 'result' },
      { kind: 'url', ref: 'https://x.example.com/REVIEW-ward.md', role: 'review' },
    ]);
    assert.deepEqual(r.actions, [BOOK]);
    assert.match(r.text, /Review url https:\/\/x\.example\.com\/REVIEW-ward\.md/);
    assert.doesNotMatch(r.text, /Supporting/);
    assert.match(r.text, /Release review: not requested/);
  });

  it('§3.5 shows an operational change as what the work produced', () => {
    const r = reading([
      { kind: 'commit', ref: 'helmo@76f395d', role: 'result' },
      { kind: 'file', ref: '~/.helmo/rev.json', role: 'supporting' },
    ]);
    assert.match(r.text, /Result commit helmo@76f395d/);
    assert.match(r.text, /Supporting file ~\/\.helmo\/rev\.json/);
    assert.doesNotMatch(r.text, /No result recorded/);
  });

  it('§3.6a says no result is recorded, and invents none', () => {
    const r = reading([]);
    assert.match(r.text, /Result No result recorded Release review/);
    assert.deepEqual(r.actions, []);
  });

  it('§3.6b keeps an unreachable ref the result, copyable, and says where it is not', () => {
    const ref = 'http://localhost:4400/#H-1';
    const r = reading([{ kind: 'url', ref, role: 'result' }]);
    assert.match(r.text, /Result url http:\/\/localhost:4400\/#H-1 Not reachable from this device/);
    assert.deepEqual(r.actions, [], 'an unreachable ref must not be offered as an opening action');
    assert.match(r.html, new RegExp(`aria-label="Copy ${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    // The same record, read on the machine it names, IS reachable: the ref did
    // not change, the device did.
    assert.deepEqual(reading([{ kind: 'url', ref, role: 'result' }], { from: 'localhost' }).actions, [ref]);
  });

  it('§3.L1 still offers a legacy URL, and says the purpose was a guess', () => {
    const r = reading([{ kind: 'url', ref: BOOK }]);
    assert.deepEqual(r.actions, [BOOK], 'no existing record may lose its result the day the field ships');
    assert.match(r.text, /Purpose not recorded/);
  });

  it('§3.L2 describes the 2,153 without claiming they produced nothing or something it cannot name', () => {
    const r = reading([{ kind: 'commit', ref: 'helmo@9177e4b' }, { kind: 'file', ref: CONTRACT }]);
    assert.match(r.text, /No result recorded — purpose was not recorded for 2 items of evidence/);
    assert.match(r.text, /commit helmo@9177e4b/);
    assert.match(r.text, new RegExp(`file ${CONTRACT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(r.text, /No product result linked/);
  });

  it('counts the results when a ticket records more than one, and hides none', () => {
    const r = reading([{ kind: 'commit', ref: 'helmo@aaa1111', role: 'result' }, { kind: 'url', ref: BOOK, role: 'result' }]);
    assert.match(r.text, /Result · 2/);
    assert.deepEqual(r.actions, [BOOK], 'the latest append is the action, and it is the only one');
    assert.match(r.text, /commit helmo@aaa1111/);
  });

  it('counts items it cannot vouch for without calling their purpose recorded', () => {
    // Ward's residual on H-2969: the heading read "2 recorded" over two items
    // whose purpose is the frozen `kind === "url"` guess, which is the one
    // thing each line underneath says was NOT recorded.
    const r = reading([{ kind: 'url', ref: BOOK }, { kind: 'url', ref: 'https://example.com/other' }]);
    assert.match(r.text, /Result · 2/);
    assert.doesNotMatch(r.text, /recorded for the purpose|· 2 recorded/);
    assert.equal(r.text.match(/Purpose not recorded/g).length, 2);
  });

  it('says so when a role was corrected by a later append', () => {
    const r = reading([{ kind: 'file', ref: CONTRACT, role: 'supporting' }, { kind: 'file', ref: CONTRACT, role: 'result' }]);
    assert.match(r.text, /Role corrected/);
    assert.doesNotMatch(r.text, /Supporting/);
    assert.equal(r.text.match(new RegExp(CONTRACT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')).length, 1);
  });

  it('lists an out-of-enum kind under a heading that does not claim no result exists', () => {
    const r = reading([{ kind: 'url', ref: BOOK, role: 'result' }, { kind: 'test', ref: 'the H-884 item' }]);
    assert.deepEqual(r.actions, [BOOK]);
    assert.match(r.text, /Purpose not recorded test the H-884 item/);
  });
});
