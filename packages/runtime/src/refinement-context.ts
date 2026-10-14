// H-1523: a caller's selection is not provider/publication authority.
export interface ClaimScope { orgId: string; projectId: string }
export interface RefinementContext {
  origin: string; executorId: string; executorVersion: string;
  claimScope?: ClaimScope; baseRef?: string;
}
export interface ContextOptions {
  origin: string; executorId?: string; executorVersion?: string;
  /** Exact selection only; it does not grant publication or provider authority. */
  claimScope?: ClaimScope;
  /** For commits: exact local commit parent. For preparation: callback artifact pin. */
  baseRef?: string;
}

export function refinementContext(options: ContextOptions): RefinementContext {
  const url = new URL(options.origin);
  const executorId = options.executorId ?? 'goodplumb-rev';
  const executorVersion = options.executorVersion ?? '1';
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || !/^[a-z0-9_-]{1,48}$/.test(executorId) || !/^[a-z0-9._-]{1,32}$/.test(executorVersion)) {
    throw new Error('invalid refinement origin or executor');
  }
  const scope = options.claimScope;
  if (scope !== undefined && (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || Object.keys(scope).sort().join(',') !== 'orgId,projectId'
    || ![scope.orgId, scope.projectId].every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)))) {
    throw new Error('invalid exact refinement claim scope');
  }
  if (options.baseRef !== undefined && (typeof options.baseRef !== 'string' || !/^[0-9a-f]{40}$/.test(options.baseRef))) throw new Error('invalid immutable refinement base');
  return Object.freeze({ origin: url.origin, executorId, executorVersion,
    ...(scope === undefined ? {} : { claimScope: Object.freeze({ orgId: scope.orgId, projectId: scope.projectId }) }),
    ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }) });
}

export function sameRefinementContext(saved: unknown, target: RefinementContext): boolean {
  try { return JSON.stringify(refinementContext(saved as ContextOptions)) === JSON.stringify(target); }
  catch { return false; }
}

export function matchesClaimScope(target: RefinementContext, envelope: { orgId?: unknown; projectId?: unknown }): boolean {
  return !target.claimScope || (envelope.orgId === target.claimScope.orgId && envelope.projectId === target.claimScope.projectId);
}
