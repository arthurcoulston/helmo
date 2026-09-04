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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ESTATE_AVATARS } from './estate-avatars.generated.js';
import { feed, markFor } from './feed.js';
import { ESTATE_TOKENS } from './estate-tokens.generated.js';
import { Store } from './store.js';
import { HygieneFinding } from './store.js';
import { Actor, ActorKind, HelmoError, Ticket, HelmoEvent } from './types.js';

const dbPath = process.env['HELMO_DB'] ?? join(homedir(), '.helmo', 'helmo.db');
const port = Number(process.env['HELMO_VIEW_PORT'] ?? 4400);
const host = process.env['HELMO_VIEW_HOST'] ?? '127.0.0.1';
const operator = process.env['HELMO_OPERATOR']?.trim() || null;
// Per-boot nonce the page carries and POST /answer must echo (H-145). NOT a
// wall against local agents — any same-user process can GET the page and read
// it. It turns a forged approval from one innocuous curl into a deliberate
// read-then-impersonate, which is the kind of act the constitution and
// injection defences catch. Friction, not a gate; keep the comment honest.
const answerNonce = randomBytes(16).toString('hex');
const ANSWER_HEADER = 'x-helmo-answer';
const sameOrigin = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
const store = new Store(dbPath);

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

// ---------- small renderers ----------

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
  const label = acceptance.state === 'accepted' ? 'accepted' : acceptance.state === 'failed' ? 'acceptance failed' : 'acceptance pending';
  const mark = acceptance.state === 'accepted' ? '✓' : acceptance.state === 'failed' ? '✕' : '◌';
  return `<span class="badge ${cls}" title="${esc(acceptance.reason.replaceAll('_', ' '))}">${mark} ${label}</span>`;
}

function evidenceLinks(t: Ticket): string {
  return t.evidence
    .map((e) => {
      const label = `${esc(e.kind)}${e.note ? `: ${esc(e.note)}` : `: ${esc(e.ref.length > 46 ? e.ref.slice(0, 46) + '…' : e.ref)}`}`;
      return e.kind === 'url'
        ? `<a class="ev" href="${esc(e.ref)}" title="${esc(e.ref)}">${label}</a>`
        : `<span class="ev" title="${esc(e.ref)}">${label}</span>`;
    })
    .join('');
}

// ---------- actors ----------

// Kinds read from the record, rebuilt once per page render. Module-level for
// the same reason `store` is: every renderer below is a free function, and
// threading a map through all of them would be the only change of shape here.
let actorKinds = new Map<string, ActorKind>();

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
  // The rule lives in feed.ts because the JSON reading draws the same faces;
  // two copies of "who has a mark" is two answers to it.
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

function lastNote(t: Ticket): string {
  const ev = store.getEvents(t.id);
  for (let i = ev.length - 1; i >= 0; i--) {
    const n = ev[i]?.payload?.['note'] as string | undefined;
    if (n?.trim()) return n;
  }
  return '';
}

function details(t: Ticket): string {
  const deps = store.getDeps(t.id);
  const depLine = (label: string, ids: string[]) =>
    ids.length ? `<div class="dep"><span class="dep-label">${label}</span> ${ids.map((i) => `<span class="tid">${esc(i)}</span>`).join(' ')}</div>` : '';
  return `<div class="body">${esc(t.body)}</div>
  ${t.uncertainty_note ? `<div class="uncertain">✱ Where the doubt is: ${esc(t.uncertainty_note)}</div>` : ''}
  ${depLine('waits on', deps.outgoing.filter((d) => d.type === 'blocks').map((d) => d.to_id))}
  ${depLine('parent of', deps.incoming.filter((d) => d.type === 'parent').map((d) => d.from_id))}
  ${depLine('discovered from', deps.outgoing.filter((d) => d.type === 'discovered_from').map((d) => d.to_id))}
  ${depLine('related', [...deps.outgoing.filter((d) => d.type === 'relates').map((d) => d.to_id), ...deps.incoming.filter((d) => d.type === 'relates').map((d) => d.from_id)])}
  ${timeline(store.getEvents(t.id))}`;
}

