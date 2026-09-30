#!/usr/bin/env node
// The roadmap view: agent-written, human-read, and — unlike Helmo's dashboard,
// which carries the one answer route — fully read-only. Ship-next at the top,
// expanded; everything below it collapsed, in derived rank order. One file,
// zero dependencies, no build step beyond tsc.
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { AVATAR_MARKS, ESTATE_AVATARS } from './estate-avatars.generated.js';
import { installationLine, requestedInstallation, requireInstallation } from './install.js';
import { ESTATE_TOKENS } from './estate-tokens.generated.js';
import { Store } from './store.js';
import { ActorKind, Claim, Project, Ranked, RoadmapEvent } from './types.js';

const install = requireInstallation(process.env, undefined, requestedInstallation(process.argv.slice(2)));
const dbPath = install.db;
// The view may be the first thing to touch a fresh store — don't crash on a
// missing home directory (caught by launchd on first boot).
mkdirSync(install.home, { recursive: true });
const port = Number(process.env['ROADMAP_VIEW_PORT'] ?? 4410);
const host = process.env['ROADMAP_VIEW_HOST'] ?? '127.0.0.1';
const store = new Store(dbPath);

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

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

// ---------- actors ----------

// Kinds read from the record, rebuilt once per page render. Module-level for
// the same reason `store` is: every renderer here is a free function, and
// threading a map through all of them would be the only change of shape.
let actorKinds = new Map<string, ActorKind>();

const MARKS = new Set<string>(AVATAR_MARKS);

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
 *  A name with no mark and no recorded kind renders bare — a new agent, or a
 *  name the roadmap has never seen write, is not a defect.
 *
 *  `known` is the kind the caller already has in hand: an event carries the
 *  kind its writer declared at the time, which is better than the store-wide
 *  answer this falls back to. Both are read from the record; neither is a
 *  guess from the name. */
/** A reference the operator might carry into a conversation, drawn with the
 *  one control that copies it. Arthur asked for copy icons "across the
 *  harness beside things he might take into an agent conversation" (H-2364)
 *  and named roadmap items alongside tickets — so every visible R- and OBJ-
 *  id on this page comes from here, which is what makes "it can always be
 *  copied" a property of the code rather than a habit. Helmo's view.ts holds
 *  the same renderer, spelled the same way, for the same reason.
 *
 *  What lands on the clipboard is `id` and nothing else: it comes off
 *  `data-copy`, never off the rendered text, so a rank, a badge or a future
 *  prefix beside it cannot end up in what he pastes.
 *
 *  `cls` is the class the id already carried here — `pid` for a project,
 *  `oid` for an objective or bet — so the page keeps the two distinct. */
function ref(id: string, cls: 'pid' | 'oid'): string {
  return `<span class="${cls}">${esc(id)}<button type="button" class="copy" data-copy="${esc(id)}" aria-label="Copy ${esc(id)}" title="Copy ${esc(id)}">⧉</button></span>`;
}

/** A title, drawn so a long one scans like a short one — the same rule helmo's
 *  view applies to ticket titles, and for the same reason (H-2476).
 *
 *  Roadmap titles are shorter than Helmo's but follow the shape even more
 *  strongly: "Release 1A: …", "Estate CI: every repo's tests run on push, red
 *  files a ticket". The lead is the handle the writer already chose; drawing
 *  it at the title's weight and the remainder quieter is presentation only.
 *  No stored field, no title rewritten — that was I4's open question and the
 *  measurement answered it no.
 *
 *  What renders is byte-identical to what is stored: the separator is kept and
 *  nothing is clipped, so selection, find-in-page and a screen reader still get
 *  the whole title. Both spans are inert, and they sit inside the existing
 *  `.rtoggle` button, so this adds nothing interactive. */
const TITLE_BREAK = /^(.{4,48}?)(: | — | – )(.{12,})$/;

