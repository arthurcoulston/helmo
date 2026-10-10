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
import { processObservation, sGet, sHas, sOwner, sValue } from './sentinels.js';
import { isPeriod, readBounded, seatContext, teamDocument, type Period } from './team.js';
import { teamNow, type HeldWork, type TeamNowData } from './team-now.js';

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

/** The reason Runtime's State column carries, for the four states that record
 *  one where a reader of that table needs it. Extracted so the condensed roster
 *  reads the same words for the same state rather than deriving its own. */
function stateReason(name: string, st: string): string | undefined {
  return st === 'IDLE'
    ? sGet(name, 'IDLE')?.split('\n')[1]
    : st === 'SEAT_HELD' ? sGet(name, 'SEAT_HELD')?.split('\n')[0]
    : st === 'BLOCKED' ? blockedSummary(name)
    : st === 'WEDGED' ? sGet(name, st)?.split('\n')[0] : undefined;
}

/** `k=v` lines in a sentinel's body. Several sentinels are written this way and
 *  each has its own keys, so the reasons below ask for the keys they know
 *  rather than assuming a shape. */
function fields(content: string | null): Record<string, string> {
  const found: Record<string, string> = Object.create(null);
  for (const line of (content ?? '').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) found[line.slice(0, at)] = line.slice(at + 1);
  }
  return found;
}

/** Why a session is stopped, limited, backed off or gone — the states Runtime's
 *  table reports by their word alone, and that the condensed roster has to be
 *  able to explain, because "Stopped" without a reason is the reading Arthur
 *  would have to go and investigate by hand.
 *
 *  Every branch reads something that was WRITTEN. Where nothing was recorded
 *  this returns undefined and the roster says so, rather than composing a
 *  plausible sentence from the sentinel's existence. */
