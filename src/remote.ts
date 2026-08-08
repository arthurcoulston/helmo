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
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { buildServer } from './tools.js';

const token = process.env['HELMO_REMOTE_TOKEN'];
if (!token || token.length < 24) {
  console.error('HELMO_REMOTE_TOKEN (min 24 chars) is required — refusing to serve the remote surface without it.');
  process.exit(1);
}

const dbPath = process.env['HELMO_DB'] ?? join(homedir(), '.helmo', 'helmo.db');
mkdirSync(join(dbPath, '..'), { recursive: true });
const store = new Store(dbPath);

const port = Number(process.env['HELMO_REMOTE_PORT'] ?? 4401);

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

createServer((req: IncomingMessage, res: ServerResponse) => {
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
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, await readBody(req));
  })().catch((e) => {
    console.error('remote request failed:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  });
}).listen(port, '127.0.0.1', () =>
  console.log(`Helmo remote MCP: http://127.0.0.1:${port} (Streamable HTTP, bearer-gated) — db: ${dbPath}`),
);