function title(text: string, cls: string): string {
  const m = TITLE_BREAK.exec(text);
  if (!m) return `<span class="${cls}">${esc(text)}</span>`;
  return `<span class="${cls}">${esc(m[1])}<span class="tdetail">${esc(m[2] + m[3])}</span></span>`;
}

function actor(name: string, known?: ActorKind): string {
  const kind = known ?? actorKinds.get(name);
  // `person` is the fallback for a human with no role mark; an agent with no
  // mark gets none. Nothing here maps a member to a kind or invents a mark —
  // both are read (estate DEV.md, "kind is read, never asserted").
  const mark = MARKS.has(name) ? name : kind === 'human' && MARKS.has('person') ? 'person' : null;
  const glyph =
    mark && kind
      ? `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><use href="#crew-${esc(mark)}-${esc(kind)}"/></svg>`
      : '';
  return `<span class="actor">${glyph}${esc(name)}</span>`;
}

function claimLine(c: Claim | null): string {
  if (!c) return '';
  const what = c.kind === 'value' ? `value ${c.level}` : `effort ${c.size}${c.predicted_usd ? ` ~$${c.predicted_usd}` : ''}`;
  return `<span class="claim"><b>${esc(what)}</b> — ${esc(c.reason)} <span class="attr">(${actor(c.author)}, ${esc(rel(c.ts))})</span></span>`;
}

function money(p: Project, effort: Claim | null): string {
  const pred = effort?.predicted_usd;
  if (!p.actual_usd && !pred) return '';
  const parts = [];
  if (pred) parts.push(`$${pred} predicted`);
  if (p.actual_usd) parts.push(`$${p.actual_usd.toFixed(2)} metered`);
  return `<span class="spend">${parts.join(' · ')}</span>`;
}

function timeline(events: RoadmapEvent[]): string {
  const items = events.map((e) => {
    const note = (e.payload['note'] as string) ?? (e.payload['reason'] as string) ?? (e.payload['claim'] as string) ?? '';
    const what =
      e.event_type === 'created' ? 'filed' :
      e.event_type === 'ship_next_set' ? `SHIP NEXT — decided by ${esc(e.payload['decided_by'])}` :
      e.event_type === 'claim_recorded' ? `${e.payload['kind']} claim` :
      e.event_type === 'readiness_verdict_recorded' ? `readiness ${esc(e.payload['verdict'])}` :
      e.event_type === 'cited' ? `cited ${esc(e.payload['objective_id'])}` :
      e.event_type === 'actual_recorded' ? `metered $${e.payload['actual_usd']}` :
      e.event_type === 'updated' ? statusMove(e) : '';
    return `<div class="tl"><span class="tl-when">${esc(rel(e.ts))}</span><span class="tl-who">${actor(e.actor.name, e.actor.kind)}</span>${
      what ? `<span class="tl-what">${what}</span>` : ''
    }${note ? `<span class="tl-note">${esc(note)}</span>` : ''}</div>`;
  });
  return items.length ? `<div class="tl-wrap">${items.join('')}</div>` : '';
}

function statusMove(e: RoadmapEvent): string {
  const d = (e.payload['diffs'] as Record<string, { from: unknown; to: unknown }> | undefined)?.['status'];
  return d ? `${esc(d.from)} → ${esc(d.to)}` : '';
}

