#!/usr/bin/env node
/* Refuses an import from the runtime into the work record (R-47 C1, H-2639).

   Before C1, `rev` and `helmo` were separate repositories and this boundary
   needed no guard: you cannot import across a repository you have not
   installed. The unified workspace removes that accident. `packages/work`'s
   package name is `helmo`, so from inside `packages/runtime` a bare
   `import { Store } from 'helmo'` now resolves, through the workspace link,
   straight into the work record's own source, and nothing would complain.

   THE RUNTIME TALKS TO THE WORK RECORD OVER A PROCESS BOUNDARY, and that is
   the whole design. src/helm.ts spawns `node <helmo_cli>` and reads its
   stdout; src/shim.ts hands agents an MCP server to run. Both reach Helmo by
   a CONFIGURED PATH (roster.toml `helmo_cli`, `helmo_mcp_server`), which is
   what lets one supervisor drive a Helmo installation it was not built beside,
   at a release it does not share. An import would link the two at build time
   and quietly end that: one store schema, one upgrade, one blast radius.

   SCOPE IS THE SHIPPED CODE: `src`, `bin`, `scripts`. `test` is deliberately
   outside it. test/helmo.ts opens the work record's store directly to assert
   what a loop actually wrote, which is an observation of the other side and
   not a coupling of this one; it already resolves that checkout through
   REV_TEST_HELMO rather than assuming anything about this tree.

   WHAT IT CANNOT SEE. The scan reads import forms with a literal specifier.
   A specifier assembled at runtime, `await import(join(dir, 'store.js'))`,
   is invisible to it, and no static check can be honest about otherwise. It
   is the accident this guard exists for, not a determined author.

   Usage:
     node scripts/check-import-boundary.mjs          # exit 1 on a violation
     node scripts/check-import-boundary.mjs --quiet  # print only on failure

   Runs as npm `prebuild`, so nothing compiles until the boundary holds,
   including from the workspace root, whose build runs every package's. The
   test path is covered by test/import-boundary.test.ts, which asserts this
   same scan over the live tree rather than running the script a second time.
*/
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspacePackage } from '@helmo/core/checkout';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The work record as this workspace spells it: the package name
 *  `packages/work/package.json` declares, and the directory the workspace
 *  resolves that name to. Asked for by NAME rather than written out as a
 *  sibling directory, so renaming `packages/work` moves the guard with it
 *  rather than quietly leaving it scanning for a directory that is gone
 *  (F4, H-2638). A lone clone of the runtime has no such package and nothing
 *  to guard against; the sibling path is what it used to mean. */
export const WORK_PACKAGE = 'helmo';
export const WORK_DIR = workspacePackage(ROOT, WORK_PACKAGE) ?? resolve(ROOT, '..', 'work');

/** The shipped surface. `test` is out of scope; see the header. */
export const SHIPPED = ['src', 'bin', 'scripts'];
const CODE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

/* A string literal in the code skeleton becomes this marker, its index, and
   the marker again. NUL cannot occur in the sources being read, so nothing it
   stands in for can be confused with code someone really wrote. */
const MARK = String.fromCharCode(0);

/* Where a `/` starts a regular expression rather than dividing. Nothing can
   lex JavaScript without deciding this, and the guard must decide it for one
   concrete reason: `const re = /it's/;` holds an apostrophe that is not a
   quote, and reading it as one swallows everything up to the next quote in
   the file — which can be the quote of a real `from 'helmo'` below it, making
   that import invisible (H-2647).

   The test is the language's own: a `/` in OPERAND position opens a literal,
   a `/` after an operand divides. Operand position is the start of the file,
   just after one of the punctuators a literal really does follow here (`=`,
   `(`, `,`, `[`, `{`, `:`, `;`, `!`, `&`, `|`, `?`, `}`, and `>` for an arrow
   body), or just after one of the keywords an expression follows. The
   arithmetic operators and `)` are deliberately OUT: `(a + b) / 2` and
   `i++ / 2` are far more common in this tree than `if (x) /re/`, and every
   character left out of the set can only cost the blind spot this already
   had, never a new one.

   Where the two readings still disagree, division wins, because a regex
   literal cannot span a line: a candidate that does not close before the
   newline is a division (see regexEnd). So the worst a misreading can cost
   is the remainder of ONE line, never the rest of the file. */
