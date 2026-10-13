// What a reader actually sees of the incident notices — the band at the top of
// Overview and the board on Incidents — rendered from the real components
// against the real projection (R-44, H-3216).
//
// Server-rendered for the same reason as `recent-results.test.mjs`: this
// checkout may not be built, and the words are what this proof is about. The
// browser proof of both, in two themes at three widths, is
// `scripts/verify-ui.mjs`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

globalThis.location = { hostname: 'dash.example.com' };
const { renderToStaticMarkup } = await import('react-dom/server');
const React = await import('react');
// The REAL projection feeding the REAL components.
const { incidentNoticeBoard } = await import('../../work/src/incidents.ts');
const { IncidentNoticeBand, IncidentNoticeTable } = await import('../src/IncidentNotices.tsx');

const AS_OF = '2026-10-12T18:00:00.000Z';
const before = (minutes) => new Date(new Date(AS_OF).getTime() - minutes * 60_000).toISOString();
const known = (value, source_ref = 'H-7', recorded_at = AS_OF) => ({ state: 'known', value, source_ref, recorded_at });
const unknown = { state: 'unknown', reason: 'not_recorded' };

/** The opening patch an incident is actually recorded with: the stage, and
 *  every other field explicitly not yet known. */
function opening(happeningNow) {
  return {
    stage: known('investigating'), owner: known('mason'), detection: known({ by: 'human', happened_at: before(90) }),
    affected: known('the operator dashboard'), happening_now: known(happeningNow), cause: unknown,
    containment: unknown, fix: unknown, recovery_evidence: [], recurrence_evidence: [],
    human_report_acknowledgement: unknown, remaining_work: [],
  };
}

function reading(component, events, asOf = AS_OF) {
  const data = incidentNoticeBoard(events, asOf);
  const html = renderToStaticMarkup(React.createElement(component, { data }));
  return {
    html,
    text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    links: [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
    roles: [...html.matchAll(/data-status-role="([^"]*)"/g)].map((m) => m[1]),
  };
}

const live = (id = 'H-7') => [{ seq: 1, ts: before(90), ticket_id: id, payload: { patch: opening(true) } }];
const contained = (id = 'H-7') => ({ seq: 2, ts: before(30), ticket_id: id, payload: { patch: { stage: known('mitigated'), containment: known('writes stopped'), happening_now: known(false) } } });
const resolved = (id = 'H-7') => ({ seq: 3, ts: before(10), ticket_id: id, payload: { patch: { stage: known('resolved'), cause: known({ account: 'bad pin', confidence: 'known' }), fix: known('pin corrected'), recovery_evidence: [known({ ref: 'check:green' })] } } });

describe('the incident band at the top of Overview', () => {
  it('draws nothing at all when the record has nothing to tell him', () => {
    // The ordinary day: Arthur's four ratified Overview readings keep the page
    // they were ratified on, because this adds no empty band above them.
    assert.equal(reading(IncidentNoticeBand, []).html, '');
  });

  it('names the live incident, paints it red, and says nothing on it is waiting on him', () => {
    const r = reading(IncidentNoticeBand, live());
    assert.deepEqual(r.roles, ['failure']);
    assert.match(r.text, /1 unresolved incident/);
    assert.match(r.text, /H-7 identified/);
    assert.match(r.text, /· still happening/);
    assert.match(r.text, /Nothing here is waiting on you/);
    assert.ok(r.links.includes('/incidents/H-7'), 'the band does not open the incident it names');
  });

  it('is green once the incident is resolved, and never says a resolved incident is still happening', () => {
    const r = reading(IncidentNoticeBand, [...live(), contained(), resolved()]);
    assert.deepEqual(r.roles, ['success']);
    assert.match(r.text, /H-7 resolved/);
    // "whether it is still happening" is a field that CHANGED; the suffix
    // this must not carry is the standing claim that it still is.
    assert.doesNotMatch(r.text, /· still happening/);
  });

  it('holds three lines and counts the rest', () => {
    const r = reading(IncidentNoticeBand, [
      ...live('H-7'), contained('H-7'), resolved('H-7'),
      { seq: 4, ts: before(5), ticket_id: 'H-9', payload: { patch: opening(false) } },
    ]);
    assert.match(r.text, /1 more notice on/);
    assert.ok(r.links.includes('/incidents'), 'the rest of the notices are not reachable');
  });
});

describe('the incident notice board on Incidents', () => {
  it('reads the changed fields as words rather than as the codes the server sends', () => {
    const r = reading(IncidentNoticeTable, [...live(), contained()]);
    assert.match(r.text, /stage, whether it is still happening, containment/);
    assert.doesNotMatch(r.text, /happening_now/);
    assert.match(r.text, /Opened on the record/, 'identification changed nothing; it opened the record');
    assert.match(r.text, /Nothing here is waiting on you/);
  });

  it('says the window it describes, and never that a check ran and found nothing', () => {
    const r = reading(IncidentNoticeTable, []);
    assert.match(r.text, /No incident has been recorded since/);
    assert.match(r.text, /and none is unresolved/);
    assert.doesNotMatch(r.text, /detected/);
  });

  it('colours the resolution green and leaves the closed incident\'s earlier notices uncoloured', () => {
    // Red under its own green resolution is the defect this guards: the
    // identification said "still happening" when it was recorded, and the
    // incident is closed now.
    assert.deepEqual(reading(IncidentNoticeTable, [...live(), contained(), resolved()]).roles, ['success']);
  });

  it('counts the notices the day window is not showing', () => {
    const old = (seq, ts, patch) => ({ seq, ts, ticket_id: 'H-9', payload: { patch } });
    const r = reading(IncidentNoticeTable, [
      old(1, before(9 * 24 * 60), opening(true)),
      old(2, before(8 * 24 * 60), { stage: known('mitigated'), containment: known('writes stopped'), happening_now: known(false) }),
      old(3, before(8 * 24 * 60), { stage: known('resolved'), cause: known({ account: 'bad pin', confidence: 'known' }), fix: known('pin corrected'), recovery_evidence: [known({ ref: 'check:green' })] }),
    ]);
    assert.match(r.text, /3 earlier notices are held on the record outside this window/);
  });
});