function details(r: Ranked): string {
  const deps = store.getDeps(r.project.id);
  const related = [...deps.outgoing.filter((d) => d.type === 'relates').map((d) => d.to_id), ...deps.incoming.filter((d) => d.type === 'relates').map((d) => d.from_id)];
  return `${r.project.body ? `<div class="body">${esc(r.project.body)}</div>` : ''}
  ${r.project.status === 'parked' && (r.project.parked_reason || r.project.unpark_condition)
    ? `<div class="park">${r.project.parked_reason ? `parked: ${esc(r.project.parked_reason)}` : ''}${r.project.unpark_condition ? ` <b>unparks when:</b> ${esc(r.project.unpark_condition)}` : ''}</div>`
    : ''}
  ${r.citations.map((c) => `<div class="cite">${ref(c.objective_id, 'oid')} ${esc(c.claim)}</div>`).join('')}
  ${claimLine(r.value)}${claimLine(r.effort)}
  ${r.blocked_by.length ? `<div class="park">⛔ waits on ${esc(r.blocked_by.join(', '))}</div>` : ''}
  ${related.length ? `<div class="park">related: ${esc(related.join(', '))}</div>` : ''}
  ${timeline(store.getEvents(r.project.id))}`;
}

// The hero cards: the work phase — everything the human has declared go on.
function shipNextCard(r: Ranked): string {
  const decision = [...store.getEvents(r.project.id)].reverse().find((e) => e.event_type === 'ship_next_set');
  // `decided_by` is drawn as a human, and that is read from the record's own
  // contract rather than guessed from the name: setShipNext refuses the write
  // without one and calls it "the human who made the call" — entering the work
  // phase is never an agent's judgment. Without this the most consequential
  // attribution on the page falls back to the store-wide map and finds nothing,
  // because Arthur never writes here himself; an orchestrator relays his call.
  return `<article class="hero-card" id="${esc(r.project.id)}">
    <header>${ref(r.project.id, 'pid')} ${title(r.project.title, 'htitle')}
      <span class="meta">${money(r.project, r.effort)} · ${esc(rel(r.project.updated_at))}</span></header>
    ${decision ? `<p class="decision"><span class="dmark">ship next</span> decided by <b>${actor(String(decision.payload['decided_by'] ?? ''), 'human')}</b>, ${esc(rel(decision.ts))} — ${esc(decision.payload['reason'])}</p>` : ''}
    ${r.project.body ? `<div class="body">${esc(r.project.body)}</div>` : ''}
    ${r.citations.map((c) => `<div class="cite">${ref(c.objective_id, 'oid')} ${esc(c.claim)}</div>`).join('')}
    ${claimLine(r.value)}${claimLine(r.effort)}
    <details class="more" id="d-${esc(r.project.id)}"><summary>history</summary>${timeline(store.getEvents(r.project.id))}</details>
  </article>`;
}

/** Deliberately NOT <details>/<summary>. The row draws its own reference
 *  through ref(), which brings a copy control with it, and a <summary> is an
 *  interactive element — so a button inside one is axe's `nested-interactive`
 *  (serious), and a real defect: a screen reader cannot reach the copy control
 *  separately from the disclosure, and a pointer gesture over the two is
 *  ambiguous between copying and opening (H-2447). Helmo's view.ts spells the
 *  same disclosure the same way, for the same reason. The rank and the
 *  explanation sit beside the button rather than inside it, which keeps the
 *  row drawing exactly as it did — the explanation's indent is measured from
 *  the row's edge, not the button's. */
function row(r: Ranked): string {
  const p = r.project;
  const noCite = !r.citations.length && store.listObjectives().length > 0;
  const panel = `b-${esc(p.id)}`;
  return `<div class="prow" id="${esc(p.id)}">
    <div class="rhead">
      <span class="rank">${r.rank}</span>
      ${ref(p.id, 'pid')}
      <button type="button" class="rtoggle" aria-expanded="false" aria-controls="${panel}">
        ${title(p.title, 'rtitle')}
        <span class="badge quiet">${esc(STATUS_LABEL[p.status] ?? p.status)}</span>
        ${r.blocked_by.length ? `<span class="badge serious">⛔ waits on ${esc(r.blocked_by.join(', '))}</span>` : ''}
        ${noCite ? '<span class="badge quiet">∅ advances nothing stated</span>' : ''}
        <span class="rmeta">${money(p, r.effort)} · ${esc(rel(p.updated_at))}</span>
      </button>
      <span class="explain">${esc(r.explanation)}</span>
    </div>
    <div class="rbody" id="${panel}" hidden>${details(r)}</div>
  </div>`;
}

