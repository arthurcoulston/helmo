/* The status palette, as far as a file can prove it.

   What is HERE: that the tokens are the exact colours Arthur approved, that
   every variable the views name is actually declared (CSS drops an undeclared
   one in silence and the element keeps its stock colour), that no colour
   literal has escaped into application code, that the stylesheet is imported at
   all, and what each state MEANS — the mappings, which are the part a reviewer
   is most likely to disagree with and the part no screenshot shows.

   What is NOT here: that the browser paints any of it. A ratio computed from
   two hexes is arithmetic, not a reading of a rendered surface, and a Tailwind
   class is only real if Tailwind generated it. `scripts/verify-ui.mjs` measures
   the computed colours of every role on every layout in both themes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const css = read('src/status.css');

/* Arthur's own approval, written out here rather than read from the stylesheet
   the way upstream.test.mjs carries his preset selection: a file that checks
   itself against itself passes any edit. Only he changes these. See UI.md and
   H-2978@dev.rev; the specimen is helmo-muted-palette.html in his 2026-10-06
   visualizations.

   Three roles are that specimen exactly. FAILURE is not: Arthur revised it in
   H-2987@dev.rev, on the same day and for a reason the specimen could not show
   him until it was on a page — all four roles came out the same weight, so red
   did not outrank amber. These two pairs are therefore chosen rather than
   picked off his specimen, which is why the margin below exists to say what
   they were chosen FOR. */
const APPROVED = {
  info: { light: ['#496A8A', '#EDF2F7'], dark: ['#A9C3DB', '#26333F'] },
  success: { light: ['#496B55', '#EDF4EF'], dark: ['#AECBB7', '#29372E'] },
  attention: { light: ['#886528', '#FAF3E5'], dark: ['#D9BD87', '#3D3424'] },
  failure: { light: ['#8A4145', '#F3D6D6'], dark: ['#E9B0B0', '#563636'] },
};

/* The ground each theme's roles sit on, which is what "stands out" is measured
   against. The light card and background are the same white; in dark the
   background is the darker of the two, so it is the one that flatters every
   tint equally and the one the comparison below uses. */
const GROUND = { light: '#ffffff', dark: '#0c090c' };

