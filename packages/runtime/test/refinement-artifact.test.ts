import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildIsolatedRefinement, refinementArtifactTarget, isolatedRefinementCallbacks } from '../src/refinement-artifact.js';
import { refinementPreparationPass } from '../src/refinement-preparation.js';
import type { PreparationEnvelope } from '../src/refinement-preparation.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const markdown = '# Synthetic project\n\n## Purpose\nHelp synthetic users.\n';
const e: PreparationEnvelope = { identity: 'prep_1', orgId: 'org_1', projectId: 'project_1', orgSlug: 'org', projectSlug: 'project',
  meetingId: 'booking:2026-10-02T18:04:11.512Z', directiveVersionId: 'v1', contentHash: sha(markdown), feedbackSha256: sha('[]'),
  attemptId: 'attempt_1', attemptCount: 1, leaseExpiresAt: '2030-01-01T00:00:00.000Z', providerPublicationDecisionRef: 'H-1523@dev.helmo.gp' };
const product = process.env.REFINEMENT_TEST_PRODUCT;
const publishing = process.env.REFINEMENT_TEST_PUBLISHING;
const files = ['booking/scripts/refinement-provider-publication.mjs', 'booking/scripts/refinement-publication-preflight.mjs', 'booking/scripts/admin.mjs', 'booking/src/server/refinement-feedback.js', 'booking/src/server/signup-document.js', 'booking/src/lib/doc.ts',
  'docs/voice/agent/build-refinement-prompt.mjs', 'docs/voice/agent/elevenlabs.mjs', 'agents/lead/PROFILE.md', 'agents/lead/FAQ.md', 'skills/directive-review.md', 'docs/REFINEMENT-MEETING-DRAFT.md'];

const hook = `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const original = cp.execFileSync;
cp.execFileSync = (cmd, ...args) => cmd === 'security' ? 'synthetic-provider-key' : original(cmd, ...args);
syncBuiltinESMExports();
globalThis.fetch = async (input, options = {}) => {
  const state = JSON.parse(readFileSync(process.env.FIXTURE_STATE, 'utf8'));
  const url = new URL(input), method = options.method ?? 'GET', body = options.body ? JSON.parse(options.body) : null;
  const save = () => writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state));
  const response = value => new Response(JSON.stringify(value), { status: 200 });
  (state.calls ??= []).push(method + ' ' + url.origin + url.pathname); save();
  if (url.origin === 'http://127.0.0.1:1' && url.pathname === '/api/admin/refinement-agent') {
    if (method === 'GET') return response(state);
    if (method === 'POST') { state.binding = body; state.published = true; save(); if (state.lose === 'bind') { state.lose = null; save(); throw new Error('private provider body'); } return response({ agentId: body.agentId }); }
  }
  if (url.origin === 'https://api.elevenlabs.io') {
    if (method === 'GET' && url.pathname === '/v1/convai/agents') return response({ agents: state.agent ? [{ name: state.agent.name, agent_id: state.agent.agent_id }] : [], has_more: false });
    if (method === 'POST' && url.pathname === '/v1/convai/agents/create') { state.agent = { ...body, agent_id: 'agent_refinement_000001' }; save(); if (state.lose === 'create') { state.lose = null; save(); throw new Error('private provider body'); } return response({ agent_id: state.agent.agent_id }); }
    if (method === 'GET' && url.pathname === '/v1/convai/agents/agent_refinement_000001') return response(state.agent);
  }
  throw new Error('unexpected request refused');
};
`
function fixture() {
  const room = mkdtempSync(join(tmpdir(), 'refinement-artifact-'));
  const source = join(room, 'goodplumb'), remote = join(room, 'remote.git'), workRoot = join(room, 'private');
  mkdirSync(source);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: 'pipe' }).trim();
  for (const f of files) { mkdirSync(dirname(join(source, f)), { recursive: true }); cpSync(join(product!, f), join(source, f)); }
  writeFileSync(join(source, 'package.json'), '{"type":"module"}');
  git(source, 'init', '-q', '-b', 'main'); git(source, 'add', '--', ...files, 'package.json'); git(source, 'commit', '-q', '-m', 'Synthetic product source');
  const baseRef = git(source, 'rev-parse', 'HEAD');
  git(room, 'init', '--bare', '-q', remote); git(source, 'remote', 'add', 'origin', remote); git(source, 'push', '-q', '-u', 'origin', 'main');
  const preload = join(room, 'preload.mjs'), state = join(room, 'fixture.json'); writeFileSync(preload, hook);
  const value = { target: { orgId: e.orgId, projectId: e.projectId, orgSlug: e.orgSlug, projectSlug: e.projectSlug },
    meeting: { meetingId: e.meetingId, directiveVersionId: e.directiveVersionId, directiveVersion: 1, contentHash: e.contentHash, feedback: [], feedbackSha256: e.feedbackSha256 },
    markdown, preparation: { state: 'current' }, published: false };
  writeFileSync(state, JSON.stringify(value));
  const options = { source, baseRef, workRoot, origin: 'http://127.0.0.1:1', syncScript: join(publishing!, 'sync.mjs'), scanScript: join(publishing!, 'scan.mjs'),
    env: { ...env, PLUMB_OPERATOR_KEY: 'synthetic', NODE_OPTIONS: `--import=${preload}`, FIXTURE_STATE: state, GP_SYNC_PROJECTS: room, GP_SYNC_VISIBILITY: 'private', GP_SYNC_RECEIPTS: join(room, 'receipts') } };
  return { room, source, remote, options, git, state, value, dispose: () => rmSync(room, { recursive: true, force: true }) };
}