const STATUS_LABEL: Record<string, string> = {
  ship_next: 'ship next',
  shipped_watching: 'watching',
  shipped_stable: 'stable',
};

// Off-list rows: shipped (watching/stable) and archived projects carry no
// rank — the body and the trail are what a reader comes for.
function shelfRow(p: Project): string {
  const panel = `b-${esc(p.id)}`;
  return `<div class="prow" id="${esc(p.id)}">
    <div class="rhead">${ref(p.id, 'pid')}
      <button type="button" class="rtoggle" aria-expanded="false" aria-controls="${panel}">
        ${title(p.title, 'rtitle')}
        <span class="badge quiet">${esc(STATUS_LABEL[p.status] ?? p.status)}</span>
        <span class="rmeta">${p.actual_usd ? `$${p.actual_usd.toFixed(2)} metered · ` : ''}${esc(rel(p.closed_at ?? p.updated_at))}</span>
      </button>
    </div>
    <div class="rbody" id="${panel}" hidden>
      ${p.body ? `<div class="body">${esc(p.body)}</div>` : ''}
      ${timeline(store.getEvents(p.id))}
    </div>
  </div>`;
}

// The charter projection: the human's hand, read-only here by double measure.
function charterStrip(): string {
  const objectives = store.listObjectives();
  const bets = store.listBets();
  if (!objectives.length && !bets.length) return '';
  return `<section class="charter"><h2>Charter</h2>
    ${objectives
      .map((o) => `<p class="citem">${ref(o.id, 'oid')}<span class="crank">#${o.rank}</span>
        <span class="cstate">${esc(o.statement)}</span> <span class="attr">${esc(o.horizon)} · from ${esc(o.source)}</span></p>`)
      .join('')}
    ${bets
      .map((b) => `<p class="citem">${ref(b.id, 'oid')}
        <span class="cstate">${esc(b.statement)}</span> <span class="attr">stake: ${esc(b.stake)} · falsified by: ${esc(b.falsifier)}</span></p>`)
      .join('')}
  </section>`;
}

