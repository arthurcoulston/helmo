// H-1523: the signed preparation protocol, independent of directive commits.
// Supervisor use requires explicit pinned isolated artifact configuration.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { atomicJson, keychainSecret, signedPost } from './intake-preparation.js';

import { refinementContext, sameRefinementContext, matchesClaimScope, type ContextOptions, type RefinementContext } from './refinement-context.js';

const BASE = '/api/refinement-preparation';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_REFUSALS = 5;

export interface PreparationEnvelope {
  identity: string; orgId: string; projectId: string; orgSlug: string; projectSlug: string;
  meetingId: string; directiveVersionId: string; contentHash: string; feedbackSha256: string;
  attemptId: string; attemptCount: number; leaseExpiresAt: string; providerPublicationDecisionRef: string;
}

/** Identifiers only; private words stay in the isolated artifact checkout. */
export interface PreparationArtifact { gitRef: string; promptHash: string }
export interface PreparationReceipt extends PreparationArtifact { agentId: string }
export class PreparationRefused extends Error {}
class Superseded extends Error {}
class Unavailable extends Error {}

export function validatePreparation(value: unknown): PreparationEnvelope {
  const e = value as Partial<PreparationEnvelope> | null;
  if (!e || ![e.identity, e.orgId, e.projectId, e.directiveVersionId, e.attemptId].every(v => typeof v === 'string' && ID.test(v))
    || !SLUG.test(e.orgSlug ?? '') || !SLUG.test(e.projectSlug ?? '')
    || typeof e.meetingId !== 'string' || !e.meetingId.startsWith('booking:') || !ISO.test(e.meetingId.slice(8))
    || !Number.isFinite(Date.parse(e.meetingId.slice(8)))
    || !HASH.test(e.contentHash ?? '') || !HASH.test(e.feedbackSha256 ?? '')
    || !Number.isInteger(e.attemptCount) || Number(e.attemptCount) < 1 || Number(e.attemptCount) > 5
    || !ISO.test(e.leaseExpiresAt ?? '') || !Number.isFinite(Date.parse(e.leaseExpiresAt ?? ''))
    || !/^H-[1-9][0-9]*@dev\.helmo\.gp$/.test(e.providerPublicationDecisionRef ?? '')) {
    throw new PreparationRefused('invalid exact-meeting preparation envelope');
  }
  // Return a whitelist: unexpected server fields never enter process state.
  return Object.fromEntries(['identity', 'orgId', 'projectId', 'orgSlug', 'projectSlug', 'meetingId',
    'directiveVersionId', 'contentHash', 'feedbackSha256', 'attemptId', 'attemptCount', 'leaseExpiresAt',
    'providerPublicationDecisionRef'].map(k => [k, e[k as keyof PreparationEnvelope]])) as unknown as PreparationEnvelope;
}

function artifact(value: PreparationArtifact): PreparationArtifact {
  if (!value || !COMMIT.test(value.gitRef) || !HASH.test(value.promptHash)) throw new PreparationRefused('invalid preparation artifact');
  return { gitRef: value.gitRef, promptHash: value.promptHash };
}
function receipt(value: PreparationReceipt): PreparationReceipt {
  if (!value || !/^[A-Za-z0-9_-]{16,64}$/.test(value.agentId)) throw new PreparationRefused('invalid preparation binding receipt');
  return { ...artifact(value), agentId: value.agentId };
}

interface Active {
  target: RefinementContext;
  envelope: PreparationEnvelope;
  artifact?: PreparationArtifact;
  receipt?: PreparationReceipt;
  verified?: boolean;
  refusals: number;
  failure?: { diagnostic: string; retryable: boolean };
}

