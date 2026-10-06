#!/usr/bin/env node
import { appConfig, startAppServer } from '../app-server.mjs';
import { appRequest, shellRequest } from '../../app/server.mjs';
import { workHealth, workListening, workRequest, workSnapshot } from '../../work/dist/view.js';
import { roadmapHealth, roadmapRequest, roadmapSnapshot } from '../../roadmap/dist/view.js';
import { runtimeRequest, runtimeSnapshot } from '../../runtime/dist/view.js';
import { loadRoster } from '../../runtime/dist/config.js';
import { apiJson, JSON_HEADERS } from '../../core/dist/index.js';

function at(request, prefix) {
  const url = request.url ?? '/';
  if (url !== prefix && !url.startsWith(`${prefix}/`) && !url.startsWith(`${prefix}?`)) return false;
  request.url = url.slice(prefix.length) || '/';
  return true;
}

function check(name, read) {
  try { return { name, ok: true, detail: read() }; }
  catch (error) { return { name, ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

let origin = null;
function teamSnapshot() {
  const { loops } = loadRoster();
  return { loops: Object.values(loops).map((loop) => ({ name: loop.seat ?? loop.name, state: 'configured', detail: loop.workstream, links: [{ label: 'Profile', href: `file://${loop.constitution}` }] })) };
}
function overviewSnapshot() {
  const work=workSnapshot(), roadmap=roadmapSnapshot(), runtime=runtimeSnapshot();
  return { records: [
    { id:'work', title:'Work', state:`${work.records.length} records`, links:[{label:'Open Work',href:'/work'}] },
    { id:'roadmap', title:'Roadmap', state:`${roadmap.projects.length} projects`, links:[{label:'Open Roadmap',href:'/roadmap'}] },
    { id:'team', title:'Team', state:`${teamSnapshot().loops.length} configured`, links:[{label:'Open Team',href:'/team'}] },
    { id:'runtime', title:'Runtime', state:runtime.supervisor_state, links:[{label:'Open Runtime',href:'/run'}] },
    ...work.records,
  ] };
}
const appDocuments={overview:overviewSnapshot,team:teamSnapshot};
const running = await startAppServer(appConfig(), (request, response) => {
  try {
    if (shellRequest(request, response)) return;
    if (request.url === '/health.json') {
      const checks = [check('app', () => ({ origin })), check('work', workHealth), check('roadmap', roadmapHealth), check('runtime', runtimeSnapshot)];
      const ok = checks.every((item) => item.ok);
      response.writeHead(ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok, checks }));
      return;
    }
    if (request.url === '/api/v1/work') return workRequest(request, response);
    if (request.url === '/api/v1/roadmap') return roadmapRequest(request, response);
    if (request.url === '/api/v1/runtime') return runtimeRequest(request, response);
    if (request.url === '/api/v1/overview' || request.url === '/api/v1/team') {
      const area=request.url.endsWith('/team')?'team':'overview';
      const document_=appDocuments[area]();
      response.writeHead(200,JSON_HEADERS);
      response.end(apiJson(area,document_));
      return;
    }
    if (appRequest(request, response)) return;
    // Still their own documents, outside the shadcn application, until
    // H-2936–H-2939 move them in.
    if (at(request, '/roadmap')) return roadmapRequest(request, response);
    if (at(request, '/run')) return runtimeRequest(request, response);
    if (at(request, '/work')) return workRequest(request, response);
    if (request.url === '/' || request.url?.startsWith('/?') || request.url === '/answer' || request.url === '/acted') return workRequest(request, response);
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Unknown Helmo app route.\n');
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`${error instanceof Error ? error.message : String(error)}\n`);
    } else {
      response.destroy(error instanceof Error ? error : undefined);
    }
  }
});
origin = running.origin;
workListening(Number(new URL(running.origin).port));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await running.close();
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
console.log(`Helmo app: ${running.origin}`);
