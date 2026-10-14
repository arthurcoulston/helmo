import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './config.js';
import { target } from './install.js';
import { logEvent, occupiedPid, sGet, sHas, sPath, streakReset, withBlockedLock } from './sentinels.js';

export interface RuntimeRecoveryRequest {
  installation: string;
  worker: string;
  ticket: string;
  reason: string;
  at: string;
  sha256: string;
  expires_at: string;
}

export function blockDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validate(request: RuntimeRecoveryRequest, worker: string, now: number): void {
  if (!request || request.installation !== target().label || request.worker !== worker)
    throw new Error('runtime recovery installation/worker mismatch');
  if (!/^H-[1-9]\d*(?:@[a-zA-Z0-9._-]+)?$/.test(request.ticket ?? '') ||
      !/^runtime failed [1-9]\d* consecutive iterations \(cap \d+\)$/.test(request.reason ?? '') ||
      !Number.isFinite(Date.parse(request.at)) || !/^[a-f0-9]{64}$/.test(request.sha256 ?? ''))
    throw new Error('runtime recovery requires an exact runtime trip and work record');
  const expires = Date.parse(request.expires_at);
  if (!Number.isFinite(expires) || expires <= now || expires > now + 15 * 60_000)
    throw new Error('runtime recovery expiry must be within fifteen minutes');
}

function precondition(request: RuntimeRecoveryRequest, worker: string): void {
  const raw = sGet(worker, 'BLOCKED');
  if (raw === null || blockDigest(raw) !== request.sha256 ||
      raw !== `reason=${request.reason}\nat=${request.at}\n` || existsSync(sPath(worker, 'BLOCKED.json')))
    throw new Error('runtime trip changed, absent, or not a plain runtime failure');
  for (const control of ['STOP', 'HOLD', 'PACE', 'LIMIT'] as const)
    if (sHas(worker, control)) throw new Error(`independent ${control} prevents runtime recovery`);
  if (existsSync(sPath(worker, 'PACE.pending'))) throw new Error('PACE write in progress');
  if (occupiedPid(worker)) throw new Error('worker still occupied');
}

function decisionPath(worker: string, request: RuntimeRecoveryRequest): string {
  return join(stateDir(worker), `.runtime-recovery-${blockDigest(JSON.stringify(request))}.json`);
}

export function requestRuntimeRecovery(worker: string, request: RuntimeRecoveryRequest, by: string, now = Date.now()): void {
  validate(request, worker, now);
  withBlockedLock(worker, () => {
    precondition(request, worker);
    if (existsSync(decisionPath(worker, request))) throw new Error('runtime recovery request already consumed');
    // No replacement of a queued request, including a request whose reply was
    // lost. The supervisor owns consumption and its audit record.
    writeFileSync(join(stateDir(worker), 'RUNTIME_RECOVERY.json'), `${JSON.stringify(request)}\n`, { flag: 'wx' });
    logEvent(worker, 'runtime-recovery-request', `ticket=${request.ticket} sha256=${request.sha256} by=${by}`);
  });
}

/** Called only by the owning supervisor with no child. A request is consumed
 * once, before releasing state; failure never becomes an automatic retry. */
export function consumeRuntimeRecovery(worker: string, now = Date.now()): boolean {
  const queued = join(stateDir(worker), 'RUNTIME_RECOVERY.json');
  if (!existsSync(queued)) return false;
  return withBlockedLock(worker, () => {
    let request: RuntimeRecoveryRequest | undefined;
    let releaseApplied = false;
    const consumed = join(stateDir(worker), 'RUNTIME_RECOVERY.last.json');
    renameSync(queued, consumed);
    try {
      request = JSON.parse(readFileSync(consumed, 'utf8')) as RuntimeRecoveryRequest;
      if (existsSync(decisionPath(worker, request))) throw new Error('runtime recovery request already consumed');
      validate(request, worker, now);
      precondition(request, worker);
      // Record intent before clearing. If interrupted here the
      // old block remains; the consumed request cannot trigger a later retry.
      const intent = `${JSON.stringify({ request, decision: 'attempt', at: new Date(now).toISOString() })}\n`;
      writeFileSync(decisionPath(worker, request), intent, { flag: 'wx' });
      writeFileSync(consumed, intent);
      streakReset(worker, 'fail');
      rmSync(sPath(worker, 'BLOCKED'));
      releaseApplied = true;
      const decision = `${JSON.stringify({ request, decision: 'release', at: new Date(now).toISOString() })}\n`;
      writeFileSync(decisionPath(worker, request), decision);
      writeFileSync(consumed, decision);
      logEvent(worker, 'runtime-recovery-release', `ticket=${request.ticket} sha256=${request.sha256}`);
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const outcome = releaseApplied ? 'released-audit-incomplete' : 'refused';
      const decision = `${JSON.stringify({ request, decision: outcome, reason, at: new Date(now).toISOString() })}\n`;
      if (request && !existsSync(decisionPath(worker, request)))
        writeFileSync(decisionPath(worker, request), decision, { flag: 'wx' });
      writeFileSync(consumed, decision);
      logEvent(worker, releaseApplied ? 'runtime-recovery-audit-failed' : 'runtime-recovery-refused', reason);
      return releaseApplied;
    }
  });
}