function stoppageReason(name: string, st: string): string | undefined {
  if (st === 'STOP') {
    // Two writers, two formats: `rev stop` records an owner (H-738's owned
    // sentinel), and the team control writes its own JSON. A stop written by
    // hand is neither, and its first line is whatever the operator typed.
    const owner = sOwner(name, 'STOP');
    if (owner) return `by ${owner.by}: ${owner.reason}`;
    const raw = sGet(name, 'STOP');
    if (!raw?.trim()) return undefined;
    try {
      const parsed = JSON.parse(raw) as { owner?: string };
      if (parsed?.owner) return `stopped by ${parsed.owner}`;
    } catch { /* not the control's JSON — read it as the operator's own line */ }
    return raw.split('\n')[0];
  }
  if (st === 'HOLD') return sGet(name, 'HOLD')?.split('\n')[0]?.trim() || undefined;
  // A park is commanded through PACE and acknowledged by PARKED, so the reason
  // lives on the command, never on the acknowledgement (loop.ts).
  if (st === 'PARKED') {
    const owner = sOwner(name, 'PACE');
    return owner ? `by ${owner.by}: ${owner.reason}` : undefined;
  }
  if (st === 'LIMIT') {
    const f = fields(sGet(name, 'LIMIT'));
    const wait = f['retry_s'] ? `retrying in ${f['retry_s']}s` : f['resume_at'] ? `resuming at ${f['resume_at']}` : undefined;
    return [f['reason'] ?? (f['attempt'] ? `transient condition, attempt ${f['attempt']}` : undefined), wait].filter(Boolean).join(' — ') || undefined;
  }
  if (st === 'BACKOFF') {
    const f = fields(sGet(name, 'BACKOFF'));
    return [f['attempt'] ? `restart attempt ${f['attempt']}` : undefined, f['retry_at'] ? `next at ${f['retry_at']}` : undefined].filter(Boolean).join(' — ') || undefined;
  }
  // The marker is still there and the process it names is not. The pid is the
  // whole diagnostic, and it is the marker's own first line.
  if (st === 'CRASHED') {
    const pid = sGet(name, 'RUNNING')?.split('\n')[0]?.trim();
    return pid ? `the recorded session process (pid ${pid}) is gone` : undefined;
  }
  return undefined;
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
      const reason = stateReason(l.name, st);
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

/** Team's own document. Loop state comes from `state()` here rather than being
 *  re-derived inside team.ts, so Runtime and Team can never disagree about
 *  whether a loop is running. */
export function teamSnapshot(period: Period = '7d') {
  return teamDocument(period, state);
}
/** The condensed roster behind Overview's Team now card (H-3091).
 *
 *  Same `state()` as Runtime and Team, so the three surfaces cannot disagree
 *  about whether a session is running. What this adds is the agent-level
 *  roll-up and the reason behind a stoppage, which `team-now.ts` documents.
 *
 *  `work` is the tickets each seat holds, passed in by the server that can read
 *  the work record; the runtime does not import it (R-47 C1).
 *
 *  A reading this installation cannot take answers `unavailable` rather than
 *  throwing: a state directory that cannot be read is exactly what a dashboard
 *  exists to report, and Overview's document is built before its header is
 *  written, so a throw here would answer 500 for the whole page (H-3001).
 *
 *  One honest limit. On the composed app an UNREADABLE ROSTER never reaches
 *  this: Overview counts the roster for its Team card first and answers 500,
 *  which `packages/cli/test/app-acceptance.test.mjs` asserts deliberately.
 *  This branch is the reading for every other caller and for a failure after
 *  the roster loaded. */
export function teamNowSnapshot(work: Record<string, HeldWork[]> = {}): TeamNowData {
  const asOf = new Date().toISOString();
  try {
    const { loops } = loadRoster();
    return teamNow(Object.values(loops).map((l) => {
      const st = state(l.name);
      return {
        session: l.name,
        agent: l.seat,
        source_state: st,
        workstream: l.workstream,
        detail: stateReason(l.name, st) ?? stoppageReason(l.name, st) ?? null,
      };
    }), work, asOf);
  } catch (error) {
    return { as_of: asOf, agents: [], unavailable: error instanceof Error ? error.message : String(error) };
  }
}

export function teamPeriod(url: string | undefined): Period {
  const asked = new URL(url ?? '/', 'http://x').searchParams.get('period') ?? undefined;
  return isPeriod(asked) ? asked : '7d';
}

/** The most of a file body this surface sends. */
const TEAM_BODY_LIMIT = 200_000;

/** A seat by roster name. `hasOwn`, because `loops` is a plain object and
 *  `loops['__proto__']`, `constructor` and `toString` are all truthy — which
 *  answered `/api/v1/team/members/__proto__` with a phantom member (H-3004). */
function seatLoop(name: string) {
  const loops = loadRoster().loops;
  return Object.hasOwn(loops, name) ? loops[name] : undefined;
}

/** One member's configured profile and the inventory behind it. The `body` key
 *  is the reading this route has always offered, kept so the profile is one
 *  request away; `context` is the inventory the Team page draws. */
export async function teamMember(name: string) {
  const loop = seatLoop(name);
  if (!loop) return null;
  const profile = loop.constitution ? readBounded(loop.constitution, TEAM_BODY_LIMIT) : null;
  return {
    id: loop.name,
    name: loop.seat ?? loop.name,
    cwd: loop.cwd,
    runtime: loop.runtime,
    model: loop.model,
    context: await seatContext(loop),
    body: profile === null ? 'No profile is configured.'
      : profile.ok ? profile.text + (profile.truncated ? '\n\n…bounded here; the file continues.' : '')
      : `This profile cannot be read: ${profile.error}`,
  };
}

/** The body of one inventoried file, bounded.
 *
 *  `path` must be a path this seat's own inventory lists — its constitution, a
 *  roster skill, a working-tree instruction file, or its memory index. Anything
 *  else is unknown rather than read, so this is not a file reader with a path
 *  argument: the set of readable files is whatever THIS installation
 *  configured, and no request can widen it. */
export async function teamFile(name: string, path: string) {
  const loop = seatLoop(name);
  if (!loop) return null;
  const context = await seatContext(loop);
  const inventory = [
    ...(context.composed.profile ? [{ file: context.composed.profile, role: 'profile' }] : []),
    ...context.composed.skills.map((file) => ({ file, role: 'skill' })),
    ...context.discovered.files.map((file) => ({ file, role: 'working tree' })),
    ...(context.memory.index ? [{ file: context.memory.index, role: 'memory index' }] : []),
  ];
  const found = inventory.find((item) => item.file.path === path);
  if (!found) return null;
  // Bounded at the read rather than after it: slicing a string we had already
  // pulled whole into memory was a bound on the response, not on the work, and
  // the same open is what refuses a fifo or a symlink (H-3004).
  const read = readBounded(path, TEAM_BODY_LIMIT);
  if (!read.ok) return { ...found.file, role: found.role, state: 'unreadable' as const, error: read.error, body: '', truncated: false };
  return { ...found.file, role: found.role, body: read.text, truncated: read.truncated };
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
