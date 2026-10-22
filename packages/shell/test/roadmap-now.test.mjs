import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { roadmapNow } from '../../cli/roadmap-now.mjs';
import { RoadmapNow, roadmapNowOf } from '../src/RoadmapNow.tsx';

const project = (id, status, extra = {}) => ({ id, title: `Initiative ${id}`, status, health: null, ...extra });
const render = (projects) => {
  const data = roadmapNow(projects, '2026-01-01T12:00:00Z');
  const html = renderToStaticMarkup(React.createElement(RoadmapNow, { data }));
  return { data, html, text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() };
};

test('the card counts visible pipeline states and names every recorded concern with its reason', () => {
  const r = render([
    project('R-1', 'Active', { health: 'Off track', health_reason: 'A delivery dependency failed.' }),
    project('R-2', 'Planned'), project('R-3', 'Proposed'),
    project('R-4', 'Monitoring', { health: 'At risk', health_reason: 'A correction is due.' }),
    project('R-5', 'Completed', { health: 'On track' }),
    project('R-6', 'Active', { archived: true, health: 'Off track', health_reason: 'Hidden concern.' }),
  ]);
  assert.deepEqual(r.data.counts, { Active: 1, Planned: 1, Proposed: 1 });
  assert.match(r.text, /Active 1 Planned 1 Proposed 1/);
  assert.match(r.text, /R-1 · Initiative R-1 Off track A delivery dependency failed/);
  assert.match(r.text, /R-4 · Initiative R-4 At risk A correction is due/);
  assert.match(r.text, /Health not recorded for 2 visible initiatives/);
  assert.doesNotMatch(r.text, /Hidden concern|Initiative R-5|Initiative R-6/);
  assert.match(r.html, /href="\/roadmap#R-1"/);
  assert.match(r.html, /href="\/roadmap#R-4"/);
  assert.match(r.html, /data-status-role="failure"/);
  assert.match(r.html, /data-status-role="attention"/);
});

test('zero counts and missing health remain visible without claiming good health', () => {
  const r = render([project('R-1', 'Paused')]);
  assert.match(r.text, /Active 0 Planned 0 Proposed 0/);
  assert.match(r.text, /No At risk or Off track health recorded/);
  assert.match(r.text, /Health not recorded for 1 visible initiative\./);
  assert.doesNotMatch(r.html, /data-status-role="success"/);
  const empty = render([]);
  assert.match(empty.text, /Active 0 Planned 0 Proposed 0/);
  assert.doesNotMatch(empty.text, /Health not recorded/);
  assert.equal(roadmapNowOf({}), null, 'an old server is not an empty roadmap');
});

test('legacy status words use the same reading as the Roadmap page', () => {
  const r = render([project('R-1', 'ship_next'), project('R-2', 'parked'), project('R-3', 'shipped_watching')]);
  assert.deepEqual(r.data.counts, { Active: 1, Planned: 0, Proposed: 1 });
});
