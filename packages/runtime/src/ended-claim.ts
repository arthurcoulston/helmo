// Runtime proves process/journal facts; only Work may mutate its claim.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { stateDir } from './config.js';
import { processObservation, sGet } from './sentinels.js';
import { readLaunch, launchGroupFile } from './launch-journal.js';

export interface EndedClaimRequest {
  ticket_id: string; session: string; generation: string; expected_updated_at: string; expected_event_seq: number;
  hold: { reason: string; provenance: string; reconsider_when: string };
  body_patch: { old: string; new: string };
}

/** Unknown/EPERM/reused/live process identities all refuse. A completed
 * journal alone does not prove the detached session group is gone. */
export function requireAbsent(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid process identity; repair refused.');
  try { process.kill(pid, 0); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw new Error('Process liveness is unknown; repair refused.');
  }
  throw new Error('Process is still live; repair refused.');
}

function requireGroupAbsent(group: number): void {
  if (!Number.isSafeInteger(group) || group <= 1) throw new Error('Missing session group; repair refused.');
  try { process.kill(-group, 0); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw new Error('Session group liveness is unknown; repair refused.');
  }
  throw new Error('Session group is still live; repair refused.');
}

export function endedClaimEvidence(worker: string, request: EndedClaimRequest) {
  if (!/^[a-zA-Z0-9_-]+$/.test(worker) || request.session !== `rev:${worker}`) throw new Error('Exact worker/session required.');
  const prefix = `${request.session}:`;
  if (!request.generation.startsWith(prefix)) throw new Error('Generation does not belong to this worker.');
  const parts = request.generation.slice(prefix.length).split(':');
  if (parts.length !== 3 || parts.some(x => !/^\d+$/.test(x))) throw new Error('Malformed generation.');
  const [pid, iteration] = parts.map(Number);
  const stop = sGet(worker, 'STOP');
  if (!stop?.trim() || processObservation(worker).state !== 'dead') throw new Error('Worker must be STOP and confirmed dead.');
  const running = sGet(worker, 'RUNNING');
  if (running) requireAbsent(Number(running.split('\n')[0]));
  requireAbsent(pid!);
  const entry = readLaunch(worker, request.generation);
  if (!entry || entry.phase !== 'complete' || entry.claim !== true || entry.ticket_id !== request.ticket_id || !entry.completed_at || !entry.dispatching_at) {
    throw new Error('Exact completed claimed launch required.');
  }
  const groupFile = launchGroupFile(worker, request.generation);
  if (!existsSync(groupFile)) throw new Error('Session group evidence missing.');
  const groupBytes = readFileSync(groupFile, 'utf8');
  requireGroupAbsent(Number(groupBytes.trim()));
  const events = readFileSync(join(stateDir(worker), 'events.log'), 'utf8');
  const lines = events.trim().split('\n');
  let start = -1;
  lines.forEach((line, i) => { if (/\srun-start\s/.test(line)) start = i; });
  if (start < 0 || !new RegExp(`\\biter=${iteration}\\b`).test(lines[start]!)) throw new Error('A later or ambiguous launch exists.');
  const ends = lines.slice(start + 1).filter(line => /\srun-end\s/.test(line));
  if (ends.length !== 1 || !new RegExp(`\\biter=${iteration}\\b.*\\brc=0\\s+class=ok\\b`).test(ends[0]!)) throw new Error('Exact clean run-end required.');
  const runEnd = ends[0]!.split(' ')[0]!;
  const completed = Date.parse(entry.completed_at), ended = Date.parse(runEnd), dispatched = Date.parse(entry.dispatching_at);
  if (![completed, ended, dispatched].every(Number.isFinite) || dispatched > completed || completed > ended || ended > Date.now()) throw new Error('Journal/run-end order is inconsistent.');
  const stopped = lines.slice(lines.indexOf(ends[0]!) + 1).some(line => /\sloop-stop\s+reason=STOP\b/.test(line));
  if (!stopped) throw new Error('Clean STOP exit required.');
  // The caller takes two identical snapshots immediately around its read-only
  // preparation. Work's transaction also compares the claim and ticket version.
  const snapshot = createHash('sha256').update(JSON.stringify(entry)).update(stop).update(groupBytes).update(events).digest('hex');
  return { snapshot, proof: { worker, observed_at: new Date().toISOString(), completed_at: entry.completed_at, run_end_at: runEnd, stop } };
}