// ---------- the three display shapes ----------

// The hero: a question awaiting the human. Everything the agent prepared is
// shown; with an operator configured, the options are the answer surface (H-90).
function questionCard(t: Ticket): string {
  const q = t.question;
  if (!q) return '';
  const opt = (o: { label: string; consequence: string }) =>
    operator
      ? `<button type="button" class="option" data-label="${esc(o.label)}"><span class="opt-label">${esc(o.label)}</span><span class="opt-consequence">${esc(o.consequence)}</span></button>`
      : `<div class="option"><span class="opt-label">${esc(o.label)}</span><span class="opt-consequence">${esc(o.consequence)}</span></div>`;
  return `<article class="qcard" id="${esc(t.id)}" data-ticket="${esc(t.id)}">
    <header><span class="tid">${esc(t.id)}</span> <span class="qtitle">${esc(t.title)}</span>
      <span class="meta">${esc(t.workstream)} · asked ${esc(rel(t.updated_at))} ${blastBadge(t)} ${acceptanceBadge(t)}</span></header>
    <p class="situation">${esc(q.situation)}</p>
    <p class="question">${esc(q.question)}</p>
    <div class="options">${q.options.map(opt).join('')}</div>
    <p class="rec"><span class="rec-mark">agent recommends</span> ${esc(q.recommendation)}</p>
    ${q.if_unanswered ? `<p class="silence">⏱ If unanswered: ${esc(q.if_unanswered)}</p>` : ''}
    ${operator ? answerForm() : ''}
    <details class="more" id="d-${esc(t.id)}"><summary>ticket detail</summary>${details(t)}</details>
  </article>`;
}

// Hidden until an option is clicked. The answer goes through store.answerTicket
// unchanged — same validation, eventing, and semantics as a meeting answer.
function answerForm(): string {
  return `<div class="answer-form" hidden>
    <div class="af-picked">answering <b class="af-label"></b></div>
    <input class="af-reason" placeholder="reasoning / constraints (optional — agents learn from the why)">
    <select class="af-res">
      <option value="resume">answer & reopen for the crew</option>
      <option value="done">answer settles it — close done</option>
      <option value="cancelled">answer kills it — cancel</option>
    </select>
    <button type="button" class="af-send">Answer as ${esc(operator)}</button>
    <span class="af-status" role="status"></span>
  </div>`;
}

// In motion: who holds it, what they last said, how far it reaches.
function motionCard(t: Ticket): string {
  const note = lastNote(t);
  return `<article class="mcard" id="${esc(t.id)}">
    <header><span class="tid">${esc(t.id)}</span> <span class="mtitle">${esc(t.title)}</span>
      ${prioBadge(t)} ${blastBadge(t)} ${acceptanceBadge(t)} ${money(t)}
      <span class="meta">${esc(t.workstream)} · <b class="holder">${t.assignee ? actor(t.assignee) : '?'}</b> · ${esc(rel(t.updated_at))}</span></header>
    ${note ? `<p class="note">${esc(note)}</p>` : ''}
    <details class="more" id="d-${esc(t.id)}"><summary>ticket detail</summary>${details(t)}</details>
  </article>`;
}

// Everything else: a quiet row that opens.
function row(t: Ticket, opts: { showDone?: boolean } = {}): string {
  const waits = t.status === 'open' ? blockedBy(t) : [];
  const noEv = t.status === 'done' && t.evidence.length === 0;
  return `<details class="trow" id="${esc(t.id)}">
    <summary>
      <span class="tid">${esc(t.id)}</span>
      <span class="rtitle">${esc(t.title)}</span>
      ${prioBadge(t)}
      ${waits.length ? `<span class="badge serious">⛔ waits on ${esc(waits.join(', '))}</span>` : ''}
      ${t.schedule ? `<span class="badge">↻ ${esc(t.schedule)}</span>` : ''}
      ${gated(t) ? `<span class="badge">⏰ not before ${esc(t.not_before!.slice(0, 10))}</span>` : ''}
      ${noEv ? '<span class="badge critical">✱ no evidence</span>' : ''}
      ${confBadge(t)} ${blastBadge(t)} ${acceptanceBadge(t)}
      <span class="rmeta">${esc(t.workstream)}${t.project ? ` · ${esc(t.project)}` : ''} · ${esc(t.type)}${t.assignee ? ` · ${esc(t.assignee)}` : ''} ${money(t)} · ${esc(
        rel(opts.showDone ? (t.closed_at ?? t.updated_at) : t.updated_at)
      )}</span>
      ${opts.showDone ? `<span class="evrow">${evidenceLinks(t)}</span>` : ''}
      ${opts.showDone ? chain(t) : ''}
    </summary>
    ${details(t)}
  </details>`;
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
};

