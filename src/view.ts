#!/usr/bin/env node
// The Helmo view: agent-written, human-read (H-2). One file, zero
// dependencies, no build step beyond tsc. The constitutional line, restated
// with Arthur in H-90: the page carries NO record data-entry — agents write
// the record — but ANSWERING an awaiting_human question is operator steering,
// and it is the one mutation this page may perform. The answer surface only
// exists when HELMO_OPERATOR names the human (deliberate config); every other
// element remains disclosure toggles and evidence hyperlinks.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { ANSWER_HEADER, answerRequest } from './answer.js';
import { ESTATE_AVATARS } from './estate-avatars.generated.js';
import { installationLine, requestedInstallation, requireInstallation } from './install.js';
import { ask, CLOSED_TAIL, markFor, recordTickets } from './presentation.js';
import { ESTATE_TOKENS } from './estate-tokens.generated.js';
import { Store } from './store.js';
import { HygieneFinding } from './store.js';
import { Actor, ActorKind, HelmoError, Ticket, HelmoEvent, TicketProgress } from './types.js';

const install = requireInstallation(process.env, undefined, requestedInstallation(process.argv.slice(2)));
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

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

// ---------- small renderers ----------

/** A reference the operator might carry into a conversation, drawn with the
 *  one control that copies it. Arthur asked for copy icons "across the
 *  harness beside things he might take into an agent conversation" (H-2364),
 *  and the reference IS how he carries a record there — so every visible ID
 *  on this page comes from here, which is what makes "it can always be
 *  copied" a property of the code rather than a habit.
 *
 *  What lands on the clipboard is `id` and nothing else: it comes off
 *  `data-copy`, never off the rendered text, so an ellipsis, a badge or a
 *  future prefix beside it cannot end up in what he pastes.
 *
 *  `href` is for the few references that are also links. The control is the
 *  link's SIBLING, never inside it — nesting a button in an anchor makes one
 *  gesture ambiguous between navigating and copying. The same rule binds every
 *  CALLER: what this returns must never be placed inside another interactive
 *  element, which is why the ticket rows spell their disclosure as a button
 *  beside it rather than as a <summary> around it (H-2447). */
function ref(id: string, href?: string): string {
  const shown = href === undefined ? esc(id) : `<a href="${esc(href)}">${esc(id)}</a>`;
  return `<span class="tid">${shown}<button type="button" class="copy" data-copy="${esc(id)}" aria-label="Copy ${esc(id)}" title="Copy ${esc(id)}">⧉</button></span>`;
}

/** A title, drawn so a long one scans like a short one.
 *
 *  Every title in this store is already plain human language — the create
 *  contract asks for it and writers comply. Measured over 400 of them (H-2476),
 *  not one needed translating; what they need is length. Median 78 characters,
 *  p90 112, max 145, all painted at a single weight, so scanning a queue means
 *  reading a paragraph per row instead of a handle per row.
 *
 *  Nearly half already carry the handle their writer intended, ahead of a `: `
 *  or an em dash. This draws that lead at the title's weight and the remainder
 *  quieter. That is why I4 needed no stored human-summary field: the summary
 *  was in the title all along and was being thrown away at paint. A second
 *  stored field would have added one more thing to write and two titles that
 *  can disagree.
 *
 *  What renders is byte-identical to what is stored — the separator is kept
 *  and nothing is clipped, elided or reordered — so selection, find-in-page
 *  and a screen reader still get the whole title, and a title with no break
 *  renders exactly as it did. The lead is capped at 48 characters so a split
 *  only ever promotes a short handle, never the first half of a sentence, and
 *  the remainder must be substantial enough to be worth quieting.
 *
 *  Only the colon and the two dashes are separators: they are what this store
 *  actually uses (171 colons, 17 em dashes, no other form in 400). A spaced
 *  hyphen is left out deliberately — nothing here writes one, and a stray
 *  hyphen splitting a title is worse than a long title rendered flat.
 *
 *  Both spans are inert. They sit inside the row's existing `.rtoggle` button,
 *  so this adds nothing interactive and cannot bring back `nested-interactive`
 *  (H-2447). */
const TITLE_BREAK = /^(.{4,48}?)(: | — | – )(.{12,})$/;

function title(text: string, cls: string): string {
  const m = TITLE_BREAK.exec(text);
  if (!m) return `<span class="${cls}">${esc(text)}</span>`;
  return `<span class="${cls}">${esc(m[1])}<span class="tdetail">${esc(m[2] + m[3])}</span></span>`;
}