const OPERAND_AFTER = new Set('=(,[{;:!&|?}>'.split(''));
const OPERAND_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
]);
const WORD_CHAR = /[A-Za-z0-9_$]/;

function regexAllowed(prev, prevWord) {
  if (prev === '') return true; // start of file
  if (WORD_CHAR.test(prev)) return OPERAND_AFTER_WORD.has(prevWord);
  return OPERAND_AFTER.has(prev);
}

/** The index of the `/` closing the regex literal opened at `start`, or -1 if
 *  it does not close on its own line — in which case the `/` was a division.
 *  `\/` is escaped and a `/` inside a `[...]` class does not close. */
function regexEnd(src, start) {
  let inClass = false;
  for (let j = start + 1; j < src.length; j += 1) {
    const c = src[j];
    if (c === '\n') return -1;
    if (c === '\\') { j += 1; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '/') return j;
  }
  return -1;
}

/**
 * Splits source into a code skeleton and the string literals it contained,
 * each literal replaced by its marker, and every comment and regex literal
 * blanked out.
 *
 * All three of those matter. Comments must go, or a commented-out import
 * reads as a violation. Strings must come out of the code before any import
 * form is matched against it, or PROSE trips the guard: src/build.ts already
 * carries `dist/store.js` in a comment, and a sentence containing the words
 * "from 'helmo'" inside a template literal would otherwise be a finding.
 * Regex literals must go before the strings are read, or a quote character
 * inside one opens a string that was never there and hides what follows it.
 * Newlines are preserved throughout, so a reported line is a real line.
 */
export function tokenize(src) {
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  let code = '';
  const strings = [];
  let i = 0;
  let line = 1;
  /* The last significant code character and the identifier it ended, which
     is what regexAllowed is asked about. Whitespace and comments are
     transparent to `prev` — `const re =\n  /x/` is one expression — but they
     do END an identifier, so `gap` keeps `const c of` from reading as one
     word and losing the keyword that the regex after it follows. */
  let prev = '';
  let prevWord = '';
  let gap = false;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      code += blank(src.slice(i, stop));
      gap = true;
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      const text = src.slice(i, stop);
      code += blank(text);
      line += (text.match(/\n/g) ?? []).length;
      gap = true;
      i = stop;
      continue;
    }
    if (src[i] === '/' && regexAllowed(prev, prevWord)) {
      const end = regexEnd(src, i);
      if (end !== -1) {
        code += blank(src.slice(i, end + 1));
        prev = ')'; // a literal is an operand: the next `/` divides it
        prevWord = '';
        gap = false;
        i = end + 1;
        continue;
      }
    }
    const q = src[i];
    if (q === '"' || q === "'" || q === '`') {
      let j = i + 1;
      let value = '';
      while (j < src.length) {
        if (src[j] === '\\') { value += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === q) break;
        value += src[j];
        j += 1;
      }
      code += MARK + strings.length + MARK;
      strings.push({ value, line });
      line += (src.slice(i, j + 1).match(/\n/g) ?? []).length;
      prev = ')';
      prevWord = '';
      gap = false;
      i = j + 1;
      continue;
    }
    if (q === '\n') line += 1;
    if (/\s/.test(q)) {
      gap = true;
    } else {
      if (!WORD_CHAR.test(q)) prevWord = '';
      else prevWord = gap || !WORD_CHAR.test(prev) ? q : prevWord + q;
      prev = q;
      gap = false;
    }
    code += q;
    i += 1;
  }
  return { code, strings };
}

