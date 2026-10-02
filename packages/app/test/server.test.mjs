import assert from 'node:assert/strict';
import test from 'node:test';
import { appPage, appRequest } from '../server.mjs';

test('five-area shell marks every direct route and its API', () => {
  for (const [route, area] of [['/','overview'], ['/work','work'], ['/roadmap','roadmap'], ['/team','team'], ['/run','runtime']]) {
    const html = appPage(route);
    assert.match(html, new RegExp(`>${area[0].toUpperCase()+area.slice(1)}</a>`));
    assert.match(html, new RegExp(`/api/v1/${area}`));
    assert.match(html, new RegExp(`<title>${area === 'overview' ? 'Helmo' : `Helmo · ${area}`}</title>`));
  }
  for (const label of ['Overview', 'Work', 'Roadmap', 'Team', 'Runtime']) assert.match(appPage('/work'), new RegExp(`>${label}</a>`));
});

test('team renders configured metadata and operator-owned links without their contents', () => {
  const html=appPage('/team',{data:{loops:[{name:'builder',state:'configured',detail:'product',links:[{label:'Profile',href:'file:///operator/PROFILE.md'}]}]}});
  assert.match(html,/>builder</); assert.match(html,/file:\/\/\/operator\/PROFILE\.md/); assert.doesNotMatch(html,/memory|doctrine|credential/i);
});

test('overview and empty states are explicit', () => {
  assert.match(appPage('/',{data:{records:[{id:'work',title:'Work',state:'2 records'}]}}),/2 records/);
  assert.match(appPage('/team',{data:{loops:[]}}),/No team records are configured/);
  assert.match(appPage('/team'),/Could not read team/);
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
