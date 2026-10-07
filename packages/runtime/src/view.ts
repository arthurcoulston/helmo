#!/usr/bin/env node
// Runtime data projection and the shared standard shadcn application.
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { apiJson, isEntrypoint, JSON_HEADERS, uiRequest } from '@helmo/core';
import { ESTATE_REACH } from './estate-reach.generated.js';
import { readCodexUsage, readUsage, usageLine, worstSeverity } from './usage.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReport, compare, loaded, parseMarker, snapshot } from './build.js';
import { revHome, loadRoster, stateDir, tokenLogPath } from './config.js';
import { target } from './install.js';
import { processObservation, sGet, sHas, sValue } from './sentinels.js';

const port = Number(process.env['REV_VIEW_PORT'] ?? 4500);
const host = process.env['REV_VIEW_HOST'] ?? '127.0.0.1';

// Read before the first request, never per request (H-2489). The view outlives
// rebuilds — H-2432's dashboard was restarted by hand at 23:43 for exactly this
// reason — so what it loaded is only knowable at startup. Asking later would
// read whatever replaced it and call that "running".
const VIEW_LOADED = loaded();

// Which installation is this dashboard about? A command refuses to run when a
// pinned release set no longer resolves (H-2454); the dashboard's job is the
// opposite — to be the surface that SAYS so — so a failure becomes the detail
// it reports rather than a page that will not load.
const INSTALL = (() => {
  try {
    const t = target();
    return { label: t.conflict ? 'UNCLEAR' : t.label, home: t.home, release: t.release, detail: t.conflict };
  } catch (e) {
    return { label: 'UNCLEAR', home: revHome(), release: null, detail: e instanceof Error ? e.message : String(e) };
  }
})();

/** What a long-lived process loaded, against the code directory as it is now. */
function running(who: 'view' | 'supervisor') {
  if (who === 'view') return { ...compare(VIEW_LOADED, snapshot()), pid: process.pid };
  const observation = processObservation('supervisor');
  if (observation.state === 'dead') return null;
  return { ...compare(parseMarker(sGet('supervisor', 'RUNNING')), snapshot()), pid: observation.pid };
}
function state(name: string): string {
  const observation = processObservation(name);
  const pid = observation.pid;
  if (sHas(name, 'STOP')) return 'STOP';
  if (sHas(name, 'HOLD')) return 'HOLD';
  if (sHas(name, 'BLOCKED')) return 'BLOCKED';
  if (sHas(name, 'WEDGED')) return 'WEDGED';
  if (observation.state === 'unknown') return 'UNKNOWN';
  if (!pid && sHas(name, 'BACKOFF')) return 'BACKOFF';
  if (pid && sHas(name, 'LIMIT')) return 'LIMIT';
  if (pid && sHas(name, 'PARKED')) return 'PARKED';
  if (pid && sHas(name, 'SEAT_HELD')) return 'SEAT_HELD';
  if (pid && sHas(name, 'IDLE')) return 'IDLE';
  if (pid) return 'RUNNING';
  if (sHas(name, 'RUNNING')) return 'CRASHED';
  return 'halted';
}

function blockedDetail(name: string): { reason?: string; investigation_ticket?: string | null } | null {
  try {
    return JSON.parse(readFileSync(join(stateDir(name), 'BLOCKED.json'), 'utf8')) as { reason?: string; investigation_ticket?: string | null };
  } catch {
    return null;
  }
}

function blockedSummary(name: string): string | undefined {
  const detail = blockedDetail(name);
  if (detail?.reason) return `${detail.reason}${detail.investigation_ticket ? ` — ${detail.investigation_ticket}` : ''}`;
  return sGet(name, 'BLOCKED')?.split('\n').find((line) => line.startsWith('reason='))?.slice('reason='.length)
    ?? sGet(name, 'BLOCKED')?.split('\n')[0];
}

function lastEvents(name: string, n: number): string[] {
  const p = join(stateDir(name), 'events.log');
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  return lines.slice(-n);
}

