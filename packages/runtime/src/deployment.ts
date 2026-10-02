import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Selection } from './release.js';
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
    installation: selection.install ?? process.env['REV_LABEL']?.trim() ?? process.env['REV_HOME']?.trim() ?? 'unrecorded',
    phase,
    release: selection.release,
    directory: selection.directory,
    components: Object.fromEntries(Object.entries(selection.components).map(([name, component]) => [name, component.commit])),
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
    components: Object.fromEntries(Object.entries(selection.components).map(([name, component]) => [name, component.commit])),
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
    components: Object.fromEntries(Object.entries(selection.components).map(([name, component]) => [name, component.commit])),
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
      if (command === null) problems.push(`${p.process} pid ${p.pid} is not live`);
      else if (command !== p.command) problems.push(`${p.process} pid ${p.pid} now runs a different command`);
    }
  }
  const truth = record.phase === 'running' && problems.length ? 'UNVERIFIED — record says running' : `${stale ? 'STALE ' : ''}${record.phase}`;
  const lines = [`deployment: ${truth} — ${record.release}, updated ${record.updated_at}`];
  lines.push(`  installation: ${record.installation}`);
  for (const [name, commit] of Object.entries(record.components)) lines.push(`  ${name.padEnd(14)} ${commit}`);
  if (record.processes?.length) {
    for (const p of record.processes) lines.push(`  process: ${p.process} pid ${p.pid}, installation ${p.installation}, release ${p.release}, observed ${p.observed_at}`);
  } else lines.push('  processes: none observed — running is not established');
  for (const problem of problems) lines.push(`  NOT RUNNING: ${problem}`);
  if (stale && selected) lines.push(`  selected now: ${selected.release} (${selected.directory}); this record describes another selection`);
  lines.push(`  recovery: ${record.recovery}`);
  return lines;
}
