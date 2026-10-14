import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitRefinement, MAX_REFUSALS, refinementCommitPass, validateRefinement } from '../src/refinement-commit.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const objectId = (kind: string, bytes: Buffer) =>
  createHash('sha1').update(Buffer.concat([Buffer.from(`${kind} ${bytes.length}\0`), bytes])).digest('hex');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const BRANCH = 'refinement/test-org/test-project/booking-1-v1';
const PATH = 'clients/test-org/projects/test-project/directive.md';

function envelope(markdown = '# Directive\n\nStatus: **proposed**\n\n1. Ship the thing.\n', overrides: Record<string, unknown> = {}) {
  return { identity: 'job_1', version: 1, attemptId: 'attempt_1', leaseExpiresAt: '2026-10-03T01:00:00Z', attemptCount: 1,
    orgSlug: 'test-org', projectSlug: 'test-project', meetingId: 'booking:1', baseVersionId: 'dv_1',
    path: PATH, branch: BRANCH, markdown, markdownSha256: hash(markdown), changeSummary: 'Tightened section 1.', ...overrides };
}

function harness(responses: Array<[number, unknown]>) {
  const calls: Array<{ path: string; action: string; body: Record<string, unknown>; headers: Headers; raw: string }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const [status, body] = responses.shift()!;
    const path = new URL(String(input)).pathname;
    calls.push({ path, action: path.split('/').pop()!, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers), raw: String(init?.body) });
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, request: request as typeof fetch };
}

/** A bare origin with a main branch, and a checkout of it on another branch with a dirty working tree. */
function repos() {
  const root = mkdtempSync(join(tmpdir(), 'rev-refinement-test-'));
  const origin = join(root, 'origin.git');
  const checkout = join(root, 'checkout');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '--quiet', checkout]);
  git(checkout, 'remote', 'add', 'origin', origin);
  git(checkout, 'config', 'user.name', 'Test');
  git(checkout, 'config', 'user.email', 'test@example.invalid');
  git(checkout, 'checkout', '--quiet', '-b', 'main');
  writeFileSync(join(checkout, 'README.md'), 'base\n');
  git(checkout, 'add', 'README.md');
  git(checkout, 'commit', '--quiet', '-m', 'base');
  git(checkout, 'push', '--quiet', 'origin', 'main');
  git(checkout, 'checkout', '--quiet', '-b', 'someone-elses-work');
  writeFileSync(join(checkout, 'README.md'), 'uncommitted edit\n');
  return { origin, checkout, stateFile: join(root, 'state', 'refinement-commit.json') };
}

function options(request: typeof fetch, r: ReturnType<typeof repos>) {
  return { origin: 'https://example.test', checkout: r.checkout, stateFile: r.stateFile, request, secret: () => 'NOT_A_REAL_SECRET' };
}

