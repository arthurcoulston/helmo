import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIntakeResult, intakePreparationPass, validateEnvelope } from '../src/intake-preparation.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function envelope(version = 1, start = '2026-10-01T16:00:00Z') {
  const e = { version, orgId: 'org_1', projectId: 'project_1', orgSlug: 'test-org', projectSlug: 'test-project',
    bookingId: 'booking_1', scheduledStart: start, signupDocument: '# Synthetic signup\n', attemptId: `attempt_${version}`,
    leaseExpiresAt: '2026-10-01T15:30:00Z', attemptCount: version };
  return { ...e, identity: hash([e.orgId, e.projectId, e.bookingId, e.scheduledStart].join('\0')), signupSha256: hash(e.signupDocument) };
}

function harness(responses: Array<[number, unknown]>) {
  const calls: Array<{ action: string; body: Record<string, unknown>; headers: Headers }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const [status, body] = responses.shift()!;
    calls.push({ action: new URL(String(input)).pathname.split('/').pop()!, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, request: request as typeof fetch };
}

function options(request: typeof fetch, assign = (_body: string) => 'H-test', assignmentStatus = (_ticketId: string) => 'in_progress') {
  const root = mkdtempSync(join(tmpdir(), 'rev-intake-'));
  return { origin: 'https://example.test', checkout: root, stateFile: join(root, '.state.json'), resultFile: join(root, '.result.json'), request, assign, assignmentStatus, secret: () => 'NOT_A_REAL_SECRET' };
}

describe('intake preparation executor', () => {
  it('rejects a hash-valid signup attached to another occurrence', () => {
    const e = envelope();
    expect(() => validateEnvelope({ ...e, scheduledStart: '2026-10-02T16:00:00Z' })).toThrow(/does not bind/);
    expect(() => validateEnvelope({ ...e, signupDocument: '# changed\n' })).toThrow(/signup document/);
  });

  it('claims delayed work once, writes exact source and heartbeats the same attempt', async () => {
    const h = harness([[200, envelope()], [200, { leaseExpiresAt: 'later' }]]);
    const o = options(h.request);
    expect(await intakePreparationPass(o)).toBe('claimed');
    expect(readFileSync(join(o.checkout, 'clients/test-org/signup.md'), 'utf8')).toBe('# Synthetic signup\n');
    expect(await intakePreparationPass(o)).toBe('heartbeat');
    expect(h.calls.map((c) => c.action)).toEqual(['claim', 'heartbeat']);
    expect(h.calls[1]!.body).toMatchObject({ identity: envelope().identity, attemptId: 'attempt_1' });
    expect(h.calls.every((c) => c.headers.get('x-gp-signature')?.match(/^[0-9a-f]{64}$/))).toBe(true);
  });

  it.each(['done', 'cancelled', 'awaiting_human'])('stops lease retention when the assignment is %s', async (status) => {
    const h = harness([[200, envelope()]]);
    const o = options(h.request);
    expect(await intakePreparationPass(o)).toBe('claimed');
    writeFileSync(o.resultFile, '{}');
    o.assignmentStatus = () => status;
    expect(await intakePreparationPass(o)).toBe('abandoned');
    expect(h.calls.map((c) => c.action)).toEqual(['claim']);
    expect(() => readFileSync(o.stateFile)).toThrow();
    expect(() => readFileSync(o.resultFile)).toThrow();
  });

  it('reports a bounded invariant failure and leaves retry ownership with the Worker', async () => {
    const h = harness([[200, { ...envelope(), signupDocument: 'tampered' }], [200, { state: 'failed' }]]);
    const o = options(h.request);
    expect(await intakePreparationPass(o)).toBe('failed');
    expect(h.calls.map((c) => c.action)).toEqual(['claim', 'failure']);
    expect(h.calls[1]!.body).toMatchObject({ kind: 'invariant', attemptId: 'attempt_1' });
  });

  it('does not create a second assignment on concurrent claim replay', async () => {
    const h = harness([[200, envelope()], [200, envelope()]]);
    let assignments = 0;
    const o = options(h.request, () => `H-${++assignments}`);
    await Promise.all([intakePreparationPass(o), intakePreparationPass(o)]);
    expect(assignments).toBe(1);
  });

  it('drops a stale completion after reschedule and cannot revive it', async () => {
    const h = harness([[200, envelope()], [409, { error: 'stale lease' }], [204, null]]);
    const o = options(h.request);
    await intakePreparationPass(o);
    writeFileSync(o.resultFile, JSON.stringify({ artifactRef: `goodplumb@${'a'.repeat(40)}`, signupSha256: envelope().signupSha256,
      promptSha256: 'b'.repeat(64), artifactProof: { commit: 'x', signup: 'x', prompt: 'x', trees: {} } }));
    expect(await intakePreparationPass(o)).toBe('superseded');
    expect(await intakePreparationPass(o)).toBe('idle');
  });

  it('reports the current prompt hash, not a prior generated prompt', async () => {
    const h = harness([[200, envelope()], [200, { state: 'ready' }]]);
    const o = options(h.request);
    await intakePreparationPass(o);
    const current = '# Prompt rebuilt from the claimed signup\n';
    writeFileSync(o.resultFile, JSON.stringify({ artifactRef: `goodplumb@${'a'.repeat(40)}`, signupSha256: envelope().signupSha256,
      promptSha256: hash(current), artifactProof: { commit: 'x', signup: 'x', prompt: Buffer.from(current).toString('base64'), trees: {} } }));
    expect(await intakePreparationPass(o)).toBe('completed');
    expect(h.calls[1]!.body.promptSha256).toBe(hash(current));
  });

  it('builds freshness evidence from the exact committed signup and prompt objects', () => {
    const root = mkdtempSync(join(tmpdir(), 'rev-intake-git-'));
    mkdirSync(join(root, 'clients/test-org'), { recursive: true });
    mkdirSync(join(root, 'docs/voice/agent/prompts/test-org'), { recursive: true });
    writeFileSync(join(root, 'clients/test-org/signup.md'), envelope().signupDocument);
    const prompt = '# Fresh generated prompt\n';
    writeFileSync(join(root, 'docs/voice/agent/prompts/test-org/test-project.md'), prompt);
    for (const args of [['init'], ['add', 'clients/test-org/signup.md', 'docs/voice/agent/prompts/test-org/test-project.md'],
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']]) execFileSync('git', ['-C', root, ...args]);
    const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const state = join(root, '.state.json');
    const { signupDocument: _private, ...active } = envelope();
    writeFileSync(state, JSON.stringify({ ...active, ticketId: 'H-test' }));
    const result = buildIntakeResult(root, state, `goodplumb@${commit}`);
    expect(result.promptSha256).toBe(hash(prompt));
    expect(Object.keys(result.artifactProof.trees).length).toBeGreaterThan(4);
    expect(Buffer.from(result.artifactProof.prompt, 'base64').toString()).toBe(prompt);
  });
});
