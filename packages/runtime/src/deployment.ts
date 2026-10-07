import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { explicitInstallationIdentity } from '@helmo/core';
import type { Selection } from './release.js';
import { loaded, parseMarker, type Snapshot } from './build.js';
import { markerObservation } from './sentinels.js';
import { runCommand } from './command-name.js';

export type DeploymentPhase = 'built' | 'published' | 'selected' | 'activating' | 'running' | 'failed' | 'rolled_back';

export interface ProcessEvidence {
  process: string;
  pid: number;
  command: string;
  installation: string;
  release: string;
  components: Record<string, string>;
  observed_at: string;
  identity_verified_at: string;
}

export interface DeploymentRecord {
  format: 1;
  installation: string;
  phase: DeploymentPhase;
  release: string;
  directory: string;
  components: Record<string, string>;
  updated_at: string;
  attempt?: string;
  processes?: ProcessEvidence[];
  required_processes?: string[];
  recovery: string;
  detail?: string;
}

export const deploymentFile = (selection: string): string => join(dirname(selection), 'activation.json');

/** The supervisor's startup marker, from any file in the installation home:
 *  the selection and the deployment record are siblings there, so either
 *  locates it. Read by path rather than through `stateDir`, which belongs to
 *  whichever installation the environment names and creates what it resolves. */
export const supervisorMarkerFile = (sibling: string): string => join(dirname(sibling), 'state', 'supervisor', 'RUNNING');

/** A path as the filesystem knows it, or as written when it is not there to
 *  ask: an unreadable path is compared literally rather than refusing. */
const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };

const commitsOf = (selection: Selection): Record<string, string> =>
  Object.fromEntries(Object.entries(selection.components).map(([name, component]) => [name, component.commit]));

export function readDeployment(file: string): DeploymentRecord | null {
  if (!existsSync(file)) return null;
  let value: Partial<DeploymentRecord>;
  try { value = JSON.parse(readFileSync(file, 'utf8')) as Partial<DeploymentRecord>; }
  catch (e) { throw new Error(`${file} is not readable: ${e instanceof Error ? e.message : String(e)}`); }
  if (value.format !== 1 || !text(value.installation) || !phases.has(value.phase as string) || !text(value.release) || !text(value.directory)
      || !refs(value.components) || !instant(value.updated_at) || !text(value.recovery)
      || (value.processes !== undefined && (!Array.isArray(value.processes) || !value.processes.every(processEvidence) || !uniqueProcessNames(value.processes)))
      || (value.required_processes !== undefined && (!Array.isArray(value.required_processes) || !value.required_processes.every(text)))) {
    throw new Error(`${file} is partial: format, installation, phase, release, directory, components, updated_at and recovery are required`);
  }
  return value as DeploymentRecord;
}

const phases = new Set<unknown>(['built', 'published', 'selected', 'activating', 'running', 'failed', 'rolled_back']);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const instant = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const refs = (value: unknown): value is Record<string, string> => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.entries(value).every(([name, ref]) => text(name) && text(ref));
const processEvidence = (value: unknown): value is ProcessEvidence => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Partial<ProcessEvidence>;
  return text(p.process) && Number.isInteger(p.pid) && p.pid! > 0 && text(p.command) && text(p.installation)
    && text(p.release) && refs(p.components) && instant(p.observed_at) && instant(p.identity_verified_at);
};
const uniqueProcessNames = (processes: ProcessEvidence[]): boolean => new Set(processes.map((p) => p.process)).size === processes.length;

function liveCommand(pid: number): string | null {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null; }
  catch { return null; }
}

