// What a reader actually sees in the Team now card, rendered from the real
// component against the real projection (H-3091).
//
// Server-rendered rather than driven in a browser, for the reason
// `recent-results.test.mjs` gives: this checkout may not be built, and the
// browser proof of the same card in both themes and at three widths is
// `scripts/verify-ui.mjs`. What is proved here is the reading — which state
// each agent is shown in, what is said about it, and what is deliberately NOT
// said in the glance view.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { renderToStaticMarkup } = await import('react-dom/server');
const React = await import('react');
// The REAL projection feeding the REAL component. A fixture restating the
// projection's output would pass while the two drifted apart.
const { teamNow } = await import('../../runtime/src/team-now.ts');
const { TeamNow, TeamNowSessions } = await import('../src/TeamNow.tsx');

const AS_OF = '2026-10-10T18:00:00.000Z';

const session = (partial) => ({
  session: partial.session ?? partial.agent,
  agent: partial.agent,
  workstream: 'estate-ui',
  detail: null,
  ...partial,
});

/** The card as the plain text a person sees, plus the roles it painted and the
 *  links it offered. */
function reading(sessions, work = {}) {
  const data = teamNow(sessions, work, AS_OF);
  return render(data);
}

/** The disclosure's own content. A closed `Collapsible` renders nothing, so the
 *  card's markup cannot carry this — it is rendered directly, and the browser
 *  run is what proves the control opens it. */
function disclosure(sessions, work = {}) {
  const html = renderToStaticMarkup(React.createElement(TeamNowSessions, { agents: teamNow(sessions, work, AS_OF).agents }));
  return { html, text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() };
}

function render(data) {
  const html = renderToStaticMarkup(React.createElement(TeamNow, { data }));
  return {
    html,
    text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    roles: [...html.matchAll(/data-status-role="([^"]*)"/g)].map((m) => m[1]),
    links: [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
  };
}

describe('the condensed team card', () => {
  it('titles itself and says when the states were read', () => {
    const r = reading([session({ agent: 'mason', source_state: 'RUNNING' })]);
    assert.match(r.text, /Team now/);
    // The machine-readable instant, not the formatted words: the card is read
    // in whatever timezone the browser is in, and the reading is the server's.
    assert.ok(r.html.includes(`dateTime="${AS_OF}"`), 'the card states the instant it was read at');
  });

  it('shows each agent once, by name, in Arthur’s four words', () => {
    const r = reading([
      session({ agent: 'mason', source_state: 'RUNNING' }),
      session({ agent: 'ward', source_state: 'IDLE' }),
      session({ agent: 'bosun', source_state: 'BLOCKED', detail: 'two consecutive failures — H-77' }),
      session({ agent: 'page', source_state: 'STOP', detail: 'by human: rev stop page' }),
    ]);
    assert.match(r.text, /mason Working/);
    assert.match(r.text, /ward Awaiting work/);
    assert.match(r.text, /bosun Blocked/);
    assert.match(r.text, /page Stopped/);
  });

  it('keeps an unexpected failure in its own words, not folded into blocked', () => {
    const r = reading([
      session({ agent: 'mason', source_state: 'WEDGED', detail: 'cannot reach Helm' }),
      session({ agent: 'ward', source_state: 'CRASHED', detail: 'the recorded session process (pid 4812) is gone' }),
    ]);
    assert.match(r.text, /mason Failed/);
    assert.match(r.text, /ward Failed/);
    assert.deepEqual(r.roles, ['failure', 'failure']);
  });

  it('reads a state it does not recognise as unknown, and says which state', () => {
    // A server newer than this build. The one thing that must not happen is a
    // future sentinel reading as a deliberate stop.
    const r = reading([session({ agent: 'mason', source_state: 'DRAINING' })]);
    assert.match(r.text, /mason Unknown: DRAINING/);
    assert.deepEqual(r.roles, ['attention']);
  });

  it('puts the reason for a blockage in the glance view and a decision’s in the disclosure', () => {
    const sessions = [
      session({ agent: 'mason', source_state: 'BLOCKED', detail: 'the store refused three writes' }),
      session({ agent: 'ward', source_state: 'PARKED', detail: 'by human: holding the fleet for a release' }),
    ];
    const r = reading(sessions);
    assert.match(r.text, /the store refused three writes/);
    // A deliberate stop does not explain itself where it would crowd out the
    // one row that needs reading.
    assert.doesNotMatch(r.text, /holding the fleet for a release/);
    // Not lost, though — the disclosure carries every session's own reason.
    assert.match(disclosure(sessions).text, /holding the fleet for a release/);
  });

  it('links the ticket an agent has claimed, and nothing when it holds none', () => {
    const r = reading([
      session({ agent: 'mason', source_state: 'RUNNING' }),
      session({ agent: 'ward', source_state: 'IDLE' }),
    ], { mason: [{ id: 'H-3091', title: 'The widget' }, { id: 'H-3092', title: 'The packet' }] });
    assert.ok(r.links.includes('/#H-3091'), `the claimed ticket is linked (${r.links.join(', ')})`);
    assert.match(r.text, /\+1 more held/);
    assert.equal(r.links.filter((href) => href.startsWith('/#')).length, 1, 'one link per agent, not a row of them');
  });

  it('shows one row for a seat with several sessions, and every session behind it', () => {
    const r = reading([
      session({ agent: 'mason', session: 'mason', source_state: 'RUNNING' }),
      session({ agent: 'mason', session: 'mason-2', source_state: 'WEDGED', detail: 'the second worker cannot reach Helm' }),
    ]);
    // The roll-up takes the worse state, and says there is more than one.
    assert.match(r.text, /mason Failed/);
    assert.match(r.text, /2 sessions/);
    // Both sessions are named in the disclosure, with their own state words, so
    // the roll-up can be checked rather than taken on trust.
    const detail = disclosure([
      session({ agent: 'mason', session: 'mason', source_state: 'RUNNING' }),
      session({ agent: 'mason', session: 'mason-2', source_state: 'WEDGED', detail: 'the second worker cannot reach Helm' }),
    ]);
    assert.match(detail.text, /session mason-2 · WEDGED/);
    assert.match(detail.text, /mason · RUNNING/);
  });

  it('says a roster it could not read is unreadable, never an empty team', () => {
    const r = render({ as_of: AS_OF, agents: [], unavailable: 'roster.toml line 4: unknown key' });
    assert.match(r.text, /The roster could not be read/);
    assert.match(r.text, /roster.toml line 4: unknown key/);
    assert.deepEqual(r.roles, ['failure']);
    // And an installation that really has no loops says that instead.
    const none = render({ as_of: AS_OF, agents: [] });
    assert.match(none.text, /roster configures no agents/);
    assert.deepEqual(none.roles, []);
  });

  it('paints nothing for an agent that is idle or deliberately stopped', () => {
    // The restraint UI.md states: colour marks what needs Arthur. Five neutral
    // rows is the fleet working.
    const r = reading([
      session({ agent: 'a', source_state: 'IDLE' }),
      session({ agent: 'b', source_state: 'SEAT_HELD' }),
      session({ agent: 'c', source_state: 'STOP' }),
      session({ agent: 'd', source_state: 'HOLD' }),
      session({ agent: 'e', source_state: 'halted' }),
    ]);
    assert.deepEqual(r.roles, []);
  });
});
