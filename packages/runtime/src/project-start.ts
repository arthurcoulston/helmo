// Good Plumb's project-start handoff (H-2178). A client's approval of an exact
// directive version queues one project start, and the product tells them
// research is under way; this pass is what makes that true. Each pass reads the
// oldest start nobody has picked up, files one assignment for it to the
// configured research seat, and reports the assignment back so the product can
// say the team has it.
// Identifiers only: the directive's words stay in the client's folder.
import { existsSync, readFileSync } from 'node:fs';
import { atomicJson, keychainSecret, signedPost } from './intake-preparation.js';

const BASE = '/api/project-start';
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_REF = /^[0-9a-f]{7,40}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REF = /^H-[0-9]+@[a-z0-9][a-z0-9.-]{0,63}$/;
/** Filed starts remembered, so a lost `assigned` report never files twice. */
const KEPT = 50;

export interface ProjectStartEnvelope {
  startId: string; orgId: string; orgSlug: string; projectId: string; projectSlug: string;
  versionId: string; versionNumber: number; contentHash: string; gitRef: string; isTest: boolean;
  directivePath: string; approvedAt: string;
}

export function validateProjectStart(value: unknown): ProjectStartEnvelope {
  const e = value as Partial<ProjectStartEnvelope>;
  if (!e || typeof e.versionId !== 'string' || !e.versionId || e.startId !== `project-start:${e.versionId}`
      || typeof e.orgId !== 'string' || !e.orgId || typeof e.projectId !== 'string' || !e.projectId
      || !SLUG.test(e.orgSlug ?? '') || !SLUG.test(e.projectSlug ?? '')
      || !Number.isInteger(e.versionNumber) || Number(e.versionNumber) < 1
      || !SHA256.test(e.contentHash ?? '') || !GIT_REF.test(e.gitRef ?? '') || typeof e.isTest !== 'boolean'
      || typeof e.approvedAt !== 'string' || !e.approvedAt) {
    throw new Error('claim returned an invalid project-start envelope');
  }
  if (e.directivePath !== `clients/${e.orgSlug}/projects/${e.projectSlug}/directive.md`) {
    throw new Error('claim path is not the project directive');
  }
  return e as ProjectStartEnvelope;
}

/** What the research seat is told. No client words: where they are, which
 *  version was approved, where the first pass is named and what a new
 *  project's library needs before anything can publish. */
export function researchAssignmentBody(e: ProjectStartEnvelope): string {
  const library = `clients/${e.orgSlug}/projects/${e.projectSlug}/library/`;
  return (e.isTest ? 'TEST ORGANIZATION: not a real client. Keep the first pass to the smallest sample that proves the path.\n' : '')
    + `Project start ${e.startId}: the client approved directive version ${e.versionNumber} `
    + `of ${e.orgSlug}/${e.projectSlug} at ${e.approvedAt} (org ${e.orgId}, project ${e.projectId}, `
    + `version ${e.versionId}, content hash ${e.contentHash}).\n`
    + `The client has been told research is under way. Read the approved words at ${e.directivePath} in goodplumb `
    + `commit ${e.gitRef} (\`git show ${e.gitRef}:${e.directivePath}\`), not on main: a refinement revision is never merged `
    + `to main, so main's copy can be missing or older. Its sha256 must equal the content hash above.\n`
    + `First pass: the directive's section 7 names it. Plan it, assign the Researcher, and route accepted results to Editor.\n`
    + `Library prerequisites for a new project: accepted records publish from ${library} `
    + `(format: the library README in the same repository), and publishing refuses with policy.missing until `
    + `the project has an installed editorial policy. If either is missing, have Editor sign the project's policy and Builder `
    + `install it with booking/scripts/library-policy-install.ts before the first publish.\n`
    + `No client text belongs in this ticket.`;
}

export interface ProjectStartOptions {
  origin: string;
  /** Filed starts (start id → assignment ref), kept across restarts. */
  stateFile: string;
  /** Overwritten after every pass with its time and outcome, ids only. */
  lastRunFile?: string;
  executorId?: string; executorVersion?: string; secret?: () => string;
  request?: typeof fetch;
  assign: (body: string) => Promise<string> | string;
  now?: () => number;
}

export type ProjectStartResult = 'idle' | 'assigned' | 'reported' | 'failed';
interface Filed { startId: string; ref: string }
interface State { filed: Filed[] }

function readState(path: string): State {
  if (!existsSync(path)) return { filed: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as State;
}

async function refusal(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  const error = typeof body?.error === 'string' && /^[a-z][a-z ]{0,39}$/.test(body.error) ? `: ${body.error}` : '';
  return `${response.status}${error}`;
}

let running: Promise<ProjectStartResult> | null = null;

/** One bounded pass: hand at most one queued start to the research seat. */
export function projectStartPass(options: ProjectStartOptions): Promise<ProjectStartResult> {
  if (running) return running;
  running = runPass(options).finally(() => { running = null; });
  return running;
}

async function runPass(options: ProjectStartOptions): Promise<ProjectStartResult> {
  const request = options.request ?? fetch;
  const secret = (options.secret ?? keychainSecret)();
  const executor = { executorId: options.executorId ?? 'goodplumb-rev', executorVersion: options.executorVersion ?? '1' };
  const last = (result: ProjectStartResult, detail: Record<string, string> = {}) => {
    if (options.lastRunFile) atomicJson(options.lastRunFile, { at: new Date((options.now ?? Date.now)()).toISOString(), pid: process.pid, result, ...detail });
    return result;
  };
  const claimed = await signedPost(options.origin, 'claim', executor, secret, request, BASE);
  if (claimed.status === 204) return last('idle');
  if (!claimed.ok) throw new Error(`project-start claim refused (${await refusal(claimed)})`);
  const start = validateProjectStart(await claimed.json());
  const state = readState(options.stateFile);
  // Filed already and only the report was lost: report the same ticket again.
  let ref = state.filed.find((f) => f.startId === start.startId)?.ref;
  const fresh = !ref;
  if (!ref) {
    ref = await options.assign(researchAssignmentBody(start));
    if (!REF.test(ref)) throw new Error(`assignment ref ${ref.slice(0, 80)} is not an installation-qualified ticket`);
    atomicJson(options.stateFile, { filed: [...state.filed, { startId: start.startId, ref }].slice(-KEPT) });
  }
  const reported = await signedPost(options.origin, 'assigned', { ...executor, startId: start.startId, assignmentRef: ref }, secret, request, BASE);
  if (!reported.ok) {
    last('failed', { startId: start.startId, ref });
    throw new Error(`project-start ${start.startId} filed as ${ref}; report refused (${await refusal(reported)})`);
  }
  return last(fresh ? 'assigned' : 'reported', { startId: start.startId, ref });
}
