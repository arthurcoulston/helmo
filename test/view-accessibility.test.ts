import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const view = readFileSync(new URL('../src/view.ts', import.meta.url), 'utf8');

function bodyOf(name: string): string {
  const start = view.indexOf(`function ${name}(`);
  const end = view.indexOf('\n}\n', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return view.slice(start, end);
}

describe('view accessibility', () => {
  it('keeps evidence links outside the control that opens the row', () => {
    // Evidence links are interactive, so they belong in the panel, never in
    // the row's own disclosure control — the same rule that moved the copy
    // button out of the <summary> this row used to have (H-2447).
    const row = bodyOf('row');
    const toggleEnd = row.indexOf('</button>');
    expect(toggleEnd).toBeGreaterThan(-1);
    expect(row.indexOf('evidenceLinks(t)')).toBeGreaterThan(toggleEnd);
  });

  it('separates product result, review evidence and release state', () => {
    const evidence = bodyOf('evidenceLinks');
    expect(evidence).toContain('Product result');
    expect(evidence).toContain('Review evidence');
    expect(evidence).toContain('Release state');
    expect(evidence).toContain('View result');
    expect(evidence).toContain('No product result linked');
  });

  it('does not hand a remote reader a device-local result link', () => {
    expect(bodyOf('evidenceLinks')).toContain('data-device-local');
    expect(bodyOf('evidenceLinks')).toContain('Result available on the estate machine');
    expect(bodyOf('enableDeviceLocalResults')).toContain("location.hostname === 'localhost'");
    expect(bodyOf('enableDeviceLocalResults')).toContain("link.hasAttribute('href')");
    expect(view).toMatch(/\.result-action\.primary\s*\{[^}]*min-height:\s*44px/);
  });

  it('keeps the one-click answer control touch-sized', () => {
    expect(view).toMatch(/\.ratify\s*\{[^}]*min-height:\s*44px/);
    expect(view).toMatch(/\.option\.choice\s*\{[^}]*min-height:\s*44px/);
    expect(bodyOf('questionCard')).toContain('Ratify recommendation');
    expect(bodyOf('questionCard')).toContain('class="option choice"');
    expect(bodyOf('questionCard')).toContain('data-choice="${esc(o.letter)}"');
  });

  it('puts the issue and its answer before the folded context', () => {
    const card = bodyOf('questionCard');
    const issue = card.indexOf('>Issue</span>');
    const options = card.indexOf('a.options.map(opt)');
    const recommendation = card.indexOf('>Recommends</span>');
    const ratify = card.indexOf('>Ratify recommendation</button>');
    const context = card.indexOf('<summary>Context</summary>');
    const situation = card.indexOf('esc(q.situation)');

    expect(issue).toBeGreaterThan(-1);
    expect(options).toBeGreaterThan(issue);
    expect(recommendation).toBeGreaterThan(options);
    expect(ratify).toBeGreaterThan(recommendation);
    expect(context).toBeGreaterThan(ratify);
    expect(situation).toBeGreaterThan(context);
  });

  it('uses Helmo letters and a proxy-safe relative answer target', () => {
    const card = bodyOf('questionCard');
    expect(card).toContain('const a = ask(q)');
    expect(card).toContain('esc(o.letter)');
    expect(view).toContain("fetch('answer', {");
    expect(view).not.toContain("fetch('/answer', {");
  });

  it('draws every reference through the one renderer that can copy it', () => {
    // The guarantee is "every visible ID is copyable", and the only way to
    // hold it is that no renderer draws one by hand. A new `.tid` span with
    // an ID in it is how that quietly stops being true.
    expect(view).toContain('function ref(id: string, href?: string)');
    expect(bodyOf('ref')).toContain('data-copy="${esc(id)}"');
    for (const site of ['row', 'questionCard', 'sittingCard', 'motionCard', 'details', 'groomStrip']) {
      expect(bodyOf(site), `${site} draws a reference by hand instead of through ref()`).toContain('ref(');
    }
    // The one `.tid` that is not an ID is the hygiene strip's workstream name.
    const byHand = [...view.matchAll(/<span class="tid">\$\{esc\(([^)]*)\)\}<\/span>/g)].map((m) => m[1]);
    expect(byHand).toEqual(["f.workstream ?? ''"]);
  });

  it('keeps the copy control finger-sized and announced', () => {
    // Small glyph, 44px target: the overlay is what reconciles the two, so it
    // is the part worth holding — losing it leaves a 18px tap target.
    expect(view).toMatch(/\.copy \{[^}]*width: 18px; height: 18px/);
    expect(view).toMatch(/\.copy::after \{[^}]*inset: -13px/);
    expect(view).toContain('id="copy-status"');
    expect(view).toContain("aria-live=\"polite\"");
    expect(bodyOf('ref')).toContain('aria-label="Copy ${esc(id)}"');
  });

  it('copies without the Clipboard API, which plain http does not have', () => {
    expect(view).toContain('function copyWithoutTheApi(text)');
    expect(view).toContain("document.execCommand('copy')");
  });

  it('never draws a copy control inside the element that opens a row', () => {
    // The nesting itself is what H-2447 cost us — a serious axe finding on
    // every live acceptance stop. The browser test proves the rendered page;
    // this holds the source shape a reader of this file could undo, which is
    // the row going back to <details>/<summary> with ref() inside it.
    expect(bodyOf('row')).not.toContain('<summary>');
    expect(bodyOf('row')).toContain('aria-expanded="false"');
    expect(bodyOf('row')).toContain('aria-controls="${panel}"');
  });

  it('does not replace the page while a reader has keyboard focus', () => {
    expect(view).toContain('document.activeElement !== document.body');
    expect(view.indexOf('document.activeElement !== document.body')).toBeLessThan(view.indexOf('document.body.replaceWith(doc.body)'));
  });

  it('labels recorded progress truthfully on every live row shape', () => {
    expect(bodyOf('progressLine')).toContain('last recorded update');
    expect(bodyOf('progressLine')).toContain('progress.actor.name');
    expect(bodyOf('questionCard')).toContain('progressLine(t)');
    expect(bodyOf('motionCard')).toContain('progressLine(t)');
    expect(bodyOf('row')).toContain('progressLine(t)');
  });

  it('makes deep terminal history an explicit whole-record choice', () => {
    const page = bodyOf('page');
    expect(page).toContain('recordTickets(completeRecord, wholeRecord)');
    expect(page).toContain('href="?whole=1"');
    expect(view).toContain("url.searchParams.get('whole') === '1'");
  });

  it('keeps the section query on refresh and reports its size and count', () => {
    expect(view).toContain("fetch(location.href, { cache: 'no-store' })");
    expect(view).toContain("type: 'helmo:section-size'");
    expect(view).toContain('height: document.documentElement.scrollHeight');
    expect(view).toContain('count: Number(document.body.dataset.count || 0)');
    expect(view).toContain('}, location.origin);');
  });
});
