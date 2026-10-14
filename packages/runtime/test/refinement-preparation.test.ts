import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { refinementPreparationPass as pass, validatePreparation, PreparationRefused, type PreparationOptions } from '../src/refinement-preparation.js';

const secret = 'NOT_A_REAL_SECRET';
const envelope = () => ({ identity: 'job-1', orgId: 'org_a', projectId: 'project_a', orgSlug: 'test-org', projectSlug: 'test-project',
  meetingId: 'booking:2026-10-13T20:00:00.000Z', directiveVersionId: 'version_a', contentHash: 'a'.repeat(64), feedbackSha256: 'b'.repeat(64),
  attemptId: 'attempt-1', attemptCount: 1, leaseExpiresAt: new Date(Date.now() + 1800_000).toISOString(), providerPublicationDecisionRef: 'H-1523@dev.helmo.gp' });
const artifact = { gitRef: 'c'.repeat(40), promptHash: 'd'.repeat(64) };
const receipt = { ...artifact, agentId: 'agent_refinement_000000001' };
const beat = () => [200, { leaseExpiresAt: new Date(Date.now() + 1800_000).toISOString() }] as const;
type Reply = readonly [number, unknown] | 'network';
function harness(replies: Reply[]) {
  const dir = mkdtempSync(join(tmpdir(), 'rev-preparation-test-'));
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  const nonces = new Set<string>();
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    expect(path).toMatch(/^\/api\/refinement-preparation\/(claim|heartbeat|failure|result)$/);
    const headers = new Headers(init?.headers);
    const nonce = headers.get('x-gp-nonce')!;
    expect(nonces.has(nonce)).toBe(false); nonces.add(nonce);
    const raw = String(init?.body);
    const expected = createHmac('sha256', secret).update(['POST', path, headers.get('x-gp-timestamp'), nonce,
      createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
    expect(headers.get('x-gp-signature')).toBe(expected);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(raw);
    expect(body).toMatchObject({ executorId: 'goodplumb-rev', executorVersion: '1' });
    calls.push({ action: path.split('/').at(-1)!, body });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected request');
    if (reply === 'network') throw new Error('SECRET raw private network response');
    return new Response(reply[1] === null ? null : JSON.stringify(reply[1]), { status: reply[0] });
  });
  const options: PreparationOptions = { origin: 'https://example.test', stateFile: join(dir, 'active.json'), lastRunFile: join(dir, 'last.json'),
    secret: () => secret, request: request as typeof fetch,
    build: vi.fn(async () => artifact), publish: vi.fn(async () => receipt), verify: vi.fn(async () => true) };
  return { options, calls, replies, saved: () => JSON.parse(readFileSync(options.stateFile, 'utf8')),
    last: () => JSON.parse(readFileSync(options.lastRunFile!, 'utf8')) };
}

