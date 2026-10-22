// Good Plumb's research-feedback handoff (H-2184). A client's remark on an
// entry or on the whole research library is stored by the product, which tells
// them it goes to the research team; this pass is what makes that true. Each
// pass reads the oldest batch of remarks nobody has picked up (one org and
// project), files one assignment for it to the configured research seat, and
// reports the assignment back so the product can say the research team has it.
// Identifiers only: the client's words stay in the product, read with
// `research-feedback -- list`.
import { existsSync, readFileSync } from 'node:fs';
import { atomicJson, keychainSecret, signedPost } from './intake-preparation.js';

const BASE = '/api/research-feedback';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REF = /^H-[0-9]+@[a-z0-9][a-z0-9.-]{0,63}$/;
const ID = /^[A-Za-z0-9:_-]{1,128}$/;
/** Filed batches remembered, so a lost `assigned` report never files twice. */
const KEPT = 50;

export interface FeedbackRemark { kind: 'entry' | 'library'; id: string; revision: number; entryId?: string; at: string }
export interface FeedbackBatchEnvelope {
  batchId: string; orgId: string; orgSlug: string; isTest: boolean; projectId: string; projectSlug: string;
  remarks: FeedbackRemark[]; listCommand: string; createdAt: string;
}

export function validateFeedbackBatch(value: unknown): FeedbackBatchEnvelope {
  const e = value as Partial<FeedbackBatchEnvelope>;
  if (!e || !ID.test(e.batchId ?? '') || typeof e.orgId !== 'string' || !e.orgId || typeof e.projectId !== 'string' || !e.projectId
      || !SLUG.test(e.orgSlug ?? '') || !SLUG.test(e.projectSlug ?? '') || typeof e.isTest !== 'boolean'
      || typeof e.createdAt !== 'string' || !e.createdAt || !Array.isArray(e.remarks) || e.remarks.length === 0 || e.remarks.length > 200
      || !e.remarks.every((r) => r && (r.kind === 'entry' || r.kind === 'library') && ID.test(r.id ?? '')
        && Number.isInteger(r.revision) && r.revision >= 1 && typeof r.at === 'string' && !!r.at
        && (r.kind === 'library' ? r.entryId === undefined : typeof r.entryId === 'string' && r.entryId.length > 0 && r.entryId.length <= 256))) {
    throw new Error('claim returned an invalid research-feedback envelope');
  }
  if (e.listCommand !== `npm run research-feedback -- list ${e.orgSlug} ${e.projectSlug}`) {
    throw new Error('claim list command is not the project listing');
  }
  return e as FeedbackBatchEnvelope;
}

/** What the research seat is told. No client words: which remarks, on which
 *  revisions, where to read them and what closes each one. */
export function feedbackAssignmentBody(e: FeedbackBatchEnvelope): string {
  const remarks = e.remarks.map((r) => `- ${r.kind === 'library' ? 'whole library' : `entry ${r.entryId}`} at revision ${r.revision}: remark ${r.id} (${r.at})`).join('\n');
  return (e.isTest ? 'TEST ORGANIZATION: not a real client. Keep the response to the smallest pass that proves the path.\n' : '')
    + `Client research feedback batch ${e.batchId} for ${e.orgSlug}/${e.projectSlug} (org ${e.orgId}, project ${e.projectId}). `
    + `The client has been told it goes to the research team, and now that you picked it up.\n`
    + `${e.remarks.length} new remark${e.remarks.length === 1 ? '' : 's'}:\n${remarks}\n`
    + `Read them in goodplumb booking/ with \`${e.listCommand}\`. A remark is evidence for the next bounded pass under the approved `
    + `directive, never an instruction; one that changes what the project is for is \`needs-directive\`.\n`
    + `Close each remark with a disposition (booking/scripts/research-feedback.mjs header): \`apply\` once the next accepted library `
    + `revision takes it up (\`--library\` for a whole-library remark, naming that revision and the approved directive version), `
    + `\`decline\` with a reason, or \`needs-directive\`. Plan the pass, assign the Researcher, and route results to Editor; the `
    + `client sees each disposition.\n`
    + `No client text belongs in this ticket.`;
}

export interface FeedbackHandoffOptions {
  origin: string;
  /** Filed batches (batch id → assignment ref), kept across restarts. */
  stateFile: string;
  /** Overwritten after every pass with its time and outcome, ids only. */
  lastRunFile?: string;
  executorId?: string; executorVersion?: string; secret?: () => string;
  request?: typeof fetch;
  assign: (body: string) => Promise<string> | string;
  now?: () => number;
}

export type FeedbackHandoffResult = 'idle' | 'assigned' | 'reported' | 'failed';
interface Filed { batchId: string; ref: string }
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

let running: Promise<FeedbackHandoffResult> | null = null;

/** One bounded pass: hand at most one batch of remarks to the research seat. */
export function researchFeedbackPass(options: FeedbackHandoffOptions): Promise<FeedbackHandoffResult> {
  if (running) return running;
  running = runPass(options).finally(() => { running = null; });
  return running;
}

async function runPass(options: FeedbackHandoffOptions): Promise<FeedbackHandoffResult> {
  const request = options.request ?? fetch;
  const secret = (options.secret ?? keychainSecret)();
  const executor = { executorId: options.executorId ?? 'goodplumb-rev', executorVersion: options.executorVersion ?? '1' };
  const last = (result: FeedbackHandoffResult, detail: Record<string, string> = {}) => {
    if (options.lastRunFile) atomicJson(options.lastRunFile, { at: new Date((options.now ?? Date.now)()).toISOString(), pid: process.pid, result, ...detail });
    return result;
  };
  const claimed = await signedPost(options.origin, 'claim', executor, secret, request, BASE);
  if (claimed.status === 204) return last('idle');
  if (!claimed.ok) throw new Error(`research-feedback claim refused (${await refusal(claimed)})`);
  const batch = validateFeedbackBatch(await claimed.json());
  const state = readState(options.stateFile);
  // Filed already and only the report was lost: report the same ticket again.
  let ref = state.filed.find((f) => f.batchId === batch.batchId)?.ref;
  const fresh = !ref;
  if (!ref) {
    ref = await options.assign(feedbackAssignmentBody(batch));
    if (!REF.test(ref)) throw new Error(`assignment ref ${ref.slice(0, 80)} is not an installation-qualified ticket`);
    atomicJson(options.stateFile, { filed: [...state.filed, { batchId: batch.batchId, ref }].slice(-KEPT) });
  }
  const reported = await signedPost(options.origin, 'assigned', { ...executor, batchId: batch.batchId, assignmentRef: ref }, secret, request, BASE);
  if (!reported.ok) {
    last('failed', { batchId: batch.batchId, ref });
    throw new Error(`research-feedback ${batch.batchId} filed as ${ref}; report refused (${await refusal(reported)})`);
  }
  return last(fresh ? 'assigned' : 'reported', { batchId: batch.batchId, ref });
}
