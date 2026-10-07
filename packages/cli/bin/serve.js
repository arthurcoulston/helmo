#!/usr/bin/env node
import { appConfig, startAppServer } from '../app-server.mjs';
import { appRequest, shellRequest } from '../../app/server.mjs';
import { workHealth, workListening, workRequest, workSnapshot } from '../../work/dist/view.js';
import { roadmapHealth, roadmapRequest, roadmapSnapshot } from '../../roadmap/dist/view.js';
import { runtimeRequest, runtimeSnapshot, teamFile, teamMember, teamPeriod, teamSnapshot } from '../../runtime/dist/view.js';
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

// The Team routes read and measure files, so they answer from a promise. A null
// result is the route's own "this installation configures no such thing" and is
// a 404 rather than an empty document.
//
// A thrown read answers 500, the same as every other route here: deferring into
// a promise takes the throw out of the handler's own catch below, so this has to
// repeat that status rather than pick its own. It picked 503 at first, and a
// broken roster made /api/v1/team disagree with /api/v1/runtime and
// /api/v1/overview about what had gone wrong — which the app's acceptance suite
// already asserted against, in a workspace no proof of this page had measured
// (H-3004).
function answer(response, area, read) {
  Promise.resolve().then(read).then((data) => {
    if (data === null) { response.writeHead(404, JSON_HEADERS); response.end(JSON.stringify({ error: 'Unknown team member or file' })); return; }
    // Serialised before the header, like /api/v1/overview below. Nothing the
    // Team reads can make apiJson throw today — the documents are plain strings
    // and numbers — so this is the shape, not a repair: a throw after a 200 is
    // on the wire reaches the catch with headersSent already true, and the only
    // thing left to do there is drop the connection (H-3001).
    const document_ = apiJson(area, data);
    response.writeHead(200, JSON_HEADERS);
    response.end(document_);
  }).catch((error) => {
    if (response.headersSent) { response.destroy(error instanceof Error ? error : undefined); return; }
    response.writeHead(500, JSON_HEADERS);
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  });
}

let origin = null;
// Overview counts the roster, never the Team document: that document measures
// every configured file with a real tokenizer, and the summary needs a count.
function teamCount() {
  return Object.keys(loadRoster().loops).length;
}
function overviewSnapshot() {
  const work=workSnapshot(), roadmap=roadmapSnapshot(), runtime=runtimeSnapshot();
  return { records: [
    { id:'work', title:'Work', state:`${work.records.length} records`, links:[{label:'Open Work',href:'/work'}] },
    { id:'roadmap', title:'Roadmap', state:`${roadmap.projects.length} projects`, links:[{label:'Open Roadmap',href:'/roadmap'}] },
    { id:'team', title:'Team', state:`${teamCount()} configured`, links:[{label:'Open Team',href:'/team'}] },
    { id:'runtime', title:'Runtime', state:runtime.supervisor_state, links:[{label:'Open Runtime',href:'/run'}] },
    ...work.records,
  ] };
}
const appDocuments={overview:overviewSnapshot};
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
    if (/^\/api\/v1\/work(?:[/?]|$)/.test(request.url ?? '')) return workRequest(request, response);
    if (/^\/api\/v1\/roadmap(?:[/?]|$)/.test(request.url ?? '')) return roadmapRequest(request, response);
    if (request.url === '/api/v1/runtime') return runtimeRequest(request, response);
    const file = /^\/api\/v1\/team\/members\/([^/?]+)\/files\/([^/?]+)$/.exec(request.url ?? '');
    if (file) return answer(response, 'team', () => teamFile(decodeURIComponent(file[1]), decodeURIComponent(file[2])));
    const member = /^\/api\/v1\/team\/members\/([^/?]+)$/.exec(request.url ?? '');
    if (member) return answer(response, 'team', () => teamMember(decodeURIComponent(member[1])));
    if (/^\/api\/v1\/team(?:\?|$)/.test(request.url ?? '')) {
      return answer(response, 'team', () => teamSnapshot(teamPeriod(request.url)));
    }
    if (request.url === '/api/v1/overview') {
      // Built before the header is written. Overview now counts the roster, and
      // a broken one threw after a 200 was already on the wire: the catch below
      // cannot answer 500 once headers are sent, so the socket closed
      // mid-response and the page showed a network error instead of the Alert
      // the view draws from the status (H-3001).
      const document_ = apiJson('overview', appDocuments.overview());
      response.writeHead(200, JSON_HEADERS);
      response.end(document_);
      return;
    }
    if (appRequest(request, response)) return;
    // Compatibility subroutes retain their backend behavior.
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