function page(): string {
  // One query per render, not one per actor drawn: the map is store-wide
  // and every renderer above reaches for it.
  actorKinds = store.actorKinds();
  const ranked = store.rankProjects();
  const shipNext = ranked.filter((r) => r.project.status === 'ship_next');
  const rest = ranked.filter((r) => r.project.status !== 'ship_next');
  const all = store.dumpState()['projects'] as Project[];
  const watching = all.filter((p) => p.status === 'shipped_watching');
  const stable = all.filter((p) => p.status === 'shipped_stable');
  const archived = all.filter((p) => p.status === 'archived');

  const stat = (n: number, label: string, alarm = false) =>
    `<div class="stat"><div class="stat-n${alarm ? ' alarm' : ''}">${n}</div><div class="stat-l">${label}</div></div>`;
  const count = (s: string) => ranked.filter((r) => r.project.status === s).length;

  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roadmap</title>
<style>${CSS}</style>
<body>
${ESTATE_AVATARS}
<header class="top">
  <div class="brand"><h1>Roadmap</h1><span class="tagline">work worth doing · agents write, you read</span></div>
  <div class="stats">
    ${stat(shipNext.length, 'ship next', shipNext.length >= 3)}${stat(watching.length, 'watching')}${stat(count('ready'), 'ready')}${stat(count('shaping'), 'shaping')}${stat(count('parked'), 'parked')}
  </div>
</header>

<section class="hero">
  <h2>Ship next${shipNext.length ? ` (${shipNext.length})` : ''}</h2>
  ${shipNext.length >= 3 ? '<p class="alarm-note">A growing work phase is a problem — what here is close enough to move to watching?</p>' : ''}
  ${shipNext.length ? shipNext.map(shipNextCard).join('') : '<p class="allclear">Nothing has the go-ahead. The list below is ranked and waiting for your call.</p>'}
</section>

${charterStrip()}

${watching.length ? `<section><h2>Shipped — watching</h2>${watching.map(shelfRow).join('')}</section>` : ''}

<section><h2>The list</h2>
${rest.length ? rest.map(row).join('') : '<p class="allclear">Empty. Ideas cost a title and a sentence.</p>'}
</section>

${stable.length ? `<section><h2>Shipped — stable</h2>${stable.map(shelfRow).join('')}</section>` : ''}
${archived.length ? `<section><h2>Archived (${archived.length})</h2>${archived.map(shelfRow).join('')}</section>` : ''}

<footer>read-only — the record is written by agents, including your decisions · ${esc(dbPath)} · refreshed <span id="age">just now</span></footer>
<span id="copy-status" class="sr-only" role="status" aria-live="polite"></span>
<script>${JS}</script>
</body></html>`;
}

// Chrome, ink and shape come from the estate's design tokens, vendored
// (R-11 H-714): one visual system across Helmo, the roadmap, rev, the health
// page and the estate shell. The roadmap keeps its own token names and every
// rule below is unchanged — the aliases are the whole seam, so a look ratified
// upstream restyles this page without it being touched. Status colours stay the
// roadmap's own and the block below says why.
//
// ESTATE_TOKENS goes first: the aliases read from it, and it brings the dark
// values under prefers-color-scheme, which is what a page with no theme
// switch needs.
const CSS = `
${ESTATE_TOKENS}
:root {
  color-scheme: light dark;
  --page: var(--background); --surface: var(--card); --ink: var(--foreground);
  /* The roadmap runs a three-step ink ladder where shadcn has two; the middle
     step is mixed rather than picked, so a look change carries it too. */
  --ink-2: color-mix(in oklab, var(--foreground) 72%, var(--background));
  --ink-3: var(--muted-foreground);
  --hairline: var(--border);
  --radius-card: var(--radius); --radius-inner: calc(var(--radius) * 0.8);

  /* Status and link were the one part of this page shadcn had nothing for, so
     they were held back as literals until the estate grew a ramp of its own
     (H-771). Now they alias like everything else, and the dark overrides are
     gone because the ramp is themed. --serious moves: it was #ec835a, which is
     2.64:1 on white — a chart mark in the reference palette, not text, and
     this page renders it as an alarm note and a badge. It takes the estate's
     deepened light step. Colour still always rides with a text label. */
  --good-text: var(--status-good); --serious: var(--status-serious); --link: var(--interactive);
}
* { box-sizing: border-box; }
/* Every string on this page came out of the store, and project bodies are full
   of absolute paths, commit refs and URLs — tokens with no space to break at.
   One of them in a phone-width column pushes the whole document sideways: this
   page was 505px wide in a 390px viewport, and because the width belongs to a
   text node rather than an element there was nothing to point at (R-11
   H-1176). Declared once, at the root, rather than on each prose selector,
   because the next surface that renders a body should not have to learn this.
   Value anywhere rather than break-word: only anywhere also lowers
   min-content, so a grid or flex track shrinks to its box instead of being
   held open by the longest ref inside it. Anything that must stay on one line
   says white-space: nowrap, and that still wins. */
:root { overflow-wrap: anywhere; }
body { margin: 0 auto; padding: 28px 32px 64px; max-width: 1080px; background: var(--page); color: var(--ink);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
.top { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
.brand h1 { font-size: 26px; margin: 0; letter-spacing: -0.02em; display: inline; }
.tagline { color: var(--ink-3); margin-left: 10px; font-size: 13px; }
.stats { display: flex; gap: 22px; }
.stat-n { font-size: 22px; font-weight: 650; letter-spacing: -0.02em; }
.stat-n.alarm { color: var(--serious); }
.alarm-note { color: var(--serious); font-size: 12.5px; margin: 4px 0 8px; }
.stat-l { font-size: 11px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.06em; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--ink-3); font-weight: 600;
  margin: 34px 0 10px; padding-top: 14px; border-top: 1px solid var(--hairline); }
.allclear { color: var(--ink-3); font-size: 14px; }
.pid, .oid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--ink-3); white-space: nowrap; }
/* The copy control (H-2428, I12), spelled as it is in Helmo's view.ts. It is
   deliberately small beside a 12px monospace id and takes its 44px touch
   target from a transparent overlay instead of from bulk: a control sized to
   a finger would stand three times the height of the reference it belongs to,
   on every row of the page. An inset of -13px around an 18px box is exactly 44. */