function spend(name: string): { tokens: number; cost: number } {
  const p = tokenLogPath();
  let tokens = 0, cost = 0;
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.includes(`loop=${name} `)) continue;
      const t = /tokens=(\d+)/.exec(line);
      const c = /cost_usd=([\d.]+)/.exec(line);
      if (t) tokens += Number(t[1]);
      if (c) cost += Number(c[1]);
    }
  }
  return { tokens, cost };
}

/** The dashboard's one line of provenance: the build on disk, then what the two
 *  live processes loaded. Stale is amber and carries its own words, because a
 *  colour alone may never be the signal (H-713). */
function provenanceLine(): string {
  const artifact = snapshot();
  const parts = [
    artifact.stamp
      ? `build ${artifact.stamp.commit.slice(0, 7)}${artifact.stamp.dirty ? ' (dirty)' : ''} of ${artifact.stamp.built_at}`
      : `build unstamped (${artifact.dir})`,
  ];
  for (const who of ['view', 'supervisor'] as const) {
    const r = running(who);
    if (!r) { parts.push(`${who}: not running`); continue; }
    parts.push(r.state === 'verified'
      ? `${who} running ${r.commit?.slice(0, 7)}${r.dirty ? ' (dirty)' : ''}`
      : `${who} ${r.state.toUpperCase()}: ${r.detail}`);
  }
  return parts.join(' · ');
}

function provenanceSeverity(): string {
  return (['view', 'supervisor'] as const).some((w) => running(w)?.state === 'stale') ? 'warning' : '';
}

export function runtimeSnapshot() {
  const { loops } = loadRoster();
  const supervisor = processObservation('supervisor');
  return {
    supervisor: supervisor.pid,
    supervisor_state: supervisor.state,
    installation: INSTALL,
    build: buildReport(snapshot()),
    running: { view: running('view'), supervisor: running('supervisor') },
    loops: Object.values(loops).map((l) => {
      const st = state(l.name);
      const reason = st === 'IDLE'
        ? sGet(l.name, 'IDLE')?.split('\n')[1]
        : st === 'SEAT_HELD' ? sGet(l.name, 'SEAT_HELD')?.split('\n')[0]
        : st === 'BLOCKED' ? blockedSummary(l.name)
        : st === 'WEDGED' ? sGet(l.name, st)?.split('\n')[0] : undefined;
      return { name: l.name, state: st, workstream: l.workstream, runtime: l.runtime, model: l.model, pace: sValue(l.name, 'PACE') ?? '1', spend: spend(l.name), recent_events: lastEvents(l.name, 5), ...(reason ? { reason } : {}) };
    }),
    usage: { claude: readUsage(), codex: readCodexUsage() },
    reading: { provenance: provenanceLine(), severity: provenanceSeverity(), usage: [
      { name: 'Claude', line: usageLine(readUsage(), 'Claude'), severity: worstSeverity(readUsage()) },
      { name: 'Codex', line: usageLine(readCodexUsage(), 'Codex'), severity: worstSeverity(readCodexUsage()) },
    ] },
    work_link: { local: process.env.REV_HELMO_VIEW_URL ?? `${ESTATE_REACH['helmo-app']!.url.replace(/\/$/, '')}/work`, remote: `${ESTATE_REACH['helmo-app']!.path.replace(/\/$/, '')}/work` },
  };
}

export function runtimeRequest(req: IncomingMessage, res: ServerResponse) {
  // Machine-readable snapshot for aggregators (the estate health page, H-627).
  // Rev owns loop-state truth — sentinel precedence and pid identity (H-154)
  // — so consumers read this instead of re-deriving it from the markers.
  if (req.url === '/health.json' || req.url === '/api/v1/runtime') {
    const data = runtimeSnapshot();
    res.writeHead(200, JSON_HEADERS);
    res.end(req.url === '/health.json' ? JSON.stringify(data) : apiJson('runtime', data));
    return;
  }
  if (uiRequest(req, res, { areas: ['runtime'], defaultArea: 'runtime' })) return;
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Unknown Runtime route.');
}

if (isEntrypoint(import.meta.url)) {
  createServer(runtimeRequest).listen(port, host, () => console.log(`Rev view (read-only): http://localhost:${port} — home: ${revHome()}`));
}
