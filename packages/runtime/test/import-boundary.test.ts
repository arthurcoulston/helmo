// The runtime-to-work-record import boundary (R-47 C1, H-2639).
//
// In two repositories this boundary enforced itself. In one workspace
// `packages/work` is a package named `helmo`, so `import { Store } from
// 'helmo'` inside the runtime resolves and links the supervisor to the work
// record's source at build time. The guard that refuses it is only worth
// having if it has been watched refusing, so every shape below is a shape
// the scan must catch or must leave alone.
//
// The quiet failures aimed at here: a scan that reads zero files and reports
// a clean boundary; a scan that catches a commented-out import; a scan that
// catches the word "helmo" in prose; a relative specifier written with a
// spelling the pattern was not written for; and a quote inside a REGEX
// literal opening a string that was never there, so that every import below
// it goes unread (H-2647).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  intoWork,
  judge,
  scan,
  specifiers,
  violationsIn,
  SHIPPED,
  WORK_DIR,
  WORK_PACKAGE,
} from '../scripts/check-import-boundary.mjs';

const RUNTIME_SRC = join(import.meta.dirname, '..', 'src');
const workDir = '/w/packages/work';
const from = (source: string, file = '/w/packages/runtime/src/helm.ts') =>
  violationsIn({ file, source, workDir });

describe('the specifiers a source really imports', () => {
  it('reads every import form, and no string that is not one', () => {
    const found = specifiers(`
      import { a } from 'node:fs';
      import 'side-effect';
      const { b } = await import('./lazy.js');
      const c = require('legacy');
      const notAnImport = 'helmo';
      run('node', [cli, '--from', 'helmo']);
    `).map((s) => s.specifier);
    expect(found.sort()).toEqual(['./lazy.js', 'legacy', 'node:fs', 'side-effect']);
  });

  it('reports the line the specifier is actually on', () => {
    const found = specifiers("// one\n/* two\n   three */\nimport { S } from 'helmo';\n");
    expect(found).toEqual([{ specifier: 'helmo', line: 4 }]);
  });

  it('ignores a commented-out import, which is not an import', () => {
    expect(specifiers("// import { S } from 'helmo';\n/* import 'helmo' */\n")).toEqual([]);
  });

  it('ignores prose that merely contains the words of an import', () => {
    expect(specifiers("const why = `the Store comes from 'helmo', over a process boundary`;\n")).toEqual([]);
  });

  it('is not confused by a URL, whose // is not a comment', () => {
    expect(specifiers("const u = 'http://localhost:4400/';\nimport { x } from './view.js';\n").map((s) => s.specifier))
      .toEqual(['./view.js']);
  });

  // A quote inside a regex literal is not a quote. Read as one, it opens a
  // string that runs to the next real quote in the file — the opening quote
  // of the import below — and the import is never seen (H-2647).
  it('reads an import that follows a regex holding a quote character', () => {
    const found = specifiers("const re = /it's/;\nimport { Store } from 'helmo';\n");
    expect(found).toEqual([{ specifier: 'helmo', line: 2 }]);
  });

  it('reads an import below a regex whose character class holds a slash', () => {
    const found = specifiers("const sep = /[/\\\\]'/;\nimport { S } from 'helmo';\n");
    expect(found.map((f) => f.specifier)).toEqual(['helmo']);
  });

  it('does not read the inside of a regex as an import', () => {
    expect(specifiers("const bad = /from 'helmo'/;\nconst also = [/import 'helmo'/, /x/g];\n")).toEqual([]);
  });

  // The other half of the same decision: a `/` that divides must stay a
  // division. Read as a regex, it blanks out the code up to the next `/` on
  // the line, which is one more way to lose an import.
  it('still reads a division as a division, not as an opening regex', () => {
    const found = specifiers("const half = (a + b) / 2 / c;\nimport { S } from 'helmo';\n");
    expect(found.map((f) => f.specifier)).toEqual(['helmo']);
    expect(specifiers("let n = i++ / 2 / 3; import { S } from 'helmo';\n").map((f) => f.specifier))
      .toEqual(['helmo']);
  });

  it('reads a regex in the places this tree actually writes one', () => {
    const sources = [
      "const re = /x/;\nimport { S } from 'helmo';",
      "if (!/x'/.test(s)) { import('helmo'); }",
      "const f = (s: string) => /x'/.test(s) || require('helmo');",
      "const o = { re: /x'/, f: 1 };\nexport { S } from 'helmo';",
      "for (const c of /x'/.source) require('helmo');",
    ];
    for (const source of sources) {
      expect(specifiers(source).map((f) => f.specifier), source).toEqual(['helmo']);
    }
  });
});