.copy { position: relative; margin-left: 4px; padding: 0; width: 18px; height: 18px; line-height: 1;
  border: 0; border-radius: var(--radius-inner); background: none; color: var(--ink-3);
  font: inherit; cursor: pointer; vertical-align: -0.12em; }
.copy::after { content: ''; position: absolute; inset: -13px; }
.copy:hover { color: var(--link); }
.copy[data-copied='yes'] { color: var(--good-text); }
.copy[data-copied='no'] { color: var(--serious); }
/* Nothing on screen, everything to a screen reader: the copy result has no
   visual home of its own — the glyph swap is the sighted feedback — so it is
   announced through a live region rather than succeeding silently. */
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.spend { font-variant-numeric: tabular-nums; color: var(--ink-3); font-size: 12px; white-space: nowrap; }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--hairline); white-space: nowrap; }
.badge.serious { color: var(--serious); }
.badge.quiet { color: var(--ink-3); }
.meta, .rmeta { color: var(--ink-3); font-size: 12px; }
.attr { color: var(--ink-3); font-size: 11.5px; }

/* ---- ship-next hero ---- */
.hero-card { background: var(--surface); border: 1px solid var(--hairline); border-left: 3px solid var(--good-text);
  border-radius: var(--radius-card); padding: 18px 22px; margin: 12px 0; }
.hero-card header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.htitle { font-size: 19px; font-weight: 650; letter-spacing: -0.01em; }
.decision { margin: 10px 0 6px; color: var(--ink-2); }
.dmark { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--good-text); font-weight: 650; margin-right: 8px; }

/* ---- charter ---- */
.charter .citem { margin: 3px 0; font-size: 13px; color: var(--ink-2); }
.crank { color: var(--link); font-weight: 650; font-size: 12px; margin: 0 6px 0 8px; }
.cstate { color: var(--ink); }

/* ---- ranked rows ---- */
/* The head is a flex line whose items are siblings, never nested: the rank,
   the reference (which carries its own copy control), the disclosure button
   that owns the title and badges, and the explanation on its own wrapped line.
   The button is stripped back to inherited type and made a wrapping flex
   container, so the row draws as it did — see row() for why it is not a
   <summary>. */
