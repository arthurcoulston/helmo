// Why this is a unit assertion and not left to the estate's product smoke
// (R-11 H-1176).
//
// The defect: a project body carrying an absolute path — a token with no space
// to break at — laid out 433px wide in a 276px column and dragged the whole
// page to 505px in a 390px viewport. The smoke on the live fleet is what
// caught it, and it is the better check in every way but one: it can only see
// the defect while some project body happens to be carrying a long path. Clear
// the roadmap of paths and the rule below could be deleted with every stop
// still green. So the rule gets an assertion that does not depend on today's
// data, and the smoke keeps proving the page.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const view = readFileSync(new URL('../src/view.ts', import.meta.url), 'utf8');
const css = view.slice(view.indexOf('const CSS = `'), view.indexOf('const JS = `'));

describe('phone-width layout', () => {
  it('lets any store string break, wherever it is rendered', () => {
    expect(css).toContain(':root { overflow-wrap: anywhere; }');
  });
});
