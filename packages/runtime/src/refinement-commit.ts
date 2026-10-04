// Good Plumb's refinement commit executor (H-800). The Worker publishes a
// drafted directive revision only under a commit proven to hold its exact
// words, and holds no Git write credential itself (H-550), so this pass puts
// the words on the job's own branch, pushes it and returns the Git objects.
// Mechanical by design: the words are fixed, so no session is spent on them.
// Nothing touches the checkout's working tree — the commit is built from
// objects and a private index on top of origin/main.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, keychainSecret, signedPost } from './intake-preparation.js';

const BASE = '/api/refinement-commit';
const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMIT = /^[0-9a-f]{40}$/;
/** Consecutive 422s on one pushed commit before the attempt is handed back. */
export const MAX_REFUSALS = 5;

export interface RefinementEnvelope {
  identity: string; version: number; attemptId: string; leaseExpiresAt: string; attemptCount: number;
  orgSlug: string; projectSlug: string; meetingId: string; baseVersionId: string;
  path: string; branch: string; markdown: string; markdownSha256: string; changeSummary: string;
}

/** What survives a pass: identifiers and the pushed commit, never the words. */
interface Pending {
  identity: string; version: number; attemptId: string;
  path: string; commit: string; markdownSha256: string; refusals: number;
}

/** A claim this executor must never commit; reported as not retryable. */
class Refused extends Error {}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function validateRefinement(value: unknown): RefinementEnvelope {
  const e = value as Partial<RefinementEnvelope>;
  if (!e || typeof e.identity !== 'string' || !e.identity || !Number.isInteger(e.version) || Number(e.version) < 1
      || typeof e.attemptId !== 'string' || !e.attemptId || !SLUG.test(e.orgSlug ?? '') || !SLUG.test(e.projectSlug ?? '')
      || typeof e.meetingId !== 'string' || typeof e.markdown !== 'string' || !e.markdown
      || !SHA256.test(e.markdownSha256 ?? '') || typeof e.changeSummary !== 'string') {
    throw new Refused('claim returned an invalid refinement-commit envelope');
  }
  if (e.path !== `clients/${e.orgSlug}/projects/${e.projectSlug}/directive.md`) {
    throw new Refused('claim path is not the project directive');
  }
  // Only the job's own proposal branch; main and every other ref are out of reach.
  const own = `refinement/${e.orgSlug}/${e.projectSlug}/`;
  const leaf = e.branch?.startsWith(own) ? e.branch.slice(own.length) : '';
  if (!/^[A-Za-z0-9._-]+-v[0-9]+$/.test(leaf) || leaf.startsWith('.') || leaf.includes('..') || leaf.endsWith('.lock')) {
    throw new Refused('claim branch is not this job\'s proposal branch');
  }
  if (sha256(e.markdown) !== e.markdownSha256) throw new Refused('claim markdown does not match markdownSha256');
  return e as RefinementEnvelope;
}

function git(checkout: string, args: string[], options: { input?: string | Buffer; env?: NodeJS.ProcessEnv } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', checkout, ...args], {
      encoding: 'buffer', env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: '0' }, timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      reject(new Error(`git ${args[0]} failed: ${stderr.toString().trim() || error.message}`));
    });
    child.stdin?.end(options.input ?? '');
  });
}

const text = async (checkout: string, args: string[], options?: Parameters<typeof git>[2]) =>
  (await git(checkout, args, options)).toString('utf8').trim();

async function blobSha256(checkout: string, commit: string, path: string): Promise<string> {
  return sha256(await git(checkout, ['cat-file', 'blob', `${commit}:${path}`]));
}

/** The tree of `base` with only `path` set to `blob`, built in a private index. */
async function treeWith(checkout: string, base: string, blob: string, path: string): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), 'rev-refinement-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
    await git(checkout, ['read-tree', base], { env });
    await git(checkout, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
    return await text(checkout, ['write-tree'], { env });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Put the exact words on the job's branch and push it; returns the commit. Never forces. */
export async function commitRefinement(checkout: string, e: RefinementEnvelope): Promise<string> {
  await git(checkout, ['fetch', '--quiet', 'origin', 'refs/heads/main:refs/remotes/origin/main']);
  const base = await text(checkout, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
  const blob = await text(checkout, ['hash-object', '-w', '--no-filters', '--stdin'], { input: Buffer.from(e.markdown, 'utf8') });
  // A pushed branch from an earlier attempt is reused only if it is exactly one
  // commit on main's history that changes nothing but these words: descent alone
  // would still let a matching-named branch carry unrelated files into the proof.
  const listed = await text(checkout, ['ls-remote', 'origin', `refs/heads/${e.branch}`]);
  if (listed) {
    const existing = listed.split(/\s/)[0]!;
    await git(checkout, ['fetch', '--quiet', '--no-write-fetch-head', 'origin', `refs/heads/${e.branch}`]);
    const [, ...parents] = (await text(checkout, ['rev-list', '--parents', '-n', '1', existing])).split(' ');
    const parent = parents.length === 1 ? parents[0]! : '';
    const onMain = parent && await git(checkout, ['merge-base', '--is-ancestor', parent, base]).then(() => true, () => false);
    if (!onMain || await text(checkout, ['rev-parse', `${existing}^{tree}`]) !== await treeWith(checkout, parent, blob, e.path)) {
      throw new Refused('the proposal branch already holds something other than these words on main');
    }
    return existing;
  }
  const tree = await treeWith(checkout, base, blob, e.path);
  const summary = e.changeSummary.trim().slice(0, 2000);
  const message = `Propose the ${e.orgSlug}/${e.projectSlug} directive revision from meeting ${e.meetingId}\n\n`
    + (summary ? `${summary}\n\n` : '')
    + `Refinement job ${e.identity} version ${e.version}, attempt ${e.attemptId}; revises directive version ${e.baseVersionId}.\n`
    + 'Committed mechanically by the Rev supervisor (H-800); the branch is the proposal and is never merged here.\n';
  const commit = await text(checkout, ['commit-tree', tree, '-p', base, '-F', '-'], { input: message });
  if (await blobSha256(checkout, commit, e.path) !== e.markdownSha256) throw new Refused('the built commit does not hold the claimed words');
  await git(checkout, ['push', '--quiet', 'origin', `${commit}:refs/heads/${e.branch}`]);
  return commit;
}

/** The Worker's proof: the raw commit, the directive blob and every tree on its path. */
export async function refinementProof(checkout: string, commit: string, path: string) {
  if (!COMMIT.test(commit)) throw new Error('refinement proof needs a full lowercase commit');
  const parts = path.split('/').slice(0, -1);
  const trees: Record<string, string> = {};
  for (const dir of ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))]) {
    const oid = await text(checkout, ['rev-parse', dir ? `${commit}:${dir}` : `${commit}^{tree}`]);
    trees[oid] = (await git(checkout, ['cat-file', 'tree', oid])).toString('base64');
  }
  return {
    commit: (await git(checkout, ['cat-file', 'commit', commit])).toString('base64'),
    directive: (await git(checkout, ['cat-file', 'blob', `${commit}:${path}`])).toString('base64'),
    trees,
  };
}