describe('which specifiers reach the work record', () => {
  const fromDir = '/w/packages/runtime/src';
  const reaches = (spec: string) => intoWork(spec, { fromDir, workDir });

  it('refuses the work record by its own package name', () => {
    expect(reaches(WORK_PACKAGE)).toMatch(/package name/);
    expect(reaches(`${WORK_PACKAGE}/dist/store.js`)).toMatch(/package name/);
  });

  it('refuses it under a scoped rename, so the guard survives one', () => {
    expect(reaches('@helmo/work')).toBeTruthy();
    expect(reaches('@helmo/work/dist/store.js')).toBeTruthy();
  });

  it('refuses a relative path into it, however that path is spelled', () => {
    expect(reaches('../../work/src/store.js')).toBeTruthy();
    expect(reaches('../../../packages/work/src/store.js')).toBeTruthy();
    expect(reaches('/w/packages/work/src/store.js')).toBeTruthy();
  });

  it('leaves the runtime its own neighbours and the shared core alone', () => {
    for (const ok of ['./helm.js', '../src/cli.ts', 'node:path', 'smol-toml', 'tsx/esm', '@helmo/core']) {
      expect(reaches(ok)).toBeNull();
    }
  });

  it('does not mistake the roadmap for the work record on a shared prefix', () => {
    expect(reaches('helmo-roadmap')).toBeNull();
    expect(reaches('../../roadmap/src/view.js')).toBeNull();
  });
});

describe('the guard refusing a real violation', () => {
  it('refuses a static import of the store, naming file, line and specifier', () => {
    const found = from("import { Store } from 'node:fs';\nimport { Store as S } from 'helmo';\n");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 2, specifier: 'helmo' });
    expect(found[0]!.file).toContain('helm.ts');
  });

  it('refuses a dynamic import of the store', () => {
    expect(from("const { Store } = await import('../../work/src/store.js');\n")).toHaveLength(1);
  });

  it('refuses a require of the store', () => {
    expect(from("const { Store } = require('helmo/dist/store.js');\n")).toHaveLength(1);
  });

  it('refuses a re-export of the store, which is an import that hides', () => {
    expect(from("export { Store } from 'helmo';\n")).toHaveLength(1);
  });
});

describe('the shipped runtime, as it stands', () => {
  const result = scan();

  it('imports nothing from the work record', () => {
    const verdict = judge(result);
    expect(result.findings).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  // The absence above is only worth reading beside a presence: a scan that
  // silently found no code, or found code and extracted no specifiers from
  // it, would report the same clean boundary.
  it('was actually read: shipped files, and real specifiers out of them', () => {
    expect(result.files).toBeGreaterThan(20);
    const seen = new Set(
      specifiers(readFileSync(join(RUNTIME_SRC, 'helm.ts'), 'utf8')).map((s) => s.specifier),
    );
    expect(seen.has('node:child_process')).toBe(true);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('scans the shipped surface and leaves the tests out of it', () => {
    expect(SHIPPED).toEqual(['src', 'bin', 'scripts']);
    expect(SHIPPED).not.toContain('test');
    expect(WORK_DIR.endsWith(join('packages', 'work'))).toBe(true);
  });
});

describe('the verdict', () => {
  it('calls an empty scan red, so a renamed directory cannot retire the guard', () => {
    expect(judge({ files: 0, findings: [] }).ok).toBe(false);
    expect(judge({ files: 0, findings: [] }).detail).toMatch(/lost its subject/);
  });

  it('counts what it found, in words a reader can act on', () => {
    const verdict = judge({ files: 9, findings: [{ file: 'a', line: 1, specifier: 'helmo', why: 'x' }] });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/1 import from the runtime into the work record/);
  });
});