function rel(iso: string): string {
  // A timestamp this cannot parse is a corrupt record, not a reason to take
  // the dashboard down. H-446 carried a Unix epoch float where every other row
  // has an ISO string, and toISOString() threw on it — which crashed the view
  // on every request until the row was noticed (H-448).
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return `bad timestamp (${String(iso).slice(0, 24)})`;
  const ms = Date.now() - t;
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d}d ago` : new Date(t).toISOString().slice(0, 10);
}

function money(t: Ticket): string {
  if (!t.tokens_total && !t.cost_usd_total) return '';
  const tok = t.tokens_total ? `${(t.tokens_total / 1000).toFixed(1)}k tok` : '';
  const usd = t.cost_usd_total ? `$${t.cost_usd_total.toFixed(2)}` : '';
  return `<span class="spend">${[tok, usd].filter(Boolean).join(' · ')}</span>`;
}

// Status colors never travel alone: every badge carries its own text label.
function blastBadge(t: Ticket): string {
  if (t.blast_radius === 'none') return '';
  const cls = { draft: 'neutral', records: 'warning', sent: 'serious', published: 'critical' }[t.blast_radius];
  return `<span class="badge ${cls}" title="How far this work has reached into the world">◆ ${t.blast_radius}</span>`;
}

function confBadge(t: Ticket): string {
  if (!t.confidence || t.status !== 'done') return '';
  if (t.confidence === 'routine') return '';
  const cls = t.confidence === 'needs_review' ? 'serious' : 'warning';
  const label = t.confidence === 'needs_review' ? 'needs review' : 'spot-check';
  return `<span class="badge ${cls}">✱ ${label}</span>`;
}

function prioBadge(t: Ticket): string {
  if (t.priority === 0) return '<span class="badge critical">▲ P0</span>';
  if (t.priority === 1) return '<span class="badge accent">▲ P1</span>';
  if (t.priority === 3) return '<span class="badge quiet">P3</span>';
  return '';
}

function acceptanceBadge(t: Ticket): string {
  const acceptance = store.productAcceptance(t.id);
  if (acceptance.state === 'not_requested') return '';
  const cls = acceptance.state === 'accepted' ? 'accent' : acceptance.state === 'failed' ? 'critical' : 'warning';
  // Reviewers disagreeing is not reviewers agreeing it failed. Neither ships,
  // so the state is the same; the badge says which, because disagreement is
  // the expensive signal and a shared label would lose it (VERDICT-SET-CONTRACT §2.3).
  const label = acceptance.state === 'accepted' ? 'accepted'
    : acceptance.reason === 'contested' ? 'acceptance contested'
    : acceptance.state === 'failed' ? 'acceptance failed' : 'acceptance pending';
  const mark = acceptance.state === 'accepted' ? '✓' : acceptance.state === 'failed' ? '✕' : '◌';
  return `<span class="badge ${cls}" title="${esc(acceptance.reason.replaceAll('_', ' '))}">${mark} ${label}</span>`;
}

function deviceLocalUrl(ref: string): boolean {
  try {
    const host = new URL(ref).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function evidenceLinks(t: Ticket): string {
  const results = t.evidence.filter((e) => e.kind === 'url');
  const review = t.evidence.filter((e) => e.kind !== 'url');
  const acceptance = store.productAcceptance(t.id);
  const release = acceptance.state === 'accepted' ? 'Accepted for release'
    : acceptance.state === 'failed' ? 'Release review failed'
    : acceptance.state === 'pending' ? 'Release review pending'
    : 'Release review not requested';
  const resultLinks = results.map((e, i) => {
    const local = deviceLocalUrl(e.ref);
    const attrs = local
      ? `data-device-local="${esc(e.ref)}" aria-disabled="true"`
      : `href="${esc(e.ref)}"`;
    const label = local ? 'Result available on the estate machine' : (i === 0 ? 'View result' : 'View another result');
    return `<a class="result-action${i === 0 ? ' primary' : ''}" ${attrs} title="${esc(e.ref)}">${label}</a>${e.note ? `<span class="result-note">${esc(e.note)}</span>` : ''}`;
  }).join('');
  const reviewLinks = review.map((e) => {
    const label = `${esc(e.kind)}${e.note ? `: ${esc(e.note)}` : `: ${esc(e.ref.length > 46 ? e.ref.slice(0, 46) + '…' : e.ref)}`}`;
    return `<span class="ev" title="${esc(e.ref)}">${label}</span>`;
  }).join('');
  return `<section class="result-group" aria-label="Product result">
      <span class="evidence-label">Product result</span>
      ${resultLinks || '<span class="result-missing">No product result linked</span>'}
    </section>
    <section class="result-group" aria-label="Review evidence">
      <span class="evidence-label">Review evidence</span>
      ${reviewLinks || '<span class="result-missing">No review evidence linked</span>'}
    </section>
    <section class="result-group" aria-label="Release state">
      <span class="evidence-label">Release state</span><span class="release-state">${release}</span>
    </section>`;
}

// ---------- actors ----------

// Kinds read from the record, rebuilt once per page render. Module-level for
// the same reason `store` is: every renderer below is a free function, and
// threading a map through all of them would be the only change of shape here.
let actorKinds = new Map<string, ActorKind>();
let latestProgress = new Map<string, TicketProgress>();

/** An actor, drawn: the crew mark for their name, framed by the kind the
 *  record holds, followed by the name itself.
 *
 *  THE NAME IS NOT OPTIONAL, and that is the point of having one function.
 *  A crew hue is a retrieval accelerator, never an identifier — the estate
 *  measured its own set and found ten members cannot have ten mutually
 *  distinguishable hues (H-713), so a coloured dot standing alone would be
 *  exactly the thing the measurement says does not work. Every mark on this
 *  page comes from here, which is what makes "the name is always beside it"
 *  a property of the code rather than a habit; test/estate-avatars.test.ts
 *  holds the rest of the page to it.
 *
 *  An actor with no mark and no recorded kind renders as their bare name —
 *  a new agent, or a name Helmo has never seen write, is not a defect.
 *
 *  `known` is the kind the caller already has in hand: an event carries the
 *  kind its writer declared at the time, which is better than the store-wide
 *  answer this falls back to. Both are read from the record; neither is a
 *  guess from the name. */
function actor(name: string, known?: ActorKind): string {
  const kind = known ?? actorKinds.get(name);
  // One rule decides who has a mark wherever the page draws an actor.
  const mark = markFor(name, kind);
  const glyph =
    mark && kind
      ? `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><use href="#crew-${esc(mark)}-${esc(kind)}"/></svg>`
      : '';
  return `<span class="actor">${glyph}${esc(name)}</span>`;
}

function chain(t: Ticket): string {
  const c = store.agentChain(t.id);
  return c.length
    ? `<span class="chain">${c.map((a) => actor(a.split(' ')[0] ?? a)).join('<span class="chain-arrow"> → </span>')}</span>`
    : '';
}

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
  return store.isBlocked(t.id) || gated(t) || held(t);
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

function timeline(events: HelmoEvent[]): string {
  const items = events
    .filter((e) => e.event_type !== 'linked' && e.event_type !== 'unlinked')
    .map((e) => {
      const note =
        (e.payload['note'] as string) ??
        (e.payload['question'] as string) ??
        (e.payload['answer'] as string) ??
        '';
      const what =
        e.event_type === 'created' ? 'created' :
        e.event_type === 'returned' ? 'returned to human' :
        e.event_type === 'answered' ? (e.actor.session === 'dashboard' ? 'answered from the dashboard' : 'answered') : '';
      // Dashboard answers are visibly marked so a click here is never mistaken
      // for an answer relayed from a meeting (H-145).
      const whatCls = e.actor.session === 'dashboard' && e.event_type === 'answered' ? 'tl-what tl-dash' : 'tl-what';
      return `<div class="tl"><span class="tl-when">${esc(rel(e.ts))}</span><span class="tl-who">${actor(e.actor.name, e.actor.kind)}</span>${
        what ? `<span class="${whatCls}">${what}</span>` : ''
      }${note ? `<span class="tl-note">${esc(note)}</span>` : ''}</div>`;
    });
  return items.length ? `<div class="tl-wrap">${items.join('')}</div>` : '';
}

function progressLine(t: Ticket): string {
  if (t.status === 'done' || t.status === 'cancelled') return '';
  const progress = latestProgress.get(t.id);
  if (!progress) return '';
  return `<p class="progress">last recorded update ${esc(rel(progress.at))} by ${actor(progress.actor.name, progress.actor.kind)}: ${esc(progress.note)}</p>`;
}

function details(t: Ticket): string {
  const deps = store.getDeps(t.id);
  const depLine = (label: string, ids: string[]) =>
    ids.length ? `<div class="dep"><span class="dep-label">${label}</span> ${ids.map((i) => ref(i)).join(' ')}</div>` : '';
  return `<div class="body">${esc(t.body)}</div>
  ${t.uncertainty_note ? `<div class="uncertain">✱ Where the doubt is: ${esc(t.uncertainty_note)}</div>` : ''}
  ${depLine('waits on', deps.outgoing.filter((d) => d.type === 'blocks').map((d) => d.to_id))}
  ${depLine('parent of', deps.incoming.filter((d) => d.type === 'parent').map((d) => d.from_id))}
  ${depLine('discovered from', deps.outgoing.filter((d) => d.type === 'discovered_from').map((d) => d.to_id))}
  ${depLine('related', [...deps.outgoing.filter((d) => d.type === 'relates').map((d) => d.to_id), ...deps.incoming.filter((d) => d.type === 'relates').map((d) => d.from_id)])}
  ${timeline(store.getEvents(t.id))}`;
}

// ---------- the three display shapes ----------

// The hero: a question awaiting the human. The decision comes first; its
// supporting situation stays one disclosure below it (H-974). With an operator
// configured, ratifying the recommendation is the answer surface (H-90).
//
// The letters are shared presentation logic (H-939), not this card's own: Arthur says "b" in a
// meeting and whoever relays it may be reading the phone queue rather than this
// page. One function letters both, so "b" means one option wherever it is said.
function questionCard(t: Ticket): string {
  const q = t.question;
  if (!q) return '';
  const a = ask(q);
  const opt = (o: { letter: string; label: string; consequence: string }) => {
    const inner = `<span class="opt-label"><span class="opt-letter">${esc(o.letter)}</span>${esc(o.label)}</span><span class="opt-consequence">${esc(o.consequence)}</span>`;
    return `<div class="option">${inner}</div>`;
  };
  return `<article class="qcard" id="${esc(t.id)}" data-ticket="${esc(t.id)}" data-ask="${esc(a.fingerprint)}">
    <header>${ref(t.id)} ${title(t.title, 'qtitle')}
      <span class="meta">${esc(t.workstream)} · asked ${esc(rel(t.updated_at))} ${blastBadge(t)} ${acceptanceBadge(t)}</span></header>
    <p class="question"><span class="decision-label">Issue</span>${esc(q.question)}</p>
    ${a.options ? `<div class="options">${a.options.map(opt).join('')}</div>` : ''}
    <p class="rec"><span class="decision-label recommends">Recommends</span>${esc(q.recommendation)}</p>
    ${operator ? `<button type="button" class="ratify">Ratify recommendation</button><span class="ratify-status" role="status"></span>` : ''}
    ${q.if_unanswered ? `<p class="silence">⏱ If unanswered: ${esc(q.if_unanswered)}</p>` : ''}
    ${progressLine(t)}
    <details class="context"><summary>Context</summary><p class="situation">${esc(q.situation)}</p></details>
    <details class="more" id="d-${esc(t.id)}"><summary>ticket detail</summary>${details(t)}</details>
  </article>`;
}

// A sitting awaiting the human: the same weight as a question, because it is
// the same ask — the difference is only that he answers it by doing something
// somewhere else rather than by saying a word here. Drawn as a plain row it
// read as backlog, and five of them sat unnoticed (H-1761).
//
// The line comes from the ticket's own `sitting` field and nowhere else. The
// body's first paragraph was the tempting alternative and it is wrong: in all
// five it was "why this exists" background, and a heuristic that scrapes it
// prints the wrong thing confidently.
function sittingCard(t: Ticket): string {
  const waits = blockedBy(t);
  return `<article class="scard" id="${esc(t.id)}" data-ticket="${esc(t.id)}">
    <header>${ref(t.id)} ${title(t.title, 'qtitle')}
      ${prioBadge(t)} ${waits.length ? `<span class="badge serious">⛔ waits on ${esc(waits.join(', '))}</span>` : ''} ${blastBadge(t)}
      <span class="meta">${esc(t.workstream)}${t.project ? ` · ${esc(t.project)}` : ''} · marked ${esc(rel(t.updated_at))}</span></header>
    <p class="question"><span class="decision-label sits">🪑 You do</span>${
      t.sitting ? esc(t.sitting) : '<span class="nositting">no line recorded — open the ticket to see what this sitting needs</span>'
    }</p>
    ${progressLine(t)}
    <details class="more" id="d-${esc(t.id)}"><summary>ticket detail</summary>${details(t)}</details>
  </article>`;
}

// In motion: who holds it, what they last said, how far it reaches.
function motionCard(t: Ticket): string {
  return `<article class="mcard" id="${esc(t.id)}">
    <header>${ref(t.id)} ${title(t.title, 'mtitle')}
      ${prioBadge(t)} ${blastBadge(t)} ${acceptanceBadge(t)} ${money(t)}
      <span class="meta">${esc(t.workstream)} · <b class="holder">${t.assignee ? actor(t.assignee) : '?'}</b> · ${esc(rel(t.updated_at))}</span></header>
    ${progressLine(t)}
    <details class="more" id="d-${esc(t.id)}"><summary>ticket detail</summary>${details(t)}</details>
  </article>`;
}

// The sitting marker on a row. An open sitting nothing stands in front of is
// drawn as a hero card and never reaches a row, so a sitting HERE is always a
// later step — behind the impediment badges that precede it, and drawn quiet so
// it does not read as something the operator can do now (H-202). The line it
// needs is retained a disclosure below, in the row's own body.
function sittingBadge(t: Ticket): string {
  if (!t.needs_human) return '';
  const later = t.status === 'open' && impeded(t);
  return later
    ? '<span class="badge quiet">🪑 then a sitting</span>'
    : '<span class="badge accent">🪑 needs a sitting</span>';
}

/** Everything else: a quiet row that opens.
 *
 *  Deliberately NOT <details>/<summary>. The row draws its own reference
 *  through ref(), which brings a copy control with it, and a <summary> is an
 *  interactive element — so a button inside one is axe's `nested-interactive`
 *  (serious), and a real defect: a screen reader cannot reach the copy control
 *  separately from the disclosure, and a pointer gesture over the two is
 *  ambiguous between copying and opening (H-2447). Spelling the disclosure out
 *  as a button with its own panel puts the reference BESIDE the control that
 *  opens the row rather than inside it. What renders is unchanged; what is
 *  interactive is. The disclosures in the row's body are still <details>:
 *  nothing inside them is interactive, so nothing there is nested. */
function row(t: Ticket, opts: { showDone?: boolean } = {}): string {
  const waits = t.status === 'open' ? blockedBy(t) : [];
  const noEv = t.status === 'done' && t.evidence.length === 0;
  const panel = `b-${esc(t.id)}`;
  return `<div class="trow" id="${esc(t.id)}">
    <div class="rhead">
      ${ref(t.id)}
      <button type="button" class="rtoggle" aria-expanded="false" aria-controls="${panel}">
        ${title(t.title, 'rtitle')}
        ${prioBadge(t)}
        ${waits.length ? `<span class="badge serious">⛔ waits on ${esc(waits.join(', '))}</span>` : ''}
        ${t.schedule ? `<span class="badge">↻ ${esc(t.schedule)}</span>` : ''}
        ${gated(t) ? `<span class="badge">⏰ not before ${esc(t.not_before!.slice(0, 10))}</span>` : ''}
        ${held(t) ? `<span class="badge">⏸ on hold · ${esc(t.capacity_hold!.reason)}</span>` : ''}
        ${sittingBadge(t)}
        ${noEv ? '<span class="badge critical">✱ no evidence</span>' : ''}
        ${confBadge(t)} ${blastBadge(t)} ${acceptanceBadge(t)}
        <span class="rmeta">${esc(t.workstream)}${t.project ? ` · ${esc(t.project)}` : ''} · ${esc(t.type)}${t.assignee ? ` · ${esc(t.assignee)}` : ''} ${money(t)} · ${esc(
          rel(opts.showDone ? (t.closed_at ?? t.updated_at) : t.updated_at)
        )}</span>
        ${opts.showDone ? chain(t) : ''}
      </button>
    </div>
    <div class="rbody" id="${panel}" hidden>
      ${t.needs_human && t.sitting && t.status === 'open' ? `<p class="later"><span class="decision-label sits">🪑 You do, after</span>${esc(t.sitting)}</p>` : ''}
      ${progressLine(t)}
      ${opts.showDone ? `<div class="evrow">${evidenceLinks(t)}</div>` : ''}
      ${details(t)}
    </div>
  </div>`;
}

// ---------- page assembly ----------

// The needs-grooming strip (H-23): icon+label, never color alone.
const GROOM_LABEL: Record<HygieneFinding['check'], string> = {
  stale_claim: '⏳ stale claim',
  done_without_evidence: '✱ no evidence',
  phantom_block: '🔓 unblocked, untouched',
  aging_question: '❓ aging question',
  spend_anomaly: '＄ spend anomaly',
  priority_inversion: '▲ priority inversion',
  budget_pressure: '＄ budget pressure',
  silent_assignee: '👻 silent assignee',
  orphan_ticket: '⚠ orphan row — not created by Helmo',
  unseated_pool: '🪑 no seat — pool no loop sees',
  awaiting_second_eyes: '👀 awaiting second eyes',
  unaccounted_work: '🏷 nothing says what it is for',
};

/** `drawn` is the set of tickets THIS document holds. The hygiene sweep reads
 *  the whole store, so it names closed tickets the current record leaves out —
 *  it keeps only the newest CLOSED_TAIL — and a bare `#H-19` to a row that
 *  is not on the page is a link that does nothing when the operator clicks it.
 *  Six of them were live on his dashboard, found by the link check in
 *  test/view-release-floor.test.ts. Those go to the whole record instead,
 *  which draws every ticket, so the link lands on the row either way. */