describe('preparation protocol adapter', () => {
  it.each([
    { orgSlug: '../outside' }, { projectSlug: 'x/y' }, { meetingId: 'booking:../outside' },
    { meetingId: 'booking:garbage' }, { directiveVersionId: '-v bad\ntext' }, { identity: '' },
    { contentHash: 'A'.repeat(64) }, { feedbackSha256: 'bad' }, { leaseExpiresAt: 'tomorrow' },
    { attemptCount: 0 }, { attemptCount: 6 }, { providerPublicationDecisionRef: 'H-1523' },
  ])('refuses malformed path/lease/authority pins %j', overrides => {
    expect(() => validatePreparation({ ...envelope(), ...overrides })).toThrow(PreparationRefused);
  });
  it('whitelists metadata and signs distinct paths/nonces without retaining raw words', async () => {
    const h = harness([[200, { ...envelope(), markdown: 'PRIVATE CLIENT WORDS' }], beat(), beat(), beat(), [200, { state: 'bound' }]]);
    expect(await pass(h.options)).toBe('bound');
    expect(h.calls.map(c => c.action)).toEqual(['claim', 'heartbeat', 'heartbeat', 'heartbeat', 'result']);
    expect(h.options.publish).toHaveBeenCalledWith(expect.objectContaining({ contentHash: envelope().contentHash }), artifact, expect.any(Function));
    expect(h.options.verify).toHaveBeenCalledOnce();
    expect(existsSync(h.options.stateFile)).toBe(false);
    expect(h.last()).toMatchObject({ result: 'bound', claim: 200, owner: 'builder' });
    expect(JSON.stringify(h.calls)).not.toContain('PRIVATE CLIENT WORDS');
  });
  it('does no work when authority has no runnable job', async () => {
    const h = harness([[204, null]]);
    expect(await pass(h.options)).toBe('idle');
    expect(h.options.build).not.toHaveBeenCalled(); expect(h.options.publish).not.toHaveBeenCalled();
    expect(h.last()).toMatchObject({ result: 'idle', claim: 204 });
  });
  it('refuses an invalid claim before invoking any pipeline', async () => {
    const h = harness([[200, { ...envelope(), meetingId: '../../bad' }]]);
    await expect(pass(h.options)).rejects.toThrow('unavailable');
    expect(h.options.build).not.toHaveBeenCalled(); expect(h.options.publish).not.toHaveBeenCalled();
    expect(h.last().result).toBe('unknown');
  });
  it.each([409, 401, 500])('refuses provider work when authority heartbeat returns %i', async status => {
    const h = harness([[200, envelope()], [status, {}]]);
    expect(await pass(h.options)).toBe(status === 409 ? 'superseded' : 'pending');
    expect(h.options.build).not.toHaveBeenCalled(); expect(h.options.publish).not.toHaveBeenCalled();
    expect(existsSync(h.options.stateFile)).toBe(status !== 409);
  });
  it('rechecks after building, and retains the artifact during an unavailable checkpoint', async () => {
    const h = harness([[200, envelope()], beat(), [503, {}]]);
    expect(await pass(h.options)).toBe('pending');
    expect(h.saved().artifact).toEqual(artifact);
    expect(h.options.publish).not.toHaveBeenCalled();
    h.replies.push(beat(), beat(), beat(), [200, { state: 'bound' }]);
    expect(await pass(h.options)).toBe('bound');
    expect(h.options.build).toHaveBeenCalledOnce(); expect(h.options.publish).toHaveBeenCalledOnce();
    expect(h.calls.filter(c => c.action === 'claim')).toHaveLength(1);
  });
  it('honors a callback checkpoint immediately before its external effect', async () => {
    const h = harness([[200, envelope()], beat(), beat(), [409, {}]]);
    const effect = vi.fn();
    h.options.publish = async (_e, _a, checkpoint) => { await checkpoint(); effect(); return receipt; };
    expect(await pass(h.options)).toBe('superseded');
    expect(effect).not.toHaveBeenCalled(); expect(h.options.verify).not.toHaveBeenCalled();
  });
  it('resumes stored provider receipt at readback without publishing again', async () => {
    const h = harness([[200, envelope()], beat(), beat(), [503, {}]]);
    expect(await pass(h.options)).toBe('pending');
    expect(h.saved()).toMatchObject({ receipt });
    expect(h.saved().verified).not.toBe(true);
    h.replies.push(beat(), beat(), beat(), [200, { state: 'bound' }]);
    expect(await pass(h.options)).toBe('bound');
    expect(h.options.publish).toHaveBeenCalledOnce(); expect(h.options.verify).toHaveBeenCalledOnce();
  });
  it('delivers a verified result first after lost response, without new claim/heartbeat/provider work', async () => {
    const h = harness([[200, envelope()], beat(), beat(), beat(), 'network']);
    await expect(pass(h.options)).rejects.toThrow('unavailable');
    expect(h.saved()).toMatchObject({ receipt, verified: true });
    expect(h.last().result).toBe('unknown');
    h.replies.push([200, { state: 'bound' }]);
    expect(await pass(h.options)).toBe('bound');
    expect(h.calls.at(-1)?.action).toBe('result');
    expect(h.options.publish).toHaveBeenCalledOnce(); expect(h.options.verify).toHaveBeenCalledOnce();
  });
  it('never treats a binding receipt as verified provider state', async () => {
    const h = harness([[200, envelope()], beat(), beat(), beat(), [503, {}]]);
    h.options.verify = vi.fn(async () => false);
    expect(await pass(h.options)).toBe('pending');
    expect(h.saved().failure).toMatchObject({ retryable: false, diagnostic: expect.stringContaining('verify failed') });
    expect(h.calls.at(-1)?.action).toBe('failure');
    h.replies.push([200, { state: 'failed' }]);
    expect(await pass(h.options)).toBe('failed');
    expect(h.options.publish).toHaveBeenCalledOnce(); expect(h.options.verify).toHaveBeenCalledOnce();
    expect(h.calls.filter(c => c.action === 'result')).toHaveLength(0);
  });
  it('retains a failure whose delivery is unknown, with closed diagnostics only', async () => {
    const h = harness([[200, envelope()], beat(), 'network']);
    h.options.build = vi.fn(async () => { throw new Error('PRIVATE CLIENT WORDS secret=raw'); });
    await expect(pass(h.options)).rejects.toThrow('unavailable');
    expect(h.saved().failure).toEqual({ diagnostic: 'Preparation build failed; Builder must inspect the exact meeting.', retryable: true });
    expect(JSON.stringify(h.saved()) + JSON.stringify(h.calls) + JSON.stringify(h.last())).not.toMatch(/PRIVATE CLIENT|secret=raw/);
    h.replies.push([200, { state: 'failed' }]);
    expect(await pass(h.options)).toBe('failed'); expect(h.options.build).toHaveBeenCalledOnce();
  });
  it('refuses a publisher receipt for different committed words', async () => {
    const h = harness([[200, envelope()], beat(), beat(), [200, {}]]);
    h.options.publish = vi.fn(async () => ({ ...receipt, gitRef: 'f'.repeat(40) }));
    expect(await pass(h.options)).toBe('failed');
    expect(h.calls.at(-1)?.body.retryable).toBe(false); expect(h.options.verify).not.toHaveBeenCalled();
  });
  it('bounds mismatched-result recovery to five submissions and a nonautomatic failure', async () => {
    const h = harness([[200, envelope()], beat(), beat(), beat(), [422, {}], beat()]);
    expect(await pass(h.options)).toBe('pending');
    for (let i = 0; i < 3; i++) { h.replies.push([422, {}], beat()); expect(await pass(h.options)).toBe('pending'); }
    h.replies.push([422, {}], [200, {}]);
    expect(await pass(h.options)).toBe('failed');
    expect(h.calls.filter(c => c.action === 'result')).toHaveLength(5);
    expect(h.calls.at(-1)?.body.retryable).toBe(false); expect(h.options.publish).toHaveBeenCalledOnce();
  });
  it('discards stale results without publishing or claiming another job', async () => {
    const h = harness([[200, envelope()], beat(), beat(), beat(), [409, {}]]);
    expect(await pass(h.options)).toBe('superseded'); expect(existsSync(h.options.stateFile)).toBe(false);
    expect(h.calls.filter(c => c.action === 'claim')).toHaveLength(1);
  });
  it('retires a retained verified result whose later heartbeat becomes stale', async () => {
    const h = harness([[200, envelope()], beat(), beat(), beat(), [503, {}]]);
    expect(await pass(h.options)).toBe('pending');
    h.replies.push([422, {}], [409, {}]);
    expect(await pass(h.options)).toBe('superseded'); expect(existsSync(h.options.stateFile)).toBe(false);
    expect(h.options.publish).toHaveBeenCalledOnce();
  });
  it('refuses a corrupt saved receipt before invoking network or pipeline', async () => {
    const h = harness([[200, envelope()], beat(), beat(), [503, {}]]);
    expect(await pass(h.options)).toBe('pending');
    writeFileSync(h.options.stateFile, JSON.stringify({ ...h.saved(), receipt: { ...receipt, promptHash: 'f'.repeat(64) } }));
    const count = h.calls.length;
    await expect(pass(h.options)).rejects.toThrow('unavailable');
    expect(h.calls).toHaveLength(count); expect(h.options.publish).toHaveBeenCalledOnce();
  });
  it('coalesces overlapping polls for the same owned state file', async () => {
    const h = harness([[200, envelope()], beat(), beat(), beat(), [200, {}]]);
    const first = pass(h.options), second = pass(h.options);
    expect(second).toBe(first); expect(await first).toBe('bound'); expect(h.options.publish).toHaveBeenCalledOnce();
  });
  it.each(['http://remote.test', 'https://user:password@example.test', 'https://example.test/api', 'https://example.test/?query=bad'])('refuses unsafe origin %s before network access', async origin => {
    const h = harness([]);
    await expect(pass({ ...h.options, origin })).rejects.toThrow('unavailable');
    expect(h.calls).toHaveLength(0); expect(h.options.publish).not.toHaveBeenCalled();
  });
  it('preserves pending ownership when configuration points at another product or executor', async () => {
    const h = harness([[200, envelope()], beat(), [503, {}]]);
    expect(await pass(h.options)).toBe('pending');
    const saved = readFileSync(h.options.stateFile, 'utf8');
    const count = h.calls.length;
    for (const overrides of [{ origin: 'https://another.test' }, { executorId: 'other' }, { executorVersion: '2' }]) {
      await expect(pass({ ...h.options, ...overrides })).rejects.toThrow('unavailable');
      expect(readFileSync(h.options.stateFile, 'utf8')).toBe(saved);
      expect(h.calls).toHaveLength(count);
    }
  });
  it.each([[200, {}], [200, { leaseExpiresAt: '2020-01-01T00:00:00Z' }], 'network'] as Reply[])('keeps a claim when its heartbeat proof is missing, expired or unknown: %j', async reply => {
    const h = harness([[200, envelope()], reply]);
    expect(await pass(h.options)).toBe('pending'); expect(existsSync(h.options.stateFile)).toBe(true);
    expect(h.options.build).not.toHaveBeenCalled(); expect(h.options.publish).not.toHaveBeenCalled();
  });
});