function groomStrip(findings: HygieneFinding[]): string {
  if (!findings.length) return '';
  return `<section class="groom"><h2>Needs grooming</h2>
    ${findings
      .map(
        (f) => `<p class="gitem"><span class="badge quiet">${GROOM_LABEL[f.check]}</span>
          ${f.ticket_id ? `<a href="#${esc(f.ticket_id)}" class="tid">${esc(f.ticket_id)}</a>` : `<span class="tid">${esc(f.workstream ?? '')}</span>`} <span class="gdetail">${esc(f.detail)}</span></p>`,
      )
      .join('')}
  </section>`;
}

// Operator steering (H-55): only workstreams the human has actually steered
// appear — an unsteered stream has nothing to show.
function steeringStrip(): string {
  // The standing notice (H-172) leads the strip when set: the fleet sees it
  // on every queue read, so the human should see it here.
  const notice = store.getNotice();
  const rows = store.listWorkstreamInfo().filter((w) => w.goal || w.budget_usd !== null);
  if (!rows.length && !notice) return '';
  return `<section class="groom"><h2>Workstream steering</h2>
    ${notice ? `<p class="gitem"><span class="badge accent">📣 standing notice</span> <span class="gdetail">${esc(notice.text)} (${esc(notice.provenance)})</span></p>` : ''}
    ${rows
      .map((w) => {
        const budget =
          w.budget_usd !== null
            ? `<span class="spend">$${w.spent_usd.toFixed(2)} of $${w.budget_usd.toFixed(2)} spent</span>`
            : w.spent_usd ? `<span class="spend">$${w.spent_usd.toFixed(2)} spent</span>` : '';
        return `<p class="gitem"><span class="tid">${esc(w.name)}</span>
          ${w.goal ? `<span class="gdetail">done means: ${esc(w.goal)}</span>` : ''} ${budget}</p>`;
      })
      .join('')}
  </section>`;
}