/** The declarations of one selector's block, as name → value. */
function block(selector) {
  const escaped = selector.replace(/[.:]/g, (c) => `\\${c}`);
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(match, `src/status.css declares no ${selector} block`);
  return Object.fromEntries([...match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

test('the tokens are the colours Arthur approved, in both themes', () => {
  const themes = { light: block(':root'), dark: block('.dark') };
  for (const [theme, declared] of Object.entries(themes)) {
    const expected = Object.fromEntries(Object.entries(APPROVED).flatMap(([role, pairs]) => [
      [`--helmo-${role}-ink`, pairs[theme][0]],
      [`--helmo-${role}-tint`, pairs[theme][1]],
    ]));
    assert.deepEqual(declared, expected, `the ${theme} tokens are not the approved palette`);
  }
});

/* sRGB relative luminance and WCAG contrast, on the hexes alone. */
const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => v / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('each ink reads on its own tint, and on every preset surface bare', () => {
  /* The frozen b6YWkyPAm surfaces an ink can land on, as sRGB. A role is
     applied to a badge (its tint), to an alert (its tint) and to text on the
     page itself, and the muted row of an expanded table is the darkest light
     one. Recomputed from src/index.css if the preset ever changes. */
  const surfaces = { light: ['#ffffff', '#f3f1f3'], dark: ['#0c090c', '#1d161e', '#2a212c'] };
  for (const [role, pairs] of Object.entries(APPROVED)) {
    for (const theme of ['light', 'dark']) {
      const [ink, tint] = pairs[theme];
      assert.ok(ratio(ink, tint) >= 4.5, `${role} ${theme} ink on its own tint: ${ratio(ink, tint).toFixed(2)}:1`);
      for (const surface of surfaces[theme]) {
        assert.ok(ratio(ink, surface) >= 4.5, `${role} ${theme} ink bare on ${surface}: ${ratio(ink, surface).toFixed(2)}:1`);
      }
      /* Stated, not asserted upward: the tint is deliberately near its
         surface, which is exactly why no role may rely on colour alone. */
      for (const surface of surfaces[theme]) {
        assert.ok(ratio(tint, surface) < 3, `${role} ${theme} tint now carries 3:1 against ${surface} — restate the rule before relying on it`);
      }
    }
  }
});

const sources = readdirSync(join(root, 'src')).filter((name) => name.endsWith('.tsx'));

test('every token the views name is declared, and no colour escaped the stylesheet', () => {
  const declared = new Set(Object.keys(block(':root')));
  const used = new Set();
  const literals = [];
  const hexes = new Set(Object.values(APPROVED).flatMap((pairs) => [...pairs.light, ...pairs.dark].map((h) => h.toUpperCase())));
  for (const name of sources) {
    const source = read(`src/${name}`);
    for (const [, token] of source.matchAll(/var\((--helmo-[\w-]+)\)/g)) used.add(token);
    /* A token spelled wrong is the silent failure this catches: CSS discards
       the declaration and the element keeps the colour it already had. */
    for (const [, token] of source.matchAll(/(--helmo-[\w-]+)/g)) {
      if (!declared.has(token)) literals.push(`${name} names ${token}, which src/status.css does not declare`);
    }
    for (const hex of source.matchAll(/#[0-9A-Fa-f]{6}\b/g)) {
      if (hexes.has(hex[0].toUpperCase())) literals.push(`${name} carries the literal ${hex[0]} — the tokens are where a colour lives`);
    }
  }
  assert.deepEqual(literals, []);
  /* An empty set would otherwise pass every assertion above it. */
  assert.deepEqual([...declared].filter((token) => !used.has(token)), [], 'a declared token nothing uses');
});

test('the stylesheet is actually imported by the application entry', () => {
  assert.match(read('src/App.tsx'), /^import "\.\/status\.css"$/m, 'nothing imports src/status.css, so every role paints as stock chrome');
});

/* ---------- what the colours mean ---------- */

const { acceptanceRole, loopStateRole, projectStatusRole, ticketStateRole, usageSeverityRole, inkRole, tintRole, StatusBadge, StatusAlert } = await import('../src/Status.tsx');

test('a deliberate or ordinary state takes no colour', () => {
  /* The restraint Arthur asked for, as a list: queued work, a capacity hold,
     a date gate and somebody's decision to stop a loop are the system working.
     Colouring them is how a backlog starts looking like an incident. */
  for (const status of ['open', 'done', 'cancelled']) assert.equal(ticketStateRole(status), null, status);
  for (const status of ['shaping', 'ready', 'parked', 'archived']) assert.equal(projectStatusRole(status), null, status);
  for (const state of ['IDLE', 'HOLD', 'STOP', 'PARKED', 'SEAT_HELD', 'halted']) assert.equal(loopStateRole(state), null, state);
  for (const severity of ['normal', 'unknown']) assert.equal(usageSeverityRole(severity), null, severity);
  assert.equal(acceptanceRole('not_requested', 'no_completion'), null);
  assert.equal(acceptanceRole('pending', 'awaiting_verdict'), null);
});

test('what needs Arthur is amber and what has failed is red', () => {
  assert.equal(ticketStateRole('awaiting_human'), 'attention');
  assert.equal(projectStatusRole('blocked'), 'attention');
  for (const state of ['BLOCKED', 'BACKOFF', 'LIMIT', 'UNKNOWN']) assert.equal(loopStateRole(state), 'attention', state);
  assert.equal(usageSeverityRole('warning'), 'attention');
  for (const state of ['WEDGED', 'CRASHED']) assert.equal(loopStateRole(state), 'failure', state);
  assert.equal(usageSeverityRole('critical'), 'failure');
  assert.equal(acceptanceRole('failed', 'rejected'), 'failure');
  /* Two reviewers disagreeing about whether work is sound is not a pending
     review: nobody else resolves it. */
  assert.equal(acceptanceRole('accepted', 'contested'), 'failure');
  assert.equal(acceptanceRole('accepted', 'independently_accepted'), 'success');
});

test('failure stands further off the page than any other role, in both themes', () => {
  /* Arthur's decision in H-2987@dev.rev, as the one measurable thing it asked
     for: red reads louder than amber. The specimen he first approved did not do
     this — its four tints were 1.10, 1.12, 1.12 and 1.14 against white, so the
     role meaning "this needs you now" carried the same weight as the one
     meaning "this is waiting for you", and a reader had only the word to go on.

     Asserted on the TINT because that is what carries the weight at table
     density: a chip's fill is a block an eye crosses the page to, and its ink
     is four words. Asserted as an ordering with a floor under the margin rather
     than as four fixed ratios, because the point is the relationship — a future
     revision may move any of these colours, and what must not survive it is
     failure quietly flattening back to the rest. */
  for (const [theme, ground] of Object.entries(GROUND)) {
    const standoff = Object.fromEntries(Object.entries(APPROVED).map(([role, pairs]) => [role, ratio(pairs[theme][1], ground)]));
    const { failure, ...rest } = standoff;
    const loudest = Math.max(...Object.values(rest));
    assert.ok(
      failure >= loudest + 0.2,
      `${theme}: failure's tint stands off ${ground} at ${failure.toFixed(3)}:1 and the loudest of the other three at ${loudest.toFixed(3)}:1 — red has to outrank amber (${JSON.stringify(standoff)})`,
    );
  }
});

test('in motion is blue and a shipped project that settled is green', () => {
  assert.equal(ticketStateRole('in_progress'), 'info');
  assert.equal(projectStatusRole('ship_next'), 'info');
  assert.equal(projectStatusRole('shipped_watching'), 'info');
  assert.equal(projectStatusRole('shipped_stable'), 'success');
  assert.equal(loopStateRole('RUNNING'), 'info');
});

test('the condensed roster cannot disagree with Runtime about severity', async () => {
  /* Overview's Team now card chips an AGENT's rolled-up state where Runtime's
     table chips a SESSION's own state word. Two surfaces, one meaning: the
     roll-up may decide which session speaks for an agent, and it may never
     decide that WEDGED is less serious when it is said about an agent.

     Checked state word by state word against the real mapping, so a new
     sentinel state can only be added in one place without this failing. */
  const { displayState } = await import('../../runtime/src/team-now.ts');
  const { agentStateRole } = await import('../src/Status.tsx');
  const words = ['RUNNING', 'IDLE', 'SEAT_HELD', 'BLOCKED', 'BACKOFF', 'LIMIT', 'WEDGED', 'CRASHED', 'STOP', 'HOLD', 'PARKED', 'halted', 'UNKNOWN'];
  for (const word of words) {
    assert.equal(agentStateRole(displayState(word)), loopStateRole(word), `${word} reads as a different severity once it is rolled up`);
  }
  /* And a state neither knows is amber rather than silent: a reading this build
     could not take is one Arthur has to take himself. */
  assert.equal(agentStateRole(displayState('DRAINING')), 'attention');
});

test('a class helper hands back a complete literal, or nothing at all', () => {
  for (const helper of [inkRole, tintRole]) {
    assert.equal(helper(null), '');
    assert.equal(helper(undefined), '');
    for (const role of Object.keys(APPROVED)) {
      const classes = helper(role);
      assert.match(classes, new RegExp(`var\\(--helmo-${role}-(ink|tint)\\)`), `${helper.name}(${role})`);
      /* Tailwind generates from source text. A class holding a role name it
         has to interpolate names a rule that does not exist, paints nothing,
         and logs nothing — so every one of these is written out in full. */
      assert.doesNotMatch(classes, /\$\{|\[object/, `${helper.name}(${role}) is composed, not literal`);
    }
  }
});

const { renderToStaticMarkup } = await import('react-dom/server');
const React = await import('react');

test('a role carries both its classes and the marker the browser proof finds', () => {
  for (const role of Object.keys(APPROVED)) {
    for (const [name, element] of [
      ['StatusBadge', React.createElement(StatusBadge, { status: role }, 'A state')],
      ['StatusAlert', React.createElement(StatusAlert, { status: role }, 'A state')],
    ]) {
      const html = renderToStaticMarkup(element);
      /* `data-status-role` is set from the prop, not from the class string, so the
         browser proof can require the tint of anything carrying it WITHOUT
         reading the class attribute it is trying to verify. */
      assert.ok(html.includes(`data-status-role="${role}"`), `${name} ${role} carries no marker`);
      for (const part of ['ink', 'tint']) {
        assert.ok(html.includes(`var(--helmo-${role}-${part})`), `${name} ${role} does not name its ${part}`);
      }
      /* cn() is what has to drop the variant's own colours. If it stopped,
         the stock background would win and the role would be invisible. The
         bare utility only — `[a]:hover:bg-secondary/80` is a different rule and
         reaches nothing here, because no role badge is a link. */
      assert.doesNotMatch(html, /(?<![\w:/[\]-])(bg-secondary|text-secondary-foreground|bg-card)(?![\w-])/, `${name} ${role} kept the variant's own colour`);
    }
  }
});

test('a neutral badge is exactly the chrome it was before', () => {
  const html = renderToStaticMarkup(React.createElement(StatusBadge, { status: null }, 'Open'));
  assert.doesNotMatch(html, /--helmo-/, 'an uncoloured state reached for a role anyway');
  assert.match(html, /bg-secondary/, 'a neutral badge lost its own variant');
  assert.doesNotMatch(html, /data-status-role/, 'an uncoloured state carries the marker, so the proof would demand a tint');
});