function groomStrip(findings: HygieneFinding[], drawn: Set<string>): string {
  if (!findings.length) return '';
  return `<section class="groom"><h2>Needs grooming</h2>
    ${findings
      .map(
        (f) => `<p class="gitem"><span class="badge quiet">${GROOM_LABEL[f.check]}</span>
          ${f.ticket_id ? ref(f.ticket_id, `${drawn.has(f.ticket_id) ? '' : '?whole=1'}#${f.ticket_id}`) : `<span class="tid">${esc(f.workstream ?? '')}</span>`} <span class="gdetail">${esc(f.detail)}</span></p>`,
      )
      .join('')}
  </section>`;
}

function awaitingSection(awaiting: Ticket[], withHuman: Ticket[]): string {
  const count = awaiting.length + withHuman.length;
  return `<section class="hero" data-helmo-section="awaiting" data-count="${count}">
  <h2>Awaiting you</h2>
  ${count ? `${awaiting.map(questionCard).join('')}${withHuman.map(sittingCard).join('')}` : '<p class="allclear">✓ Queue is empty. Nothing needs you.</p>'}
</section>`;
}

const COPY_STATUS = '<span id="copy-status" class="sr-only" role="status" aria-live="polite"></span>';

function page(wholeRecord = false, section: 'awaiting' | null = null): string {
  // One query per render, not one per actor drawn: the map is store-wide and
  // the page names the same handful of writers hundreds of times.
  actorKinds = store.actorKinds();
  const completeRecord = store.listTickets({ limit: -1 });
  const all = recordTickets(completeRecord, wholeRecord);
  latestProgress = store.latestProgress(all.filter((t) => t.status !== 'done' && t.status !== 'cancelled').map((t) => t.id));
  const by = (s: string) => all.filter((t) => t.status === s);
  const awaiting = by('awaiting_human');
  const motion = by('in_progress');
  const standing = by('open').filter((t) => t.schedule); // recurring templates (H-22)
  const live = by('open').filter((t) => !t.schedule);
  // A date gate blocks as surely as a dep does, so it belongs on the blocked
  // side: the 'ready' stat is read as "what an agent could pick up now", and a
  // gated ticket is exactly what the queue will not offer (H-732). A capacity
  // hold is the same promise in the other direction — the queue withholds it
  // and the claim path refuses it — so it sits beside them (H-2321).
  //
  // A sitting is offered the same way, and the same reading decides it: work
  // the operator cannot reach yet is blocked work that also needs him later,
  // not work awaiting him (H-202). So `impeded` splits all three sections, and
  // Blocked holds sittings too — it is the section that names the prerequisite.
  // This is also what stops a held sitting falling out of the page entirely:
  // it used to be excluded from "Awaiting you" for being held and from the
  // agent sections for needing a human, and was drawn nowhere at all.
  const withHuman = live.filter((t) => t.needs_human && !impeded(t));
  const open = live.filter((t) => !t.needs_human);
  const ready = open.filter((t) => !impeded(t));
  const blocked = live.filter(impeded);
  const done = by('done');
  const cancelled = by('cancelled');
  const spend = all.reduce((s, t) => s + (t.cost_usd_total || 0), 0);
  const awaitingHtml = awaitingSection(awaiting, withHuman);

  // The estate landing embeds this reading rather than drawing a second kind
  // of ticket. It is still a complete document so Helmo's CSS, answer nonce,
  // relative ratify path and refresh behaviour cross the iframe unchanged.
  if (section === 'awaiting') {
    const count = awaiting.length + withHuman.length;
    return `<!doctype html><html lang="en" data-answer="${answerNonce}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Helmo · Awaiting you</title>
<style>${CSS}</style>
<body class="section-reading" data-helmo-section="awaiting" data-count="${count}">
${ESTATE_AVATARS}
${awaitingHtml}
${COPY_STATUS}
<script>${JS}</script>
</body></html>`;
  }

  const stat = (n: number, label: string, cls = '') => `<div class="stat ${cls}"><div class="stat-n">${n}</div><div class="stat-l">${label}</div></div>`;

  return `<!doctype html><html lang="en" data-answer="${answerNonce}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Helmo</title>
<style>${CSS}</style>
<body>
${ESTATE_AVATARS}
<header class="top">
  <div class="brand"><h1>Helmo</h1><span class="tagline">${operator ? 'agents write · you read & answer' : 'agents write · you read'}</span></div>
  <div class="stats">
    ${stat(awaiting.length + withHuman.length, awaiting.length + withHuman.length === 1 ? 'awaits you' : 'await you', awaiting.length + withHuman.length ? 'hot' : 'calm')}
    ${stat(motion.length, 'in motion')}
    ${stat(ready.length, 'ready')}
    ${stat(blocked.length, 'blocked')}
    ${stat(done.length, 'done')}
    ${spend ? `<div class="stat"><div class="stat-n">$${spend.toFixed(0)}</div><div class="stat-l">spend</div></div>` : ''}
  </div>
</header>

<nav class="record-scope">${wholeRecord
  ? `Whole record · <a href="?">return to current record</a>`
  : `Current record · every live ticket and the newest ${CLOSED_TAIL} closed · <a href="?whole=1">whole record</a>`}</nav>

${awaitingHtml}

${groomStrip(store.hygiene(), new Set(all.map((t) => t.id)))}


${motion.length ? `<section><h2>In motion</h2>${motion.map(motionCard).join('')}</section>` : ''}

${ready.length ? `<section><h2>Ready</h2>${ready.map((t) => row(t)).join('')}</section>` : ''}
${blocked.length ? `<section><h2>Blocked</h2>${blocked.map((t) => row(t)).join('')}</section>` : ''}
${standing.length ? `<section><h2>Standing</h2>${standing.map((t) => row(t)).join('')}</section>` : ''}
${done.length ? `<section><h2>Done</h2>${done.map((t) => row(t, { showDone: true })).join('')}</section>` : ''}
${cancelled.length ? `<section><h2>Cancelled (${cancelled.length})</h2>${cancelled.map((t) => row(t)).join('')}</section>` : ''}

<footer>${operator ? `answers write as ${esc(operator)} (human) · everything else read-only` : 'read-only · set HELMO_OPERATOR to answer from here'} · ${esc(dbPath)} · refreshed <span id="age">just now</span>
  <span id="refresh-warning" class="refresh-warning" role="status" hidden>⚠ refresh failed · showing last good reading from <time id="last-good"></time></span>
</footer>
${COPY_STATUS}
<script>${JS}</script>
</body></html>`;
}

