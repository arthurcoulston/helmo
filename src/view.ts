#!/usr/bin/env node
// The Helmo view: read-only, agent-written, human-read (H-2).
// One file, zero dependencies, no build step beyond tsc. The read-only
// constraint is constitutional: the only interactive elements are disclosure
// toggles and evidence hyperlinks — no affordance on this page mutates state.
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { HygieneFinding } from './store.js';
import { Ticket, HelmoEvent } from './types.js';

const dbPath = process.env['HELMO_DB'] ?? join(homedir(), '.helmo', 'helmo.db');
const port = Number(process.env['HELMO_VIEW_PORT'] ?? 4400);
const host = process.env['HELMO_VIEW_HOST'] ?? '127.0.0.1';
const store = new Store(dbPath);

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

// ---------- small renderers ----------

function rel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d}d ago` : new Date(iso).toISOString().slice(0, 10);
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

function chain(t: Ticket): string {
  const c = store.agentChain(t.id);
  return c.length ? `<span class="chain">${esc(c.map((a) => a.split(' ')[0]).join(' → '))}</span>` : '';
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
        e.event_type === 'answered' ? 'answered' : '';
      return `<div class="tl"><span class="tl-when">${esc(rel(e.ts))}</span><span class="tl-who">${esc(e.actor.name)}</span>${
        what ? `<span class="tl-what">${what}</span>` : ''
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

// The hero: a question awaiting the human. Everything the agent prepared is shown.
function questionCard(t: Ticket): string {
  const q = t.question;
  if (!q) return '';
  return `<article class="qcard" id="${esc(t.id)}">
    <header><span class="tid">${esc(t.id)}</span> <span class="qtitle">${esc(t.title)}</span>
      <span class="meta">${esc(t.workstream)} · asked ${esc(rel(t.updated_at))} ${blastBadge(t)}</span></header>
    <p class="situation">${esc(q.situation)}</p>
    <p class="question">${esc(q.question)}</p>
    <div class="options">${q.options
      .map((o) => `<div class="option"><span class="opt-label">${esc(o.label)}</span><span class="opt-consequence">${esc(o.consequence)}</span></div>`)
      .join('')}</div>
    <p class="rec"><span class="rec-mark">agent recommends</span> ${esc(q.recommendation)}</p>
    ${q.if_unanswered ? `<p class="silence">⏱ If unanswered: ${esc(q.if_unanswered)}</p>` : ''}
    <details class="more" id="d-${esc(t.id)}"><summary>ticket detail</summary>${details(t)}</details>
  </article>`;
}

// In motion: who holds it, what they last said, how far it reaches.
function motionCard(t: Ticket): string {
  const note = lastNote(t);
  return `<article class="mcard" id="${esc(t.id)}">
    <header><span class="tid">${esc(t.id)}</span> <span class="mtitle">${esc(t.title)}</span>
      ${prioBadge(t)} ${blastBadge(t)} ${money(t)}
      <span class="meta">${esc(t.workstream)} · <b class="holder">${esc(t.assignee ?? '?')}</b> · ${esc(rel(t.updated_at))}</span></header>
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
      ${noEv ? '<span class="badge critical">✱ no evidence</span>' : ''}
      ${confBadge(t)} ${blastBadge(t)}
      <span class="rmeta">${esc(t.workstream)} · ${esc(t.type)}${t.assignee ? ` · ${esc(t.assignee)}` : ''} ${money(t)} · ${esc(
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
  const rows = store.listWorkstreamInfo().filter((w) => w.goal || w.budget_usd !== null);
  if (!rows.length) return '';
  return `<section class="groom"><h2>Workstream steering</h2>
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
  const all = store.listTickets({ limit: 1000 });
  const by = (s: string) => all.filter((t) => t.status === s);
  const awaiting = by('awaiting_human');
  const motion = by('in_progress');
  const standing = by('open').filter((t) => t.schedule); // recurring templates (H-22)
  const open = by('open').filter((t) => !t.schedule);
  const ready = open.filter((t) => !store.isBlocked(t.id));
  const blocked = open.filter((t) => store.isBlocked(t.id));
  const done = by('done');
  const cancelled = by('cancelled');
  const spend = all.reduce((s, t) => s + (t.cost_usd_total || 0), 0);

  const stat = (n: number, label: string, cls = '') => `<div class="stat ${cls}"><div class="stat-n">${n}</div><div class="stat-l">${label}</div></div>`;

  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Helmo</title>
<style>${CSS}</style>
<body>
<header class="top">
  <div class="brand"><h1>Helmo</h1><span class="tagline">agents write · you read</span></div>
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

<footer>read-only · ${esc(dbPath)} · refreshed <span id="age">just now</span></footer>
<script>${JS}</script>
</body></html>`;
}

// Chrome and ink tokens follow the reference palette (dataviz skill): fixed
// status colors always ride with a text label, never color alone.
const CSS = `
:root {
  color-scheme: light dark;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --hairline: #e1e0d9; --border: rgba(11,11,11,0.10);
  --good: #0ca30c; --good-text: #006300; --warning: #fab219; --serious: #ec835a; --critical: #d03b3b;
  --accent: #2a78d6; --amber-wash: rgba(250,178,25,0.08);
}
@media (prefers-color-scheme: dark) { :root {
  --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
  --hairline: #2c2c2a; --border: rgba(255,255,255,0.10);
  --good-text: #0ca30c; --accent: #3987e5; --amber-wash: rgba(250,178,25,0.06);
} }
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 28px 32px 64px; max-width: 1080px; background: var(--page); color: var(--ink);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
.top { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
.brand h1 { font-size: 26px; margin: 0; letter-spacing: -0.02em; display: inline; }
.tagline { color: var(--muted); margin-left: 10px; font-size: 13px; }
.stats { display: flex; gap: 22px; }
.stat-n { font-size: 22px; font-weight: 650; letter-spacing: -0.02em; }
.stat-l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.stat.hot .stat-n { color: var(--warning); }
.stat.calm .stat-n { color: var(--good-text); }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--muted); font-weight: 600;
  margin: 34px 0 10px; padding-top: 14px; border-top: 1px solid var(--hairline); }
.allclear { color: var(--good-text); font-size: 15px; }
.groom .gitem { margin: 3px 0; font-size: 12.5px; color: var(--ink-2); }
.groom .gdetail { color: var(--muted); }
.tid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); white-space: nowrap; }
.spend { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12px; white-space: nowrap; }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); white-space: nowrap; }
.badge.neutral { color: var(--ink-2); }
.badge.warning { color: #8a5c00; background: var(--amber-wash); border-color: transparent; }
.badge.serious { color: var(--serious); }
.badge.critical { color: var(--critical); font-weight: 600; }
.badge.accent { color: var(--accent); }
.badge.quiet { color: var(--muted); }
@media (prefers-color-scheme: dark) { .badge.warning { color: var(--warning); } }
.meta, .rmeta { color: var(--muted); font-size: 12px; }
.chain { color: var(--muted); font-size: 11px; font-family: ui-monospace, monospace; }

/* ---- question cards (the hero) ---- */
.qcard { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--warning);
  border-radius: 10px; padding: 18px 22px; margin: 12px 0; }