function page(): string {
  // One query per render, not one per actor drawn: the map is store-wide and
  // the page names the same handful of writers hundreds of times.
  actorKinds = store.actorKinds();
  const all = store.listTickets({ limit: 1000 });
  const by = (s: string) => all.filter((t) => t.status === s);
  const awaiting = by('awaiting_human');
  const motion = by('in_progress');
  const standing = by('open').filter((t) => t.schedule); // recurring templates (H-22)
  const open = by('open').filter((t) => !t.schedule);
  // A date gate blocks as surely as a dep does, so it belongs on the blocked
  // side: the 'ready' stat is read as "what an agent could pick up now", and a
  // gated ticket is exactly what the queue will not offer (H-732).
  const ready = open.filter((t) => !store.isBlocked(t.id) && !gated(t));
  const blocked = open.filter((t) => store.isBlocked(t.id) || gated(t));
  const done = by('done');
  const cancelled = by('cancelled');
  const spend = all.reduce((s, t) => s + (t.cost_usd_total || 0), 0);

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
    ${stat(awaiting.length, awaiting.length === 1 ? 'awaits you' : 'await you', awaiting.length ? 'hot' : 'calm')}
    ${stat(motion.length, 'in motion')}
    ${stat(ready.length, 'ready')}
    ${stat(blocked.length, 'blocked')}
    ${stat(done.length, 'done')}
    ${spend ? `<div class="stat"><div class="stat-n">$${spend.toFixed(0)}</div><div class="stat-l">spend</div></div>` : ''}
  </div>
</header>

<section class="hero">
  <h2>Awaiting you</h2>
  ${awaiting.length ? awaiting.map(questionCard).join('') : '<p class="allclear">✓ Queue is empty. Nothing needs you.</p>'}
</section>

${groomStrip(store.hygiene())}

${steeringStrip()}

${motion.length ? `<section><h2>In motion</h2>${motion.map(motionCard).join('')}</section>` : ''}

${ready.length ? `<section><h2>Ready</h2>${ready.map((t) => row(t)).join('')}</section>` : ''}
${blocked.length ? `<section><h2>Blocked</h2>${blocked.map((t) => row(t)).join('')}</section>` : ''}
${standing.length ? `<section><h2>Standing</h2>${standing.map((t) => row(t)).join('')}</section>` : ''}
${done.length ? `<section><h2>Done</h2>${done.map((t) => row(t, { showDone: true })).join('')}</section>` : ''}
${cancelled.length ? `<section><h2>Cancelled (${cancelled.length})</h2>${cancelled.map((t) => row(t)).join('')}</section>` : ''}

<footer>${operator ? `answers write as ${esc(operator)} (human) · everything else read-only` : 'read-only · set HELMO_OPERATOR to answer from here'} · ${esc(dbPath)} · refreshed <span id="age">just now</span></footer>
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
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 28px 32px 64px; max-width: 1080px; background: var(--page); color: var(--ink);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
.top { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
.brand h1 { font-size: 26px; margin: 0; letter-spacing: -0.02em; display: inline; }
.tagline { color: var(--ink-3); margin-left: 10px; font-size: 13px; }
.stats { display: flex; gap: 12px 22px; flex-wrap: wrap; }
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
.spend { font-variant-numeric: tabular-nums; color: var(--ink-3); font-size: 12px; white-space: nowrap; }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--hairline); white-space: nowrap; }
.badge.neutral { color: var(--ink-2); }
.badge.warning { color: var(--amber-ink); background: var(--amber-wash); border-color: transparent; }
.badge.serious { color: var(--serious); }
.badge.critical { color: var(--critical); font-weight: 600; }
.badge.accent { color: var(--link); }
.badge.quiet { color: var(--ink-3); }
.meta, .rmeta { color: var(--ink-3); font-size: 12px; }
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
  border-radius: var(--radius-card); padding: 18px 22px; margin: 12px 0; }
.qcard header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.qtitle { font-weight: 600; }
.situation { color: var(--ink-2); margin: 10px 0 6px; }
.question { font-size: 19px; font-weight: 650; letter-spacing: -0.01em; margin: 8px 0 12px; }
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
.opt-label { font-weight: 600; font-size: 13px; }
.opt-consequence { color: var(--ink-2); font-size: 13px; }
.rec { margin: 0 0 6px; }
.rec-mark { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--good-text); font-weight: 650; margin-right: 8px; }
.silence { color: var(--ink-3); font-size: 12.5px; margin: 0; }

/* ---- the answer surface (H-90): options are buttons only when an operator is configured ---- */
button.option { cursor: pointer; text-align: left; background: none; color: inherit; font: inherit; width: 100%; }
button.option:hover { border-color: var(--link); }
button.option.selected { border-color: var(--link); box-shadow: inset 2px 0 0 var(--link); }
.answer-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0 0 12px; padding: 10px 12px;
  border: 1px solid var(--hairline); border-radius: var(--radius-inner); background: var(--page); font-size: 13px; }
.af-picked { white-space: nowrap; }
.af-reason { flex: 1 1 260px; padding: 5px 9px; border: 1px solid var(--hairline); border-radius: var(--radius-control);
  background: var(--surface); color: var(--ink); font: inherit; }
.af-res { padding: 5px 6px; border: 1px solid var(--hairline); border-radius: var(--radius-control); background: var(--surface); color: var(--ink); font: inherit; }
.af-send { padding: 5px 14px; border: 1px solid var(--link); border-radius: var(--radius-control); background: var(--link); color: var(--link-ink);
  font: inherit; font-weight: 600; cursor: pointer; }
