import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_AREAS, appRequest, shellRequest } from '../server.mjs';

function recorder() {
  const writes = [];
  return {
    writes,
    response: {
      writeHead(code, headers) { writes.push({ code, headers }); },
      end(body) { writes.push(body); },
    },
  };
}

test('every area uses the shared application', () => {
  assert.deepEqual(APP_AREAS, ['overview', 'team', 'work', 'roadmap', 'runtime']);
});

test('a migrated area answers with the built document, with or without a trailing slash', () => {
  for (const url of ['/', '/?whole=1', '/?section=awaiting', '/overview', '/team', '/team/', '/overview?scope=all', '/work', '/roadmap/', '/run']) {
    const { writes, response } = recorder();
    assert.equal(appRequest({ url, headers: { host: 'localhost' } }, response), true, url);
    assert.ok(writes[0].code === 200 || writes[0].code === 503, `${url}: status ${writes[0].code}`);
    if (writes[0].code === 200) assert.equal(writes[0].headers['content-type'], 'text/html; charset=utf-8');
  }
});

test('unknown areas and write routes are not claimed', () => {
  for (const url of ['/answer', '/acted', '/anything']) {
    const { response } = recorder();
    assert.equal(appRequest({ url, headers: { host: 'localhost' } }, response), false, url);
  }
});

test('asset requests can only name a file the build emitted', () => {
  const { response } = recorder();
  // No join, so no traversal: a name outside [\w.-] is simply not an asset
  // request, and falls through to the server's 404.
  for (const url of ['/assets/../../../etc/passwd', '/assets/sub/dir.js', '/assets/', '/nothing']) {
    assert.equal(shellRequest({ url }, response), false, url);
  }
});

test('an unbuilt application says so rather than serving an empty page', () => {
  const { writes, response } = recorder();
  assert.equal(shellRequest({ url: '/assets/index-abc123.js' }, response), true);
  assert.ok(writes[0].code === 200 || writes[0].code === 503, `unexpected status ${writes[0].code}`);
  if (writes[0].code === 503) assert.match(writes[1], /not built/);
});

test('an asset type the build never emits is refused', () => {
  const { response } = recorder();
  assert.equal(shellRequest({ url: '/assets/secrets.env' }, response), false);
});
