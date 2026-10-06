// The shell's two seams, and nothing else: the components it vendors from the
// estate, and the theme variables it borrows from the tokens every Helmo page
// already inlines. Both are copies of things another file owns, so the failure
// to catch is the copy going stale — which it does invisibly, because a stale
// copy still compiles and still renders a page.
//
// One test here is allowed to skip, and that is the interesting part. Helmo is
// published standalone: a clone with no estate checkout beside it has nothing
// to compare against. The skip is deliberate and it is LOUD — node:test counts
// a skipped test in its summary, where an early return would simply pass.

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FILES, SOURCE, render } from '../scripts/vendor-estate-components.mjs';

const root = new URL('..', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), 'utf8');
const haveSource = existsSync(SOURCE);

test('retains the shadcn MIT notice beside the vendored copies', () => {
  const notice = read('../../THIRD_PARTY_NOTICES.md');
  assert.match(notice, /Copyright \(c\) 2023 shadcn/);
  assert.match(notice, /The above copyright notice and this permission notice/);
});

test('is the estate component source verbatim', { skip: haveSource ? false : `no estate checkout at ${SOURCE}` }, () => {
  for (const relative of FILES) {
    assert.equal(read(`src/${relative}`), render(relative, readFileSync(join(SOURCE, relative), 'utf8')), relative);
  }
});

test('vendors every component it imports, and no component it does not', () => {
  // A vendored file nobody renders is a file nobody has checked still works,
  // and an import of a file nobody vendored only fails at build time — which
  // is a worse place to learn it than here.
  const sources = ['src/shell.tsx', 'src/main.tsx', ...FILES.map((f) => `src/${f}`)].map(read).join('\n');
  const imported = new Set([...sources.matchAll(/from "@\/([^"]+)"|from '@\/([^']+)'/g)].map((m) => m[1] ?? m[2]));
  const vendored = new Set(FILES.map((f) => f.replace(/\.tsx?$/, '')));
  for (const path of imported) {
    if (path === 'shell' || path === 'index.css') continue;
    assert.ok(vendored.has(path), `src/${path} is imported but not vendored`);
  }
  for (const path of vendored) {
    assert.ok(imported.has(path), `src/${path} is vendored but nothing imports it`);
  }
});

test('every theme variable the shell maps is one the estate tokens declare', () => {
  // index.css deliberately declares no colours — it maps the ones ESTATE_TOKENS
  // already puts on every Helmo page. An `@theme inline` entry pointing at a
  // variable the tokens no longer declare is the silent half of a rename: the
  // build stays green, the utility compiles, and the rule it emits resolves to
  // nothing at all, so that part of the chrome simply loses its colour.
  const tokens = read('../core/src/estate-tokens.generated.ts');
  const declared = new Set([...tokens.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));
  const theme = /@theme inline \{([^]*?)\n\}/.exec(read('src/index.css'));
  assert.ok(theme, 'index.css declares no @theme inline block');
  const referenced = [...theme[1].matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
  assert.ok(referenced.length > 20, `only ${referenced.length} theme mappings — did the block move?`);
  const missing = [...new Set(referenced)].filter((name) => !declared.has(name) && !name.startsWith('--font-'));
  assert.deepEqual(missing, []);
});

test('the built stylesheet resolves the sidebar colours rather than dropping them', () => {
  // The check that actually closes a token remap: an unresolved variable emits
  // no rule at all, so reading the BUILT sheet is the only place the mapping
  // can be seen to have survived.
  const built = new URL('dist/shell.css', root);
  assert.ok(existsSync(built), 'dist/shell.css is missing: run npm run build');
  const css = readFileSync(built, 'utf8');
  for (const [utility, variable] of [
    ['.bg-sidebar', '--sidebar'],
    ['.text-sidebar-foreground', '--sidebar-foreground'],
    ['.bg-background', '--background'],
    ['.text-muted-foreground', '--muted-foreground'],
  ]) {
    // Lightning CSS groups selectors that share a declaration, so the utility
    // is not always the last name before the brace.
    const rule = new RegExp(`\\${utility}[^{}]*\\{[^}]*var\\(${variable}\\)`);
    assert.match(css, rule, `${utility} did not compile to var(${variable})`);
  }
});
