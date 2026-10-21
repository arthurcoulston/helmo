#!/usr/bin/env node
import { appConfig, startAppServer } from '../app-server.mjs';
import { appRequest, shellRequest } from '../../app/server.mjs';
import { activitySnapshot, checkInSnapshot, historySnapshot, incidentNoticesSnapshot, incidentSnapshot, incidentsSnapshot, issuesSnapshot, runwaySnapshot, workHealth, workListening, workRequest, workSnapshot } from '../../work/dist/view.js';
import { resultDisplay, seatWork } from '../../work/dist/presentation.js';
import { roadmapHealth, roadmapRequest, roadmapSnapshot } from '../../roadmap/dist/view.js';
import { AUTHORIZED, statusReading } from '../../roadmap/dist/types.js';
import { runtimeRequest, runtimeSnapshot, teamFile, teamMember, teamNowSnapshot, teamPeriod, teamSnapshot } from '../../runtime/dist/view.js';
import { loadRoster } from '../../runtime/dist/config.js';
import { apiJson, JSON_HEADERS } from '../../core/dist/index.js';

function at(request, prefix) {
  const url = request.url ?? '/';
  if (url !== prefix && !url.startsWith(`${prefix}/`) && !url.startsWith(`${prefix}?`)) return false;
  request.url = url.slice(prefix.length) || '/';
  return true;
}

