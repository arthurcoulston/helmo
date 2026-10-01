// The second write route on the dashboard: POST /acted records that the
// action the card was asking for has been carried out (R-42 I13).
//
// It is deliberately NOT a branch of POST /answer. Arthur's complaint was that
// he could not tell "decide this" from "please go and do this", and that an
// action came back through Ratify as though it were permission. Two endpoints
// with two payload shapes is what makes that mistake unrepresentable rather
// than merely discouraged: nothing this route accepts can carry an answer, a
// resolution or a chosen option, and nothing /answer accepts can report an
// action.
//
// The one thing a click can honestly say is "the request as drawn is done", so
// that is the only thing the payload says. It carries no free text — Ward's
// H-1053 boundary, kept by shape rather than by care — which means the stored
// report has to be written here. It says where the report came from and quotes
// what was asked, and it does not pretend Arthur described anything.
import { fail, refuseUnlessOperatorSameOrigin, AnswerContext, AnswerResult } from './answer.js';
import { actionFingerprint } from './presentation.js';
import { Actor, HelmoError } from './types.js';

export function actedRequest(
  headers: Record<string, string | string[] | undefined>,
  body: string,
  ctx: AnswerContext,
): AnswerResult {
  const refused = refuseUnlessOperatorSameOrigin(headers, ctx);
  if (refused) return refused;
  let p: { ticket_id?: unknown; done?: unknown; action_fingerprint?: unknown };
  try {
    p = JSON.parse(body) as typeof p;
  } catch {
    return fail(400, 'the report body is not JSON.');
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return fail(400, 'the report body must be a JSON object.');
  const allowed = new Set(['ticket_id', 'done', 'action_fingerprint']);
  if (Object.keys(p).some((key) => !allowed.has(key))) {
    return fail(400, 'this route records only that the action as drawn was carried out; free text, answers and resolution changes are refused.');
  }
  if (p.done !== true) return fail(400, 'send done: true — this route records that the action as drawn was carried out, and nothing else.');
  if (typeof p.ticket_id !== 'string' || !p.ticket_id.trim()) return fail(400, 'ticket_id is required.');
  if (typeof p.action_fingerprint !== 'string' || !p.action_fingerprint.trim()) {
    return fail(400, 'action_fingerprint is required — it says which action is being reported done.');
  }
  try {
    const pending = ctx.store.getTicket(p.ticket_id);
    // Named separately from "no action pending", because the two are different
    // mistakes and only one of them means the reader is on the wrong card.
    if (pending.question) {
      return fail(400, `${pending.id} is asking you to DECIDE something, not to do it — ratify it or choose one of its options instead.`);
    }
    if (!pending.action) return fail(400, `${pending.id} has no action waiting to be reported done.`);
    // Checked here for a plain message, and again inside the write
    // transaction, which is the check that actually holds (H-1053): consent
    // belongs to the request it was given for, never to the ticket id.
    if (actionFingerprint(pending.action) !== p.action_fingerprint) {
      return fail(409, 'the request on screen is not the one on the ticket now — reload and read it again.');
    }
    // Non-null by the gate above, which refuses every request when no
    // operator is configured.
    const actor: Actor = { name: ctx.operator!, kind: 'human', session: 'dashboard' };
    const t = ctx.store.reportAction(
      actor,
      p.ticket_id,
      { did: `Reported done from the dashboard, with no words added, against the request as asked: ${pending.action.action}` },
      p.action_fingerprint,
    );
    return { code: 200, body: { ok: true, id: t.id, status: t.status } };
  } catch (e) {
    return fail(e instanceof HelmoError ? 400 : 500, e instanceof Error ? e.message : String(e));
  }
}
