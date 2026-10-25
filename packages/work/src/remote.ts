#!/usr/bin/env node
// Remote MCP entry point (H-116): the same tool surface as server.ts, served
// over Streamable HTTP for agents that reach Helmo through the crew-mcp
// worker (e.g. the Claude mobile app). Binds localhost only — the network
// path in front of it is cloudflared; the worker is the OAuth gate. This
// process still refuses anything without the shared bearer token, so a
// misconfigured tunnel exposes nothing.
//
// Stateless per-request servers (sessionIdGenerator: undefined) so the proxy
// hop needs no session affinity; GET/DELETE get 405 per the stateless
// Streamable HTTP pattern.
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mkdirSync } from 'node:fs';
import { loaded } from './build.js';
import { installationLine, requestedInstallation, requireInstallation } from './install.js';
import { Store } from './store.js';
import { buildServer } from './tools.js';

const token = process.env['HELMO_REMOTE_TOKEN'];
if (!token || token.length < 24) {
  console.error('HELMO_REMOTE_TOKEN (min 24 chars) is required — refusing to serve the remote surface without it.');
  process.exit(1);
}

const install = requireInstallation(process.env, undefined, requestedInstallation(process.argv.slice(2)));
// The reading of what this process loaded is taken here, before it serves:
// a long-lived server asked later would report whatever replaced its code
// (H-2490).
loaded();
mkdirSync(install.home, { recursive: true });
const store = new Store(install.db, install);

const port = Number(process.env['HELMO_REMOTE_PORT'] ?? 4401);

// How large a request body this surface will read before answering 413. The
// transport enforces it — but only on bodies IT reads: this entry used to
// concatenate the whole stream itself and hand the transport the parsed
// object, and `parsedBody` is the one branch that skips the size check
// (GHSA-46jr-4wx8-v453, H-3517). So the stream goes to the transport unread.
// 4 MiB is the SDK's own default, stated here rather than inherited, because a
// cap a later release quietly changes is a cap nobody can test against.
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

const listener = createServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(JSON.stringify({ error: 'method not allowed — stateless server, POST only' }));
      return;
    }
    // Remote callers never inherit a machine identity: no HELMO_ACTOR here,
    // so every write must carry a truthful per-call actor or be rejected (H-3).
    const server = buildServer(store, null);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  })().catch((e) => {
    console.error('remote request failed:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  });
}).listen(port, '127.0.0.1', () =>
  console.log(`Helmo remote MCP: http://127.0.0.1:${port} (Streamable HTTP, bearer-gated) — ${installationLine(install, store.installationIdentity())}`),
);

// Test and supervised callers use IPC as the lifetime bond. Without this,
// an interrupted caller leaves a bearer-gated server and its store behind.
if (process.channel) {
  process.once('disconnect', () => {
    listener.close(() => store.close());
  });
}