// Chrome, ink and shape come from the estate's design tokens, vendored
// (R-11 H-714): one visual system across Helmo, roadmap, rev, the health page
// and the estate shell. Helmo keeps its own token names and every rule below
// is unchanged — the aliases are the whole seam, so a look ratified upstream
// restyles this page without it being touched. Status colors are the estate's
// too since H-771 — the ramp it grew is themed, so Helmo's own dark overrides
// for them are gone.
//
// ESTATE_TOKENS goes first: the aliases read from it, and it brings the dark
// values under prefers-color-scheme, which is what a page with no theme
// switch needs.
const CSS = `
${ESTATE_TOKENS}
:root {
  color-scheme: light dark;
  --page: var(--background); --surface: var(--card); --ink: var(--foreground);
  /* Helmo runs a three-step ink ladder where shadcn has two; the middle step
     is mixed rather than picked, so a look change carries it too. */
  --ink-2: color-mix(in oklab, var(--foreground) 72%, var(--background));
  --ink-3: var(--muted-foreground);
  --hairline: var(--border);
  --radius-card: var(--radius); --radius-inner: calc(var(--radius) * 0.8);
  --radius-control: calc(var(--radius) * 0.6);

  /* Status and link were the one part of this page shadcn had nothing for, so
     they were held back as literals until the estate grew a ramp of its own
     (H-771). Now they alias like everything else. Two of the values move:
     --warning was #fab219, which is 1.83:1 on white — it is a chart mark in
     the reference palette, not text, and Helmo renders it as both a headline
     figure and badge ink; --serious was #ec835a at 2.64:1. Both take the
     estate's deepened light step. Colour still always rides with a text
     label, never alone (H-713). */
  --good-text: var(--status-good); --warning: var(--status-warn); --serious: var(--status-serious);
  --critical: var(--status-bad); --link: var(--interactive);
  --amber-wash: var(--status-warn-wash); --amber-ink: var(--status-warn-ink);
  /* The send button is a solid fill of --link with text on it, which is a
     second job for that colour. It used to hardcode white, and white on the
     dark link blue is 3.64:1 — a real defect on this page, found by the
     estate's own contrast test rather than by looking at it. */
  --link-ink: var(--interactive-foreground);
}
:root.light { color-scheme: light; }
:root.dark { color-scheme: dark; }
* { box-sizing: border-box; }
/* Every string on this page came out of the store, and the store is full of
   absolute paths, commit refs and URLs — tokens with no space to break at. One
   of them in a phone-width column pushes the whole document sideways, and the
   check that catches it can only point at the text, never at an element, so it
   is a slow thing to find. Declared once, at the root, because three selectors
   carried this and .situation did not, which is precisely how it happened
   again (R-11 H-1176). Value anywhere rather than break-word: only anywhere
   also lowers min-content, which is what lets a grid or flex track shrink to
   the box instead of being held open by the longest ref inside it. Anything
   that must stay on one line says white-space: nowrap, and that still wins. */
:root { overflow-wrap: anywhere; }
body { margin: 0 auto; padding: 18px 16px 48px; max-width: 1080px; background: var(--page); color: var(--ink);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
.section-reading { padding: 0; max-width: none; }
.section-reading .hero h2 { margin-top: 0; }
.top { display: grid; gap: 18px; margin-bottom: 8px; }
.brand h1 { font-size: 26px; margin: 0; letter-spacing: -0.02em; display: inline; }
.tagline { display: block; color: var(--ink-3); margin-top: 2px; font-size: 13px; }
.stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 18px; width: 100%; }
.stat-n { font-size: 22px; font-weight: 650; letter-spacing: -0.02em; }
.stat-l { font-size: 11px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.06em; }
.stat.hot .stat-n { color: var(--warning); }
.stat.calm .stat-n { color: var(--good-text); }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--ink-3); font-weight: 600;
  margin: 34px 0 10px; padding-top: 14px; border-top: 1px solid var(--hairline); }
.allclear { color: var(--good-text); font-size: 15px; }
.groom .gitem { margin: 3px 0; font-size: 12.5px; color: var(--ink-2); }
.groom .gdetail { color: var(--ink-3); }
.tid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--ink-3); white-space: nowrap; }
/* The copy control (H-2428, I12). It is deliberately small beside a 12px
   monospace ID and takes its 44px touch target from a transparent overlay
   instead of from bulk: a control sized to a finger would stand three times
   the height of the reference it belongs to, on every row of the page.
   An inset of -13px around an 18px box is exactly 44. */
.tid a { color: inherit; }
.copy { position: relative; min-height: 18px; margin-left: 4px; padding: 0; width: 18px; height: 18px; line-height: 1;
  border: 0; border-radius: var(--radius-control); background: none; color: var(--ink-3);
  font: inherit; cursor: pointer; vertical-align: -0.12em; }
.copy::after { content: ''; position: absolute; inset: -13px; }
.copy:hover { color: var(--link); }
.copy[data-copied='yes'] { color: var(--good-text); }
.copy[data-copied='no'] { color: var(--critical); }
/* Nothing on screen, everything to a screen reader: the copy result has no
   visual home of its own — the glyph swap is the sighted feedback — so it is
   announced through a live region rather than succeeding silently. */
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.spend { font-variant-numeric: tabular-nums; color: var(--ink-3); font-size: 12px; white-space: nowrap; }
.badge { display: inline-block; max-width: 100%; font-size: 11px; line-height: 1.35; padding: 2px 7px; border-radius: 999px;
  border: 1px solid var(--hairline); white-space: normal; vertical-align: middle; }
.badge.neutral { color: var(--ink-2); }
.badge.warning { color: var(--amber-ink); background: var(--amber-wash); border-color: transparent; }
.badge.serious { color: var(--serious); }
.badge.critical { color: var(--critical); font-weight: 600; }
.badge.accent { color: var(--link); }
.badge.quiet { color: var(--ink-3); }
.meta, .rmeta { color: var(--ink-3); font-size: 12px; }
.record-scope { margin: 14px 0 0; color: var(--ink-3); font-size: 12px; }
.record-scope a { color: var(--link); }
.chain { color: var(--ink-3); font-size: 11px; font-family: ui-monospace, monospace; }
.chain-arrow { opacity: 0.7; }

/* ---- actors (R-11 H-713): the mark says who, the frame says what kind ---- */
/* nowrap is load-bearing, not tidiness: the rule the avatar set ships under is
   that a crew hue never identifies a member on its own, and a mark that wrapped
   to the end of a line away from its name would be doing exactly that. */
.actor { white-space: nowrap; }
/* Sized in em so one rule serves 11px chain text and 14px card meta alike.
   No colour here — the mark carries its member hue from the sprite, the frame
   is currentColor at .18, so an actor is whatever ink its context gives it. */
.mark { width: 1.15em; height: 1.15em; vertical-align: -0.22em; margin-right: 3px; }

/* ---- question cards (the hero) ---- */
.qcard { background: var(--surface); border: 1px solid var(--hairline); border-left: 3px solid var(--warning);
  border-radius: var(--radius-card); padding: 16px 14px; margin: 12px 0; }
.qcard header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.qtitle { font-weight: 600; }
.question { font-size: 19px; font-weight: 650; letter-spacing: -0.01em; margin: 8px 0 12px; }
.decision-label { color: var(--ink-3); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 650; margin-right: 8px; }
.options { display: grid; gap: 6px; margin: 0 0 12px; }
/* minmax(0, 1fr) rather than 1fr, and the stack below (R-11 H-889). A bare
   plain 1fr track is minmax(auto, 1fr): its floor is the min-content width of
   the consequence, so a card 278px wide laid out a 343px option and dragged
   the whole page sideways at 390px — 400px of document in a 390px viewport, on
   the one page Arthur answers questions from. minmax(0, …) lets it shrink
   to whatever is there, which is what makes long consequence text wrap instead
   of push. */
.option { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 12px; padding: 7px 10px;
  border: 1px solid var(--hairline); border-radius: var(--radius-inner); }
/* The first breakpoint in this file, and it is content that decided it, not a
   device: a 150px label column plus the gap and the padding leaves the
   consequence under 100px on a phone — a ribbon three words wide that shrinking
   correctly does not make readable. Below 480px the label sits above its
   consequence and both get the full card. Same call rev's loop table makes:
   two columns of this width do not fit a phone and should not try to. */
@media (max-width: 480px) {
  .option { grid-template-columns: minmax(0, 1fr); gap: 2px; }
}
@media (min-width: 700px) {
  body { padding: 28px 32px 64px; }
  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; }
  .tagline { display: inline; margin: 0 0 0 10px; }
  .stats { display: flex; gap: 12px 22px; width: auto; flex-wrap: wrap; }
  .qcard, .scard { padding: 18px 22px; }
}
/* A sitting card is a question card in every dimension but hue: same surface,
   same padding, same 19px ask. Amber asks for a word, blue asks for an act. */
.scard { background: var(--surface); border: 1px solid var(--hairline); border-left: 3px solid var(--link);
  border-radius: var(--radius-card); padding: 16px 14px; margin: 12px 0; }
.scard header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.decision-label.sits { color: var(--link); }
.nositting { color: var(--ink-3); font-weight: 400; font-size: 15px; }
.opt-label { font-weight: 600; font-size: 13px; }
/* The letter is what Arthur says out loud, so it leads the label and holds its
   own column width — ragged letters read as a list of labels that happen to
   start with a letter. */
.opt-letter { display: inline-block; min-width: 1.1em; color: var(--ink-3); font-weight: 650; }
.opt-consequence { color: var(--ink-2); font-size: 13px; }
.rec { margin: 0 0 6px; }
.decision-label.recommends { color: var(--good-text); }
.silence { color: var(--ink-3); font-size: 12.5px; margin: 0; }
.context { margin-top: 8px; }
.context summary { color: var(--ink-3); cursor: pointer; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
.situation { color: var(--ink-2); margin: 6px 0 0; }

/* ---- the answer surface (H-90): one deliberate acceptance, disagreement stays a meeting ---- */
.ratify { min-height: 44px; padding: 5px 14px; border: 1px solid var(--link); border-radius: var(--radius-control); background: var(--link); color: var(--link-ink);
  font: inherit; font-weight: 600; cursor: pointer; }
.ratify:disabled { opacity: 0.5; cursor: default; }
.ratify-status { margin-left: 8px; color: var(--ink-3); font-size: 12.5px; }
.ratify-status.err { color: var(--critical); }

/* ---- in-motion cards ---- */
.mcard { background: var(--surface); border: 1px solid var(--hairline); border-radius: var(--radius-card); padding: 13px 18px; margin: 10px 0; }
.mcard header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.mtitle { font-weight: 600; }
.holder { color: var(--link); font-weight: 600; }
.progress { color: var(--ink-2); margin: 8px 0 0; font-size: 13.5px;
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
/* The sitting a blocked ticket will need once its impediment clears: retained
   where the operator can read it, a disclosure below the row he skims (H-202). */
.later { color: var(--ink-2); margin: 8px 0 0; font-size: 13.5px; }

/* ---- quiet rows ---- */
/* The head is a flex line with two items: the reference (which carries its own
   copy control) and the disclosure button that owns everything else. They are
   siblings so that neither is inside the other — see row() for why. The button
   is stripped back to inherited type and made the wrapping flex container the
   <summary> used to be, so the row draws exactly as it did. */
.trow { border-bottom: 1px solid var(--hairline); }
.rhead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 9px 4px; }
.rhead:hover { background: var(--surface); }
/* Mobile-first, as the rest of this file is: below 700px the reference takes a
   line of its own and the rest of the row gets the full width under it, which
   is what the single wrapping <summary> used to do at that width. The ≥700px
   block puts them back on one line. */
.rtoggle { flex: 1 1 100%; min-width: 0; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.rtitle { font-weight: 500; }
/* The quieter half of a split title (H-2476). Weight and colour only: the text
   is the stored title's own remainder, still selectable and still found by
   find-in-page. */
.tdetail { font-weight: 400; color: var(--ink-2); }
.rmeta { flex-basis: 100%; text-align: left; }
.evrow { flex-basis: 100%; display: grid; gap: 10px; }
.result-group { display: flex; align-items: baseline; gap: 8px 12px; flex-wrap: wrap; }
.evidence-label { min-width: 96px; color: var(--ink-3); font-size: 11px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; }
.result-action { min-height: 36px; display: inline-flex; align-items: center; padding: 3px 10px; border: 1px solid var(--hairline);
  border-radius: var(--radius-control); color: var(--link); font-weight: 600; text-decoration: none; }
.result-action.primary { min-height: 44px; padding: 7px 14px; border-color: var(--link); background: var(--link); color: var(--link-ink); }
.result-action[aria-disabled='true'] { border-color: var(--hairline); background: none; color: var(--ink-3); font-weight: 400; }
.result-note, .result-missing, .release-state { color: var(--ink-2); font-size: 12px; }
.ev { font-size: 12px; color: var(--ink-2); min-width: 0; }

/* ---- shared detail ---- */
details.more { margin-top: 10px; }
details.more summary { font-size: 12px; color: var(--ink-3); cursor: pointer; }
/* pre-wrap keeps the newlines a body was written with; it is the :root rule
   above that lets the long refs inside it break. */
.body { white-space: pre-wrap; min-width: 0; color: var(--ink-2); font-size: 13px; background: var(--page);
  border: 1px solid var(--hairline); border-radius: var(--radius-inner); padding: 10px 14px; margin: 8px 0; }
.trow .body { background: var(--surface); }
.rbody[hidden] { display: none; }
.uncertain { color: var(--serious); font-size: 13px; margin: 6px 0; }
.dep { font-size: 12.5px; color: var(--ink-2); margin: 2px 0; }
.dep-label { color: var(--ink-3); text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.05em; margin-right: 6px; }
.tl-wrap { margin: 10px 0 4px; border-left: 2px solid var(--hairline); padding-left: 14px; }
.tl { margin: 7px 0; font-size: 12.5px; }
.tl-when { color: var(--ink-3); margin-right: 8px; font-variant-numeric: tabular-nums; }
.tl-who { color: var(--link); font-weight: 600; margin-right: 8px; }
.tl-what { color: var(--ink-3); font-style: italic; margin-right: 8px; }
/* --hot was never defined anywhere in this file, so this always rendered its
   literal fallback — an amber picked before the page had a dark half. It is
   the estate's warning step now, like every other amber here. */
.tl-dash { color: var(--warning); font-weight: 600; }
.tl-note { color: var(--ink-2); display: block; margin-top: 1px; }
footer { margin-top: 48px; color: var(--ink-3); font-size: 11.5px; border-top: 1px solid var(--hairline); padding-top: 12px; }
.refresh-warning { display: block; margin-top: 6px; color: var(--critical); font-weight: 600; }
.refresh-warning[hidden] { display: none; }
@media (min-width: 700px) {
  .rtoggle { flex-basis: 0; }
  .rmeta { flex-basis: auto; margin-left: auto; text-align: right; }
  .evrow { padding-left: 44px; }
}
`;