function check(name, read) {
  try {
    const detail = read();
    return { name, ok: detail?.ok !== false, detail };
  }
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
function checkInInput(work, roadmap, team) {
  const continuing = new Set(work.records
    .filter((ticket) => !['done', 'cancelled'].includes(ticket.status))
    .map((ticket) => ticket.project)
    .filter(Boolean));
  // This composition belongs here because serve.js already holds Work,
  // Roadmap and Runtime's views. It is existing practice, not an import rule:
  // Work remains independently testable, while the unified document can say
  // which selected initiatives have no open ticket carrying their project id.
  // The work phase is Planned and Active alike: an authorized initiative with
  // nothing underway is exactly the gap this reading exists to show (R-46).
  const continuations = roadmap.projects
    .filter((project) => AUTHORIZED.includes(statusReading(project.status)) && !continuing.has(project.id))
    .map((project) => ({
      id: project.id,
      title: project.title,
      updated_at: project.updated_at,
      last_progress_note: project.progress?.note ?? null,
    }));
  return {
    seats: team.unavailable ? null : team.agents.map((agent) => ({ agent: agent.agent, state: agent.state })),
    continuations,
  };
}

// ---------- what remains and what shipped, per initiative (R-46) ----------

// How many shipped milestones the document names per initiative. The rest are
// counted beside them, never dropped silently — Work's own record does the
// same with CLOSED_TAIL. A long-running initiative can carry a hundred closed
// tagged tickets; a list of a hundred is a log, and the reading this field
// exists to answer is "what shipped", which the newest few answer and the
// count qualifies.
const MILESTONES_NAMED = 5;

const CLOSED = ['done', 'cancelled'];

// Counted from tickets, so it says which tickets and what it leaves out. The
// surface prints this verbatim: a count whose denominator and coverage live
// somewhere else is a count a reader has to take on trust (R-46).
const COVERAGE = 'Counted from tickets tagged with the initiative id in this installation\'s work store. Recurring templates are standing work, listed apart from the open count; tickets nobody tagged are invisible to it.';

/** What one initiative still has open, and what it has shipped.
 *
 *  Two things that look like outstanding work and are not, both of them read
 *  off real rows (R-46 cases 4 and 5):
 *
 *  - A recurring TEMPLATE carries `schedule` and is never ready and never
 *    claimed; its spawned instances are the work. Counting the template
 *    would report a delivered initiative as having outstanding work forever.
 *  - A ticket under a CAPACITY HOLD is waiting on a person, and says so in
 *    the hold rather than in `needs_human`, which it may well carry as
 *    false. Both fields are served, because reading either one alone gets
 *    that row wrong.
 */
function initiativeWork(tickets) {
  const live = tickets.filter((ticket) => !CLOSED.includes(ticket.status));
  const open = live.filter((ticket) => !ticket.schedule);
  const standing = live.filter((ticket) => ticket.schedule);
  const closed = tickets.filter((ticket) => CLOSED.includes(ticket.status));
  // A milestone is work that finished and left something behind: `done` with
  // a recorded result. Cancelled work shipped nothing, and a done with no
  // evidence is a claim rather than a record, so neither is named here —
  // both stay in the `closed` count, which is the denominator.
  const delivered = closed
    .filter((ticket) => ticket.status === 'done')
    .map((ticket) => ({ ticket, result: resultDisplay(ticket.evidence).primary }))
    .filter((row) => row.result)
    .sort((a, b) => String(b.ticket.closed_at ?? '').localeCompare(String(a.ticket.closed_at ?? '')));
  const named = delivered.slice(0, MILESTONES_NAMED);
  return {
    remaining_work: {
      open: open
        .slice()
        .sort((a, b) => a.priority - b.priority || String(a.created_at).localeCompare(String(b.created_at)))
        .map((ticket) => ({
          id: ticket.id,
          title: ticket.title,
          status: ticket.status,
          assignee: ticket.assignee,
          hold: ticket.capacity_hold,
          needs_human: ticket.needs_human,
        })),
      standing: standing.map((ticket) => ({ id: ticket.id, title: ticket.title, schedule: ticket.schedule })),
      open_count: open.length,
      standing_count: standing.length,
      closed_count: closed.length,
      tagged: tickets.length,
      reading: `${open.length} open of ${tickets.length} tagged`,
      coverage: COVERAGE,
    },
    shipped: {
      milestones: named.map(({ ticket, result }) => ({
        id: ticket.id,
        title: ticket.title,
        closed_at: ticket.closed_at,
        result: ticket.evidence[result.at] ?? null,
      })),
      named_count: named.length,
      with_result_count: delivered.length,
      closed_count: closed.length,
      reading: `${named.length} named of ${delivered.length} closed with a recorded result, from ${closed.length} closed of ${tickets.length} tagged`,
      coverage: COVERAGE,
    },
  };
}

/** The roadmap list document with the work store joined in.
 *
 *  The join lives here for the same reason the Overview check-in's does: this
 *  process holds both views and the two stores may not read each other
 *  (R-47 C1). The consequence is that the Roadmap view served standalone has
 *  no such field at all — and a reader must take its absence as *unknown*,
 *  never as "nothing is outstanding", which is why the fields are added here
 *  rather than defaulted to empty in the roadmap package (R-46).
 */
function roadmapDocument() {
  const snapshot = roadmapSnapshot();
  const tagged = new Map(snapshot.projects.map((project) => [project.id, []]));
  for (const ticket of workSnapshot().records) tagged.get(ticket.project)?.push(ticket);
  // Only `projects` is enriched. `ranked` carries its own copy of each row and
  // the shell already resolves those back through `projects`, so writing the
  // join twice would be two readings of one fact that could disagree.
  return { ...snapshot, projects: snapshot.projects.map((project) => ({ ...project, ...initiativeWork(tagged.get(project.id) ?? []) })) };
}

function overviewSnapshot(since) {
  const work=workSnapshot(), roadmap=roadmapSnapshot(), runtime=runtimeSnapshot();
  const team=teamNowSnapshot(seatWork(work.records));
  return { records: [
    { id:'work', title:'Work', state:`${work.records.length} records`, links:[{label:'Open Work',href:'/work'}] },
    { id:'roadmap', title:'Roadmap', state:`${roadmap.projects.length} projects`, links:[{label:'Open Roadmap',href:'/roadmap'}] },
    { id:'team', title:'Team', state:`${teamCount()} configured`, links:[{label:'Open Team',href:'/team'}] },
    { id:'runtime', title:'Runtime', state:runtime.supervisor_state, links:[{label:'Open Runtime',href:'/run'}] },
    ...work.records,
  // Carried through from the Work document rather than recomputed: the window
  // is the server's to fix, and two readings taken at two instants on one page
  // would disagree about what the past 24 hours held (R-44).
  ], results: work.results,
  // The condensed roster. This is the one place the two records meet: the
  // runtime knows which sessions are running and the work record knows what
  // each seat has claimed, and neither may read the other (R-47 C1), so the
  // join happens here — in the process that already holds both (H-3091).
  team,
  // The forecast needs the same join in the other direction: which seats can
  // draw work decides which backlog is runway at all. An unreadable roster is
  // passed through as null rather than an empty seat list, because a fleet
  // nobody could read is not a fleet with no agents (H-3089).
  next: runwaySnapshot(team.unavailable ? null : team.agents.map((a) => ({ agent: a.agent, state: a.state }))),
  // Tokens, completions and requests over the day and the week. Its own read,
  // because it counts timestamped events rather than the current record, and
  // its own `as_of` and zone for the same reason the others fix theirs (R-44
  // H-3090).
  activity: activitySnapshot(), issues: issuesSnapshot(),
  // What Arthur has been told about every incident (H-3216). Served with the
  // Overview readings because this is where he looks first, and derived from
  // the incident record so that recording an incident IS notifying him — no
  // separate act an agent could skip, and no ticket parked out of the agents'
  // queues to get his attention.
  incident_notices: incidentNoticesSnapshot(),
  ...(since !== undefined ? { check_in: checkInSnapshot(since, checkInInput(work, roadmap, team)) } : {}) };
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
    if (/^\/api\/v1\/work(?:[/?]|$)/.test(request.url ?? '')) {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/v1/work' && url.searchParams.has('since')) {
        const since = url.searchParams.get('since');
        if (!since) throw new Error('since="" is not an instant this reading can parse; supply an ISO instant.');
        const work = workSnapshot({ whole: url.searchParams.get('whole') === '1', ticket: url.searchParams.get('ticket') ?? undefined });
        const roadmap = roadmapSnapshot();
        const team = teamNowSnapshot(seatWork(work.records));
        const document_ = apiJson('work', { ...work, check_in: checkInSnapshot(since, checkInInput(work, roadmap, team)) });
        response.writeHead(200, JSON_HEADERS); response.end(document_); return;
      }
      return workRequest(request, response);
    }
    if (request.url === '/api/v1/issues') {
      response.writeHead(200, JSON_HEADERS); response.end(apiJson('issues', issuesSnapshot())); return;
    }
    if (request.url === '/api/v1/incidents') {
      response.writeHead(200, JSON_HEADERS); response.end(apiJson('incidents', incidentsSnapshot())); return;
    }
    if (/^\/api\/v1\/history(?:\?|$)/.test(request.url ?? '')) {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const period = url.searchParams.get('period') ?? 'week';
      if (!['day', 'week', 'month'].includes(period)) {
        response.writeHead(400, JSON_HEADERS); response.end(JSON.stringify({ error: 'period must be day, week, or month' })); return;
      }
      response.writeHead(200, JSON_HEADERS);
      response.end(apiJson('history', historySnapshot(period, url.searchParams.get('actor') || undefined)));
      return;
    }
    const incident = /^\/api\/v1\/incidents\/(H-\d+)$/.exec(request.url ?? '');
    if (incident) {
      const document_ = incidentSnapshot(incident[1]);
      response.writeHead(document_ ? 200 : 404, JSON_HEADERS);
      response.end(document_ ? apiJson('incidents', document_) : JSON.stringify({ error: 'Incident not found' })); return;
    }
    if (/^\/api\/v1\/roadmap(?:[/?]|$)/.test(request.url ?? '')) {
      // The list document is built here because it carries the work join; every
      // other roadmap route is still the roadmap package's own.
      if (new URL(request.url ?? '/', 'http://localhost').pathname === '/api/v1/roadmap') {
        const document_ = apiJson('roadmap', roadmapDocument());
        response.writeHead(200, JSON_HEADERS);
        response.end(document_);
        return;
      }
      return roadmapRequest(request, response);
    }
    if (request.url === '/api/v1/runtime') return runtimeRequest(request, response);
    const file = /^\/api\/v1\/team\/members\/([^/?]+)\/files\/([^/?]+)$/.exec(request.url ?? '');
    if (file) return answer(response, 'team', () => teamFile(decodeURIComponent(file[1]), decodeURIComponent(file[2])));
    const member = /^\/api\/v1\/team\/members\/([^/?]+)$/.exec(request.url ?? '');
    if (member) return answer(response, 'team', () => teamMember(decodeURIComponent(member[1])));
    if (/^\/api\/v1\/team(?:\?|$)/.test(request.url ?? '')) {
      return answer(response, 'team', () => teamSnapshot(teamPeriod(request.url)));
    }
    if (/^\/api\/v1\/overview(?:\?|$)/.test(request.url ?? '')) {
      // Built before the header is written. Overview now counts the roster, and
      // a broken one threw after a 200 was already on the wire: the catch below
      // cannot answer 500 once headers are sent, so the socket closed
      // mid-response and the page showed a network error instead of the Alert
      // the view draws from the status (H-3001).
      const url = new URL(request.url ?? '/', 'http://localhost');
      const since = url.searchParams.has('since') ? url.searchParams.get('since') : undefined;
      if (since === '') throw new Error('since="" is not an instant this reading can parse; supply an ISO instant.');
      const document_ = apiJson('overview', appDocuments.overview(since));
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
      const badBound = error instanceof Error && error.message.startsWith('since=');
      response.writeHead(badBound ? 400 : 500, { 'content-type': 'text/plain; charset=utf-8' });
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
