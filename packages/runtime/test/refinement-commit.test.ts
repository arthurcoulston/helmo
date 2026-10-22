import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_REFUSALS, refinementCommitPass, validateRefinement } from '../src/refinement-commit.js';

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
  const calls: Array<{ path: string; action: string; body: Record<string, unknown> }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const [status, body] = responses.shift()!;
    const path = new URL(String(input)).pathname;
    calls.push({ path, action: path.split('/').pop()!, body: JSON.parse(String(init?.body)) });
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
    expect(() => validateRefinement({ ...envelope(), markdown: '# tampered\n' })).toThrow(/markdownSha256/);
    for (const branch of ['main', 'refinement/other-org/test-project/x-v1', 'refinement/test-org/test-project/../main-v1',
      'refinement/test-org/test-project/x', 'refinement/test-org/test-project/a/b-v1']) {
      expect(() => validateRefinement({ ...envelope(), branch }), branch).toThrow(/proposal branch/);
    }
    for (const path of ['clients/test-org/projects/test-project/../../../../etc/directive.md', 'clients/test-org/signup.md']) {
      expect(() => validateRefinement({ ...envelope(), path }), path).toThrow(/project directive/);
    }
  });

  it('records every pass, idle or failing, in the last-run file', async () => {
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

  // H-2190: the Worker's envelope can carry the project's library schema beside the directive.
  const SCHEMA = 'clients/test-org/projects/test-project/library/schema.yaml';
  const schemaText = 'schema: goodplumb-library-schema/1\nversion: 1\ntypes: {}\n';
  const withSchema = (overrides: Record<string, unknown> = {}) =>
    envelope(undefined, { files: [{ path: SCHEMA, text: schemaText, sha256: hash(schemaText) }], ...overrides });

  it('commits the library schema beside the directive and proves both blobs (H-2190)', async () => {
    const r = repos();
    const h = harness([[200, withSchema()], [200, { state: 'committed' }]]);
    expect(await refinementCommitPass(options(h.request, r))).toBe('committed');
    const pushed = git(r.origin, 'rev-parse', `refs/heads/${BRANCH}`);
    expect(git(r.origin, 'show', `${pushed}:${SCHEMA}`) + '\n').toBe(schemaText);
    expect(git(r.origin, 'show', `${pushed}:${PATH}`) + '\n').toBe(envelope().markdown);
    expect(git(r.origin, 'diff', '--name-only', `${pushed}^`, pushed).split('\n').sort()).toEqual([PATH, SCHEMA].sort());
    const proof = (h.calls[1]!.body as { artifactProof: { schema: string; directive: string; trees: Record<string, string> } }).artifactProof;
    expect(Buffer.from(proof.schema, 'base64').toString()).toBe(schemaText);
    // root, clients, org, projects, project, library
    expect(Object.keys(proof.trees)).toHaveLength(6);
    for (const [id, bytes] of Object.entries(proof.trees)) expect(objectId('tree', Buffer.from(bytes, 'base64'))).toBe(id);
    expect(git(r.origin, 'rev-parse', `${pushed}:clients/test-org/projects/test-project/library`)).toBeOneOf(Object.keys(proof.trees));
  });

  it('a claim without files proves no schema, as before (H-2190)', async () => {
    const r = repos();
    const h = harness([[200, envelope(undefined, { files: [] })], [200, { state: 'committed' }]]);
    expect(await refinementCommitPass(options(h.request, r))).toBe('committed');
    expect(h.calls[1]!.body.artifactProof).not.toHaveProperty('schema');
  });

  it('refuses any file but the project library schema, or words that miss their hash (H-2190)', () => {
    expect(() => validateRefinement(withSchema())).not.toThrow();
    for (const path of ['clients/test-org/projects/test-project/library/other.yaml', 'clients/other-org/projects/test-project/library/schema.yaml',
      'booking/src/server.ts', 'clients/test-org/projects/test-project/library/../directive.md']) {
      expect(() => validateRefinement(withSchema({ files: [{ path, text: schemaText, sha256: hash(schemaText) }] })), path).toThrow(/library schema/);
    }
    expect(() => validateRefinement(withSchema({ files: [{ path: SCHEMA, text: 'tampered', sha256: hash(schemaText) }] }))).toThrow(/sha256/);
    const one = { path: SCHEMA, text: schemaText, sha256: hash(schemaText) };
    expect(() => validateRefinement(withSchema({ files: [one, one] }))).toThrow(/one library schema/);
    expect(() => validateRefinement(withSchema({ files: 'x' }))).toThrow(/one library schema/);
  });

  it('keeps the schema path, never its words, across a refused result (H-2190)', async () => {
    const r = repos();
    const h = harness([[200, withSchema()], [422, { error: 'commit not reachable' }], [200, {}], [200, { state: 'committed' }]]);
    const o = options(h.request, r);
    expect(await refinementCommitPass(o)).toBe('pending');
    const state = readFileSync(r.stateFile, 'utf8');
    expect(state).not.toContain('goodplumb-library-schema');
    expect(JSON.parse(state)).toMatchObject({ schemaPath: SCHEMA });
    expect(await refinementCommitPass(o)).toBe('committed');
    expect(Buffer.from((h.calls[3]!.body as { artifactProof: { schema: string } }).artifactProof.schema, 'base64').toString()).toBe(schemaText);
  });

  it('reuses an earlier pushed branch only when it holds the same directive and schema (H-2190)', async () => {
    const r = repos();
    const first = harness([[200, withSchema()], [503, { error: 'resolver down' }]]);
    await expect(refinementCommitPass(options(first.request, r))).rejects.toThrow(/503/);
    const pushed = git(r.origin, 'rev-parse', `refs/heads/${BRANCH}`);
    execFileSync('rm', ['-f', r.stateFile]);
    const replay = harness([[200, withSchema()], [200, { state: 'committed' }]]);
    expect(await refinementCommitPass(options(replay.request, r))).toBe('committed');
    expect(replay.calls[1]!.body.artifactRef).toBe(`goodplumb@${pushed}`);
    execFileSync('rm', ['-f', r.stateFile]);
    const other = 'schema: goodplumb-library-schema/1\nversion: 2\ntypes: {}\n';
    const changed = harness([[200, withSchema({ files: [{ path: SCHEMA, text: other, sha256: hash(other) }] })], [200, { state: 'failed' }]]);
    expect(await refinementCommitPass(options(changed.request, r))).toBe('failed');
    expect(changed.calls[1]!.body).toMatchObject({ retryable: false, diagnostic: expect.stringMatching(/other than these words/) });
  });
});
