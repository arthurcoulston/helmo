// Good Plumb's opt-in intake-preparation pull adapter (H-539).
// The capability is deliberately read from Keychain, never roster, argv or env.
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const SERVICE = 'plumb-intake-executor-secret';
const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface IntakeEnvelope {
  identity: string; version: number; orgId: string; projectId: string;
  orgSlug: string; projectSlug: string; bookingId: string; scheduledStart: string;
  signupDocument: string; signupSha256: string; attemptId: string;
  leaseExpiresAt: string; attemptCount: number;
}

interface Active extends Omit<IntakeEnvelope, 'signupDocument'> { ticketId: string }
export interface IntakeResult {
  artifactRef: string; signupSha256: string; promptSha256: string;
  artifactProof: { commit: string; signup: string; prompt: string; trees: Record<string, string> };
}

export function keychainSecret(): string {
  return execFileSync('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-w'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function validateEnvelope(value: unknown): IntakeEnvelope {
  const e = value as Partial<IntakeEnvelope>;
  if (!e || !SHA256.test(e.identity ?? '') || !Number.isInteger(e.version) || Number(e.version) < 1
      || !e.orgId || !e.projectId || !SLUG.test(e.orgSlug ?? '') || !SLUG.test(e.projectSlug ?? '')
      || !e.bookingId || !e.scheduledStart || typeof e.signupDocument !== 'string'
      || !SHA256.test(e.signupSha256 ?? '') || !e.attemptId || !e.leaseExpiresAt) {
    throw new Error('claim returned an invalid intake-preparation envelope');
  }
  const identity = sha256([e.orgId, e.projectId, e.bookingId, e.scheduledStart].join('\0'));
  if (identity !== e.identity) throw new Error('claim identity does not bind the supplied organization, project, booking and occurrence');
  if (sha256(e.signupDocument) !== e.signupSha256) throw new Error('claim signup document does not match signupSha256');
  return e as IntakeEnvelope;
}

async function signedPost(origin: string, action: string, body: object, secret: string, request: typeof fetch): Promise<Response> {
  const path = `/api/intake-preparation/${action}`;
  const raw = JSON.stringify(body);
  const timestamp = Date.now();
  const nonce = randomBytes(18).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(['POST', path, timestamp, nonce, sha256(raw)].join('\n')).digest('hex');
  return request(new URL(path, origin), { method: 'POST', body: raw, headers: {
    'content-type': 'application/json', 'x-gp-timestamp': String(timestamp),
    'x-gp-nonce': nonce, 'x-gp-signature': signature,
  } });
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const next = `${path}.${process.pid}.tmp`;
  writeFileSync(next, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(next, path);
}

function scopedPath(root: string, ...parts: string[]): string {
  const path = resolve(root, ...parts);
  const base = `${resolve(root)}${sep}`;
  if (!path.startsWith(base)) throw new Error('claimed slugs escape the Good Plumb checkout');
  return path;
}

export interface IntakeExecutorOptions {
  origin: string; checkout: string; stateFile: string; resultFile: string;
  executorId?: string; executorVersion?: string; secret?: () => string;
  request?: typeof fetch;
  assign: (body: string) => Promise<string> | string;
  assignmentStatus: (ticketId: string) => Promise<string> | string;
}

type PassResult = 'idle' | 'claimed' | 'heartbeat' | 'completed' | 'superseded' | 'abandoned' | 'failed';
let running: Promise<PassResult> | null = null;

/** One bounded scheduling pass: reconcile an owned attempt, or claim one job. */
export function intakePreparationPass(options: IntakeExecutorOptions): Promise<PassResult> {
  if (running) return running;
  running = runPass(options).finally(() => { running = null; });
  return running;
}

// What a later assignment of the same occurrence must be told (H-654): the
// Worker hands a live lease back to its owner, so an abandoned attempt returns
// as a new ticket, and without this it reads as fresh preparation work.
interface Abandoned { identity: string; attemptId: string; ticketId: string; artifactRef?: string; refused?: string }
const KEPT_ABANDONED = 20;

function abandonedFile(stateFile: string): string {
  return join(dirname(stateFile), 'intake-preparation-abandoned.json');
}

function readAbandoned(stateFile: string): Abandoned[] {
  try { return JSON.parse(readFileSync(abandonedFile(stateFile), 'utf8')) as Abandoned[]; } catch { return []; }
}

// The Worker's error is a closed set of short phrases; anything else is not printed.
async function refusalReason(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  const error = typeof body?.error === 'string' && /^[a-z][a-z ]{0,39}$/.test(body.error) ? `: ${body.error}` : '';
  return `${response.status}${error}`;
}

function priorAttempts(stateFile: string, envelope: IntakeEnvelope): string {
  const prior = readAbandoned(stateFile).filter((a) => a.identity === envelope.identity);
  const lines = prior.map((a) => `${a.attemptId === envelope.attemptId ? 'This same attempt' : `Earlier attempt ${a.attemptId}`} `
    + `was assigned to ${a.ticketId} and abandoned when that ticket closed`
    + (a.artifactRef ? `; its result ${a.artifactRef} was ${a.refused ? `refused (${a.refused})` : 'never delivered'}` : ' without a result')
    + '.');
  if (prior.some((a) => a.artifactRef)) lines.push('Do not prepare again: fix what the refusal names, or rerun gp-rev intake result with the existing commit.');
  else if (envelope.attemptCount > 1) lines.push(`This is attempt ${envelope.attemptCount} of this preparation.`);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

async function runPass(options: IntakeExecutorOptions): Promise<PassResult> {
  const request = options.request ?? fetch;
  const secret = (options.secret ?? keychainSecret)();
  const executor = { executorId: options.executorId ?? 'goodplumb-rev', executorVersion: options.executorVersion ?? '1' };
  let active: Active | null = null;
  if (existsSync(options.stateFile)) active = JSON.parse(readFileSync(options.stateFile, 'utf8')) as Active;
  if (active) {
    const owned = { ...executor, identity: active.identity, version: active.version, attemptId: active.attemptId };
    const forget = () => { rmSync(options.stateFile, { force: true }); rmSync(options.resultFile, { force: true }); };
    const abandon = (artifactRef?: string, refused?: string): PassResult => {
      const entry: Abandoned = { identity: active!.identity, attemptId: active!.attemptId, ticketId: active!.ticketId, artifactRef, refused };
      atomicJson(abandonedFile(options.stateFile), [...readAbandoned(options.stateFile), entry].slice(-KEPT_ABANDONED));
      forget();
      return 'abandoned';
    };
    const assignmentOpen = async () => ['open', 'in_progress'].includes(await options.assignmentStatus(active!.ticketId));
    // A staged result is delivered whatever the ticket's status (H-654): staging
    // then closing is the Builder's ordinary sequence, and the close can land
    // before this poll does.
    if (existsSync(options.resultFile)) {
      const result = JSON.parse(readFileSync(options.resultFile, 'utf8')) as IntakeResult;
      const response = await signedPost(options.origin, 'result', { ...owned, ...result }, secret, request);
      if (response.ok) { forget(); return 'completed'; }
      if (response.status === 409) { forget(); return 'superseded'; }
      const reason = await refusalReason(response);
      if (!await assignmentOpen()) return abandon(result.artifactRef, reason);
      // Nobody can repair the result once the lease lapses, so keep it while
      // the ticket is open and say why it was refused (H-655).
      const heartbeat = await signedPost(options.origin, 'heartbeat', owned, secret, request);
      if (heartbeat.status === 409) { forget(); return 'superseded'; }
      throw new Error(`intake result ${result.artifactRef} refused (${reason}); `
        + (heartbeat.ok ? 'lease renewed, result kept for retry' : `heartbeat also refused (${await refusalReason(heartbeat)})`));
    }
    if (!await assignmentOpen()) return abandon();
    const response = await signedPost(options.origin, 'heartbeat', owned, secret, request);
    if (response.ok) return 'heartbeat';
    if (response.status === 409) { rmSync(options.stateFile, { force: true }); return 'superseded'; }
    throw new Error(`intake heartbeat refused (${await refusalReason(response)})`);
  }

  const claimed = await signedPost(options.origin, 'claim', executor, secret, request);
  if (claimed.status === 204 || claimed.status === 409) return 'idle';
  if (!claimed.ok) throw new Error(`intake claim refused (${claimed.status})`);
  let envelope: IntakeEnvelope | undefined;
  let candidate: Partial<IntakeEnvelope> | undefined;
  try {
    candidate = await claimed.json() as Partial<IntakeEnvelope>;
    envelope = validateEnvelope(candidate);
    const signup = scopedPath(options.checkout, 'clients', envelope.orgSlug, 'signup.md');
    mkdirSync(dirname(signup), { recursive: true });
    writeFileSync(signup, envelope.signupDocument, { mode: 0o600 });
    const body = `Intake preparation ${envelope.identity} version ${envelope.version}, attempt ${envelope.attemptId}.\n`
      + `Verified signup ${envelope.signupSha256} is at clients/${envelope.orgSlug}/signup.md for project ${envelope.projectSlug} and booking ${envelope.bookingId}.\n`
      + priorAttempts(options.stateFile, envelope)
      + `Prepare and push the project artifacts, then run gp-rev intake result goodplumb@<40-hex-commit>; the supervisor delivers a staged result even after this ticket closes. No client text belongs in this ticket.`;
    const ticketId = await options.assign(body);
    const { signupDocument: _private, ...kept } = envelope;
    atomicJson(options.stateFile, { ...kept, ticketId });
    return 'claimed';
  } catch (error) {
    const held = envelope ?? candidate;
    if (held?.identity && Number.isInteger(held.version) && held.attemptId) {
      const owned = { ...executor, identity: held.identity, version: held.version, attemptId: held.attemptId };
      await signedPost(options.origin, 'failure', { ...owned, kind: 'invariant', diagnostic: String(error).slice(0, 240) }, secret, request);
    }
    return 'failed';
  }
}

/** The Builder writes this after producing a pushed, repository-reachable candidate. */
export function recordIntakeResult(resultFile: string, result: IntakeResult): void {
  if (!/^goodplumb@[0-9a-f]{40}$/.test(result.artifactRef) || !SHA256.test(result.signupSha256) || !SHA256.test(result.promptSha256)) {
    throw new Error('intake result needs an exact goodplumb commit and lowercase SHA-256 evidence');
  }
  atomicJson(resultFile, result);
}

function git(checkout: string, args: string[], binary = false): string | Buffer {
  return execFileSync('git', ['-C', checkout, ...args], binary ? { encoding: 'buffer' } : { encoding: 'utf8' });
}

/** Build the exact Git object proof required by the Worker from a pushed commit. */
export function buildIntakeResult(checkout: string, stateFile: string, artifactRef: string): IntakeResult {
  const active = JSON.parse(readFileSync(stateFile, 'utf8')) as Active;
  if (!/^goodplumb@([0-9a-f]{40})$/.test(artifactRef)) throw new Error('artifact ref must be goodplumb@ plus a full lowercase commit');
  const commit = artifactRef.slice('goodplumb@'.length);
  const signupPath = `clients/${active.orgSlug}/signup.md`;
  const promptPath = `docs/voice/agent/prompts/${active.orgSlug}/${active.projectSlug}.md`;
  const blob = (path: string) => {
    const oid = String(git(checkout, ['rev-parse', `${commit}:${path}`])).trim();
    return git(checkout, ['cat-file', 'blob', oid], true) as Buffer;
  };
  const signup = blob(signupPath);
  const prompt = blob(promptPath);
  if (sha256(signup) !== active.signupSha256) throw new Error('pushed commit does not contain the claimed signup bytes');
  const trees: Record<string, string> = {};
  const dirs = new Set(['', ...[signupPath, promptPath].flatMap((path) => {
    const parts = path.split('/').slice(0, -1);
    return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  })]);
  for (const dir of dirs) {
    const oid = String(git(checkout, ['rev-parse', dir ? `${commit}:${dir}` : `${commit}^{tree}`])).trim();
    trees[oid] = (git(checkout, ['cat-file', 'tree', oid], true) as Buffer).toString('base64');
  }
  return {
    artifactRef, signupSha256: active.signupSha256, promptSha256: sha256(prompt),
    artifactProof: {
      commit: (git(checkout, ['cat-file', 'commit', commit], true) as Buffer).toString('base64'),
      signup: signup.toString('base64'), prompt: prompt.toString('base64'), trees,
    },
  };
}
