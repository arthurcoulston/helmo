import assert from 'node:assert/strict';
import test from 'node:test';
import { appPage, appRequest, serveProduct, shellMount, shellRequest } from '../server.mjs';

test('five-area shell marks every direct route and its API', () => {
  for (const [route, area] of [['/overview','overview'], ['/work','work'], ['/roadmap','roadmap'], ['/team','team'], ['/run','runtime']]) {
    const html = appPage(route);
    assert.equal(config(html).area, area);
    assert.match(html, new RegExp(`/api/v1/${area}`));
    assert.match(html, new RegExp(`<title>${area === 'overview' ? 'Helmo' : `Helmo · ${area}`}</title>`));
  }
  assert.deepEqual(config(appPage('/work')).destinations.map((d) => d.label), ['Overview', 'Work', 'Roadmap', 'Team', 'Runtime']);
});

test('team renders configured metadata and operator-owned links without their contents', () => {
  const html=appPage('/team',{data:{loops:[{name:'builder',state:'configured',detail:'product',links:[{label:'Profile',href:'file:///operator/PROFILE.md'}]}]}});
  assert.match(html,/>builder</); assert.match(html,/file:\/\/\/operator\/PROFILE\.md/); assert.doesNotMatch(html,/memory|doctrine|credential/i);
});

test('overview and empty states are explicit', () => {
  const overview=appPage('/overview',{data:{records:[{id:'work',title:'Work',state:'2 records'},{id:'roadmap',title:'Roadmap'},{id:'team',title:'Team'},{id:'runtime',title:'Runtime'},{id:'H-1',title:'Current'}]}});
  assert.match(overview,/2 records/); assert.match(overview,/<h3>Areas<\/h3>/); assert.match(overview,/<h3>Current work<\/h3>/);
  assert.match(appPage('/team',{data:{loops:[]}}),/No team records are configured/);
  assert.match(appPage('/team'),/Could not read team/);
});

test('interactive links use the dark-mode-safe estate token directly', () => {
  assert.match(appPage('/team',{data:{loops:[]}}),/\.links a\{color:var\(--interactive\)\}/);
});

test('navigation is the shell, not a strip the page draws for itself', () => {
  const html = appPage('/run');
  // A narrow window answers with the sidebar's own hiding, so no page carries
  // a second horizontal area list to scroll sideways.
  assert.doesNotMatch(html, /aria-label="Areas"/);
  assert.match(html, /<link rel="stylesheet" href="\/shell\/shell\.css">/);
  assert.match(html, /<script type="module" src="\/shell\/shell\.js"><\/script>/);
  const { area, title, destinations } = config(html);
  assert.equal(area, 'runtime');
  assert.equal(title, 'Runtime');
  assert.deepEqual(destinations.find((d) => d.id === 'runtime'), { id: 'runtime', href: '/run', label: 'Runtime' });
});

test('the shell config closes its own element exactly once', () => {
  // The config is a JSON island in a served document. Nothing in it is
  // caller-supplied today, which is why `<` is escaped rather than trusted:
  // the day a destination label comes from somewhere else, this stays true.
  const mounted = shellMount('work');
  assert.equal(mounted.split('</script>').length - 1, 2);
  assert.equal(config(mounted).area, 'work');
});

test('an unbuilt shell says so rather than serving an empty page', () => {
  assert.equal(shellRequest({ url: '/nothing' }, null), false);
  const writes = [];
  const response = { writeHead(code, headers) { writes.push({ code, headers }); }, end(body) { writes.push(body); } };
  assert.equal(shellRequest({ url: '/shell/shell.js' }, response), true);
  assert.ok(writes[0].code === 200 || writes[0].code === 503, `unexpected status ${writes[0].code}`);
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

/** The shell's own configuration, read back out of the rendered document. */
function config(html) {
  const found = /<script type="application\/json" id="helmo-shell-config">([^]*?)<\/script>/.exec(html);
  assert.ok(found, 'the page carries no shell configuration');
  return JSON.parse(found[1].replaceAll('\\u003c', '<'));
}

test('the shell loads on documents that render no head element', () => {
  // Work and Roadmap open straight into <meta>: the browser builds their head
  // implicitly, so an injection anchored on `</head>` matches nothing and the
  // shell silently never loads on the two pages Arthur actually watches.
  const headless = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Work</title><body><h1>Work</h1></body></html>';
  const writes = [];
  const response = { writeHead() {}, end(body) { writes.push(body); } };
  serveProduct({ url: '/' }, response, (_request, res) => res.end(headless), 'work');
  assert.doesNotMatch(writes[0], /<\/head>/);
  assert.match(writes[0], /<link rel="stylesheet" href="\/shell\/shell\.css">/);
  assert.match(writes[0], /<script type="module" src="\/shell\/shell\.js"><\/script>/);
  assert.equal(config(writes[0]).area, 'work');
});
