#!/usr/bin/env node
/* Generates the embedded legacy tokens module from sources shipped inside
   this Helmo distribution. Runtime views consume the committed module; source
   regeneration and drift checks need no sibling checkout. The explicit
   ESTATE_TOKENS_CSS override remains available for deliberate development. */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SOURCE =
  process.env.ESTATE_TOKENS_CSS ??
  join(ROOT, 'assets', 'legacy', 'estate-tokens.css');
export const VENDORED = join(ROOT, 'src', 'estate-tokens.generated.ts');

/** The vendored module's exact contents for a given token stylesheet. */
export function render(css) {
  // A backtick or `${` in the source would break out of the template literal
  // and, worse, could execute. Neither belongs in a CSS custom-property file,
  // so refuse rather than escape: an escaped copy is no longer verbatim, and
  // the source is a generated file whose shape we get to insist on.
  const bad = /[`]|\$\{/.exec(css);
  if (bad)
    throw new Error(
      `estate token file holds ${JSON.stringify(bad[0])} at index ${bad.index} — ` +
        `a CSS custom-property file should not, and vendoring it as a template ` +
        `literal cannot be verbatim if it does`,
    );
  return [
    '// VENDORED — do not edit. Source: packages/core/assets/legacy/estate-tokens.css',
    '// Refresh: node scripts/vendor-estate-tokens.mjs',
    '// Drift is a test failure: npm test (source is included in this distribution)',
    '// shadcn-derived values retain their MIT notice in THIRD_PARTY_NOTICES.md.',
    '//',
    '// Legacy view assets are owned and shipped by Helmo; no sibling repo is read.',
    '',
    'export const ESTATE_TOKENS = `',
    css.trimEnd(),
    '`;',
    '',
  ].join('\n');
}

function run() {
  const check = process.argv.includes('--check');
  let css;
  try {
    css = readFileSync(SOURCE, 'utf8');
  } catch {
    console.error(`no estate token file at ${SOURCE} — set ESTATE_TOKENS_CSS or restore the asset included in packages/core/assets/legacy`);
    process.exit(2);
  }
  const want = render(css);
  if (!check) {
    writeFileSync(VENDORED, want);
    console.log(`wrote src/estate-tokens.generated.ts from ${SOURCE}`);
    return;
  }
  let have = null;
  try {
    have = readFileSync(VENDORED, 'utf8');
  } catch {
    /* missing counts as drift */
  }
  if (have === want) {
    console.log('ok    src/estate-tokens.generated.ts');
    return;
  }
  console.error(
    `DRIFT src/estate-tokens.generated.ts — ${have === null ? 'missing' : 'stale'}; ` +
      `run node scripts/vendor-estate-tokens.mjs`,
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) run();