.prow { border-bottom: 1px solid var(--hairline); }
.rhead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 9px 4px; }
.rtoggle { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
/* The one place the estate's --accent belongs: it is a hover SURFACE in
   shadcn's vocabulary, which is exactly this row's job. Aliasing it here rather
   than to --surface matters — --card and --background are the same white in
   the light palette, so a --surface hover would be no hover at all. */
.rhead:hover { background: var(--accent); }
.rank { font-variant-numeric: tabular-nums; color: var(--ink-3); font-size: 12px; min-width: 20px; text-align: right; }
.rtitle { font-weight: 500; }
/* The quieter half of a split title (H-2476). Weight and colour only; the text
   is the stored title's own remainder. */
.tdetail { font-weight: 400; color: var(--ink-2); }
.rmeta { margin-left: auto; text-align: right; }
.explain { flex-basis: 100%; color: var(--ink-3); font-size: 12px; padding-left: 30px; }

/* ---- shared detail ---- */
details.more { margin-top: 10px; }
details.more summary, .prow .rhead { font-size: 13.5px; }
details.more summary { font-size: 12px; color: var(--ink-3); cursor: pointer; }
.body { white-space: pre-wrap; color: var(--ink-2); font-size: 13px; background: var(--page);
  border: 1px solid var(--hairline); border-radius: var(--radius-inner); padding: 10px 14px; margin: 8px 0; }
.prow .body { background: var(--surface); }
.rbody[hidden] { display: none; }
.park { color: var(--ink-2); font-size: 12.5px; margin: 4px 0; }
.cite { font-size: 12.5px; color: var(--ink-2); margin: 3px 0; }
.claim { display: block; font-size: 12.5px; color: var(--ink-2); margin: 3px 0; }
.tl-wrap { margin: 10px 0 4px; border-left: 2px solid var(--hairline); padding-left: 14px; }
.tl { margin: 7px 0; font-size: 12.5px; }
.tl-when { color: var(--ink-3); margin-right: 8px; font-variant-numeric: tabular-nums; }
.tl-who { color: var(--link); font-weight: 600; margin-right: 8px; }
.tl-what { color: var(--ink-3); font-style: italic; margin-right: 8px; }
.tl-note { color: var(--ink-2); display: block; margin-top: 1px; }

/* ---- actors (R-11 H-713): the mark says who, the frame says what kind ---- */
/* nowrap is load-bearing, not tidiness: the rule the avatar set ships under is
   that a crew hue never identifies a member on its own, and a mark that wrapped
   to the end of a line away from its name would be doing exactly that. */
.actor { white-space: nowrap; }
/* Sized in em so one rule serves the 11.5px claim attribution and the 12.5px
   timeline alike. No colour here — the mark carries its member hue from the
   sprite, the frame is currentColor at .18, so an actor is whatever ink its
   context gives it. */
.mark { width: 1.15em; height: 1.15em; vertical-align: -0.22em; margin-right: 3px; }
footer { margin-top: 48px; color: var(--ink-3); font-size: 11.5px; border-top: 1px solid var(--hairline); padding-top: 12px; }
`;

// Refresh by replacement, preserving scroll and open disclosures.
const JS = `
let last = Date.now();

// Put text on the clipboard where navigator.clipboard is not there to do it.
// This is not a legacy nicety: the Clipboard API is secure-context only and
// this page is served over plain http, so a phone reading the estate over the
// LAN takes THIS path every time. Focus is borrowed and handed straight back,
// or the reader loses their place to an invisible textarea.
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

document.addEventListener('click', async (e) => {
  // The project rows' disclosure. <details> would open itself, but its
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
  if (!copy) return;
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
});

setInterval(async () => {
  // A focused disclosure or control belongs to the reader until they leave
  // it. This page had no such guard while everything on it was inert; a copy
  // button is focusable, so without this a reader tabbing to one would have
  // it pulled out from under them every fifteen seconds.
  if (document.activeElement && document.activeElement !== document.body) return;
  try {
    const r = await fetch(location.pathname, { cache: 'no-store' });
    if (!r.ok) return;
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const open = new Set([...document.querySelectorAll('details[open]')].map((d) => d.id).filter(Boolean));
    for (const id of open) doc.getElementById(id)?.setAttribute('open', '');
    // The project rows are a button and a panel rather than a <details>, so
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
    scrollTo(0, y);
    last = Date.now();
  } catch {}
}, 15000);
setInterval(() => {
  const el = document.getElementById('age');
  if (el) el.textContent = Math.round((Date.now() - last) / 1000) + 's ago';
}, 5000);
`;

createServer((req, res) => {
  try {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page());
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(e));
  }
}).listen(port, host, () => console.log(`Roadmap view: http://localhost:${port} — ${installationLine(install)}`));
