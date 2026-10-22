import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

globalThis.location = { hostname: 'dash.example.com' };
const { renderToStaticMarkup } = await import('react-dom/server');
const React = await import('react');
const { TicketRecordContent, WorkRecord } = await import('../src/WorkRecord.tsx');

const row = {
  id: 'H-1', title: 'Build the library table', body: 'The run is elsewhere.',
  status: 'open', workstream: 'helmo-dev', type: 'build', priority: 1,
  updated_at: '2026-10-22T12:00:00Z', tokens_total: 0, cost_usd_total: 0,
  evidence: [], not_before: '2026-10-22T13:00:00Z',
  capacity_hold: { reason: 'Keep the independent hold visible.' },
  display: {
    group: 'motion', cloud_run: 'run-7-1', waits_on: ['H-2'], gated: true,
    held: true, chain: [], progress: null,
    acceptance: { state: 'not_requested', reason: 'no_completion' },
    result: { result: null, supporting: [], review: [], legacy_inferred: false },
  },
};

const text = (component) => renderToStaticMarkup(component)
  .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

describe('a cloud run in the rendered work record', () => {
  it('appears in motion with its run named and counted', () => {
    const reading = text(React.createElement(WorkRecord, {
      data: { whole: false, rows: [row], hygiene: [] }, selected: '',
    }));
    assert.match(reading, /In motion · 1/);
    assert.match(reading, /Running in cloud · run run-7-1/);
    assert.doesNotMatch(reading, /Not before/);
  });

  it('names the run in the record without concealing independent holds', () => {
    const reading = text(React.createElement(TicketRecordContent, { row, standing: [
      'On hold · Keep the independent hold visible.', 'Waits on H-2',
    ] }));
    assert.match(reading, /Running in cloud as run run-7-1/);
    assert.match(reading, /On hold · Keep the independent hold visible/);
    assert.match(reading, /Waits on H-2/);
  });
});
