import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readLaunch, recordLaunchAdmission, recordLaunchDispatch, recordLaunchIntent, settleLaunch, unsettledLaunches, type LaunchReceipt } from '../src/launch-journal.js';

const receipt: LaunchReceipt = {
  id: 'admission:attempt-1:launch:7',
  ticket_id: 'H-7',
  attempt_id: 'attempt-1',
  launch_id: 'rev:builder:42:1:1000',
  definition_revision: 'v3',
  evidence: [{ requirement: { id: 'technical' }, manifest: { id: 'candidate-3' }, decision: { id: 'pass-9' } }],
};

describe('launch journal', () => {
  beforeEach(() => { process.env['REV_HOME'] = mkdtempSync(join(tmpdir(), 'rev-launch-journal-')); });

  it('durably records intent and the exact admitted authority before dispatch', () => {
    recordLaunchIntent('builder', receipt.launch_id, { ticketId: 'H-7', workflowAttemptId: 'attempt-1' }, '2026-10-01T00:00:00.000Z');
    recordLaunchAdmission('builder', receipt, '2026-10-01T00:00:01.000Z');

    expect(readLaunch('builder', receipt.launch_id)).toEqual({
      format: 1, phase: 'admitted', launch_id: receipt.launch_id, intent_at: '2026-10-01T00:00:00.000Z',
      ticket_id: 'H-7', workflow_attempt_id: 'attempt-1', admission_id: 'admission:attempt-1:launch:7',
      definition_revision: 'v3', requirement_refs: [{ requirement_id: 'technical', manifest_id: 'candidate-3', decision_id: 'pass-9' }],
      admitted_at: '2026-10-01T00:00:01.000Z',
    });
    const files = readdirSync(join(process.env['REV_HOME']!, 'state', 'builder', 'launches'));
    expect(files).toHaveLength(1);
    expect(() => JSON.parse(readFileSync(join(process.env['REV_HOME']!, 'state', 'builder', 'launches', files[0]!), 'utf8'))).not.toThrow();
  });

  it('makes replay idempotent and rejects a changed identity', () => {
    recordLaunchAdmission('builder', receipt);
    expect(recordLaunchAdmission('builder', receipt)).toEqual(readLaunch('builder', receipt.launch_id));
    expect(() => recordLaunchAdmission('builder', { ...receipt, ticket_id: 'H-other' })).toThrow(/different ticket/);
    expect(() => recordLaunchIntent('builder', receipt.launch_id, { ticketId: 'H-other', workflowAttemptId: 'attempt-1' })).toThrow(/different ticket/);
  });

  it('suppresses a second dispatch after a crash in the pre-dispatch gap', () => {
    recordLaunchAdmission('builder', receipt);
    expect(recordLaunchDispatch('builder', receipt.launch_id, '2026-10-01T00:00:02.000Z')).toBe(true);
    // A restarted caller sees the marker written before the first model spawn.
    expect(recordLaunchDispatch('builder', receipt.launch_id, '2026-10-01T00:00:03.000Z')).toBe(false);
    expect(readLaunch('builder', receipt.launch_id)).toMatchObject({ phase: 'dispatching', dispatching_at: '2026-10-01T00:00:02.000Z' });
  });

  it('exposes only unsettled recovered launches and durably settles them', () => {
    recordLaunchAdmission('builder', receipt);
    expect(unsettledLaunches('builder')).toHaveLength(1);
    settleLaunch('builder', receipt.launch_id, 'quarantined', '2026-10-01T00:00:04.000Z');
    expect(unsettledLaunches('builder')).toEqual([]);
    expect(readLaunch('builder', receipt.launch_id)).toMatchObject({ phase: 'quarantined', quarantined_at: '2026-10-01T00:00:04.000Z' });
  });
});