describe('supervisor drain fences', () => {
  it('does not start a signed pass once draining', async () => {
    const h = harness([]);
    await expect(pass({ ...h.options, shouldContinue: () => false })).rejects.toThrow('unavailable');
    expect(h.calls).toEqual([]); expect(h.options.build).not.toHaveBeenCalled();
  });
  it('retains the claim when drain begins during build; restart resumes from retained pins', async () => {
    const h = harness([[200, envelope()], beat()]);
    let live = true;
    h.options.build = vi.fn(async (_e, checkpoint) => { live = false; await checkpoint(); return artifact; });
    expect(await pass({ ...h.options, shouldContinue: () => live })).toBe('pending');
    expect(h.saved().failure).toBeUndefined(); expect(h.options.publish).not.toHaveBeenCalled();
    expect(h.calls.map(c => c.action)).toEqual(['claim', 'heartbeat']);
    live = true; h.options.build = vi.fn(async () => artifact);
    h.replies.push(beat(), beat(), beat(), [200, {}]);
    expect(await pass({ ...h.options, shouldContinue: () => live })).toBe('bound');
    expect(h.calls.filter(c => c.action === 'claim')).toHaveLength(1);
  });
  it('drain during heartbeat refuses provider effects without discarding attempt', async () => {
    const h = harness([[200, envelope()], beat()]); let live = true;
    const request = h.options.request!;
    h.options.request = async (...args) => { const response = await request(...args); if (String(args[0]).endsWith('/heartbeat')) live = false; return response; };
    expect(await pass({ ...h.options, shouldContinue: () => live })).toBe('pending');
    expect(h.options.build).not.toHaveBeenCalled(); expect(h.saved().envelope.attemptId).toBe('attempt-1');
  });
});