/** The import forms a literal specifier can arrive through. */
const FORMS = [
  // import x from 'y'; export { a } from 'y'
  new RegExp('\\bfrom\\s*' + MARK + '(\\d+)' + MARK, 'g'),
  // import 'y'
  new RegExp('\\bimport\\s*' + MARK + '(\\d+)' + MARK, 'g'),
  // await import('y')
  new RegExp('\\bimport\\s*\\(\\s*' + MARK + '(\\d+)' + MARK + '\\s*\\)', 'g'),
  // require('y')
  new RegExp('\\brequire\\s*\\(\\s*' + MARK + '(\\d+)' + MARK + '\\s*\\)', 'g'),
];

/** Every module specifier this source actually imports, with its line. */
export function specifiers(src) {
  const { code, strings } = tokenize(src);
  const found = new Map();
  for (const form of FORMS) {
    for (const m of code.matchAll(form)) {
      const s = strings[Number(m[1])];
      if (s) found.set(`${s.line}:${s.value}`, { specifier: s.value, line: s.line });
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

/**
 * Does this specifier reach the work record? Pure, and told where it is asked
 * from, so a relative specifier is RESOLVED rather than pattern-matched:
 * `../work/src/store.js` and `../../packages/work/src/store.js` name the same
 * module, and a pattern written for one spelling misses the other.
 */
export function intoWork(specifier, { fromDir, workDir = WORK_DIR, workPackage = WORK_PACKAGE } = {}) {
  if (specifier === workPackage || specifier.startsWith(`${workPackage}/`)) {
    return `'${specifier}' is the work record's own package name`;
  }
  if (specifier === '@helmo/work' || specifier.startsWith('@helmo/work/')) {
    return `'${specifier}' is the work record's package`;
  }
  if (/^[./]/.test(specifier) && fromDir) {
    const target = resolve(fromDir, specifier);
    if (target === workDir || target.startsWith(workDir + sep)) {
      return `'${specifier}' resolves to ${relative(workDir, target) || '.'} inside the work record`;
    }
  }
  return null;
}

/** Every violation in one file. */
export function violationsIn({ file, source, workDir = WORK_DIR }) {
  const fromDir = dirname(file);
  return specifiers(source).flatMap(({ specifier, line }) => {
    const why = intoWork(specifier, { fromDir, workDir });
    return why ? [{ file, line, specifier, why }] : [];
  });
}

function* codeFiles(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries.sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { yield* codeFiles(full); continue; }
    if (CODE.test(name)) yield full;
  }
}

export function scan({ root = ROOT, shipped = SHIPPED, workDir = WORK_DIR, read = readFileSync } = {}) {
  const findings = [];
  let files = 0;
  for (const area of shipped) {
    for (const file of codeFiles(join(root, area))) {
      files += 1;
      findings.push(...violationsIn({ file, source: read(file, 'utf8'), workDir }));
    }
  }
  return { files, findings };
}

/**
 * The verdict. Zero files scanned is RED, not green: a guard that found
 * nothing to read has not cleared the boundary, it has lost its subject.
 * A renamed source directory would otherwise retire it in silence.
 */
export function judge({ files, findings }) {
  if (files === 0) return { ok: false, detail: 'no shipped code found to scan: the guard has lost its subject' };
  if (findings.length) {
    return {
      ok: false,
      detail: `${findings.length} import${findings.length === 1 ? '' : 's'} from the runtime into the work record`,
    };
  }
  return { ok: true, detail: `${files} shipped files import nothing from the work record` };
}

function main(quiet) {
  const result = scan();
  const verdict = judge(result);
  for (const f of result.findings) {
    console.error(`FAIL  ${relative(ROOT, f.file)}:${f.line}  ${f.why}`);
  }
  if (!verdict.ok) {
    console.error(`FAIL  import boundary: ${verdict.detail}`);
    console.error('      The runtime reaches Helmo by spawning its CLI at a configured path, never by importing it.');
    console.error('      Read the header of scripts/check-import-boundary.mjs before changing this.');
    return 1;
  }
  if (!quiet) console.log(`  ok  import boundary: ${verdict.detail}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.includes('--quiet')));
}
