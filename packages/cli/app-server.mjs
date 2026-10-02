import { createServer } from 'node:http';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function port(value, name) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`${name} must be an integer from 0 to 65535`);
  }
  return parsed;
}

function route(value, name) {
  // Idempotent, because both ends of the configuration validate: appConfig
  // normalizes the app root to '' and startAppServer checks what it is handed,
  // so re-reading a normalized route must mean the root rather than refuse it.
  if (value === '') return '';
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('?') || value.includes('#')) {
    throw new Error(`${name} must be an absolute path without a query or fragment`);
  }
  return value === '/' ? '' : value.replace(/\/$/, '');
}

/** Read the app's process configuration. Legacy listeners are explicit and
 * empty by default: a second installation must never inherit this estate's
 * retired ports merely by starting the same release. */
export function appConfig(env = process.env) {
  const host = env.HELMO_APP_HOST ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('HELMO_APP_HOST must be a loopback host (127.0.0.1, localhost, or ::1)');

  let legacy = [];
  if (env.HELMO_LEGACY_LISTENERS) {
    try {
      legacy = JSON.parse(env.HELMO_LEGACY_LISTENERS);
    } catch {
      throw new Error('HELMO_LEGACY_LISTENERS must be JSON');
    }
  }
  if (!Array.isArray(legacy)) throw new Error('HELMO_LEGACY_LISTENERS must be a JSON array');

  return {
    host,
    port: port(env.HELMO_APP_PORT ?? 4400, 'HELMO_APP_PORT'),
    legacy: legacy.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`HELMO_LEGACY_LISTENERS[${index}] must be an object`);
      }
      return {
        port: port(item.port, `HELMO_LEGACY_LISTENERS[${index}].port`),
        route: route(item.route, `HELMO_LEGACY_LISTENERS[${index}].route`),
      };
    }),
  };
}

function listen(server, portNumber, host) {
  return new Promise((resolve, reject) => {
    const error = (cause) => reject(cause);
    server.once('error', error);
    server.listen(portNumber, host, () => {
      server.off('error', error);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function urlHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

/** Start one app listener and its bounded compatibility redirects as one
 * lifecycle. Nothing is returned to the caller until every bind succeeded;
 * any failed bind closes all listeners opened earlier in the attempt. */
export async function startAppServer(config, handler) {
  if (!config || typeof config !== 'object') throw new Error('app server config is required');
  if (!LOOPBACK_HOSTS.has(config.host)) throw new Error('app host must be loopback');
  const appPort = port(config.port, 'app port');
  const legacy = (config.legacy ?? []).map((item, index) => ({
    port: port(item.port, `legacy listener ${index} port`),
    route: route(item.route, `legacy listener ${index} route`),
  }));
  const ports = [appPort, ...legacy.map((item) => item.port)];
  if (new Set(ports).size !== ports.length) throw new Error('app and legacy listener ports must be distinct');

  const app = createServer(handler);
  const opened = [];
  try {
    await listen(app, appPort, config.host);
    opened.push(app);
    const address = app.address();
    if (!address || typeof address === 'string') throw new Error('app listener did not report its bound port');
    const origin = `http://${urlHost(config.host)}:${address.port}`;

    for (const item of legacy) {
      const redirect = createServer((request, response) => {
        const incoming = request.url?.startsWith('/') ? request.url : '/';
        response.writeHead(301, { location: `${origin}${item.route}${incoming}` });
        response.end();
      });
      await listen(redirect, item.port, '127.0.0.1');
      opened.push(redirect);
    }

    let stopped = false;
    return {
      origin,
      app,
      redirects: opened.slice(1),
      async close() {
        if (stopped) return;
        stopped = true;
        await Promise.all(opened.map(close));
      },
    };
  } catch (error) {
    await Promise.allSettled(opened.map(close));
    throw error;
  }
}