.qcard header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.qtitle { font-weight: 600; }
.situation { color: var(--ink-2); margin: 10px 0 6px; }
.question { font-size: 19px; font-weight: 650; letter-spacing: -0.01em; margin: 8px 0 12px; }
.options { display: grid; gap: 6px; margin: 0 0 12px; }
.option { display: grid; grid-template-columns: 150px 1fr; gap: 12px; padding: 7px 10px;
  border: 1px solid var(--hairline); border-radius: 8px; }
.opt-label { font-weight: 600; font-size: 13px; }
.opt-consequence { color: var(--ink-2); font-size: 13px; }
.rec { margin: 0 0 6px; }
.rec-mark { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--good-text); font-weight: 650; margin-right: 8px; }
.silence { color: var(--muted); font-size: 12.5px; margin: 0; }

/* ---- in-motion cards ---- */
.mcard { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 13px 18px; margin: 10px 0; }
.mcard header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.mtitle { font-weight: 600; }
.holder { color: var(--accent); font-weight: 600; }
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
.ev { font-size: 12px; color: var(--ink-2); }
a.ev { color: var(--accent); text-decoration: none; }
a.ev:hover { text-decoration: underline; }

/* ---- shared detail ---- */
details.more { margin-top: 10px; }
details.more summary { font-size: 12px; color: var(--muted); cursor: pointer; }
.body { white-space: pre-wrap; color: var(--ink-2); font-size: 13px; background: var(--page);
  border: 1px solid var(--hairline); border-radius: 8px; padding: 10px 14px; margin: 8px 0; }
.trow .body { background: var(--surface); }
.uncertain { color: var(--serious); font-size: 13px; margin: 6px 0; }
.dep { font-size: 12.5px; color: var(--ink-2); margin: 2px 0; }
.dep-label { color: var(--muted); text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.05em; margin-right: 6px; }
.tl-wrap { margin: 10px 0 4px; border-left: 2px solid var(--hairline); padding-left: 14px; }
.tl { margin: 7px 0; font-size: 12.5px; }
.tl-when { color: var(--muted); margin-right: 8px; font-variant-numeric: tabular-nums; }
.tl-who { color: var(--accent); font-weight: 600; margin-right: 8px; }
.tl-what { color: var(--muted); font-style: italic; margin-right: 8px; }
.tl-note { color: var(--ink-2); display: block; margin-top: 1px; }
footer { margin-top: 48px; color: var(--muted); font-size: 11.5px; border-top: 1px solid var(--hairline); padding-top: 12px; }
`;

// Refresh by replacement, preserving scroll and open disclosures. Read-only:
// this script fetches and renders; it never sends anything but GET /.
const JS = `
let last = Date.now();
setInterval(async () => {
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
`;

createServer((_req, res) => {
  try {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page());
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(e));
  }
}).listen(port, host, () => console.log(`Helmo view (read-only): http://localhost:${port} — db: ${dbPath}`));