export function writeDeployment(file: string, record: DeploymentRecord): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.tmp`);
  try {
    const fd = openSync(tmp, 'w');
    try { writeFileSync(fd, `${JSON.stringify(record, null, 1)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* no partial record remains */ }
    throw e;
  }
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function recordSelection(file: string, selection: Selection, phase: 'selected' | 'rolled_back'): void {
  const previous = (() => { try { return readDeployment(file); } catch { return null; } })();
  writeDeployment(file, {
    format: 1,
    installation: selection.install ?? explicitInstallationIdentity(process.env)?.label ?? process.env['REV_HOME']?.trim() ?? 'unrecorded',
    phase,
    release: selection.release,
    directory: selection.directory,
    components: commitsOf(selection),
    updated_at: new Date().toISOString(),
    recovery: phase === 'selected'
      ? 'Activation has not completed. Run the installation activation command; if it fails, follow the failed record it writes.'
      : 'Rollback changed the selection only. Restart the installation and verify every process before calling it recovered.',
    ...(previous?.attempt ? { attempt: previous.attempt } : {}),
  });
}

export function beginActivation(file: string, selection: Selection, installation: string, attempt = `${Date.now()}-${process.pid}`): DeploymentRecord {
  const record: DeploymentRecord = {
    format: 1, installation, phase: 'activating', release: selection.release, directory: selection.directory,
    components: commitsOf(selection),
    updated_at: new Date().toISOString(), attempt,
    recovery: `Wait for the bounded supervisor drain. If no replacement supervisor returns, run ${runCommand} service start; ${runCommand} release status preserves the failed attempt and selected release.`,
  };
  writeDeployment(file, record);
  return record;
}

export function completeActivation(file: string, selection: Selection, installation: string, command: string | null = null, pid = process.pid): DeploymentRecord | null {
  let previous: DeploymentRecord | null;
  try { previous = readDeployment(file); } catch { return null; }
  if (!previous || previous.phase !== 'activating' || previous.release !== selection.release || previous.directory !== selection.directory) return null;
  const observed = new Date().toISOString();
  const processEvidence: ProcessEvidence = {
    process: 'supervisor', pid, command: command ?? liveCommand(pid) ?? `${process.execPath} ${process.argv.join(' ')}`, installation, release: selection.release,
    components: commitsOf(selection),
    observed_at: observed, identity_verified_at: observed,
  };
  const record: DeploymentRecord = {
    ...previous, phase: 'running', updated_at: observed, processes: [processEvidence], required_processes: ['supervisor'],
    recovery: `This release is running. To recover, select the retained release with ${runCommand} release rollback, then run ${runCommand} release activate.`,
  };
  writeDeployment(file, record);
  const readback = readDeployment(file);
  if (!readback || readback.attempt !== previous.attempt || readback.installation !== installation) throw new Error('activation identity readback disagreed with the record just written');
  return record;
}

export function failActivation(file: string, detail: string): DeploymentRecord | null {
  let previous: DeploymentRecord | null;
  try { previous = readDeployment(file); } catch { return null; }
  if (!previous || previous.phase !== 'activating') return null;
  const record: DeploymentRecord = {
    ...previous, phase: 'failed', updated_at: new Date().toISOString(), detail,
    recovery: `The selected release remains selected. Start it with ${runCommand} service start; if it will not stay up, inspect ${runCommand} release status and roll back before activating again.`,
  };
  writeDeployment(file, record);
  return record;
}

/**
 * Did a process load the selected release's OWN bytes? The marker says which
 * directory it loaded and the build stamped there; the selection says which
 * directory it chose and the commit it expects of each component. Loaded code
 * under `<directory>/<component>/…` whose stamp is that component's selected
 * commit is the selection running, under whatever pid.
 *
 * A dirty or unstamped build names no commit that certifies its bytes, so it
 * is no answer here — the whole point of comparing is not to report a
 * configured ref as a running one (H-2432, build.ts).
 *
 * Each component's own directory is resolved before the comparison, exactly as
 * `selectedRelease` resolves the two paths it compares. A process records the
 * directory Node resolved for it; the selection holds what the operator wrote,
 * and a set may stage a component as a symlink. One link anywhere above the
 * loaded code — `/tmp` is one on macOS — otherwise makes two spellings of the
 * same directory look like two different releases.
 */
