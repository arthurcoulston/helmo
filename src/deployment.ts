import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Selection } from './release.js';

export type DeploymentPhase = 'built' | 'published' | 'selected' | 'activating' | 'running' | 'failed' | 'rolled_back';

export interface ProcessEvidence {
  process: string;
  pid: number;
  installation: string;
  release: string;
  components: Record<string, string>;
  observed_at: string;
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
  recovery: string;
  detail?: string;
}

export const deploymentFile = (selection: string): string => join(dirname(selection), 'activation.json');

export function readDeployment(file: string): DeploymentRecord | null {
  if (!existsSync(file)) return null;
  let value: Partial<DeploymentRecord>;
  try { value = JSON.parse(readFileSync(file, 'utf8')) as Partial<DeploymentRecord>; }
  catch (e) { throw new Error(`${file} is not readable: ${e instanceof Error ? e.message : String(e)}`); }
  if (value.format !== 1 || !value.installation || !value.phase || !value.release || !value.directory
      || !value.components || !value.updated_at || !value.recovery) {
    throw new Error(`${file} is partial: format, installation, phase, release, directory, components, updated_at and recovery are required`);
  }
  return value as DeploymentRecord;
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

export function describeDeployment(file: string, selected: Selection | null): string[] {
  let record: DeploymentRecord | null;
  try { record = readDeployment(file); }
  catch (e) { return [`deployment: UNREADABLE — ${e instanceof Error ? e.message : String(e)}`, `  recovery: repair or replace ${file}; do not infer running state from the selection`]; }
  if (!record) return [`deployment: unrecorded (${file} does not exist)`, '  selected is not running: no activation has supplied live process evidence'];
  const stale = selected && (record.release !== selected.release || record.directory !== selected.directory);
  const lines = [`deployment: ${stale ? 'STALE ' : ''}${record.phase} — ${record.release}, updated ${record.updated_at}`];
  lines.push(`  installation: ${record.installation}`);
  for (const [name, commit] of Object.entries(record.components)) lines.push(`  ${name.padEnd(14)} ${commit}`);
  if (record.processes?.length) {
    for (const p of record.processes) lines.push(`  process: ${p.process} pid ${p.pid}, installation ${p.installation}, release ${p.release}, observed ${p.observed_at}`);
  } else lines.push('  processes: none observed — running is not established');
  if (stale) lines.push(`  selected now: ${selected.release} (${selected.directory}); this record describes another selection`);
  lines.push(`  recovery: ${record.recovery}`);
  return lines;
}
