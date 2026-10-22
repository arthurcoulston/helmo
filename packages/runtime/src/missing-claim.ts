// OS/journal evidence stays in Runtime; Work alone reads and repairs claims
// (H-1646). This recovers only tickets stranded by the pre-fix same-owner
// in_progress checkpoint, which retired the worker's generation and dropped
// its execution claim while the ticket stayed in_progress.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { stateDir } from './config.js';
import { sGet, processObservation } from './sentinels.js';
import { readLaunch, launchGroupFile } from './launch-journal.js';
import { requireProcessAbsent, requireSessionGroupAbsent } from './liveness-guard.js';

export interface MissingClaimRequest {
  ticket_id: string; session: string; generation: string; expected_updated_at: string;
  expected_event_seq: number; expected_worker_launch_id: string;
}

function requireNoControl(worker: string, name: string) {
  try { readFileSync(join(stateDir(worker), name), 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Worker control state unknown; repair refused.');
  }
  throw new Error('Worker has a control hold; repair refused.');
}

/** An active idle driver may remain. Every detached session must have ended;
 * any in-flight launch, halt, corrupt evidence or drift refuses. */
export function missingClaimEvidence(worker: string, request: MissingClaimRequest) {
  if (!/^[a-zA-Z0-9_-]+$/.test(worker) || request.session !== `rev:${worker}`
      || !request.generation.startsWith(`${request.session}:`)) throw new Error('Exact worker/session required.');
  const parts = request.generation.slice(request.session.length + 1).split(':');
  if (parts.length !== 3 || parts.some(x => !/^\d+$/.test(x))) throw new Error('Malformed generation.');
  const [oldPid, iteration] = parts.map(Number);
  requireProcessAbsent(oldPid!);
  const idle = sGet(worker, 'IDLE');
  const running = sGet(worker, 'RUNNING');
  if (!idle?.trim() || !running?.includes('\ncmd ') || processObservation(worker).state !== 'alive') throw new Error('Exact live idle worker required.');
  for (const control of ['STOP', 'HOLD', 'BLOCKED', 'BLOCKED.json', 'OUT_OF_SCOPE', 'LIMIT', 'WEDGED', 'BACKOFF', 'PARKED']) {
    requireNoControl(worker, control);
  }
  const entry = readLaunch(worker, request.generation);
  if (!entry || entry.phase !== 'complete' || entry.claim !== true || entry.ticket_id !== request.ticket_id
      || !entry.completed_at || !entry.dispatching_at) throw new Error('Exact completed claimed launch required.');
  const snapshot = createHash('sha256').update(running).update(idle);
  // Complete journals can still have living detached children. Prove absence
  // for all dispatched entries, and refuse an unresolved later launch intent.
  for (const name of readdirSync(join(stateDir(worker), 'launches')).filter(n => n.endsWith('.json')).sort()) {
    const bytes = readFileSync(join(stateDir(worker), 'launches', name), 'utf8');
    const parsed = JSON.parse(bytes) as { launch_id: string };
    const candidate = readLaunch(worker, parsed.launch_id);
    if (!candidate || !['complete', 'quarantined'].includes(candidate.phase)) throw new Error('Unsettled or ambiguous launch; repair refused.');
    snapshot.update(name).update(bytes);
    if (candidate.dispatching_at) {
      const group = readFileSync(launchGroupFile(worker, candidate.launch_id), 'utf8');
      requireSessionGroupAbsent(Number(group.trim())); snapshot.update(group);
    }
  }
  const events = readFileSync(join(stateDir(worker), 'events.log'), 'utf8');
  snapshot.update(events);
  const lines = events.trim().split('\n');
  const dispatched = Date.parse(entry.dispatching_at), completed = Date.parse(entry.completed_at);
  let start = -1;
  lines.forEach((line, i) => {
    if (/\srun-start\s/.test(line) && Date.parse(line.split(' ')[0]!) <= dispatched) start = i;
  });
  if (start < 0 || !new RegExp(`\\biter=${iteration}\\b`).test(lines[start]!)) throw new Error('Historical launch is ambiguous.');
  let finish = lines.findIndex((line, i) => i > start && /\srun-start\s/.test(line));
  if (finish < 0) finish = lines.length;
  const ends = lines.slice(start + 1, finish).filter(line => /\srun-end\s/.test(line));
  if (ends.length !== 1 || !new RegExp(`\\biter=${iteration}\\b.*\\brc=0\\s+class=ok\\b`).test(ends[0]!)) throw new Error('Exact clean historical run-end required.');
  const runEnd = ends[0]!.split(' ')[0]!, ended = Date.parse(runEnd);
  if (![dispatched, completed, ended].every(Number.isFinite) || dispatched > completed || completed > ended || ended > Date.now()) throw new Error('Historical journal order inconsistent.');
  return { snapshot: snapshot.digest('hex'), proof: { worker, observed_at: new Date().toISOString(), completed_at: entry.completed_at, run_end_at: runEnd, idle } };
}