export function loadedFromRelease(snapshot: Snapshot | null, directory: string, commits: Record<string, string>): { component: string; commit: string } | null {
  if (!snapshot?.stamp || snapshot.stamp.dirty) return null;
  const where = real(snapshot.dir);
  for (const [component, commit] of Object.entries(commits)) {
    if (commit !== snapshot.stamp.commit) continue;
    const within = relative(real(join(directory, component)), where);
    if (!within.startsWith('..') && !isAbsolute(within)) return { component, commit };
  }
  return null;
}

export interface Restart {
  pid: number;
  /** When that process started, as its own marker recorded it. */
  started: string | null;
  component: string;
  commit: string;
}

/**
 * What the live supervisor marker says, when it says the selected release is
 * running under a pid the record does not know. Null means there is nothing to
 * reconcile — no live marker, or one whose loaded build is not this selection's.
 */
export function supervisorRestart(sibling: string, selected: Selection | null, observe = liveCommand): Restart | null {
  if (!selected) return null;
  const path = supervisorMarkerFile(sibling);
  if (!existsSync(path)) return null;
  let marker: string;
  try { marker = readFileSync(path, 'utf8'); } catch { return null; }
  const observation = markerObservation(marker, observe);
  if (observation.state !== 'alive') return null;
  const where = loadedFromRelease(parseMarker(marker), selected.directory, commitsOf(selected));
  if (!where) return null;
  const started = marker.split('\n').find((l) => l.startsWith('started '))?.slice(8).trim();
  return { pid: observation.pid, started: started ?? null, ...where };
}

/**
 * A supervisor that starts outside an activation is the ordinary thing launchd
 * and systemd do, and the whole point of the stable launcher (H-2889): the same
 * release comes back under a new pid. `recordSelection` and `beginActivation`
 * write the record, `completeActivation` finishes it — and before this nothing
 * reconciled it on a plain restart, so the receipt went on naming a dead pid
 * and `release status` read that as NOT RUNNING and advised a rollback off a
 * correctly running release (H-2985).
 *
 * It re-attests only its own evidence, only while the record already describes
 * the selection it just loaded, and only when the bytes it loaded are that
 * release's own. A supervisor back on other code, or a record describing
 * another selection, must be left saying so.
 */
export function recordRestart(file: string, selection: Selection, installation: string, snapshot: Snapshot | null = loaded(), pid = process.pid, command: string | null = null): DeploymentRecord | null {
  let previous: DeploymentRecord | null;
  try { previous = readDeployment(file); } catch { return null; }
  if (!previous || previous.phase !== 'running' || previous.release !== selection.release || previous.directory !== selection.directory) return null;
  if (previous.installation !== installation) return null;
  const stale = previous.processes?.find((p) => p.process === 'supervisor');
  if (!stale || stale.pid === pid || liveCommand(stale.pid) === stale.command) return null;
  if (!loadedFromRelease(snapshot, selection.directory, commitsOf(selection))) return null;
  const observed = new Date().toISOString();
  const evidence: ProcessEvidence = {
    ...stale, pid, command: command ?? liveCommand(pid) ?? `${process.execPath} ${process.argv.join(' ')}`,
    observed_at: observed, identity_verified_at: observed,
  };
  const record: DeploymentRecord = {
    ...previous, updated_at: observed,
    processes: [...(previous.processes ?? []).filter((p) => p.process !== 'supervisor'), evidence],
    detail: `supervisor pid ${stale.pid} was replaced by a restart; pid ${pid} loaded the same selection`,
  };
  writeDeployment(file, record);
  return record;
}