export interface PreparationOptions extends ContextOptions {
  stateFile: string; lastRunFile?: string;
  /** Drain fence: false retains the durable attempt for restart, before any new effect. */
  shouldContinue?: () => boolean;
  secret?: () => string; request?: typeof fetch;
  /** Each implementation must use the checkpoint immediately before external
   * effects, including Git push, provider mutation and product binding. */
  build: (e: PreparationEnvelope, checkpoint: () => Promise<void>) => Promise<PreparationArtifact>;
  publish: (e: PreparationEnvelope, a: PreparationArtifact, checkpoint: () => Promise<void>) => Promise<PreparationReceipt>;
  /** Independent read of actual provider config. A stored binding is not proof.
   * Must be read-only; a mismatch stops this attempt, never mutates on retry. */
  verify: (e: PreparationEnvelope, r: PreparationReceipt) => Promise<boolean>;
}
export type PreparationPassResult = 'idle' | 'bound' | 'pending' | 'superseded' | 'failed';
// A state file is the installation's ownership unit. Independent disposable
// installations do not accidentally share a promise, while repeated polls do.
const running = new Map<string, { target: RefinementContext; pass: Promise<PreparationPassResult> }>();

export function refinementPreparationPass(options: PreparationOptions): Promise<PreparationPassResult> {
  let target: RefinementContext;
  try { target = refinementContext(options); }
  catch { return Promise.reject(new PreparationRefused('refinement preparation unavailable; invalid context')); }
  const current = running.get(options.stateFile);
  if (current) return sameRefinementContext(current.target, target) ? current.pass
    : Promise.reject(new PreparationRefused('refinement preparation unavailable; concurrent context differs'));
  // Snapshot mutable caller options before the first await.
  options = { ...options, ...target };
  const seen: { claim?: number } = {};
  const record = (result: PreparationPassResult | 'unknown') => {
    try {
      if (options.lastRunFile) atomicJson(options.lastRunFile, { at: new Date().toISOString(), pid: process.pid, result, ...seen, owner: 'builder' });
    } catch { /* observation failure cannot change delivery */ }
  };
  const pass = run(options, seen).then(result => { record(result); return result; }, () => {
    // Never persist a callback/provider error: it can contain client words or
    // credentials. Failed network responses are unknown, not successful work.
    record('unknown');
    throw new Unavailable('refinement preparation unavailable; retained attempt needs inspection');
  }).finally(() => { running.delete(options.stateFile); });
  running.set(options.stateFile, { target, pass });
  return pass;
}