.af-send:disabled { opacity: 0.5; cursor: default; }
.af-status { color: var(--ink-3); font-size: 12.5px; }
.af-status.err { color: var(--critical); }

/* ---- in-motion cards ---- */
.mcard { background: var(--surface); border: 1px solid var(--hairline); border-radius: var(--radius-card); padding: 13px 18px; margin: 10px 0; }
.mcard header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.mtitle { font-weight: 600; }
.holder { color: var(--link); font-weight: 600; }
.note { color: var(--ink-2); margin: 8px 0 0; font-size: 13.5px;
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }

/* ---- quiet rows ---- */
.trow { border-bottom: 1px solid var(--hairline); }
.trow summary { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 9px 4px; cursor: pointer; list-style: none; }
.trow summary::-webkit-details-marker { display: none; }
.trow summary:hover { background: var(--surface); }
.rtitle { font-weight: 500; }
.rmeta { margin-left: auto; text-align: right; }
.evrow { flex-basis: 100%; display: flex; gap: 12px; flex-wrap: wrap; padding-left: 44px; }
.ev { font-size: 12px; color: var(--ink-2); min-width: 0; overflow-wrap: anywhere; }
a.ev { color: var(--link); text-decoration: none; }
a.ev:hover { text-decoration: underline; }

/* ---- shared detail ---- */
details.more { margin-top: 10px; }
details.more summary { font-size: 12px; color: var(--ink-3); cursor: pointer; }
.body { white-space: pre-wrap; color: var(--ink-2); font-size: 13px; background: var(--page);
  border: 1px solid var(--hairline); border-radius: var(--radius-inner); padding: 10px 14px; margin: 8px 0; }
.trow .body { background: var(--surface); }
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
`;

// Refresh by replacement, preserving scroll and open disclosures — and paused
// while an answer is being composed, so the refresh never eats the human's
// half-written reasoning. Handlers ride document-level delegation, which
// survives body replacement. The ONLY non-GET this page ever sends is
// POST /answer, and only from the click flow below (H-90).
const JS = `
let last = Date.now();
setInterval(async () => {
  if (document.querySelector('.answer-form:not([hidden])')) return; // composing: hands off
  try {
    const r = await fetch(location.pathname, { cache: 'no-store' });
    if (!r.ok) return;
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const open = new Set([...document.querySelectorAll('details[open]')].map((d) => d.id).filter(Boolean));
    for (const id of open) doc.getElementById(id)?.setAttribute('open', '');
    const y = scrollY;
    document.body.replaceWith(doc.body);
    scrollTo(0, y);
    last = Date.now();
  } catch {}
}, 15000);
setInterval(() => {
  const el = document.getElementById('age');
  if (el) el.textContent = Math.round((Date.now() - last) / 1000) + 's ago';
}, 5000);