export function describeDeployment(file: string, selected: Selection | null, observe = liveCommand): string[] {
  let record: DeploymentRecord | null;
  try { record = readDeployment(file); }
  catch (e) { return [`deployment: UNREADABLE — ${e instanceof Error ? e.message : String(e)}`, `  recovery: repair or replace ${file}; do not infer running state from the selection`]; }
  if (!record) return [`deployment: unrecorded (${file} does not exist)`, '  selected is not running: no activation has supplied live process evidence'];
  const stale = Boolean(selected && (record.release !== selected.release || record.directory !== selected.directory));
  const expectedInstall = selected?.install;
  const required = new Set(record.required_processes ?? []);
  const observed = new Map((record.processes ?? []).map((p) => [p.process, p]));
  const problems: string[] = [];
  let restarted: Restart | null = null;
  if (record.phase === 'running') {
    if (!selected) problems.push('no readable selection exists');
    if (stale) problems.push('the record describes another selection');
    if (expectedInstall && record.installation !== expectedInstall) problems.push(`record installation ${record.installation} does not match selected ${expectedInstall}`);
    if (selected) {
      for (const [name, component] of Object.entries(selected.components)) {
        if (record.components[name] === undefined) problems.push(`record has no selected ${name} ref`);
        else if (record.components[name] !== component.commit) problems.push(`record ${name} ref does not match selected ${component.commit}`);
      }
      for (const name of Object.keys(record.components)) if (selected.components[name] === undefined) problems.push(`record has unselected component ${name}`);
    }
    if (required.size === 0) problems.push('no required process coverage is declared');
    for (const name of required) if (!observed.has(name)) problems.push(`required process ${name} has no evidence`);
    for (const p of observed.values()) {
      if (p.installation !== record.installation) problems.push(`${p.process} reports installation ${p.installation}`);
      if (p.release !== record.release) problems.push(`${p.process} reports release ${p.release}`);
      for (const [name, ref] of Object.entries(record.components)) if (p.components[name] !== ref) problems.push(`${p.process} reports a different ${name} ref`);
      if (Date.parse(p.observed_at) > Date.now() + 60_000 || Date.parse(p.identity_verified_at) > Date.now() + 60_000) problems.push(`${p.process} evidence is dated in the future`);
      const command = observe(p.pid);
      if (command !== null && command === p.command) continue;
      // The recorded pid is gone. For the supervisor that is the ordinary
      // consequence of a launchd or systemd restart, not a failure, so ask the
      // live marker before concluding the release is down: the recovery line
      // below says to roll back, and on a merely restarted fleet following it
      // abandons a correctly running release to recover from nothing (H-2985).
      if (p.process === 'supervisor') {
        restarted = supervisorRestart(file, stale ? null : selected, observe);
        if (restarted) continue;
      }
      if (command === null) problems.push(`${p.process} pid ${p.pid} is not live`);
      else problems.push(`${p.process} pid ${p.pid} now runs a different command`);
    }
  }
  const truth = record.phase === 'running' && problems.length ? 'UNVERIFIED — record says running' : `${stale ? 'STALE ' : ''}${record.phase}`;
  const lines = [`deployment: ${truth} — ${record.release}, updated ${record.updated_at}`];
  lines.push(`  installation: ${record.installation}`);
  for (const [name, commit] of Object.entries(record.components)) lines.push(`  ${name.padEnd(14)} ${commit}`);
  if (record.processes?.length) {
    for (const p of record.processes) lines.push(`  process: ${p.process} pid ${p.pid}, installation ${p.installation}, release ${p.release}, observed ${p.observed_at}`);
  } else lines.push('  processes: none observed — running is not established');
  if (restarted) {
    lines.push(`  RESTARTED: supervisor pid ${restarted.pid}${restarted.started ? ` since ${restarted.started}` : ''} loaded ${restarted.component} ${restarted.commit.slice(0, 12)} from this release — the record's process evidence predates it`);
  }
  for (const problem of problems) lines.push(`  NOT RUNNING: ${problem}`);
  if (stale && selected) lines.push(`  selected now: ${selected.release} (${selected.directory}); this record describes another selection`);
  // Recovery is advice, and advice printed over a healthy deployment is read as
  // something to do: the rollback in a running record's recovery line is how an
  // operator would go back, which `release status` already says beside the
  // retained selection. Print it only where something needs recovering.
  if (problems.length || record.phase !== 'running') lines.push(`  recovery: ${record.recovery}`);
  return lines;
}