async function run(options: PreparationOptions, seen: { claim?: number }): Promise<PreparationPassResult> {
  const continuing = () => { if (options.shouldContinue?.() === false) throw new Unavailable(); };
  continuing();
  // Bound signed network ambiguity so supervisor drain does not wait forever.
  const send = options.request ?? fetch;
  const request: typeof fetch = (input, init) => send(input, { ...init, signal: AbortSignal.timeout(30_000) });
  const target = refinementContext(options);
  const executor = { executorId: target.executorId, executorVersion: target.executorVersion };
  const secret = (options.secret ?? keychainSecret)();
  const post = (action: string, body: object) => signedPost(target.origin, action, { ...executor, ...body }, secret, request, BASE);
  const forget = () => rmSync(options.stateFile, { force: true });
  let active: Active;
  if (existsSync(options.stateFile)) {
    const saved = JSON.parse(readFileSync(options.stateFile, 'utf8')) as Active;
    if (!sameRefinementContext(saved.target, target)) {
      throw new PreparationRefused('saved attempt belongs to another refinement context');
    }
    active = { target, envelope: validatePreparation(saved.envelope), refusals: saved.refusals };
    if (!Number.isInteger(active.refusals) || active.refusals < 0 || active.refusals > MAX_REFUSALS) throw new PreparationRefused('invalid saved retry count');
    if (saved.artifact) active.artifact = artifact(saved.artifact);
    if (saved.receipt) active.receipt = receipt(saved.receipt);
    if (saved.verified === true && !active.receipt) throw new PreparationRefused('verified attempt has no receipt');
    active.verified = saved.verified === true;
    if (saved.failure) {
      // Only our closed diagnostics survive restart; never relay arbitrary text.
      if (!/^Preparation (build|publish|verify|result|envelope) failed; Builder must inspect the exact meeting\.$/.test(saved.failure.diagnostic)
        || typeof saved.failure.retryable !== 'boolean') throw new PreparationRefused('invalid saved failure');
      active.failure = saved.failure;
    }
    if (active.receipt && (!active.artifact || active.receipt.gitRef !== active.artifact.gitRef || active.receipt.promptHash !== active.artifact.promptHash)) {
      throw new PreparationRefused('saved receipt differs from artifact');
    }
  } else {
    const claimed = await post('claim', target.claimScope ? { claimScope: target.claimScope } : {});
    seen.claim = claimed.status;
    if (claimed.status === 204 || claimed.status === 409) return 'idle';
    if (!claimed.ok) throw new Unavailable();
    // Invalid envelopes are never allowed to invoke any artifact/provider work.
    active = { target, envelope: validatePreparation(await claimed.json()), refusals: 0 };
    if (!matchesClaimScope(target, active.envelope)) throw new PreparationRefused('claimed tenant differs from requested scope');
    atomicJson(options.stateFile, active);
  }
  const e = active.envelope;
  if (!matchesClaimScope(target, e)) throw new PreparationRefused('claimed or saved tenant differs from requested scope');
  const owned = { identity: e.identity, attemptId: e.attemptId };
  const save = () => atomicJson(options.stateFile, active);
  const checkpoint = async () => {
    continuing();
    const beat = await post('heartbeat', owned).catch(() => { throw new Unavailable(); });
    if (beat.status === 409) throw new Superseded();
    if (!beat.ok) throw new Unavailable();
    const body = await beat.json().catch(() => { throw new Unavailable(); }) as { leaseExpiresAt?: string };
    if (!ISO.test(body.leaseExpiresAt ?? '') || Date.parse(body.leaseExpiresAt ?? '') <= Date.now()) throw new Unavailable();
    continuing();
    e.leaseExpiresAt = body.leaseExpiresAt!;
    save();
  };
  const fail = async () => {
    continuing();
    const response = await post('failure', { ...owned, ...active.failure });
    if (response.ok || response.status === 409) { forget(); return response.ok ? 'failed' as const : 'superseded' as const; }
    return 'pending' as const;
  };
  const deliver = async (): Promise<PreparationPassResult> => {
    continuing();
    const response = await post('result', { ...owned, ...active.receipt });
    if (response.ok || response.status === 409) { forget(); return response.ok ? 'bound' : 'superseded'; }
    if (response.status === 422) {
      active.refusals++;
      if (active.refusals >= MAX_REFUSALS) active.failure = { diagnostic: 'Preparation result failed; Builder must inspect the exact meeting.', retryable: false };
      save();
      if (active.failure) return fail();
      try { await checkpoint(); } catch (error) {
        if (error instanceof Superseded) { forget(); return 'superseded'; }
        return 'pending';
      }
    }
    return 'pending';
  };
  // Reconcile acknowledged provider work/failure before starting anything else.
  // Exact bound result replay deliberately does not demand a live lease.
  if (active.failure) return fail();
  if (active.verified) return deliver();
  let stage: 'build' | 'publish' | 'verify' = 'build';
  try {
    await checkpoint();
    if (!active.artifact) {
      active.artifact = artifact(await options.build(Object.freeze({ ...e }), checkpoint));
      save();
    }
    stage = 'publish';
    await checkpoint();
    if (!active.receipt) {
      const bound = receipt(await options.publish(Object.freeze({ ...e }), Object.freeze({ ...active.artifact }), checkpoint));
      if (bound.gitRef !== active.artifact.gitRef || bound.promptHash !== active.artifact.promptHash) throw new PreparationRefused('publisher changed artifact pins');
      active.receipt = bound;
      save(); // A crash now resumes readback, never publication.
    }
    stage = 'verify';
    await checkpoint();
    if (!await options.verify(Object.freeze({ ...e }), Object.freeze({ ...active.receipt }))) throw new PreparationRefused('provider readback differs');
    active.verified = true;
    save();
  } catch (error) {
    if (error instanceof Superseded) { forget(); return 'superseded'; }
    if (error instanceof Unavailable) return 'pending';
    // A pipeline can have acted before it threw. Never immediately repeat it.
    // The Worker owns bounded retries after this durable failure is delivered.
    active.failure = { diagnostic: `Preparation ${stage} failed; Builder must inspect the exact meeting.`, retryable: !(error instanceof PreparationRefused) };
    save();
    return fail();
  }
  // A lost result response is delivery ambiguity, never a provider failure.
  return deliver();
}
