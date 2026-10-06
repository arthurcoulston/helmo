#!/usr/bin/env node
/* Vendors the estate's shadcn/ui component source into src/ (R-39 H-2933).

   The estate shell is where this estate's shadcn configuration was agreed and
   fetched: style `radix-nova`, base colour neutral, tsx, lucide icons. Helmo
   consumes those components the same way it already consumes the tokens that
   paint them — as a checked-in copy, so a clone with no estate checkout near
   it builds and runs unchanged, and so the two cannot silently fall onto
   different generations of the same component.

   The copy is verbatim below a provenance header. Nothing here rewrites an
   import or a class: a component that needed editing to work here is a change
   to make in the estate, once, not in each product that vendors it.

   Usage:
     node scripts/vendor-estate-components.mjs           # refresh the copies
     node scripts/vendor-estate-components.mjs --check   # exit 1 on drift

   ESTATE_SRC overrides the source directory; it defaults to a checkout beside
   this one. --check with no source present exits 2 rather than passing: a
   check that goes quiet when its input is missing can never go red. The test
   that wraps it (test/vendored-components.test.mjs) is the thing allowed to
   skip, and it says so aloud.
*/

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { besideCheckout } from '@helmo/core/checkout';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SOURCE = process.env.ESTATE_SRC ?? besideCheckout(ROOT, 'estate', 'src');

/* The sidebar and what it composes, and nothing else. Every file here is
   reached from the shell's own imports; a component nobody renders is a
   component nobody has checked still works. */
export const FILES = [
  'lib/utils.ts',
  'hooks/use-mobile.ts',
  'components/ui/button.tsx',
  'components/ui/input.tsx',
  'components/ui/separator.tsx',
  'components/ui/sheet.tsx',
  'components/ui/skeleton.tsx',
  'components/ui/tooltip.tsx',
  'components/ui/sidebar.tsx',
];

/** The vendored module's exact contents for a given upstream file. */
export function render(relative, source) {
  return [
    `// VENDORED — do not edit. Source: the estate repo, src/${relative}`,
    '// Refresh: node scripts/vendor-estate-components.mjs',
    '// Drift is a test failure: npm test (skipped, loudly, with no estate checkout)',
    '//',
    '// shadcn/ui source, style radix-nova, retaining its MIT notice in',
    '// THIRD_PARTY_NOTICES.md. The estate is where this estate agreed that',
    '// configuration (R-11); Helmo vendors it so it stays publishable alone.',
    '',
    source.trimEnd(),
    '',
  ].join('\n');
}

function run() {
  const check = process.argv.includes('--check');
  const wanted = new Map();
  for (const relative of FILES) {
    let source;
    try {
      source = readFileSync(join(SOURCE, relative), 'utf8');
    } catch {
      console.error(
        `no estate component at ${join(SOURCE, relative)} — set ESTATE_SRC or clone the estate repo beside this checkout`,
      );
      process.exit(2);
    }
    wanted.set(relative, render(relative, source));
  }

  const drifted = [];
  for (const [relative, want] of wanted) {
    const target = join(ROOT, 'src', relative);
    if (!check) {
      writeFileSync(target, want);
      continue;
    }
    let have = null;
    try {
      have = readFileSync(target, 'utf8');
    } catch {
      /* missing counts as drift */
    }
    if (have !== want) drifted.push(`src/${relative} — ${have === null ? 'missing' : 'stale'}`);
  }

  if (!check) {
    console.log(`wrote ${FILES.length} components from ${SOURCE}`);
    return;
  }
  if (!drifted.length) {
    console.log(`ok    ${FILES.length} vendored components`);
    return;
  }
  console.error(`DRIFT ${drifted.join('; ')}; run node scripts/vendor-estate-components.mjs`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) run();
