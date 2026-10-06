#!/usr/bin/env node
// Read-only Roadmap API and the shared, unmodified shadcn application.
import { mkdirSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { apiJson, JSON_HEADERS, uiRequest } from '@helmo/core';
import { join } from 'node:path';
import { installationLine, requestedInstallation, requireInstallation } from './install.js';
import { Store } from './store.js';
import { Project } from './types.js';
import { loaded, running } from './build.js';

const install = requireInstallation(process.env, undefined, requestedInstallation(process.argv.slice(2)));
loaded();
const dbPath = install.db;
// The view may be the first thing to touch a fresh store — don't crash on a
// missing home directory (caught by launchd on first boot).
mkdirSync(install.home, { recursive: true });
const port = Number(process.env['ROADMAP_VIEW_PORT'] ?? 4410);
const host = process.env['ROADMAP_VIEW_HOST'] ?? '127.0.0.1';
const store = new Store(dbPath, install);

export function roadmapHealth() {
  return { installation: store.installationIdentity(), store: dbPath };
}

export function roadmapSnapshot() {
  return { installation: store.installationIdentity(), running: running(), projects: store.dumpState()['projects'] as Project[], ranked: store.rankProjects(), objectives: store.listObjectives(), bets: store.listBets() };
}

export function roadmapRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    if (req.url === '/api/v1/roadmap') {
      res.writeHead(200, JSON_HEADERS);
      res.end(apiJson('roadmap', roadmapSnapshot()));
      return;
    }
    const detail = /^\/api\/v1\/roadmap\/projects\/(R-\d+)$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (detail && req.method === 'GET') {
      try {
        const data = store.projectSnapshot(detail[1]!);
        res.writeHead(200, JSON_HEADERS);
        res.end(apiJson('roadmap', data));
      } catch {
        res.writeHead(404, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'Project not found' }));
      }
      return;
    }
    if (uiRequest(req, res, { areas: ['roadmap'], defaultArea: 'roadmap' })) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Unknown Roadmap route.');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(e));
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  createServer(roadmapRequest).listen(port, host, () => console.log(`Roadmap view: http://localhost:${port} — ${installationLine(install, store.installationIdentity())}`));
}