describe('isolated refinement target validation', () => {
  it('keeps the branch stable across lease/attempt changes and different across evidence changes', () => {
    expect(refinementArtifactTarget({ ...e, attemptId: 'attempt_2', attemptCount: 2 }).branch).toBe(refinementArtifactTarget(e).branch);
    expect(refinementArtifactTarget({ ...e, contentHash: 'c'.repeat(64) }).branch).not.toBe(refinementArtifactTarget(e).branch);
  });
  it.each([{ orgSlug: '../outside' }, { projectSlug: '-x' }, { meetingId: 'booking:../../' }, { contentHash: 'invalid' }])('refuses unsafe target %j', change => {
    expect(() => refinementArtifactTarget({ ...e, ...change })).toThrow();
  });
});

// Explicit integration inputs: immutable reviewed product source plus the
// existing company tools. No network/provider/keychain fall-through allowed.
// The bare local remote is declared private fixture data, not a live remote.
describe.skipIf(!product || !publishing)('actual product builder and scanner-backed private artifact sync', () => {
  it('composes real callbacks with owned protocol delivery and never repeats effects after a lost result response', async () => {
    const f = fixture();
    try {
      let results = 0;
      const request = async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/claim')) return new Response(JSON.stringify(e));
        if (path.endsWith('/heartbeat')) return new Response(JSON.stringify({ leaseExpiresAt: e.leaseExpiresAt }));
        if (path.endsWith('/result')) {
          const body = JSON.parse(String(init?.body));
          const binding = JSON.parse(readFileSync(f.state, 'utf8')).binding;
          expect(body).toMatchObject({ agentId: binding.agentId, gitRef: binding.gitRef, promptHash: binding.promptHash });
          if (++results === 1) throw new Error('lost result response');
          return new Response('{}');
        }
        throw new Error('unexpected signed request');
      };
      const options = { origin: f.options.origin, stateFile: join(f.room, 'attempt.json'), secret: () => 'synthetic', request: request as typeof fetch, ...isolatedRefinementCallbacks(f.options) };
      await expect(refinementPreparationPass(options)).rejects.toThrow('unavailable');
      const calls = JSON.parse(readFileSync(f.state, 'utf8')).calls;
      expect(await refinementPreparationPass(options)).toBe('bound');
      expect(JSON.parse(readFileSync(f.state, 'utf8')).calls).toEqual(calls);
      expect(calls.filter((s: string) => s.startsWith('POST https://api.elevenlabs.io'))).toHaveLength(1);
    } finally { f.dispose(); }
  });
  it('refuses a symlink in an artifact parent before any evidence write', async () => {
    const f = fixture();
    try {
      const outside = join(f.room, 'outside'); mkdirSync(outside);
      symlinkSync(outside, join(f.source, 'clients'));
      f.git(f.source, 'add', '--', 'clients'); f.git(f.source, 'commit', '-q', '-m', 'Synthetic unsafe base');
      f.options.baseRef = f.git(f.source, 'rev-parse', 'HEAD');
      await expect(buildIsolatedRefinement(f.options, e, async () => {})).rejects.toThrow('artifact path contains a link');
      expect(f.git(f.remote, 'show-ref', '--heads')).not.toContain(refinementArtifactTarget(e).branch);
    } finally { f.dispose(); }
  });
  it.each(['create', 'bind'])('runs actual provider callbacks and independently verifies after a lost %s response', { timeout: 15000 }, async phase => {
    const f = fixture();
    try {
      const callbacks = isolatedRefinementCallbacks(f.options);
      const a = await callbacks.build(e, async () => {});
      let state = JSON.parse(readFileSync(f.state, 'utf8')); state.lose = phase; writeFileSync(f.state, JSON.stringify(state));
      await expect(callbacks.publish(e, a, async () => {})).rejects.toThrow('did not verify');
      let beats = 0;
      const receipt = await callbacks.publish(e, a, async () => { beats++; });
      expect(receipt).toEqual({ ...a, agentId: 'agent_refinement_000001' });
      expect(beats).toBeGreaterThanOrEqual(1);
      state = JSON.parse(readFileSync(f.state, 'utf8'));
      expect(state.calls.filter((s: string) => s.startsWith('POST https://api.elevenlabs.io'))).toHaveLength(1);
      expect(state.calls.filter((s: string) => s.startsWith('POST http://127.0.0.1:1'))).toHaveLength(1);
      const before = state.calls.length;
      expect(await callbacks.verify(e, receipt)).toBe(true);
      state = JSON.parse(readFileSync(f.state, 'utf8'));
      expect(state.calls.slice(before)).toEqual(['GET https://api.elevenlabs.io/v1/convai/agents/agent_refinement_000001']);
      state.agent.platform_settings.auth.enable_auth = false; writeFileSync(f.state, JSON.stringify(state));
      expect(await callbacks.verify(e, receipt)).toBe(false);
      await expect(callbacks.publish(e, a, async () => {})).rejects.toThrow('publication refused');
      expect(JSON.parse(readFileSync(f.state, 'utf8')).calls.some((s: string) => s.startsWith('PATCH'))).toBe(false);
    } finally { f.dispose(); }
  });
  it('propagates an IPC checkpoint refusal before provider create and never exposes response bodies', async () => {
    const f = fixture();
    try {
      const callbacks = isolatedRefinementCallbacks(f.options), a = await callbacks.build(e, async () => {});
      let beats = 0;
      const refused = new Error('synthetic checkpoint revoked');
      await expect(callbacks.publish(e, a, async () => { if (++beats === 2) throw refused; })).rejects.toBe(refused);
      expect(JSON.parse(readFileSync(f.state, 'utf8')).calls.some((s: string) => s.startsWith('POST'))).toBe(false);
    } finally { f.dispose(); }
  });
  // Four real build/sync passes can exceed Vitest's 5s default under fleet load.
  it('builds exact artifacts, pushes only their branch, and reconciles a committed lost sync response', { timeout: 15000 }, async () => {
    const f = fixture();
    try {
      let beats = 0;
      const checkpoint = async () => { beats++; };
      const a = await buildIsolatedRefinement(f.options, e, checkpoint);
      const t = refinementArtifactTarget(e), checkout = join(f.options.workRoot, t.key);
      expect(beats).toBe(2);
      expect(f.git(f.source, 'status', '--porcelain')).toBe('');
      expect(f.git(f.source, 'rev-parse', 'HEAD')).toBe(f.options.baseRef);
      expect(f.git(f.remote, 'rev-parse', 'refs/heads/main')).toBe(f.options.baseRef);
      expect(f.git(checkout, 'diff-tree', '--no-commit-id', '--name-only', '-r', a.gitRef).split('\n').sort()).toEqual([t.snapshot, t.prompt].sort());
      const prompt = readFileSync(join(checkout, t.prompt), 'utf8');
      expect(prompt).toContain('Help synthetic users');
      const again = await buildIsolatedRefinement(f.options, { ...e, attemptId: 'attempt_2', attemptCount: 2 }, checkpoint);
      expect(again).toEqual(a);
      // Lose the CLI response after a real successful scanner-backed push.
      const other = { ...e, meetingId: 'booking:2026-10-03T18:04:11.512Z' };
      f.value.meeting.meetingId = other.meetingId; writeFileSync(f.state, JSON.stringify(f.value));
      const wrapper = join(f.room, 'lose-sync.mjs');
      writeFileSync(wrapper, `import { execFileSync } from 'node:child_process'; execFileSync(process.execPath, [${JSON.stringify(f.options.syncScript)}, ...process.argv.slice(2)], { stdio: 'pipe' }); process.exit(1);`);
      await expect(buildIsolatedRefinement({ ...f.options, syncScript: wrapper }, other, checkpoint)).rejects.toThrow('command failed');
      const recovered = await buildIsolatedRefinement(f.options, other, checkpoint);
      expect(f.git(f.remote, 'rev-parse', `refs/heads/${refinementArtifactTarget(other).branch}`)).toBe(recovered.gitRef);
      expect(f.git(join(f.options.workRoot, refinementArtifactTarget(other).key), 'rev-list', '--count', `${f.options.baseRef}..HEAD`)).toBe('1');
    } finally { f.dispose(); }
  });
  it.each(['tenant', 'content', 'feedback', 'current'])('refuses %s mismatch before writing evidence', async phase => {
    const f = fixture();
    try {
      if (phase === 'tenant') f.value.target.orgId = 'other_org';
      if (phase === 'content') f.value.markdown = 'changed';
      if (phase === 'feedback') f.value.meeting.feedbackSha256 = 'd'.repeat(64);
      if (phase === 'current') f.value.preparation.state = 'superseded';
      writeFileSync(f.state, JSON.stringify(f.value));
      await expect(buildIsolatedRefinement(f.options, e, async () => {})).rejects.toThrow('build refused');
      const t = refinementArtifactTarget(e);
      expect(f.git(join(f.options.workRoot, t.key), 'status', '--porcelain')).toBe('');
      expect(f.git(f.remote, 'show-ref', '--heads')).not.toContain(t.branch);
    } finally { f.dispose(); }
  });
  it('keeps local artifacts unpublished when the immediate pre-push checkpoint refuses', async () => {
    const f = fixture();
    try {
      let beats = 0;
      await expect(buildIsolatedRefinement(f.options, e, async () => { if (++beats === 2) throw new Error('revoked'); })).rejects.toThrow('revoked');
      expect(f.git(f.remote, 'show-ref', '--heads')).not.toContain(refinementArtifactTarget(e).branch);
      const recovered = await buildIsolatedRefinement(f.options, e, async () => {});
      expect(recovered.gitRef).toMatch(/^[a-f0-9]{40}$/);
    } finally { f.dispose(); }
  });
  it('refuses a foreign edit and scanner findings without publishing', async () => {
    const f = fixture();
    try {
      // Credential-shaped synthetic text intentionally exercises the scanner.
      f.value.markdown = markdown + 'ghp_' + 'A'.repeat(36);
      f.value.meeting.contentHash = sha(f.value.markdown);
      writeFileSync(f.state, JSON.stringify(f.value));
      const bad = { ...e, contentHash: f.value.meeting.contentHash };
      await expect(buildIsolatedRefinement(f.options, bad, async () => {})).rejects.toThrow('scanner refused');
      expect(f.git(f.remote, 'show-ref', '--heads')).not.toContain(refinementArtifactTarget(bad).branch);
      await expect(buildIsolatedRefinement(f.options, bad, async () => {})).rejects.toThrow('unfinished or foreign');
    } finally { f.dispose(); }
  });
});
