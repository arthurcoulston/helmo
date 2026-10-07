import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { appConfig, startAppServer } from '../app-server.mjs';

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function rawRequest(port, host) {
  return new Promise((resolve, reject) => {
    const headers = host === undefined ? {} : { host };
    const outgoing = request({ host: '127.0.0.1', port, path: '/', headers, setHost: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('configuration is loopback-only and legacy listeners default empty', () => {
  assert.deepEqual(appConfig({}), { host: '127.0.0.1', port: 4400, legacy: [] });
  assert.throws(() => appConfig({ HELMO_APP_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => appConfig({ HELMO_LEGACY_LISTENERS: 'nope' }), /must be JSON/);
});

test('the app root survives being read twice: appConfig normalizes it, startAppServer accepts it', async (t) => {
  // Both ends validate, so '/' arrives at startAppServer as the '' that
  // appConfig made of it. Refusing that spelling meant an installation could
  // configure a retired port onto the app root and never start.
  const redirect = await freePort();
  const config = appConfig({ HELMO_APP_PORT: '0', HELMO_LEGACY_LISTENERS: `[{"port":${redirect},"route":"/"}]` });
  assert.deepEqual(config.legacy, [{ port: redirect, route: '' }]);
  const running = await startAppServer(config, (_request, response) => response.end('app'));
  t.after(() => running.close());
  const response = await fetch(`http://127.0.0.1:${redirect}/?whole=1`, { redirect: 'manual' });
  assert.equal(response.headers.get('location'), `${running.origin}/?whole=1`);
});

test('redirects preserve path and query and ignore a poisoned Host header', async (t) => {
  const redirectPort = await freePort();
  const running = await startAppServer(
    { host: '127.0.0.1', port: 0, legacy: [{ port: redirectPort, route: '/roadmap' }] },
    (_request, response) => response.end('app'),
  );
  t.after(() => running.close());

  const response = await fetch(`http://127.0.0.1:${redirectPort}/next?whole=1`, {
    redirect: 'manual',
    headers: { host: 'poison.example:9999' },
  });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), `${running.origin}/roadmap/next?whole=1`);
});

test('the app answers only for a loopback Host naming its bound port', async (t) => {
  let handled = 0;
  const running = await startAppServer(
    { host: '127.0.0.1', port: 0, legacy: [] },
    (_request, response) => {
      handled += 1;
      response.end('app');
    },
  );
  t.after(() => running.close());
  const port = running.app.address().port;

  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
    assert.deepEqual(await rawRequest(port, host), { status: 200, body: 'app' });
  }
  for (const host of ['evil.example:4400', `127.0.0.1:${port + 1}`]) {
    assert.deepEqual(await rawRequest(port, host), { status: 421, body: 'Misdirected Request\n' });
  }
  assert.deepEqual(await rawRequest(port), { status: 400, body: '' });
  assert.equal(handled, 3);
});

test('duplicate and app-listener port collisions refuse before binding', async () => {
  const port = await freePort();
  await assert.rejects(
    startAppServer({ host: '127.0.0.1', port, legacy: [{ port, route: '/work' }] }, () => {}),
    /must be distinct/,
  );
  const probe = createServer();
  await listen(probe, port);
  await close(probe);
});

test('a later bind failure closes every listener opened by the attempt', async () => {
  const appPort = await freePort();
  const firstRedirect = await freePort();
  const occupiedPort = await freePort();
  const occupied = createServer();
  await listen(occupied, occupiedPort);
  try {
    await assert.rejects(
      startAppServer({
        host: '127.0.0.1',
        port: appPort,
        legacy: [
          { port: firstRedirect, route: '/work' },
          { port: occupiedPort, route: '/run' },
        ],
      }, () => {}),
      /EADDRINUSE/,
    );
    const appProbe = createServer();
    const redirectProbe = createServer();
    await listen(appProbe, appPort);
    await listen(redirectProbe, firstRedirect);
    await Promise.all([close(appProbe), close(redirectProbe)]);
  } finally {
    await close(occupied);
  }
});

test('shutdown closes the app and every redirect listener', async () => {
  const appPort = await freePort();
  const redirectPort = await freePort();
  const running = await startAppServer(
    { host: '127.0.0.1', port: appPort, legacy: [{ port: redirectPort, route: '/work' }] },
    (_request, response) => response.end('ok'),
  );
  await running.close();
  await running.close();

  for (const port of [appPort, redirectPort]) {
    const probe = createServer();
    await listen(probe, port);
    await close(probe);
  }
});
