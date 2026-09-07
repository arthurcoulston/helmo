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
  it('keeps evidence links outside the disclosure summary', () => {
    const row = bodyOf('row');
    const summaryEnd = row.indexOf('</summary>');
    expect(summaryEnd).toBeGreaterThan(-1);
    expect(row.indexOf('evidenceLinks(t)')).toBeGreaterThan(summaryEnd);
  });

  it('keeps the one-click answer control touch-sized', () => {
    expect(view).toMatch(/\.ratify\s*\{[^}]*min-height:\s*44px/);
    expect(bodyOf('questionCard')).toContain('Ratify recommendation');
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

  it('does not replace the page while a reader has keyboard focus', () => {
    expect(view).toContain('document.activeElement !== document.body');
    expect(view.indexOf('document.activeElement !== document.body')).toBeLessThan(view.indexOf('document.body.replaceWith(doc.body)'));
  });
});