describe('refinement commit executor', () => {
  it('refuses envelopes that would write anywhere but the project directive on its own branch', () => {
    expect(() => validateRefinement(envelope())).not.toThrow();
    for (const ids of [{ orgId: 'org_a' }, { orgId: { private: 'words' }, projectId: 'project_a' }]) {
      expect(() => validateRefinement(envelope(undefined, ids))).toThrow('tenant identifiers');
    }
    expect(() => validateRefinement({ ...envelope(), markdown: '# tampered\n' })).toThrow(/markdownSha256/);
    for (const branch of ['main', 'refinement/other-org/test-project/x-v1', 'refinement/test-org/test-project/../main-v1',
      'refinement/test-org/test-project/x', 'refinement/test-org/test-project/a/b-v1']) {
      expect(() => validateRefinement({ ...envelope(), branch }), branch).toThrow(/proposal branch/);
    }
    for (const path of ['clients/test-org/projects/test-project/../../../../etc/directive.md', 'clients/test-org/signup.md']) {
      expect(() => validateRefinement({ ...envelope(), path }), path).toThrow(/project directive/);
    }
  });

  it('records every pass, idle or failing, in the last-run file (H-1087)', async () => {
    const r = repos();
    const lastRunFile = join(r.stateFile, '..', 'refinement-commit-last.json');
    const idle = harness([[204, null]]);
    expect(await refinementCommitPass({ ...options(idle.request, r), lastRunFile })).toBe('idle');
    const first = JSON.parse(readFileSync(lastRunFile, 'utf8'));
    expect(first).toMatchObject({ pid: process.pid, result: 'idle', claim: 204 });
    expect(Date.now() - Date.parse(first.at)).toBeLessThan(60_000);
    expect(existsSync(r.stateFile)).toBe(false);

    const refused = harness([[401, { error: 'unauthorized' }]]);
    await expect(refinementCommitPass({ ...options(refused.request, r), lastRunFile })).rejects.toThrow(/401/);
    const second = JSON.parse(readFileSync(lastRunFile, 'utf8'));
    expect(second).toMatchObject({ pid: process.pid, claim: 401, error: expect.stringMatching(/refused \(401\)/) });
    expect(second).not.toHaveProperty('result');
  });

  it('commits the exact words on the job branch only, and proves them with raw Git objects', async () => {
    const r = repos();
    const head = git(r.checkout, 'rev-parse', 'HEAD');
    const h = harness([[200, envelope()], [200, { state: 'committed' }]]);
    expect(await refinementCommitPass(options(h.request, r))).toBe('committed');
    expect(h.calls.map((c) => c.path)).toEqual(['/api/refinement-commit/claim', '/api/refinement-commit/result']);

    const pushed = git(r.origin, 'rev-parse', `refs/heads/${BRANCH}`);
    const result = h.calls[1]!.body as { artifactRef: string; markdownSha256: string; attemptId: string;
      artifactProof: { commit: string; directive: string; trees: Record<string, string> } };
    expect(result).toMatchObject({ artifactRef: `goodplumb@${pushed}`, markdownSha256: envelope().markdownSha256, attemptId: 'attempt_1',
      executorId: 'goodplumb-rev', executorVersion: '1' });
    expect(git(r.origin, 'show', `${pushed}:${PATH}`) + '\n').toBe(envelope().markdown);
    expect(git(r.origin, 'rev-parse', `${pushed}^`)).toBe(git(r.origin, 'rev-parse', 'refs/heads/main'));
    expect(git(r.origin, 'log', '-1', '--format=%B', pushed)).toMatch(/meeting booking:1[\s\S]*Tightened section 1\./);

    // Every object re-hashes to its id, as the Worker checks it.
    const proof = result.artifactProof;
    expect(objectId('commit', Buffer.from(proof.commit, 'base64'))).toBe(pushed);
    expect(Buffer.from(proof.directive, 'base64').toString()).toBe(envelope().markdown);
    expect(Object.keys(proof.trees)).toHaveLength(5);
    for (const [id, bytes] of Object.entries(proof.trees)) expect(objectId('tree', Buffer.from(bytes, 'base64'))).toBe(id);

    // Main and the operator's checkout are untouched.
    expect(git(r.origin, 'log', '--format=%s', 'refs/heads/main')).toBe('base');
    expect(git(r.checkout, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(r.checkout, 'branch', '--show-current')).toBe('someone-elses-work');
    expect(readFileSync(join(r.checkout, 'README.md'), 'utf8')).toBe('uncommitted edit\n');
    expect(existsSync(join(r.checkout, PATH))).toBe(false);
    expect(existsSync(r.stateFile)).toBe(false);
  });

  it('reports a refused claim as not retryable and pushes nothing', async () => {
    const r = repos();
    const h = harness([[200, { ...envelope(), markdown: '# tampered\n' }], [200, { state: 'failed' }]]);
    expect(await refinementCommitPass(options(h.request, r))).toBe('failed');
    expect(h.calls.map((c) => c.action)).toEqual(['claim', 'failure']);
    expect(h.calls[1]!.body).toMatchObject({ identity: 'job_1', attemptId: 'attempt_1', retryable: false });
    expect(git(r.origin, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
  });

  it('reuses a branch an earlier attempt pushed with the same words, and refuses one holding other words', async () => {
    const r = repos();
    const first = harness([[200, envelope()], [503, { error: 'resolver down' }]]);
    await expect(refinementCommitPass(options(first.request, r))).rejects.toThrow(/503/);
    const pushed = git(r.origin, 'rev-parse', `refs/heads/${BRANCH}`);

    // The local state is lost; the Worker replays the live attempt.
    execFileSync('rm', ['-f', r.stateFile]);
    const replay = harness([[200, envelope()], [200, { state: 'committed' }]]);
    expect(await refinementCommitPass(options(replay.request, r))).toBe('committed');
    expect(replay.calls[1]!.body.artifactRef).toBe(`goodplumb@${pushed}`);
    expect(git(r.origin, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(pushed);

    const other = harness([[200, envelope('# Other words\n')], [200, { state: 'failed' }]]);
    expect(await refinementCommitPass(options(other.request, r))).toBe('failed');
    expect(other.calls[1]!.body).toMatchObject({ retryable: false, diagnostic: expect.stringMatching(/other than these words/) });
    expect(git(r.origin, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(pushed);
  });

  /** Push a commit holding the claimed words to the job branch by hand, built by `build` in a scratch clone. */
  function plant(r: ReturnType<typeof repos>, build: (clone: string) => void) {
    const clone = mkdtempSync(join(tmpdir(), 'rev-refinement-plant-'));
    execFileSync('git', ['clone', '--quiet', r.origin, clone]);
    git(clone, 'config', 'user.name', 'Other');
    git(clone, 'config', 'user.email', 'other@example.invalid');
    build(clone);
    mkdirSync(join(clone, 'clients/test-org/projects/test-project'), { recursive: true });
    writeFileSync(join(clone, PATH), envelope().markdown);
    git(clone, 'add', '-A');
    git(clone, 'commit', '--quiet', '-m', 'planted');
    git(clone, 'push', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`);
    return git(clone, 'rev-parse', 'HEAD');
  }

  it('refuses a same-word branch whose history or other contents are not main\'s', async () => {
    for (const build of [
      (clone: string) => { git(clone, 'checkout', '--quiet', '--orphan', 'unrelated'); git(clone, 'rm', '-rq', '--cached', '.');
        writeFileSync(join(clone, 'README.md'), 'unrelated history\n'); },
      (clone: string) => writeFileSync(join(clone, 'payload.sh'), 'echo smuggled\n'),
    ]) {
      const r = repos();
      const planted = plant(r, build);
      const h = harness([[200, envelope()], [200, { state: 'failed' }]]);
      expect(await refinementCommitPass(options(h.request, r))).toBe('failed');
      expect(h.calls.map((c) => c.action)).toEqual(['claim', 'failure']);
      expect(h.calls[1]!.body).toMatchObject({ retryable: false, diagnostic: expect.stringMatching(/other than these words on main/) });
      expect(git(r.origin, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(planted);
    }
  });

  it('reuses an earlier attempt\'s branch after main has moved on', async () => {
    const r = repos();
    const first = harness([[200, envelope()], [503, { error: 'resolver down' }]]);
    await expect(refinementCommitPass(options(first.request, r))).rejects.toThrow(/503/);
    const pushed = git(r.origin, 'rev-parse', `refs/heads/${BRANCH}`);
    const clone = mkdtempSync(join(tmpdir(), 'rev-refinement-main-'));
    execFileSync('git', ['clone', '--quiet', r.origin, clone]);
    git(clone, '-c', 'user.name=Other', '-c', 'user.email=other@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'main moves on');
    git(clone, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');

    execFileSync('rm', ['-f', r.stateFile]);
    const replay = harness([[200, envelope()], [200, { state: 'committed' }]]);
    expect(await refinementCommitPass(options(replay.request, r))).toBe('committed');
    expect(replay.calls[1]!.body.artifactRef).toBe(`goodplumb@${pushed}`);
  });

  it('keeps an unreachable commit leased and retries it, holding no words locally', async () => {
    const r = repos();
    const h = harness([[200, envelope()], [422, { error: 'commit not reachable' }], [200, { leaseExpiresAt: 'later' }],
      [200, { state: 'committed' }]]);
    const o = options(h.request, r);
    expect(await refinementCommitPass(o)).toBe('pending');
    const state = readFileSync(r.stateFile, 'utf8');
    expect(state).not.toContain('Ship the thing');
    expect(JSON.parse(state)).toMatchObject({ identity: 'job_1', refusals: 1 });
    expect(await refinementCommitPass(o)).toBe('committed');
    expect(h.calls.map((c) => c.action)).toEqual(['claim', 'result', 'heartbeat', 'result']);
    expect(existsSync(r.stateFile)).toBe(false);
  });

  it(`hands the attempt back as retryable after ${MAX_REFUSALS} refusals`, async () => {
    const r = repos();
    const h = harness([[200, envelope()], ...Array.from({ length: MAX_REFUSALS - 1 }, () => [[422, {}], [200, {}]] as Array<[number, unknown]>).flat(),
      [422, {}], [200, { state: 'drafted' }]]);
    const o = options(h.request, r);
    for (let i = 1; i < MAX_REFUSALS; i++) expect(await refinementCommitPass(o)).toBe('pending');
    expect(await refinementCommitPass(o)).toBe('failed');
    expect(h.calls.at(-1)).toMatchObject({ action: 'failure', body: { retryable: true } });
    expect(existsSync(r.stateFile)).toBe(false);
  });

  it('drops a superseded attempt on 409 and reports an unreachable origin as retryable', async () => {
    const r = repos();
    const h = harness([[200, envelope()], [409, { error: 'stale lease' }], [204, null]]);
    const o = options(h.request, r);
    expect(await refinementCommitPass(o)).toBe('superseded');
    expect(existsSync(r.stateFile)).toBe(false);
    expect(await refinementCommitPass(o)).toBe('idle');

    const gone = repos();
    execFileSync('rm', ['-rf', gone.origin]);
    const down = harness([[200, envelope()], [200, { state: 'drafted' }]]);
    expect(await refinementCommitPass(options(down.request, gone))).toBe('failed');
    expect(down.calls[1]).toMatchObject({ action: 'failure', body: { retryable: true, diagnostic: expect.stringMatching(/git fetch failed/) } });
  });
});


describe('H-1523 scoped immutable commit context', () => {
  const claimScope = { orgId: 'org_a', projectId: 'project_a' };
  const scoped = () => envelope(undefined, claimScope);
  it('signs the exact selector and commits on the explicit base even after main changes', async () => {
    const r = repos(); const baseRef = git(r.checkout, 'rev-parse', 'HEAD');
    const clone = mkdtempSync(join(tmpdir(), 'rev-pinned-main-'));
    execFileSync('git', ['clone', '--quiet', r.origin, clone]);
    writeFileSync(join(clone, 'new-on-main'), 'must not enter pinned proposal');
    git(clone, 'add', 'new-on-main');
    git(clone, '-c', 'user.name=Other', '-c', 'user.email=other@example.invalid', 'commit', '--quiet', '-m', 'main moves');
    git(clone, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
    const h = harness([[200, scoped()], [200, {}]]);
    expect(await refinementCommitPass({ ...options(h.request, r), claimScope, baseRef })).toBe('committed');
    const claim = h.calls[0]; expect(claim.body.claimScope).toEqual(claimScope);
    expect(claim.headers.get('x-gp-signature')).toBe(createHmac('sha256', 'NOT_A_REAL_SECRET')
      .update(['POST', claim.path, claim.headers.get('x-gp-timestamp'), claim.headers.get('x-gp-nonce'), hash(claim.raw)].join('\n')).digest('hex'));
    const pushed = git(r.origin, 'rev-parse', `refs/heads/${BRANCH}`);
    expect(git(r.origin, 'rev-parse', `${pushed}^`)).toBe(baseRef);
    expect(git(r.origin, 'ls-tree', '--name-only', pushed)).not.toContain('new-on-main');
    // Reusing pushed words on a different explicit base is refused, never rewritten.
    const newBase = git(clone, 'rev-parse', 'HEAD');
    git(r.checkout, 'fetch', '--quiet', 'origin', 'main');
    await expect(commitRefinement(r.checkout, scoped(), newBase)).rejects.toThrow('other than these words');
    expect(git(r.origin, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(pushed);
    expect(await commitRefinement(r.checkout, scoped(), baseRef)).toBe(pushed);
  });
  it.each([{ orgId: 'other' }, { projectId: 'other' }, { orgId: undefined }])('refuses foreign or absent envelope tenant %j without failure delivery', async change => {
    const r = repos(); const h = harness([[200, { ...scoped(), ...change }]]);
    await expect(refinementCommitPass({ ...options(h.request, r), claimScope })).rejects.toThrow('claimed tenant');
    expect(h.calls.map(c => c.action)).toEqual(['claim']); expect(existsSync(r.stateFile)).toBe(false);
    expect(git(r.origin, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
  });
  it('preserves retained result under changed origin/executor/scope/base and refuses legacy unbound state', async () => {
    const r = repos(); const baseRef = git(r.checkout, 'rev-parse', 'HEAD');
    const h = harness([[200, scoped()], [503, {}], [200, {}]]);
    const o = { ...options(h.request, r), claimScope, baseRef };
    await expect(refinementCommitPass(o)).rejects.toThrow('503');
    const saved = readFileSync(r.stateFile, 'utf8'); const count = h.calls.length;
    for (const override of [{ origin: 'https://another.test' }, { executorId: 'other' }, { executorVersion: '2' },
      { claimScope: undefined }, { claimScope: { ...claimScope, projectId: 'other' } }, { baseRef: undefined }, { baseRef: 'e'.repeat(40) }]) {
      await expect(refinementCommitPass({ ...o, ...override })).rejects.toThrow('context');
      expect(h.calls).toHaveLength(count); expect(readFileSync(r.stateFile, 'utf8')).toBe(saved);
    }
    const legacy = JSON.parse(saved); delete legacy.target;
    writeFileSync(r.stateFile, JSON.stringify(legacy));
    await expect(refinementCommitPass(o)).rejects.toThrow('unknown context'); expect(h.calls).toHaveLength(count);
    writeFileSync(r.stateFile, saved);
    expect(await refinementCommitPass(o)).toBe('committed');
  });
  it('refuses a saved envelope tenant mismatch before result, heartbeat or failure delivery', async () => {
    const r = repos(); const h = harness([[200, scoped()], [503, {}]]);
    const o = { ...options(h.request, r), claimScope };
    await expect(refinementCommitPass(o)).rejects.toThrow('503');
    const saved = JSON.parse(readFileSync(r.stateFile, 'utf8')); saved.projectId = 'other';
    writeFileSync(r.stateFile, JSON.stringify(saved));
    await expect(refinementCommitPass(o)).rejects.toThrow('context');
    expect(h.calls.map(c => c.action)).toEqual(['claim', 'result']);
  });
  it('refuses a retained matching-word commit with an unrelated file before result delivery', async () => {
    const r = repos(); const baseRef = git(r.checkout, 'rev-parse', 'HEAD');
    const h = harness([[200, scoped()], [503, {}]]); const o = { ...options(h.request, r), claimScope, baseRef };
    await expect(refinementCommitPass(o)).rejects.toThrow('503');
    const saved = JSON.parse(readFileSync(r.stateFile, 'utf8'));
    const clone = mkdtempSync(join(tmpdir(), 'rev-pinned-tamper-'));
    execFileSync('git', ['clone', '--quiet', r.origin, clone]);
    git(clone, 'checkout', '--quiet', saved.commit);
    writeFileSync(join(clone, 'payload'), 'foreign'); git(clone, 'add', 'payload');
    const tree = git(clone, 'write-tree');
    const fake = git(clone, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit-tree', tree, '-p', baseRef, '-m', 'fake');
    git(clone, 'push', '--quiet', 'origin', `${fake}:refs/heads/test-tamper`);
    git(r.checkout, 'fetch', '--quiet', 'origin', 'test-tamper');
    writeFileSync(r.stateFile, JSON.stringify({ ...saved, commit: fake }));
    await expect(refinementCommitPass(o)).rejects.toThrow('base plus directive');
    expect(h.calls.map(c => c.action)).toEqual(['claim', 'result']);
  });
  it.each([null, {}, { orgId: 'org_a' }, { orgId: 'org_a', projectId: 'project_a', extra: true }])('rejects invalid scope %j before a request', async bad => {
    const r = repos(); const h = harness([]);
    await expect(refinementCommitPass({ ...options(h.request, r), claimScope: bad as never })).rejects.toThrow('context'); expect(h.calls).toEqual([]);
  });
  it('requires a full actual commit object before any claim', async () => {
    const r = repos(); const h = harness([]);
    for (const baseRef of ['main', 'A'.repeat(40), git(r.checkout, 'rev-parse', 'HEAD:README.md'), 'e'.repeat(40)]) {
      await expect(refinementCommitPass({ ...options(h.request, r), baseRef })).rejects.toThrow(); expect(h.calls).toEqual([]);
    }
  });
  it('does not coalesce concurrent changed scopes and freezes caller options', async () => {
    const r = repos(); const h = harness([[200, scoped()], [200, {}]]);
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    const request: typeof fetch = async (...args) => { await blocked; return h.request(...args); };
    const mutableScope = { ...claimScope }; const o = { ...options(request, r), claimScope: mutableScope };
    const first = refinementCommitPass(o); expect(refinementCommitPass(o)).toBe(first);
    mutableScope.orgId = 'other';
    await expect(refinementCommitPass(o)).rejects.toThrow('concurrent');
    release(); expect(await first).toBe('committed'); expect(h.calls[0].body.claimScope).toEqual(claimScope);
  });
});
