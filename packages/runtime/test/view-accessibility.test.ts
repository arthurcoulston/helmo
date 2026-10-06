import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const view = readFileSync(new URL('../src/view.ts', import.meta.url), 'utf8');

describe('view accessibility', () => {
  it('declares its language and does not use timed document reloads', () => {
    expect(view).toContain('<html lang="en">');
    expect(view).not.toMatch(/http-equiv=["']refresh["']/i);
    expect(view).not.toContain('location.reload()');
  });

  it('keeps the loop table as a named, keyboard-focusable scroll region', () => {
    expect(view).toMatch(/class="tablewrap" tabindex="0" role="region" aria-label="Loop status"/);
  });

  it('uses the approved readable ink step for the title line', () => {
    expect(view).toContain('h1 .title-line { min-width: 0; overflow-wrap: anywhere; color: var(--ink-3)');
    expect(view).not.toMatch(/h1 \.title-line \{ color: var\(--ink-4\)/);
  });

  it('allows the title line to shrink on phones and keeps every quiet text state readable', () => {
    expect(view).toMatch(/h1 \.title-line \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
    expect(view).toContain('.st-halted { color: var(--ink-3); }');
    expect(view).toContain('.st-STOP, .st-HOLD { color: var(--ink-3); }');
    expect(view).toContain('.dim { color: var(--ink-3); }');
    expect(view).not.toContain('color: var(--ink-4)');
  });

  it('wraps the provenance line, which carries a filesystem path', () => {
    // An unstamped build prints its own directory, and a monospace path has no
    // break opportunity: on a phone the paragraph laid out 426px wide in a
    // 326px box and took the whole document to 458px (H-2923). Same rule, and
    // the same reason, as the title line above.
    expect(view).toMatch(/\.usage \{[^}]*overflow-wrap: anywhere;/);
  });

  it('polls in place and yields while a reader has keyboard focus', () => {
    expect(view).toContain('document.activeElement !== document.body');
    expect(view).toContain('current.replaceWith(replacement)');
    expect(view).not.toContain('document.body.replaceWith');
  });
});
