import assert from 'node:assert/strict';
import test from 'node:test';
import { appPage, appRequest } from '../server.mjs';

test('five-area shell marks each migrated direct route and its API', () => {
  for (const [route, area, api] of [['/work','work','/api/v1/work'], ['/roadmap','roadmap','/api/v1/roadmap'], ['/run','runtime','/api/v1/runtime']]) {
    const html = appPage(route);
    assert.match(html, new RegExp(`>${area[0].toUpperCase()+area.slice(1)}</a>`));
    assert.match(html, new RegExp(api));
    assert.match(html, new RegExp(`<title>Helmo · ${area}</title>`));
  }
  for (const label of ['Overview', 'Work', 'Roadmap', 'Team', 'Runtime']) assert.match(appPage('/work'), new RegExp(`>${label}</a>`));
});

test('fixture-backed app request renders a real record', () => {
  const writes = [];
  const response = { writeHead(code, headers) { writes.push({ code, headers }); }, end(body) { writes.push(body); } };
  const fixture = { api: 'helmo/v1', area: 'work', data: { records: [{ id: 'H-42', title: 'Real fixture', status: 'open' }] } };
  assert.equal(appRequest({ url: '/work', headers: { host: 'localhost' } }, response, { work: () => fixture }), true);
  assert.equal(writes[0].code, 200);
  assert.match(writes[1], /id="H-42"/);
  assert.match(writes[1], /Real fixture/);
});
