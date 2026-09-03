// The vendored estate design tokens (R-11 H-714). src/estate-tokens.generated.ts
// is a copy of a file another repo owns, so the only thing that can go wrong
// here is the copy going stale — and it would go stale invisibly, because a
// stale copy still compiles and still renders a page.
//
// One test here is allowed to skip, and that is the interesting part. Helmo is
// published standalone: a clone with no estate checkout beside it has no source
// to compare against, and failing there would make the product depend on a repo
// it is not allowed to depend on. So the skip is deliberate — but it must be
// visible, because a check that quietly passes when its input is missing is a
// check that can never go red. `it.skipIf` is what makes it visible: the run
// summary counts it as skipped rather than passed. An early `return` with a
// console.log does NOT — vitest swallows console output from a passing test,
// which was measured here, not assumed.
//
// The run that matters is Arthur's machine and estate CI, where the sibling
// checkout exists. The other two tests never skip: they read the vendored copy
// alone, which is the file that actually ships.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { SOURCE, VENDORED, render } from '../scripts/vendor-estate-tokens.mjs';

describe('vendored estate tokens', () => {
  const haveSource = existsSync(SOURCE);

  it.skipIf(!haveSource)('is the estate token file verbatim', () => {
    expect(readFileSync(VENDORED, 'utf8')).toBe(render(readFileSync(SOURCE, 'utf8')));
  });

  it('carries the dark values under prefers-color-scheme, not on a class alone', () => {
    // The view has no theme switch, so this is the line between "adopted the
    // tokens" and "adopted the light half of the tokens and wore it at night".
    // It reads the vendored copy, not the source: what ships is what matters.
    const css = readFileSync(VENDORED, 'utf8');
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\.light\) \{/);
    expect(css).toMatch(/--background: [^;]+;/);
  });

  it('refuses a source that cannot be vendored verbatim', () => {
    // The copy lands inside a template literal. A backtick or `${` in the
    // source would escape it, so the script stops instead of escaping — an
    // escaped copy is no longer a copy.
    expect(() => render(':root { --x: `; }')).toThrow(/should not/);
    expect(() => render(':root { --x: ${1}; }')).toThrow(/should not/);
  });
});
