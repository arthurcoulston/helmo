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

  it('gives the answer resolution select a visible label', () => {
    const form = bodyOf('answerForm');
    expect(form).toMatch(/<label class="af-resolution">[^]*<select class="af-res">[^]*<\/select>[^]*<\/label>/);
  });

  it('does not replace the page while a reader has keyboard focus', () => {
    expect(view).toContain('document.activeElement !== document.body');
    expect(view.indexOf('document.activeElement !== document.body')).toBeLessThan(view.indexOf('document.body.replaceWith(doc.body)'));
  });
});