export interface RefinementCommitOptions {
  origin: string; checkout: string; stateFile: string;
  executorId?: string; executorVersion?: string; secret?: () => string;
  request?: typeof fetch;
}

export type RefinementPassResult = 'idle' | 'committed' | 'pending' | 'superseded' | 'failed';
let running: Promise<RefinementPassResult> | null = null;

/** One bounded pass: deliver an owned pushed commit, or claim, commit and deliver one job. */
export function refinementCommitPass(options: RefinementCommitOptions): Promise<RefinementPassResult> {
  if (running) return running;
  running = runPass(options).finally(() => { running = null; });
  return running;
}

async function runPass(options: RefinementCommitOptions): Promise<RefinementPassResult> {
  const request = options.request ?? fetch;
  const secret = (options.secret ?? keychainSecret)();
  const executor = { executorId: options.executorId ?? 'goodplumb-rev', executorVersion: options.executorVersion ?? '1' };
  const post = (action: string, body: object) => signedPost(options.origin, action, { ...executor, ...body }, secret, request, BASE);

  if (existsSync(options.stateFile)) {
    return deliver(options, post, JSON.parse(readFileSync(options.stateFile, 'utf8')) as Pending);
  }
  const claimed = await post('claim', {});
  if (claimed.status === 204 || claimed.status === 409) return 'idle';
  if (!claimed.ok) throw new Error(`refinement claim refused (${claimed.status})`);
  const candidate = await claimed.json() as Partial<RefinementEnvelope>;
  let pending: Pending;
  try {
    const e = validateRefinement(candidate);
    const commit = await commitRefinement(options.checkout, e);
    pending = { identity: e.identity, version: e.version, attemptId: e.attemptId, path: e.path, commit, markdownSha256: e.markdownSha256, refusals: 0 };
  } catch (error) {
    if (candidate?.identity && Number.isInteger(candidate.version) && candidate.attemptId) {
      await post('failure', { identity: candidate.identity, version: candidate.version, attemptId: candidate.attemptId,
        diagnostic: String(error).replace(/\s+/g, ' ').slice(0, 240), retryable: !(error instanceof Refused) });
    }
    return 'failed';
  }
  // Recorded before delivery, so a crash between push and result loses nothing.
  atomicJson(options.stateFile, pending);
  return deliver(options, post, pending);
}

async function deliver(options: RefinementCommitOptions, post: (action: string, body: object) => Promise<Response>,
  pending: Pending): Promise<RefinementPassResult> {
  const owned = { identity: pending.identity, version: pending.version, attemptId: pending.attemptId };
  const response = await post('result', { ...owned, artifactRef: `goodplumb@${pending.commit}`, markdownSha256: pending.markdownSha256,
    artifactProof: await refinementProof(options.checkout, pending.commit, pending.path) });
  if (response.ok || response.status === 409) {
    rmSync(options.stateFile, { force: true });
    return response.ok ? 'committed' : 'superseded';
  }
  if (response.status !== 422) throw new Error(`refinement result refused (${response.status})`);
  // A just-pushed branch can be briefly unreachable to the Worker's resolver;
  // keep the lease and retry, then hand the attempt back for a fresh one.
  if (pending.refusals + 1 >= MAX_REFUSALS) {
    await post('failure', { ...owned, diagnostic: `result refused ${MAX_REFUSALS} times for goodplumb@${pending.commit}`, retryable: true });
    rmSync(options.stateFile, { force: true });
    return 'failed';
  }
  atomicJson(options.stateFile, { ...pending, refusals: pending.refusals + 1 });
  const beat = await post('heartbeat', owned);
  if (beat.status === 409) { rmSync(options.stateFile, { force: true }); return 'superseded'; }
  return 'pending';
}
