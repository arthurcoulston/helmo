// What an expanded row actually says, rendered from the real component, and the
// proof that the two bounds behind it are one rule.
//
// Server-rendered rather than driven in a browser for the same reason as
// `work-result.test.mjs`: this checkout may not be built, and building a shared
// installation deploys it to every consumer loading its `dist`. That the table
// draws this component is proved in a real browser by `scripts/verify-ui.mjs`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

globalThis.location = { hostname: 'dash.example.com' };
const { renderToStaticMarkup } = await import('react-dom/server');
const React = await import('react');
const { RecordPreview, excerpt } = await import('../src/RecordTable.tsx');
// Reached for by path rather than through a declared dependency: the shell is a
// browser bundle and `@helmo/core` imports `node:fs`, so the one rule the two
// sides share cannot be one function. This import is what keeps it one rule.
const { boundNote, NOTE_BOUND } = await import('../../core/src/progress.ts');

const reading = (progress, body) => {
  const html = renderToStaticMarkup(React.createElement(RecordPreview, {
    progress, body, openLabel: 'H-1 The work', onOpen: () => {},
  }));
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
};
const PROGRESS = { at: '2026-10-07T06:00:00Z', note: 'Findings 1 and 2 are delivered; the preview is the one thing left.', actor: { name: 'mason' } };

describe('what an expanded row says about a record', () => {
  it('leads with where the record stands, attributed', () => {
    const text = reading(PROGRESS, 'Arthur asked in the attended session on 2026-10-06.');
    assert.match(text, /Where it stands Findings 1 and 2 are delivered; the preview is the one thing left\. — mason,/);
    // The note leads: a reader scanning sees it before the filing prose.
    assert.ok(text.indexOf('Where it stands') < text.indexOf('The record opens'));
  });

  it('says so when nobody has recorded progress, rather than drawing a blank', () => {
    const text = reading(null, 'Filed and never touched since.');
    assert.match(text, /Where it stands No progress has been recorded on this record yet\./);
    assert.match(text, /The record opens Filed and never touched since\./);
  });

  it('never calls either reading a summary or a description', () => {
    const text = reading(PROGRESS, 'A body.');
    for (const word of [/\bsummary\b/i, /\bdescription of\b/i, /\bin short\b/i]) assert.doesNotMatch(text, word);
  });

  it('admits that the opening is only an opening, and does not when it is whole', () => {
    // The apostrophe arrives HTML-escaped out of static markup; the words are the assertion.
    assert.match(reading(PROGRESS, 'x '.repeat(400)), /Open full view — this is the record\S+ opening only/);
    assert.match(reading(PROGRESS, 'Short enough to show whole.'), /The record opens Short enough to show whole\. Open full view : H-1 The work/);
  });

  it('names the record in the full-view control, which a screen reader reads out of context', () => {
    assert.match(reading(PROGRESS, 'A body.'), /Open full view : H-1 The work/);
  });

  it('shows a record with no body at all as having none', () => {
    assert.match(reading(PROGRESS, ''), /The record opens This record has no description\./);
  });
});

describe('the two bounds are one rule', () => {
  /* A note is bounded on the server by `boundNote` and an opening on the client
     by `excerpt`. Two functions, because the shell cannot import a package that
     reads `node:fs` — so this is what stops them drifting into two rules, which
     would show a reader two different kinds of truncation on one row. */
  const CASES = [
    '',
    'short',
    'Reconciled the fixture record against the real one and found the same drift again. '.repeat(5),
    // The live store's longest note, in shape: one unbroken stretch past the bound.
    'x'.repeat(400),
    // A cut landing exactly on a space, and one landing on the character after it.
    `${'a '.repeat(139)}trailing words beyond the bound`,
    `${'ab '.repeat(93)}trailing words beyond the bound`,
    // Multi-byte, where a code-point slice and a UTF-16 slice disagree.
    `${'🧱 '.repeat(100)}trailing words beyond the bound`,
  ];
  for (const [i, input] of CASES.entries()) {
    it(`agrees on case ${i} (${input.length} characters)`, () => {
      assert.equal(boundNote(input), excerpt(input, NOTE_BOUND).text);
    });
  }

  it('cuts at a word boundary and admits the cut', () => {
    const note = 'Reconciled the fixture record against the real one and found the same drift again. '.repeat(5).trim();
    const bounded = boundNote(note);
    assert.ok(bounded.endsWith('…'), bounded);
    const visible = bounded.slice(0, -1);
    assert.ok(note.startsWith(visible), "the bounded note must be the author's own words");
    assert.equal(note[visible.length], ' ', `cut mid-word: "${visible.slice(-20)}"`);
    assert.ok(visible.length <= NOTE_BOUND);
  });

  it('leaves a note inside the bound exactly as written', () => {
    assert.equal(boundNote(PROGRESS.note), PROGRESS.note);
  });
});
