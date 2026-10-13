// H-1523: isolated exact-meeting artifacts. Not wired to the supervisor.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { PreparationRefused, validatePreparation, type PreparationEnvelope, type PreparationArtifact, type PreparationReceipt } from './refinement-preparation.js';

export interface IsolatedArtifactOptions {
  /** Registered Good Plumb source repository; its working files are never edited. */
  source: string;
  /** Operator-pinned accepted source snapshot, never a moving branch. */
  baseRef: string;
  /** Dedicated private working area, outside the source checkout. */
  workRoot: string;
  /** Existing company scanner-backed sync tool; not an alternate push route. */
  syncScript: string;
  scanScript: string;
  origin: string;
  /** Explicit child environment, e.g. own credential service names. No values in status. */
  env?: NodeJS.ProcessEnv;
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
class CommandFailed extends Error {
  constructor(readonly code: number | string | undefined) { super('Isolated refinement command failed; Builder must inspect this meeting.'); }
}

function command(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((accept, reject) => execFile(file, args, { cwd, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
    (error, out) => error ? reject(new CommandFailed(error.code)) : accept(out.trim())));
}

function regularArtifactPaths(checkout: string, paths: string[]) {
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const at = join(checkout, ...parts.slice(0, i));
      try {
        const stat = lstatSync(at);
        if (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile())) throw new PreparationRefused('artifact path contains a link or unexpected file type');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}

export function refinementArtifactTarget(raw: PreparationEnvelope) {
  const e = validatePreparation(raw);
  const meeting = e.meetingId.slice(8).replace(/[:.]/g, '-');
  // Attempt-independent: a lost push reuses the same exact meeting artifacts.
  const key = sha(JSON.stringify([e.orgId, e.projectId, e.orgSlug, e.projectSlug, e.meetingId, e.directiveVersionId, e.contentHash, e.feedbackSha256]));
  const target = `${e.orgSlug}/${e.projectSlug}/${meeting}`;
  return { key, target, branch: `refinement-preparation/${key}`,
    snapshot: `clients/${e.orgSlug}/projects/${e.projectSlug}/refinement/${meeting}/meeting.json`,
    prompt: `docs/voice/agent/refinement-prompts/${target}.md` };
}

// Execute the existing product readers/builders inside the real isolated
// checkout. No path/source override into the shared checkout. Only the two
// exact artifacts are written. Provider access is absent from this program.
const BUILD = String.raw`
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [raw, mode] = process.argv.slice(1);
const e = JSON.parse(raw), root = process.cwd();
class BuildRefused extends Error {}
try {
const load = p => import(pathToFileURL(resolve(root, p)).href);
const { api } = await load('booking/scripts/admin.mjs');
const { meetingName, feedbackSha256 } = await load('booking/src/server/refinement-feedback.js');
const { buildPrompt, readMeeting, promptPath } = await load('docs/voice/agent/build-refinement-prompt.mjs');
const { agentConfig, promptHash } = await load('docs/voice/agent/elevenlabs.mjs');
const target = e.orgSlug + '/' + e.projectSlug + '/' + meetingName(e.meetingId);
const file = resolve(root, 'clients', e.orgSlug, 'projects', e.projectSlug, 'refinement', meetingName(e.meetingId), 'meeting.json');
const fields = ['meetingId', 'directiveVersionId', 'contentHash', 'feedbackSha256'];
const live = await api('/api/admin/refinement-agent?org=' + encodeURIComponent(e.orgSlug) + '&project=' + encodeURIComponent(e.projectSlug) + '&meetingId=' + encodeURIComponent(e.meetingId));
if (live.target?.orgId !== e.orgId || live.target?.projectId !== e.projectId || live.target?.orgSlug !== e.orgSlug || live.target?.projectSlug !== e.projectSlug || live.preparation?.state !== 'current' || fields.some(k => live.meeting?.[k] !== e[k])) throw new BuildRefused();
if (!Number.isInteger(live.meeting.directiveVersion) || live.meeting.directiveVersion < 1) throw new BuildRefused();
if (typeof live.markdown !== 'string' || createHash('sha256').update(live.markdown).digest('hex') !== e.contentHash || !Array.isArray(live.meeting.feedback) || await feedbackSha256(live.meeting.feedback) !== e.feedbackSha256) throw new BuildRefused();
if (mode === 'build') {
  if (existsSync(file) || existsSync(promptPath(target))) throw new BuildRefused();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ meeting: live.meeting, markdown: live.markdown }, null, 2) + '\n');
}
const saved = await readMeeting(target);
if (fields.some(k => saved.meeting[k] !== e[k]) || saved.markdown !== live.markdown || JSON.stringify(saved.meeting.feedback) !== JSON.stringify(live.meeting.feedback)) throw new BuildRefused();
const prompt = await buildPrompt(target);
if (mode === 'build') { mkdirSync(dirname(promptPath(target)), { recursive: true }); writeFileSync(promptPath(target), prompt); }
else if (readFileSync(promptPath(target), 'utf8') !== prompt) throw new BuildRefused();
const config = agentConfig({ name: 'Good Plumb refinement — ' + target, prompt });
console.log(JSON.stringify({ promptHash: promptHash(config) }));
} catch (error) { process.exit(error instanceof BuildRefused ? 2 : 1); }
`;
const SCAN = `
import { pathToFileURL } from 'node:url';
const [module, repo, raw, message] = process.argv.slice(1);
const { scanCommitCandidate } = await import(pathToFileURL(module).href);
if (scanCommitCandidate(repo, JSON.parse(raw), { message }).length) process.exit(2);
`;

/** Concrete build callback. Private proposal only, never merges or edits the
 * shared working tree. Preserves an uncertain commit/push for reconciliation. */
export async function buildIsolatedRefinement(options: IsolatedArtifactOptions, raw: PreparationEnvelope,
  checkpoint: () => Promise<void>): Promise<PreparationArtifact> {
  const e = validatePreparation(raw), t = refinementArtifactTarget(e);
  if (![options.source, options.workRoot, options.syncScript, options.scanScript].every(isAbsolute)
    || !/^[0-9a-f]{40}$/.test(options.baseRef) || typeof checkpoint !== 'function') throw new PreparationRefused('invalid isolated artifact configuration');
  const url = new URL(options.origin);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new PreparationRefused('invalid artifact origin');
  const source = realpathSync(options.source);
  mkdirSync(options.workRoot, { recursive: true, mode: 0o700 });
  const workRoot = realpathSync(options.workRoot), checkout = join(workRoot, t.key);
  if (workRoot === source || workRoot.startsWith(source + '/')) throw new PreparationRefused('artifact working area must be outside source');
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0', PLUMB_URL: url.origin, GOODPLUMB_REPO: checkout };
  // Never inherit Git routing variables that could change the target/index.
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[k];
  const git = (cwd: string, ...args: string[]) => command('git', ['-C', cwd, ...args], cwd, env);
  if (realpathSync(await git(source, 'rev-parse', '--show-toplevel')) !== source) throw new PreparationRefused('artifact source is not a repository root');
  await git(source, 'cat-file', '-e', options.baseRef + '^{commit}');
  if (!existsSync(checkout)) {
    // A remotely retained branch is fetched before a fresh local registration.
    // Conflicting local branches or missing registered worktree directories
    // refuse through Git for Builder inspection; never prune/reset them here.
    const listed = await git(source, 'ls-remote', 'origin', `refs/heads/${t.branch}`);
    if (listed) {
      await git(source, 'fetch', '--quiet', 'origin', `refs/heads/${t.branch}:refs/remotes/origin/${t.branch}`);
      await git(source, 'worktree', 'add', '--quiet', '-b', t.branch, checkout, `refs/remotes/origin/${t.branch}`);
    } else await git(source, 'worktree', 'add', '--quiet', '-b', t.branch, checkout, options.baseRef);
  }
  if (realpathSync(checkout) !== resolve(checkout) || realpathSync(await git(checkout, 'rev-parse', '--show-toplevel')) !== checkout
    || await git(checkout, 'rev-parse', '--git-common-dir') !== await git(source, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    || await git(checkout, 'symbolic-ref', '--short', 'HEAD') !== t.branch) throw new PreparationRefused('isolated checkout identity differs');
  const tip = await git(checkout, 'rev-parse', 'HEAD');
  if (await git(checkout, 'status', '--porcelain')) throw new PreparationRefused('unfinished or foreign artifact edits require Builder inspection');
  regularArtifactPaths(checkout, [t.snapshot, t.prompt]);
  let hash: string;
  if (tip === options.baseRef) {
    // Remove the auto-created main upstream; supported sync publishes this
    // proposal only under its own name. No existing proposal upstream changes.
    const upstream = await git(checkout, 'config', '--get', `branch.${t.branch}.merge`).catch(() => '');
    if (upstream && upstream !== `refs/heads/${t.branch}`) await git(checkout, 'branch', '--unset-upstream');
    await checkpoint();
    try { hash = JSON.parse(await command(process.execPath, ['--input-type=module', '-e', BUILD, JSON.stringify(e), 'build'], checkout, env)).promptHash; }
    catch (error) { if (error instanceof CommandFailed && error.code === 2) throw new PreparationRefused('exact-current refinement build refused'); throw error; }
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new PreparationRefused('invalid built prompt hash');
    const message = `Prepare exact refinement meeting ${e.meetingId} (H-1523)\n\nMechanical proposal; no merge or client approval.\n`;
    try { await command(process.execPath, ['--input-type=module', '-e', SCAN, options.scanScript, checkout, JSON.stringify([t.snapshot, t.prompt]), message], checkout, env); }
    catch (error) { if (error instanceof CommandFailed && error.code === 2) throw new PreparationRefused('artifact candidate scanner refused; Builder must inspect this meeting'); throw error; }
    // Only these two paths; no other worker's files or credentials in a commit.
    await git(checkout, 'add', '--', t.snapshot, t.prompt);
    await git(checkout, 'commit', '--quiet', '-m', message, '--', t.snapshot, t.prompt);
  } else {
    const parents = (await git(checkout, 'rev-list', '--parents', '-n', '1', tip)).split(' ');
    const changed = (await git(checkout, 'diff-tree', '--no-commit-id', '--name-only', '-r', tip)).split('\n').sort();
    if (parents.length !== 2 || parents[1] !== options.baseRef || JSON.stringify(changed) !== JSON.stringify([t.snapshot, t.prompt].sort())) throw new PreparationRefused('proposal does not contain only exact artifacts on the pinned base');
    await checkpoint();
    try { hash = JSON.parse(await command(process.execPath, ['--input-type=module', '-e', BUILD, JSON.stringify(e), 'verify'], checkout, env)).promptHash; }
    catch (error) { if (error instanceof CommandFailed && error.code === 2) throw new PreparationRefused('retained refinement artifacts differ from current evidence'); throw error; }
  }
  const gitRef = await git(checkout, 'rev-parse', 'HEAD');
  await checkpoint();
  // This existing tool owns private visibility, object scan and non-forced
  // publication. Its stdout/receipt can contain private paths; never relay it.
  await command(process.execPath, [options.syncScript, checkout], checkout, env);
  const remote = (await git(checkout, 'ls-remote', 'origin', `refs/heads/${t.branch}`)).split(/\s/)[0];
  if (remote !== gitRef || await git(checkout, 'status', '--porcelain')) throw new PreparationRefused('artifact push did not verify exact clean remote tip');
  return { gitRef, promptHash: hash };
}


// The product module owns preflight, deterministic-name reconciliation and
// actual config readback. IPC carries only pins/receipts and checkpoint signals;
// no private prompt/provider body/credential is returned or logged.
const PROVIDER = String.raw`
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const [raw, artifact, phase] = process.argv.slice(1), e = JSON.parse(raw), a = JSON.parse(artifact);
const load = p => import(pathToFileURL(resolve(process.cwd(), p)).href);
process.on('disconnect', () => process.exit(1));
const checkpoint = () => new Promise((accept, reject) => {
  process.once('message', m => m?.type === 'continue' ? accept() : reject(new Error('checkpoint refused')));
  process.send({ type: 'checkpoint' });
});
try {
  const { buildPrompt, readMeeting, promptPath } = await load('docs/voice/agent/build-refinement-prompt.mjs');
  const { meetingName } = await load('booking/src/server/refinement-feedback.js');
  const { agentConfig, promptHash, api: vendor, agentsNamed } = await load('docs/voice/agent/elevenlabs.mjs');
  const { api } = await load('booking/scripts/admin.mjs');
  const { publishVerifiedRefinement, verifyRefinementProvider, RefinementProviderRefused } = await load('booking/scripts/refinement-provider-publication.mjs');
  const target = e.orgSlug + '/' + e.projectSlug + '/' + meetingName(e.meetingId);
  const snapshot = (await readMeeting(target)).meeting;
  if (['meetingId', 'directiveVersionId', 'contentHash', 'feedbackSha256'].some(k => snapshot[k] !== e[k])) throw new RefinementProviderRefused();
  const prompt = await buildPrompt(target);
  if (readFileSync(promptPath(target), 'utf8') !== prompt) throw new RefinementProviderRefused();
  const config = agentConfig({ name: 'Good Plumb refinement — ' + target, prompt });
  if (promptHash(config) !== a.promptHash) throw new RefinementProviderRefused();
  const result = phase === 'publish'
    ? await publishVerifiedRefinement({ org: e.orgSlug, project: e.projectSlug, snapshot, config, promptHash: a.promptHash, gitRef: a.gitRef, api, vendor, agentsNamed, checkpoint })
    : await verifyRefinementProvider({ vendor, config, agentId: a.agentId });
  process.send({ type: 'result', value: phase === 'publish' ? { agentId: result.agentId, gitRef: result.gitRef, promptHash: result.promptHash } : result }, () => process.exit(0));
} catch (error) {
  // Classify the product's permanent refusal, never export its raw diagnostic.
  const refused = error?.constructor?.name === 'RefinementProviderRefused';
  process.send({ type: 'failed', refused }, () => process.exit(1));
}
`;

async function providerChild(options: IsolatedArtifactOptions, raw: PreparationEnvelope, a: PreparationArtifact | PreparationReceipt,
  phase: 'publish' | 'verify', checkpoint?: () => Promise<void>): Promise<PreparationReceipt | boolean> {
  const e = validatePreparation(raw), t = refinementArtifactTarget(e);
  if (!/^[0-9a-f]{40}$/.test(a.gitRef) || !/^[0-9a-f]{64}$/.test(a.promptHash) ||
    (phase === 'verify' && !/^[A-Za-z0-9_-]{16,64}$/.test((a as PreparationReceipt).agentId))) throw new PreparationRefused('invalid provider artifact pins');
  const checkout = join(realpathSync(options.workRoot), t.key);
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0', PLUMB_URL: new URL(options.origin).origin, GOODPLUMB_REPO: checkout };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[k];
  const git = (...args: string[]) => command('git', ['-C', checkout, ...args], checkout, env);
  if (realpathSync(checkout) !== resolve(checkout) || await git('symbolic-ref', '--short', 'HEAD') !== t.branch ||
    await git('rev-parse', 'HEAD') !== a.gitRef || await git('status', '--porcelain') ||
    realpathSync(await git('rev-parse', '--show-toplevel')) !== checkout ||
    await git('rev-parse', '--git-common-dir') !== await command('git', ['-C', options.source, 'rev-parse', '--path-format=absolute', '--git-common-dir'], options.source, env)) {
    throw new PreparationRefused('provider checkout differs from exact retained artifact');
  }
  const parents = (await git('rev-list', '--parents', '-n', '1', a.gitRef)).split(' ');
  const changed = (await git('diff-tree', '--no-commit-id', '--name-only', '-r', a.gitRef)).split('\n').sort();
  if (parents.length !== 2 || parents[1] !== options.baseRef || JSON.stringify(changed) !== JSON.stringify([t.snapshot, t.prompt].sort())) throw new PreparationRefused('provider artifact tree differs');
  regularArtifactPaths(checkout, [t.snapshot, t.prompt]);
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', PROVIDER, JSON.stringify(e), JSON.stringify(a), phase],
      { cwd: checkout, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let settled = false, checking = false;
    const end = (error?: Error, value?: PreparationReceipt | boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill();
      error ? reject(error) : accept(value!);
    };
    const timer = setTimeout(() => end(new Error('Refinement provider child unavailable; Builder must inspect this meeting.')), 120_000);
    child.on('error', () => end(new Error('Refinement provider child unavailable.')));
    child.on('exit', () => end(new Error('Refinement provider child ended without a verified receipt.')));
    child.on('message', async (rawMessage) => {
      if (settled) return;
      const m = (rawMessage ?? {}) as { type?: string; value?: unknown; refused?: boolean };
      if (m.type === 'checkpoint' && phase === 'publish' && checkpoint && !checking) {
        checking = true;
        try { await checkpoint(); if (!settled) child.send({ type: 'continue' }); }
        catch (error) { end(error instanceof Error ? error : new Error('Refinement checkpoint unavailable.')); }
        finally { checking = false; }
      } else if (m.type === 'failed') {
        end(m.refused === true ? new PreparationRefused('Product refinement publication refused; Builder must inspect the exact meeting.') : new Error('Refinement provider operation did not verify; Builder must reconcile this meeting.'));
      } else if (m.type === 'result') {
        if (phase === 'verify' && typeof m.value === 'boolean') end(undefined, m.value);
        else if (phase === 'publish') {
          const r = m.value as PreparationReceipt;
          if (r?.gitRef === a.gitRef && r?.promptHash === a.promptHash && /^[A-Za-z0-9_-]{16,64}$/.test(r?.agentId)) end(undefined, { gitRef: r.gitRef, promptHash: r.promptHash, agentId: r.agentId });
          else end(new PreparationRefused('Product returned different refinement receipt pins.'));
        } else end(new PreparationRefused('Invalid refinement child receipt.'));
      } else end(new PreparationRefused('Invalid refinement child protocol.'));
    });
  });
}

/** Concrete callbacks for refinementPreparationPass. Still not wired: source
 * acceptance/upstream adoption and configured action scope precede use. */
export function isolatedRefinementCallbacks(options: IsolatedArtifactOptions) {
  return {
    build: (e: PreparationEnvelope, checkpoint: () => Promise<void>) => buildIsolatedRefinement(options, e, checkpoint),
    publish: (e: PreparationEnvelope, a: PreparationArtifact, checkpoint: () => Promise<void>) => providerChild(options, e, a, 'publish', checkpoint) as Promise<PreparationReceipt>,
    verify: (e: PreparationEnvelope, r: PreparationReceipt) => providerChild(options, e, r, 'verify') as Promise<boolean>,
  };
}