document.addEventListener('click', async (e) => {
  const opt = e.target.closest('button.option[data-label]');
  if (opt) {
    const card = opt.closest('.qcard');
    card.querySelectorAll('button.option').forEach((o) => o.classList.toggle('selected', o === opt));
    const form = card.querySelector('.answer-form');
    form.hidden = false;
    form.dataset.label = opt.dataset.label;
    form.querySelector('.af-label').textContent = opt.dataset.label;
    form.querySelector('.af-reason').focus();
    return;
  }
  const send = e.target.closest('.af-send');
  if (send) {
    const form = send.closest('.answer-form');
    const card = form.closest('.qcard');
    const status = form.querySelector('.af-status');
    const reason = form.querySelector('.af-reason').value.trim();
    send.disabled = true;
    status.classList.remove('err');
    status.textContent = 'recording…';
    try {
      const r = await fetch('/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-helmo-answer': document.documentElement.dataset.answer },
        body: JSON.stringify({
          ticket_id: card.dataset.ticket,
          chosen_option: form.dataset.label,
          reasoning: reason || undefined,
          resolution: form.querySelector('.af-res').value,
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

// The one write route (H-90). It exists only when HELMO_OPERATOR is set, and
// it does nothing the store's answerTicket wouldn't allow an orchestrator to
// relay in a meeting — the dashboard just lets the human say it directly.
function handleAnswer(
  headers: Record<string, string | string[] | undefined>,
  body: string,
  res: { writeHead: (c: number, h: Record<string, string>) => void; end: (s: string) => void },
): void {
  const json = (code: number, v: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(v));
  };
  if (!operator) return json(403, { error: 'No operator configured: set HELMO_OPERATOR to enable answering from the dashboard.' });
  // Browser CSRF gate (H-145). A cross-origin page can send a "simple" POST
  // without preflight; a custom header and a JSON content-type both force a
  // preflight, which this server never answers — so the browser never sends
  // it. Origin is checked when present as belt-and-braces.
  const h = (k: string) => (Array.isArray(headers[k]) ? headers[k]![0] : headers[k]) ?? '';
  if (!h('content-type').toLowerCase().startsWith('application/json')) return json(403, { error: 'answers must be application/json' });
  if (h('origin') && !sameOrigin.has(h('origin'))) return json(403, { error: 'cross-origin answer refused' });
  if (h('sec-fetch-site') && h('sec-fetch-site') !== 'same-origin' && h('sec-fetch-site') !== 'none') return json(403, { error: 'cross-site answer refused' });
  if (h(ANSWER_HEADER) !== answerNonce) return json(403, { error: 'missing or stale answer token — reload the dashboard' });
  try {
    const p = JSON.parse(body) as { ticket_id?: string; chosen_option?: string; reasoning?: string; resolution?: string };
    if (!p.ticket_id || !p.chosen_option) return json(400, { error: 'ticket_id and chosen_option are required.' });
    const actor: Actor = { name: operator, kind: 'human', session: 'dashboard' };
    const answer = p.reasoning?.trim() ? `${p.chosen_option} — ${p.reasoning.trim()}` : p.chosen_option;
    const resolution = (['resume', 'done', 'cancelled'].includes(p.resolution ?? '') ? p.resolution : 'resume') as 'resume' | 'done' | 'cancelled';
    const t = store.answerTicket(actor, p.ticket_id, { answer, chosen_option: p.chosen_option, resolution });
    return json(200, { ok: true, id: t.id, status: t.status });
  } catch (e) {
    return json(e instanceof HelmoError ? 400 : 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** The queue reading as JSON (R-11 H-832), for the estate shell to compose on
 *  its own origin — see src/feed.ts for why this is the one view the shell
 *  draws itself instead of proxying.
 *
 *  It reads and never writes, whatever method asks — like the page it sits
 *  beside, and unlike /answer above, which is the one route on this server
 *  that touches the record and is gated accordingly. */
function handleFeed(res: { writeHead: (c: number, h: Record<string, string>) => void; end: (s: string) => void }): void {
  try {
    const tickets = store.listTickets({ limit: 1000 });
    const progress = store.latestProgress(tickets.map((t) => t.id));
    const body = JSON.stringify(feed(
      tickets,
      store.actorKinds(),
      new Date(),
      (id) => store.productAcceptance(id),
      (id) => progress.get(id),
    ));
    // no-store for the same reason the page is not cached: this is a reading
    // of right now, and the shell refreshes it on a timer.
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  } catch (e) {
    // Named, not generic: an unreadable feed sends whoever is holding a phone
    // looking for which of five services is down, and this one can say.
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: `helmo tickets.json failed — ${e instanceof Error ? e.message : String(e)}` }));
  }
}

createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/answer') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handleAnswer(req.headers, body, res));
    return;
  }
  if (req.url?.split('?')[0] === '/tickets.json') return handleFeed(res);
  try {
    // Render BEFORE the headers go out. Writing 200 first meant any error in
    // page() hit a catch that could no longer set a status — the writeHead(500)
    // threw ERR_HTTP_HEADERS_SENT, unhandled, and took the whole view process
    // down. A render bug should be a 500 you can read, not a dead dashboard.
    const html = page();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(e instanceof Error ? (e.stack ?? e.message) : e));
  }
}).listen(port, host, () =>
  console.log(`Helmo view: http://localhost:${port} — db: ${dbPath}${operator ? ` — answers enabled for ${operator}` : ' (read-only; set HELMO_OPERATOR to answer)'}`),
);