// Refresh by replacement, preserving scroll and open disclosures — and paused
// while an answer is being composed, so the refresh never eats the human's
// half-written reasoning. Handlers ride document-level delegation, which
// survives body replacement. The ONLY non-GET this page ever sends is
// POST /answer, and only from the click flow below (H-90).
const JS = `
let lastGood = Date.now();
const embeddedSection = document.body.dataset.helmoSection;
function reportSectionSize() {
  if (!embeddedSection || window.parent === window) return;
  window.parent.postMessage({
    type: 'helmo:section-size',
    section: embeddedSection,
    count: Number(document.body.dataset.count || 0),
    height: document.documentElement.scrollHeight,
  }, location.origin);
}
const sectionObserver = embeddedSection && 'ResizeObserver' in window ? new ResizeObserver(reportSectionSize) : null;
if (sectionObserver) sectionObserver.observe(document.body);
else requestAnimationFrame(reportSectionSize);
function showRefreshFailure() {
  const warning = document.getElementById('refresh-warning');
  const time = document.getElementById('last-good');
  if (!warning || !time) return;
  const reading = new Date(lastGood);
  time.dateTime = reading.toISOString();
  time.textContent = reading.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  warning.hidden = false;
}
setInterval(async () => {
  // A focused disclosure, link or form control belongs to the reader until
  // they leave it. Replacing the body beneath keyboard focus would reset their
  // place even though the open disclosures and scroll position are preserved.
  if (document.activeElement && document.activeElement !== document.body) return;
  try {
    const r = await fetch(location.href, { cache: 'no-store' });
    if (!r.ok) throw new Error('refresh returned ' + r.status);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const open = new Set([...document.querySelectorAll('details[open]')].map((d) => d.id).filter(Boolean));
    for (const id of open) doc.getElementById(id)?.setAttribute('open', '');
    // The ticket rows are a button and a panel rather than a <details>, so
    // their open state lives in two places and both have to come across.
    for (const b of document.querySelectorAll('.rtoggle[aria-expanded="true"]')) {
      const id = b.getAttribute('aria-controls');
      const panel = doc.getElementById(id);
      if (!panel) continue;
      panel.removeAttribute('hidden');
      doc.querySelector('[aria-controls="' + id + '"]')?.setAttribute('aria-expanded', 'true');
    }
    const y = scrollY;
    document.body.replaceWith(doc.body);
    enableDeviceLocalResults();
    if (sectionObserver) {
      sectionObserver.disconnect();
      sectionObserver.observe(document.body);
    } else {
      requestAnimationFrame(reportSectionSize);
    }
    scrollTo(0, y);
    lastGood = Date.now();
  } catch {
    showRefreshFailure();
  }
}, 15000);
setInterval(() => {
  const el = document.getElementById('age');
  if (el) el.textContent = Math.round((Date.now() - lastGood) / 1000) + 's ago';
}, 5000);

// Put text on the clipboard where navigator.clipboard is not there to do it.
// This is not a legacy nicety: the Clipboard API is secure-context only and
// these pages are served over plain http, so a phone reading the estate over
// the LAN takes THIS path every time. Focus is borrowed and handed straight
// back, or the reader loses their place to an invisible textarea.
function copyWithoutTheApi(text) {
  const held = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(field);
  field.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  field.remove();
  if (held && held.focus) held.focus();
  return ok;
}

// A localhost result belongs to the machine serving it, not to whichever
// phone happens to read this page. It becomes a link only on that machine;
// remote readers get an honest status instead of a trip to their own port.
function enableDeviceLocalResults() {
  const here = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '::1';
  if (here) {
    for (const link of document.querySelectorAll('[data-device-local]')) {
      link.href = link.dataset.deviceLocal;
      link.removeAttribute('aria-disabled');
    }
  }
  for (const group of document.querySelectorAll('.result-group')) {
    const links = [...group.querySelectorAll('.result-action')];
    for (const link of links) link.classList.remove('primary');
    const firstReachable = links.find((link) => link.hasAttribute('href'));
    if (!firstReachable) continue;
    firstReachable.classList.add('primary');
    for (const link of links) link.textContent = link === firstReachable ? 'View result' : link.hasAttribute('href') ? 'View another result' : 'Result available on the estate machine';
  }
}
enableDeviceLocalResults();

document.addEventListener('click', async (e) => {
  // The ticket rows' disclosure. <details> would open itself, but its
  // <summary> cannot hold the row's copy control without nesting one
  // interactive element in another (H-2447), so the open/closed state is
  // carried on aria-expanded and the panel's hidden attribute instead.
  const toggle = e.target.closest('.rtoggle');
  if (toggle) {
    const wasOpen = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', wasOpen ? 'false' : 'true');
    const panel = document.getElementById(toggle.getAttribute('aria-controls'));
    if (panel) panel.hidden = wasOpen;
    return;
  }

  const copy = e.target.closest('.copy');
  if (copy) {
    const text = copy.dataset.copy;
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        ok = copyWithoutTheApi(text);
      }
    } catch {
      ok = copyWithoutTheApi(text);
    }
    copy.dataset.copied = ok ? 'yes' : 'no';
    copy.textContent = ok ? '✓' : '✗';
    const announce = document.getElementById('copy-status');
    if (announce) announce.textContent = ok ? text + ' copied' : 'could not copy ' + text;
    setTimeout(() => {
      delete copy.dataset.copied;
      copy.textContent = '⧉';
    }, 1500);
    return;
  }

  const send = e.target.closest('.ratify');
  if (send) {
    const card = send.closest('.qcard');
    const status = card.querySelector('.ratify-status');
    send.disabled = true;
    status.classList.remove('err');
    status.textContent = 'recording…';
    try {
      const r = await fetch('answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-helmo-answer': document.documentElement.dataset.answer },
        body: JSON.stringify({
          ticket_id: card.dataset.ticket,
          ratify: true,
          question_fingerprint: card.dataset.ask,
        }),
      });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || 'answer failed');
      status.textContent = 'recorded ✓';
      setTimeout(() => location.reload(), 400);
    } catch (err) {
      status.classList.add('err');
      status.textContent = String(err.message || err);
      send.disabled = false;
    }
  }
});
`;

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/answer') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const out = answerRequest(req.headers, body, { operator, nonce: answerNonce, sameOrigin, store });
      res.writeHead(out.code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
    return;
  }
  try {
    // Render BEFORE the headers go out. Writing 200 first meant any error in
    // page() hit a catch that could no longer set a status — the writeHead(500)
    // threw ERR_HTTP_HEADERS_SENT, unhandled, and took the whole view process
    // down. A render bug should be a 500 you can read, not a dead dashboard.
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const section = url.searchParams.get('section');
    if (section && section !== 'awaiting') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`Unknown Helmo section: ${section}`);
      return;
    }
    const html = page(url.searchParams.get('whole') === '1', section === 'awaiting' ? 'awaiting' : null);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(e instanceof Error ? (e.stack ?? e.message) : e));
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  sameOrigin.add(`http://127.0.0.1:${boundPort}`);
  sameOrigin.add(`http://localhost:${boundPort}`);
  process.send?.({ type: 'helmo-view-ready', port: boundPort });
  console.log(`Helmo view: http://localhost:${boundPort} — ${installationLine(install, store.installationIdentity())}${operator ? ` — answers enabled for ${operator}` : ' (read-only; set HELMO_OPERATOR to answer)'}`);
});
