// The one write route (H-90), on its own so it can be tested: POST /answer
// ratifies the recommendation on a pending question and does nothing else.
//
// It used to also accept a free-text payload — a reasoning field and a
// resume/done/cancelled select, from the form the dashboard used to draw.
// Ward's review of the estate's remote path (H-1053) named that capability
// the defect: the form was gone from the page, but the ROUTE could still
// record arbitrary answers and close or cancel tickets as Arthur, now from
// anywhere the shell is reachable. Disagreement is a meeting, by Arthur's own
// account of how he works, so the route says the one thing the button says.
import { questionFingerprint } from './feed.js';
import { Store } from './store.js';
import { Actor, HelmoError } from './types.js';

export const ANSWER_HEADER = 'x-helmo-answer';

export interface AnswerContext {
  /** The human this dashboard answers as; null disables the route entirely. */
  operator: string | null;
  /** The per-boot nonce the page carries (H-145). */
  nonce: string;
  /** Origins this server is reachable at, for the belt-and-braces check. */
  sameOrigin: Set<string>;
  store: Store;
}

export interface AnswerResult {
  code: number;
  body: Record<string, unknown>;
}

/** Decide what POST /answer does with one request. Pure apart from the store
 *  write, so the refusals can be tested without a socket. */
export function answerRequest(
  headers: Record<string, string | string[] | undefined>,
  body: string,
  ctx: AnswerContext,
): AnswerResult {
  const fail = (code: number, error: string): AnswerResult => ({ code, body: { error } });
  if (!ctx.operator) return fail(403, 'No operator configured: set HELMO_OPERATOR to enable answering from the dashboard.');
  // Browser CSRF gate (H-145). A cross-origin page can send a "simple" POST
  // without preflight; a custom header and a JSON content-type both force a
  // preflight, which this server never answers — so the browser never sends
  // it. Origin is checked when present as belt-and-braces.
  const h = (k: string) => (Array.isArray(headers[k]) ? headers[k]![0] : headers[k]) ?? '';
  if (!h('content-type').toLowerCase().startsWith('application/json')) return fail(403, 'answers must be application/json');
  if (h('origin') && !ctx.sameOrigin.has(h('origin'))) return fail(403, 'cross-origin answer refused');
  if (h('sec-fetch-site') && h('sec-fetch-site') !== 'same-origin' && h('sec-fetch-site') !== 'none') return fail(403, 'cross-site answer refused');
  if (h(ANSWER_HEADER) !== ctx.nonce) return fail(403, 'missing or stale answer token — reload the dashboard');
  let p: { ticket_id?: unknown; ratify?: unknown; question_fingerprint?: unknown };
  try {
    p = JSON.parse(body) as typeof p;
  } catch {
    return fail(400, 'the answer body is not JSON.');
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return fail(400, 'the answer body must be a JSON object.');
  if (p.ratify !== true) return fail(400, 'this route only ratifies a recommendation: send {ticket_id, ratify: true, question_fingerprint}.');
  if (typeof p.ticket_id !== 'string' || !p.ticket_id.trim()) return fail(400, 'ticket_id is required.');
  if (typeof p.question_fingerprint !== 'string' || !p.question_fingerprint.trim()) {
    return fail(400, 'question_fingerprint is required — it says which question is being ratified.');
  }
  try {
    const pending = ctx.store.getTicket(p.ticket_id);
    const recommendation = pending.question?.recommendation?.trim();
    if (!recommendation) return fail(400, 'the ticket has no pending recommendation to ratify.');
    // Checked here for a plain message, and again inside the write
    // transaction, which is the check that actually holds (H-1053).
    if (questionFingerprint(pending.question!) !== p.question_fingerprint) {
      return fail(409, 'the question on screen is not the one on the ticket now — reload and read it again.');
    }
    const actor: Actor = { name: ctx.operator, kind: 'human', session: 'dashboard' };
    const t = ctx.store.answerTicket(
      actor,
      p.ticket_id,
      { answer: 'Ratified from the dashboard', chosen_option: recommendation, resolution: 'resume' },
      p.question_fingerprint,
    );
    return { code: 200, body: { ok: true, id: t.id, status: t.status } };
  } catch (e) {
    return fail(e instanceof HelmoError ? 400 : 500, e instanceof Error ? e.message : String(e));
  }
}
