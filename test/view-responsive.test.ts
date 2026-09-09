import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const view = readFileSync(new URL('../src/view.ts', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../src/estate-tokens.generated.ts', import.meta.url), 'utf8');
const css = view.slice(view.indexOf('const CSS = `'), view.indexOf('const JS = `'));
const js = view.slice(view.indexOf('const JS = `'));

describe('phone-first dashboard', () => {
  it('uses a one-column header and stacked stats until the wide breakpoint', () => {
    expect(css).toMatch(/\.top \{ display: grid;/);
    expect(css).toMatch(/\.stats \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(min-width: 700px\)[\s\S]*\.top \{ display: flex;/);
  });

  it('allows long badges to wrap inside the phone viewport', () => {
    const badge = /\.badge \{([^}]*)\}/.exec(css)?.[1] ?? '';
    // The badge only has to opt back IN to wrapping; where it breaks is the
    // root rule's business, and it inherits that (H-1176).
    expect(badge).toContain('white-space: normal');
  });

  /* Every string on this page is store text carrying paths, refs and URLs, and
     one of them with nowhere to break drags the whole document sideways on a
     phone. This lived on three selectors and was missed on a fourth, so it is
     declared once at the root; asserting it there is what stops the next
     surface having to remember (R-11 H-1176). */
  it('lets any store string break, wherever it is rendered', () => {
    expect(css).toContain(':root { overflow-wrap: anywhere; }');
  });

  it('honours an explicit shell theme as well as the system preference', () => {
    expect(css).toContain(':root.light { color-scheme: light; }');
    expect(css).toContain(':root.dark { color-scheme: dark; }');
    expect(tokens).toContain('@media (prefers-color-scheme: dark)');
  });
});

describe('automatic refresh failure', () => {
  it('keeps the old reading and exposes when it was last good', () => {
    expect(view).toContain('id="refresh-warning"');
    expect(view).toContain('id="last-good"');
    expect(js).toContain("if (!r.ok) throw new Error('refresh returned ' + r.status)");
    expect(js).toContain('showRefreshFailure();');
    expect(js).toContain('new Date(lastGood)');
  });
});
