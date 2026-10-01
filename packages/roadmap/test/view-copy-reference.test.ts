/* The copy control's shape, held where this repo can hold it (H-2428, I12).
 *
 * Arthur asked for one-click copying of ids on every ticket AND roadmap item
 * (crew:projects/r39/research/notes/h2364-arthur-walkthrough.md). Helmo's
 * repo proves the same control end to end in a real browser, clipboard and
 * all, in test/view-viewport-render.test.ts; this repo has no browser in its
 * toolchain and buying one for a page this size is not worth it. So what is
 * asserted here is the part a reader of this file can break by accident: that
 * no renderer draws a reference by hand, and that the pieces the browser test
 * proved are still the pieces this page ships.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const view = readFileSync(new URL('../src/view.ts', import.meta.url), 'utf8');
const css = view.slice(view.indexOf('const CSS = `'), view.indexOf('const JS = `'));
const js = view.slice(view.indexOf('const JS = `'));

describe('every reference can be carried into a conversation', () => {
  it('draws every id through the one renderer that can copy it', () => {
    expect(view).toContain("function ref(id: string, cls: 'pid' | 'oid')");
    expect(view).toContain('data-copy="${esc(id)}"');
    // A new hand-drawn `.pid`/`.oid` span is how the guarantee quietly stops
    // being true, so the absence of one is the assertion.
    expect([...view.matchAll(/<span class="(pid|oid)">\$\{esc\(/g)].map((m) => m[0])).toEqual([]);
    for (const site of ['ref(c.objective_id,', 'ref(r.project.id,', 'ref(p.id,', 'ref(o.id,', 'ref(b.id,']) {
      expect(view, `${site} is not drawn through ref()`).toContain(site);
    }
  });

  it('copies the id itself, never the text drawn beside it', () => {
    expect(js).toContain('const text = copy.dataset.copy;');
    expect(js).not.toContain('copy.parentElement.textContent');
  });

  it('keeps the control finger-sized without a finger-sized icon', () => {
    expect(css).toMatch(/\.copy \{[^}]*width: 18px; height: 18px/);
    expect(css).toMatch(/\.copy::after \{[^}]*inset: -13px/);
  });

  it('copies where the page has no Clipboard API, which plain http has not', () => {
    expect(js).toContain('function copyWithoutTheApi(text)');
    expect(js).toContain("document.execCommand('copy')");
    expect(js).toContain('if (held && held.focus) held.focus();');
  });

  it('announces the result and does not also toggle the row it sits in', () => {
    expect(view).toContain('id="copy-status"');
    expect(view).toContain('aria-live="polite"');
    expect(view).toContain('aria-label="Copy ${esc(id)}"');
    // The control cannot toggle the row because it is not inside the thing
    // that toggles it. A <summary> is interactive, so a button within one is
    // axe's `nested-interactive` and unreachable on its own terms (H-2447):
    // the rows spell their disclosure as a sibling button and a panel.
    expect(view).not.toMatch(/<summary>[^<]*\$\{ref\(/);
    expect(view).toContain('class="rtoggle" aria-expanded="false"');
    expect(js).toContain("e.target.closest('.rtoggle')");
  });

  it('stops the refresh from pulling a focused control out from under a reader', () => {
    // This page replaces document.body every 15s. That was harmless while
    // nothing on it could hold focus; a copy button can, so the guard Helmo
    // already had is now load-bearing here too.
    expect(js).toContain('document.activeElement !== document.body');
    expect(js.indexOf('document.activeElement !== document.body')).toBeLessThan(js.indexOf('document.body.replaceWith(doc.body)'));
  });
});
