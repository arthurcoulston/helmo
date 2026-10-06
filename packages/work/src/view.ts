#!/usr/bin/env node
// The Helmo view: agent-written, human-read (H-2). One file, zero
// dependencies, no build step beyond tsc. The constitutional line, restated
// with Arthur in H-90: the page carries NO record data-entry — agents write
// the record — but ANSWERING an awaiting_human question is operator steering,
// and it is the one mutation this page may perform. The answer surface only
// exists when HELMO_OPERATOR names the human (deliberate config); every other
// element remains disclosure toggles and evidence hyperlinks.
import { randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { apiJson, JSON_HEADERS, uiRequest } from '@helmo/core';
import { actedRequest } from './acted.js';
import { answerRequest } from './answer.js';
import { loaded, running } from './build.js';
import { installationLine, requestedInstallation, requireInstallation } from './install.js';
import { actionFingerprint, ask, CLOSED_TAIL, recordTickets } from './presentation.js';
import { Store } from './store.js';
import { Ticket } from './types.js';

const install = requireInstallation(process.env, undefined, requestedInstallation(process.argv.slice(2)));
// Take the reading of what this process loaded NOW, before it serves anything:
// a first reading taken at the first request would describe whatever had
// replaced this code by then and call that running (H-2490).
loaded();
const dbPath = install.db;
const port = Number(process.env['HELMO_VIEW_PORT'] ?? 4400);
const host = process.env['HELMO_VIEW_HOST'] ?? '127.0.0.1';
const operator = process.env['HELMO_OPERATOR']?.trim() || null;
// Per-boot nonce the page carries and POST /answer must echo (H-145). NOT a
// wall against local agents — any same-user process can GET the page and read
// it. It turns a forged approval from one innocuous curl into a deliberate
// read-then-impersonate, which is the kind of act the constitution and
// injection defences catch. Friction, not a gate; keep the comment honest.
const answerNonce = randomBytes(16).toString('hex');
const sameOrigin = new Set<string>();
const store = new Store(dbPath, install);

/** True while the ticket's own date gate is still shut (H-732). */
function gated(t: Ticket): boolean {
  return !!t.not_before && t.not_before > new Date().toISOString();
}

/** True while a deliberate capacity hold still forbids starting this work
 *  (H-2321). The store's queue and claim path read a hold exactly this way:
 *  only a bounded release that has not expired lifts it. Reading it any other
 *  way here put held work under Ready, and the operator read the gap between
 *  page and queue as a fleet ignoring its backlog. */
function held(t: Ticket): boolean {
  const hold = t.capacity_hold;
  if (!hold) return false;
  return !hold.release || hold.release.until <= new Date().toISOString();
}

/** True while something stands in front of this work right now — a prerequisite
 *  that has not finished, a date that has not arrived, a hold that has not
 *  lifted. The operator reads this backlog to choose what he can usefully do
 *  now, so the current impediment is the primary status and anything the work
 *  needs from him AFTER it clears is secondary (H-202). Before that, a ticket
 *  blocked on another ticket still sat in "Awaiting you" on the strength of a
 *  sitting it could not reach, and he could not tell it from work he could
 *  actually pick up. */
function impeded(t: Ticket): boolean {
  return store.isBlocked(t.id) || gated(t) || held(t) || (t.release_handoff?.current === false && !t.needs_human);
}

function actionableSitting(t: Ticket): boolean {
  return t.needs_human;
}

/** The awaiting-you family, split by what each row actually holds.
 *
 *  Factored out when the shadcn application started drawing these cards
 *  (H-2936): the split is the part that is easy to get subtly wrong — an
 *  action-pending ticket leaves `question` null on purpose, and a sitting is
 *  open work the operator cannot reach rather than work awaiting him — so one
 *  function feeds both renderings. Two copies would eventually disagree about
 *  which card a ticket is, and the control on the card is what differs. */
function awaitingFamily(all: Ticket[]): { decisions: Ticket[]; actions: Ticket[]; sittings: Ticket[] } {
  const awaiting = all.filter((t) => t.status === 'awaiting_human');
  const live = all.filter((t) => t.status === 'open' && !t.schedule);
  return {
    actions: awaiting.filter((t) => t.action),
    decisions: awaiting.filter((t) => !t.action),
    sittings: live.filter((t) => actionableSitting(t) && !impeded(t)),
  };
}

function blockedBy(t: Ticket): string[] {
  return store
    .getDeps(t.id)
    .outgoing.filter((d) => d.type === 'blocks')
    .map((d) => d.to_id)
    .filter((id) => {
      try {
        const b = store.getTicket(id);
        return b.status !== 'done' && b.status !== 'cancelled';
      } catch {
        return false;
      }
    });
}

export function workHealth() {
  return { installation: store.installationIdentity(), store: dbPath };
}

/** The awaiting-you family as JSON, for the application that draws these
 *  cards (H-2936).
 *
 *  The fields a reader could compute for itself are left to it; the three the
 *  browser must NOT compute are here:
 *
 *  - The FINGERPRINT. It is the consent token the write routes check inside
 *    their transaction (H-1053), and its canonical form lives in exactly one
 *    place. A browser that rebuilt it would be a second implementation of a
 *    security boundary, drifting silently until a stale question answered as
 *    a fresh one.
 *  - The LETTERS. Arthur says "b" in a meeting and whoever relays it may be
 *    reading the phone queue rather than this page (H-939), so one function
 *    letters every surface.
 *  - WHICH KIND of card a row is, from `awaitingFamily`.
 *
 *  `token` is the per-boot answer nonce (H-145). Carrying it in this document
 *  rather than in the page is what the standard upstream application needs —
 *  its document is a built file with nothing of ours injected into it — and it
 *  costs the gate nothing: this server sends no access-control headers, so a
 *  cross-origin page can post the request but can never read the reply, and
 *  the nonce stays unreadable to exactly the callers it was keeping out. */
function awaitingDocument() {
  const all = recordTickets(store.listTickets({ limit: -1 }));
  const { decisions, actions, sittings } = awaitingFamily(all);
  const common = (t: Ticket) => ({
    id: t.id,
    title: t.title,
    workstream: t.workstream,
    project: t.project ?? null,
    priority: t.priority,
    blast_radius: t.blast_radius ?? null,
    updated_at: t.updated_at,
  });
  return {
    // Null says answering is off, which is the difference between a card with
    // controls and a card to read. The name is what the page says it answers
    // as, so a reader can see whose decision it is about to record.
    operator,
    token: answerNonce,
    decisions: decisions.map((t) => {
      const a = t.question ? ask(t.question) : null;
      // Awaiting with neither a decision nor an action: nothing legal writes
      // it, an imported row can carry it, and the page it is drawn nowhere on
      // is the one failure the operator cannot recover from (see
      // `unreadableCard`). Said out loud here too.
      if (!a) return { ...common(t), unreadable: true as const };
      return {
        ...common(t),
        fingerprint: a.fingerprint,
        question: a.question,
        recommendation: a.recommendation,
        situation: a.situation,
        ...(a.options ? { options: a.options } : {}),
        ...(a.if_unanswered ? { if_unanswered: a.if_unanswered } : {}),
      };
    }),
    actions: actions.map((t) => {
      const r = t.action!;
      return {
        ...common(t),
        fingerprint: actionFingerprint(r),
        action: r.action,
        why_human: r.why_human,
        situation: r.situation,
        ...(r.if_unanswered ? { if_unanswered: r.if_unanswered } : {}),
      };
    }),
    // No fingerprint and no token use: a sitting carries no control, because
    // the response to a sitting happens in the sitting and a button here would
    // be a way to report one without having had it.
    sittings: sittings.map((t) => {
      const release = t.release_handoff?.current ? t.release_handoff : null;
      return {
        ...common(t),
        release: Boolean(release),
        sitting: release?.decision ?? t.sitting ?? null,
        sitting_with: release?.sitting_with ?? t.sitting_with ?? null,
        ...(release ? { why_human: release.why_human } : {}),
        waits_on: blockedBy(t),
      };
    }),
  };
}

export function workSnapshot(options: { whole?: boolean; ticket?: string } = {}) {
  const complete = store.listTickets({ limit: -1 });
  const selected = recordTickets(complete, options.whole);
  const pinned = options.ticket && complete.find((t) => t.id === options.ticket);
  if (pinned && !selected.some((t) => t.id === pinned.id)) selected.push(pinned);
  const progress = store.latestProgress(selected.filter((t) => !['done', 'cancelled'].includes(t.status)).map((t) => t.id));
  const group = (t: Ticket) => {
    if (t.status === 'awaiting_human') return 'awaiting';
    if (t.status === 'in_progress') return 'motion';
    if (t.status !== 'open') return t.status;
    if (t.schedule) return 'standing';
    if (impeded(t)) return 'blocked';
    if (actionableSitting(t)) return 'awaiting';
    return 'ready';
  };
  return {
    installation: store.installationIdentity(),
    records: complete,
    running: running(),
    awaiting: awaitingDocument(),
    record: {
      whole: Boolean(options.whole),
      closed_tail: CLOSED_TAIL,
      total: complete.length,
      hygiene: store.hygiene(),
      rows: selected.map((t) => {
        const acceptance = store.productAcceptance(t.id);
        return { ...t, display: {
          group: group(t), waits_on: blockedBy(t), gated: gated(t), held: held(t),
          acceptance: { state: acceptance.state, reason: acceptance.reason },
          progress: progress.get(t.id) ?? null,
          chain: ['done', 'cancelled'].includes(t.status) ? store.agentChain(t.id) : [],
        } };
      }),
    },
  };
}

export function workRequest(req: IncomingMessage, res: ServerResponse) {
  const apiUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (apiUrl.pathname === '/api/v1/work') {
    res.writeHead(200, JSON_HEADERS);
    res.end(apiJson('work', workSnapshot({ whole: apiUrl.searchParams.get('whole') === '1', ticket: apiUrl.searchParams.get('ticket') ?? undefined })));
    return;
  }
  const detail = /^\/api\/v1\/work\/tickets\/(H-\d+)$/.exec(apiUrl.pathname);
  if (detail && req.method === 'GET') {
    try {
      const ticket = store.getTicket(detail[1]!);
      res.writeHead(200, JSON_HEADERS);
      res.end(apiJson('work', { ticket, deps: store.getDeps(ticket.id), events: store.getEvents(ticket.id) }));
    } catch {
      res.writeHead(404, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'Ticket not found' }));
    }
    return;
  }
  // Two write routes now, and they stay two. A decision is answered; an
  // action is reported done. Collapsing them into one endpoint that branches
  // on its payload would put the free-text capability Ward removed (H-1053)
  // back within reach of whichever branch was written less carefully.
  if (req.method === 'POST' && (req.url === '/answer' || req.url === '/acted')) {
    const route = req.url === '/acted' ? actedRequest : answerRequest;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const out = route(req.headers, body, { operator, nonce: answerNonce, sameOrigin, store });
      res.writeHead(out.code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
    return;
  }
  if (uiRequest(req, res, { areas: ['work'], defaultArea: 'work' })) return;
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Unknown Work route.');
}

export function workListening(boundPort: number) {
  sameOrigin.add(`http://127.0.0.1:${boundPort}`);
  sameOrigin.add(`http://localhost:${boundPort}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
const server = createServer(workRequest);
server.listen(port, host, () => {
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  sameOrigin.add(`http://127.0.0.1:${boundPort}`);
  sameOrigin.add(`http://localhost:${boundPort}`);
  process.send?.({ type: 'helmo-view-ready', port: boundPort });
  console.log(`Helmo view: http://localhost:${boundPort} — ${installationLine(install, store.installationIdentity())}${operator ? ` — answers enabled for ${operator}` : ' (read-only; set HELMO_OPERATOR to answer)'}`);
});
}