describe('H-1523 exact callable preparation context', () => {
  const claimScope = { orgId: 'org_a', projectId: 'project_a' };
  it('signs exact scope in claim and retains the frozen base/scope across pending recovery', async () => {
    const h = harness([[200, envelope()], beat(), [503, {}]]);
    const o = { ...h.options, claimScope, baseRef: 'e'.repeat(40) };
    expect(await pass(o)).toBe('pending');
    expect(h.calls[0].body.claimScope).toEqual(claimScope); // harness checks HMAC against the entire raw body
    expect(h.saved().target).toMatchObject({ claimScope, baseRef: o.baseRef });
    const saved = readFileSync(o.stateFile, 'utf8'); const count = h.calls.length;
    for (const override of [{ claimScope: { ...claimScope, orgId: 'other' } },
      { claimScope: { ...claimScope, projectId: 'other' } }, { claimScope: undefined }, { baseRef: 'f'.repeat(40) }, { baseRef: undefined }]) {
      await expect(pass({ ...o, ...override })).rejects.toThrow('unavailable');
      expect(h.calls).toHaveLength(count); expect(readFileSync(o.stateFile, 'utf8')).toBe(saved);
    }
    h.replies.push(beat(), beat(), beat(), [200, {}]);
    expect(await pass(o)).toBe('bound');
    expect(h.options.build).toHaveBeenCalledOnce();
  });
  it.each([{ orgId: 'other' }, { projectId: 'other' }])('refuses mismatching claimed tenant %j before saving or callbacks', async change => {
    const h = harness([[200, { ...envelope(), ...change }]]);
    await expect(pass({ ...h.options, claimScope })).rejects.toThrow('unavailable');
    expect(h.calls.map(c => c.action)).toEqual(['claim']);
    expect(existsSync(h.options.stateFile)).toBe(false); expect(h.options.build).not.toHaveBeenCalled();
  });
  it.each([null, {}, { orgId: 'org_a' }, { orgId: 'org_a', projectId: 'project_a', extra: true }])('refuses malformed scope before transport: %j', async bad => {
    const h = harness([]);
    await expect(pass({ ...h.options, claimScope: bad as never })).rejects.toThrow('unavailable');
    expect(h.calls).toEqual([]);
  });
  it('refuses a concurrent changed context while preserving the first pass and snapshots mutable input', async () => {
    const h = harness([[200, envelope()], beat(), beat(), beat(), [200, {}]]);
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    h.options.build = vi.fn(async () => { await blocked; return artifact; });
    const mutableScope = { ...claimScope };
    const o = { ...h.options, claimScope: mutableScope, baseRef: 'e'.repeat(40) };
    const first = pass(o);
    expect(pass(o)).toBe(first);
    mutableScope.projectId = 'other';
    await expect(pass(o)).rejects.toThrow('concurrent context');
    release(); expect(await first).toBe('bound');
    expect(h.calls[0].body.claimScope).toEqual(claimScope);
  });
  it('refuses a saved envelope outside the unchanged requested tenant before any delivery', async () => {
    const h = harness([[200, envelope()], beat(), beat(), beat(), [503, {}]]);
    const o = { ...h.options, claimScope, baseRef: 'e'.repeat(40) };
    expect(await pass(o)).toBe('pending');
    const saved = h.saved(); saved.envelope.projectId = 'other';
    writeFileSync(o.stateFile, JSON.stringify(saved)); const count = h.calls.length;
    await expect(pass(o)).rejects.toThrow('unavailable'); expect(h.calls).toHaveLength(count);
    expect(h.options.publish).toHaveBeenCalledOnce();
  });
  it.each(['verified', 'failure'])('does not deliver saved %s state to a changed context', async kind => {
    const h = harness(kind === 'verified' ? [[200, envelope()], beat(), beat(), beat(), [503, {}]]
      : [[200, envelope()], beat(), [503, {}]]);
    if (kind === 'failure') h.options.build = vi.fn(async () => { throw new PreparationRefused('closed'); });
    const o = { ...h.options, claimScope, baseRef: 'e'.repeat(40) };
    expect(await pass(o)).toBe('pending');
    const count = h.calls.length;
    await expect(pass({ ...o, baseRef: 'f'.repeat(40) })).rejects.toThrow('unavailable');
    expect(h.calls).toHaveLength(count);
  });
});
